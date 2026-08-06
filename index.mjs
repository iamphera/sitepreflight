#!/usr/bin/env node
// sitepreflight — pre-flight checks for a static site, then tell the search engines.
// Zero dependencies. Node 18+.
//
//   sitepreflight check https://example.com [--limit N] [--json]
//   sitepreflight submit https://example.com/page/ ... --key <indexnow-key>
//
// Exit code is 1 when any check fails, so it works as a CI gate.

const UA = 'sitepreflight/0.1 (+https://github.com/iamphera/sitepreflight)';
const CHILD_SITEMAP_CAP = 50;
const INDEX_DEPTH_CAP = 3;

// ---------- pure helpers (covered by --selftest) ----------

export function parseSitemap(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m => m[1]);
}

// A <sitemapindex> lists other sitemaps, not pages. Astro, Next.js and Yoast all emit one
// by default, so treating its <loc>s as pages means checking XML files for a <title>.
export function isSitemapIndex(xml) {
  return /<sitemapindex[\s>]/i.test(xml);
}

export function parseRobots(txt) {
  const lines = txt.split('\n').map(l => l.replace(/#.*/, '').trim()).filter(Boolean);
  const sitemaps = [];
  let star = false, blocksAll = false;
  for (const line of lines) {
    const [rawKey, ...rest] = line.split(':');
    const key = rawKey.toLowerCase().trim();
    const value = rest.join(':').trim();
    if (key === 'sitemap') sitemaps.push(value);
    else if (key === 'user-agent') star = value === '*';
    else if (key === 'disallow' && star && value === '/') blocksAll = true;
  }
  return { sitemaps, blocksAll };
}

// Mojibake: UTF-8 bytes that were decoded as latin-1 somewhere upstream. The
// giveaway is the Â/â/Ã prefixes, which almost never appear in real English copy.
export function findMojibake(html) {
  // Code samples are skipped — a page documenting mojibake will contain it on purpose.
  const prose = html
    .replace(/<(code|pre|script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  const hits = [...prose.matchAll(/[ÂÃâ][-¿ -›]/g)].map(m => m[0]);
  return [...new Set(hits)];
}

// Absent or unparseable Content-Type is treated as HTML — plenty of hand-rolled servers omit
// it, and refusing to check those pages would be a worse failure than checking a stray file.
export function isHtml(contentType) {
  const t = (contentType || '').split(';')[0].trim().toLowerCase();
  return !t || t === 'text/html' || t === 'application/xhtml+xml';
}

// HTML5 allows unquoted attribute values and real sites ship them: ghost.org serves
// `<link rel="canonical" href=https://ghost.org/about/>`, so a quotes-only regex reported
// "no rel=canonical" on six pages that all had one. Telling a paying customer to add a tag
// they already have is the same class of failure as inventing a 404.
// `name` is always a literal here; it is interpolated into the pattern unescaped.
// Quoted forms are tried first: a quoted value may contain the text `href=`, and preferring
// the quoted match means `<a title="see href=/evil" href="/real">` resolves to /real.
export function attrValue(tag, name) {
  const q = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  if (q) return q[1] !== undefined ? q[1] : q[2];
  const u = tag.match(new RegExp(`\\s${name}\\s*=\\s*([^\\s"'\`=<>]+)`, 'i'));
  return u ? u[1] : undefined;
}

// A `>` inside a quoted value does NOT close the tag: `content="Compare A > B"` truncated a
// plain `[^>]*>` matcher mid-attribute, which reported a missing description on a page that
// had one. Skip over quoted spans instead.
const openTag = name => new RegExp(`<${name}(?=[\\s>])(?:"[^"]*"|'[^']*'|[^>])*>`, 'gi');

// Returns the opening tags of `name` whose `attr` contains `value` as a token — `rel` is a
// space-separated list, so `rel="canonical alternate"` is still a canonical.
function tagsWhere(html, name, attr, value) {
  return [...html.matchAll(openTag(name))]
    .map(m => m[0])
    .filter(t => (attrValue(t, attr) || '').trim().toLowerCase().split(/\s+/).includes(value));
}

export function checkHtml(html, url) {
  const problems = [];
  const pick = re => (html.match(re) || [])[1];
  const meta = n => attrValue(tagsWhere(html, 'meta', 'name', n)[0] || '', 'content');

  const title = pick(/<title[^>]*>([^<]*)<\/title>/i);
  if (!title || !title.trim()) problems.push('no <title>');

  const robots = meta('robots') || '';
  if (/noindex/i.test(robots)) problems.push(`meta robots says noindex ("${robots}")`);

  const canonical = attrValue(tagsWhere(html, 'link', 'rel', 'canonical')[0] || '', 'href');
  if (!canonical) problems.push('no rel=canonical');
  else if (normalise(canonical) !== normalise(url)) problems.push(`canonical points elsewhere (${canonical})`);

  const desc = meta('description');
  if (!desc || !desc.trim()) problems.push('no meta description');

  const mojibake = findMojibake(html);
  if (mojibake.length) problems.push(`mojibake: ${mojibake.slice(0, 4).join(' ')}`);

  return { title, problems };
}

function normalise(u) {
  try {
    const p = new URL(u);
    return (p.origin + p.pathname).replace(/\/+$/, '') || p.origin;
  } catch { return u; }
}

// The whitespace before `href` is load-bearing: Vue/Alpine/Angular write the DYNAMIC link as
// `:href`, `v-bind:href`, `x-bind:href` or `[href]`, and a bare `href=` match happily lands
// inside those. Allbirds (Shopify + Vue) served three "broken links" that were really the
// unevaluated bindings `(cardRefs['…']?.selectedUrl) || '/x'` and `` `/products/${item.handle}` ``.
// Fabricated 404s in a paid report are worse than a missed link, so require a real attribute
// boundary and drop anything still carrying template syntax.
const TEMPLATE_SYNTAX = /\$\{|\{\{|`|<%/;

export function internalLinks(html, base) {
  // `<a` needs the lookahead too, or <article ...href=...> and <audio> are harvested as links.
  // attrValue's leading `\s` keeps the binding guard: `:href`/`[href]`/`v-bind:href` never match.
  const hrefs = [...html.matchAll(openTag('a'))].map(m => attrValue(m[0], 'href'));
  const out = new Set();
  for (const raw of hrefs) {
    const h = (raw || '').split('#')[0];
    if (!h) continue;
    if (TEMPLATE_SYNTAX.test(h)) continue;
    let abs;
    try { abs = new URL(h, base); } catch { continue; }
    if (abs.origin !== new URL(base).origin) continue;
    if (/\.(png|jpe?g|gif|svg|webp|ico|css|js|pdf|xml|txt)$/i.test(abs.pathname)) continue;
    // Cloudflare's email obfuscation emits <a href="/cdn-cgi/l/email-protection#hex">, which
    // only resolves in the browser and 404s to a plain GET. It is Cloudflare's endpoint, not
    // a page of the site, and the owner cannot fix it.
    if (abs.pathname.startsWith('/cdn-cgi/')) continue;
    out.add(abs.origin + abs.pathname);
  }
  return [...out];
}

// A site with no usable sitemap still needs its pages checked — the homepage plus
// whatever it links to is a far better report than "you have no sitemap" and nothing.
export function seedFromHome(html, origin) {
  const home = origin + '/';
  return [...new Set([home, ...internalLinks(html, home)])];
}

// A <sitemapindex> is allowed to list further indexes, and Jetpack — which ships on a large
// share of WordPress sites — always does: /sitemap.xml → /sitemap-index-1.xml → the urlsets.
// Stopping after one level means checking XML files as if they were pages.
// fetchXml returns the body, or null if it already reported the failure.
export async function expandSitemapIndex(xml, fetchXml, note) {
  const seen = new Set();
  const pages = [];
  let frontier = parseSitemap(xml);
  let depth = 0;
  for (; depth < INDEX_DEPTH_CAP && frontier.length; depth++) {
    const batch = frontier.filter(u => !seen.has(u));
    batch.forEach(u => seen.add(u));
    if (batch.length > CHILD_SITEMAP_CAP)
      note(`sitemap index lists ${batch.length} sitemaps, reading the first ${CHILD_SITEMAP_CAP}`);
    const next = [];
    for (const body of await mapLimit(batch.slice(0, CHILD_SITEMAP_CAP), 6, fetchXml)) {
      if (body == null) continue;
      (isSitemapIndex(body) ? next : pages).push(...parseSitemap(body));
    }
    frontier = next;
  }
  if (frontier.length) note(`sitemap index nests deeper than ${INDEX_DEPTH_CAP} levels — stopping there`);
  return { urls: [...new Set(pages)], sitemaps: seen.size };
}

// ---------- network ----------

// fetch()'s res.text() decodes as UTF-8 no matter what the page declares, so a site
// served as ISO-8859-1 or Shift_JIS comes back as U+FFFD soup and every text check —
// title, description, mojibake — then runs on garbage. Honour the declared charset.
export function decodeBody(buf, contentType) {
  const bytes = new Uint8Array(buf);
  // A BOM outranks both the header and <meta> (HTML spec), and it is the only thing
  // that saves us on UTF-16, where the ASCII-ish meta sniff below is blind.
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);

  const header = /charset=["']?([\w-]+)/i.exec(contentType || '');
  // No charset on the header: sniff <meta charset> from the first 1KB, which is ASCII
  // in every encoding that survives the BOM check above.
  const meta = header ? null : /<meta[^>]+charset=["']?([\w-]+)/i.exec(
    new TextDecoder('iso-8859-1').decode(bytes.subarray(0, 1024)));
  const label = ((header || meta)?.[1] || 'utf-8').toLowerCase();
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes); // unknown label — best effort
  }
}

async function get(url, method = 'GET') {
  try {
    const res = await fetch(url, { method, headers: { 'user-agent': UA }, redirect: 'follow' });
    const body = method === 'GET'
      ? decodeBody(await res.arrayBuffer(), res.headers.get('content-type'))
      : '';
    return { status: res.status, body, url: res.url, type: res.headers.get('content-type') || '' };
  } catch (err) {
    return { status: 0, body: '', url, type: '', error: err.message };
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const n = i++;
      out[n] = await fn(items[n], n);
    }
  }));
  return out;
}

// ---------- commands ----------

async function check(base, { limit, json }) {
  const origin = new URL(base).origin;
  const report = { site: origin, pages: [], issues: [], checkedAt: new Date().toISOString() };
  const fail = msg => report.issues.push(msg);

  const robotsRes = await get(origin + '/robots.txt');
  let sitemapUrls = [];
  if (robotsRes.status !== 200) {
    fail(`robots.txt returned ${robotsRes.status || robotsRes.error}`);
  } else {
    const { sitemaps, blocksAll } = parseRobots(robotsRes.body);
    if (blocksAll) fail('robots.txt disallows / for all crawlers — nothing will be indexed');
    if (!sitemaps.length) fail('robots.txt declares no Sitemap:');
    sitemapUrls = sitemaps;
  }

  const sitemapUrl = sitemapUrls[0] || origin + '/sitemap.xml';
  const smRes = await get(sitemapUrl);
  let urls = [];
  if (smRes.status !== 200) {
    fail(`sitemap ${sitemapUrl} returned ${smRes.status || smRes.error}`);
  } else {
    urls = parseSitemap(smRes.body);
    if (isSitemapIndex(smRes.body)) {
      const expanded = await expandSitemapIndex(smRes.body, async u => {
        const r = await get(u);
        if (r.status !== 200) { fail(`sitemap ${u} returned ${r.status || r.error}`); return null; }
        return r.body;
      }, m => console.log('  note: ' + m));
      urls = expanded.urls;
      report.sitemap_index = { url: sitemapUrl, sitemaps: expanded.sitemaps };
    }
    if (!urls.length) fail(`sitemap ${sitemapUrl} lists no <loc> entries`);
    const foreign = urls.filter(u => { try { return new URL(u).origin !== origin; } catch { return true; } });
    if (foreign.length) fail(`sitemap lists ${foreign.length} URL(s) off-origin, e.g. ${foreign[0]}`);
  }
  report.sitemap = { url: sitemapUrl, count: urls.length };
  // Everything failed so far is site-level (robots/sitemap); later fails are per-page and
  // get printed alongside their page. Snapshot so the text report can show these too.
  const siteIssues = report.issues.slice();

  // Missing/empty sitemap meant zero pages checked, so the subscriber got a report about
  // their sitemap and nothing about their site. Crawl from the homepage instead.
  if (!urls.length) {
    const home = await get(origin + '/');
    if (home.status !== 200) fail(`${origin}/ → ${home.status || home.error}`);
    else {
      urls = seedFromHome(home.body, origin);
      report.crawledFromHome = true;
    }
  }

  const targets = urls.slice(0, limit);
  const linkTargets = new Set();
  report.pages = await mapLimit(targets, 6, async url => {
    const res = await get(url);
    if (res.status !== 200) {
      fail(`${url} → ${res.status || res.error}`);
      return { url, status: res.status, problems: ['not reachable'] };
    }
    // allbirds.com's sitemap lists /agents.md (text/markdown). Running the HTML checks on it
    // produced three findings that a customer can do nothing useful with; the actionable
    // fact is that a non-page is in the sitemap at all.
    if (!isHtml(res.type)) {
      const p = `not an HTML page (${res.type.split(';')[0] || 'unknown type'}) — remove it from the sitemap`;
      fail(`${url} — ${p}`);
      return { url, status: res.status, problems: [p] };
    }
    const { title, problems } = checkHtml(res.body, url);
    for (const l of internalLinks(res.body, url)) linkTargets.add(l);
    for (const p of problems) fail(`${url} — ${p}`);
    return { url, status: res.status, title, problems };
  });

  // Internal links that the sitemap never mentions are the usual source of dead ends.
  const known = new Set(urls.map(normalise));
  const unlisted = [...linkTargets].filter(l => !known.has(normalise(l)));
  const broken = (await mapLimit(unlisted.slice(0, limit), 6, async l => {
    const res = await get(l, 'HEAD');
    return res.status >= 400 || res.status === 0 ? { url: l, status: res.status } : null;
  })).filter(Boolean);
  for (const b of broken) fail(`internal link ${b.url} → ${b.status || 'unreachable'}`);
  report.brokenLinks = broken;

  console.log(json ? JSON.stringify(report, null, 2)
                   : renderText(report, siteIssues, unlisted.length));
  return report.issues.length ? 1 : 0;
}

// This text IS what a paying subscriber receives by email, so every issue counted in the
// summary line must also be spelled out above it.
function renderText(report, siteIssues, unlistedCount) {
  const out = [
    ``,
    `  ${report.site}`,
    report.crawledFromHome
      ? `  no usable sitemap — crawled from the homepage instead`
      : `  sitemap: ${report.sitemap.count} URLs (${report.sitemap.url})`,
    `  checked: ${report.pages.length} pages, ${unlistedCount} extra internal links`,
    ``,
  ];
  for (const m of siteIssues) out.push(`  ✗ ${m}`);
  for (const p of report.pages) {
    const mark = p.problems.length ? '✗' : '✓';
    out.push(`  ${mark} ${p.url}${p.problems.length ? '\n      ' + p.problems.join('\n      ') : ''}`);
  }
  for (const b of report.brokenLinks) out.push(`  ✗ broken link ${b.url} → ${b.status || 'unreachable'}`);
  out.push(report.issues.length ? `\n  ${report.issues.length} issue(s) found.\n` : `\n  All clear.\n`);
  return out.join('\n');
}

async function submit(urls, key) {
  if (!key) throw new Error('--key <indexnow-key> is required (host it at https://<host>/<key>.txt)');
  const host = new URL(urls[0]).host;
  const keyRes = await get(`https://${host}/${key}.txt`);
  if (keyRes.status !== 200 || keyRes.body.trim() !== key) {
    throw new Error(`key file https://${host}/${key}.txt must return 200 with the key as its body (got ${keyRes.status})`);
  }
  const res = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ host, key, keyLocation: `https://${host}/${key}.txt`, urlList: urls }),
  });
  console.log(`  IndexNow HTTP ${res.status} for ${urls.length} URL(s) on ${host}`);
  return res.ok ? 0 : 1;
}

// ---------- selftest ----------

async function selftest() {
  const assert = (cond, msg) => { if (!cond) throw new Error('selftest: ' + msg); };

  assert(parseSitemap('<url><loc>https://a.com/x</loc></url><url><loc> https://a.com/y </loc></url>')
    .join(',') === 'https://a.com/x,https://a.com/y', 'parseSitemap');

  assert(isSitemapIndex('<?xml version="1.0"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
    + '<sitemap><loc>https://a.com/sitemap-0.xml</loc></sitemap></sitemapindex>'), 'isSitemapIndex detects an index');
  assert(!isSitemapIndex('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://a.com/x</loc></url></urlset>'),
    'isSitemapIndex does not flag a plain urlset');

  const r = parseRobots('User-agent: *\nDisallow: /\nSitemap: https://a.com/sitemap.xml # note');
  assert(r.blocksAll && r.sitemaps[0] === 'https://a.com/sitemap.xml', 'parseRobots blocking');
  assert(!parseRobots('User-agent: *\nAllow: /\nDisallow: /admin/').blocksAll, 'parseRobots allowing');
  assert(!parseRobots('User-agent: badbot\nDisallow: /').blocksAll, 'parseRobots per-agent block is not site-wide');

  // Jetpack's real shape: index → index → urlset. One level of following returns XML files.
  const index = locs => `<sitemapindex>${locs.map(l => `<loc>${l}</loc>`).join('')}</sitemapindex>`;
  const urlset = locs => `<urlset>${locs.map(l => `<loc>${l}</loc>`).join('')}</urlset>`;
  const tree = {
    'https://a.com/sitemap-index-1.xml': index(['https://a.com/sitemap-1.xml', 'https://a.com/sitemap-2.xml']),
    'https://a.com/sitemap-1.xml': urlset(['https://a.com/p1', 'https://a.com/p2']),
    'https://a.com/sitemap-2.xml': urlset(['https://a.com/p2', 'https://a.com/p3']),
  };
  const fetchXml = async u => tree[u] ?? null;
  const nestedRun = await expandSitemapIndex(index(['https://a.com/sitemap-index-1.xml']), fetchXml, () => {});
  assert(nestedRun.urls.join(',') === 'https://a.com/p1,https://a.com/p2,https://a.com/p3',
    'nested sitemap index resolves to deduped pages, not to the child .xml files');
  assert(nestedRun.sitemaps === 3, 'every sitemap fetched is counted');
  assert(!nestedRun.urls.some(u => u.endsWith('.xml')), 'no sitemap file is ever returned as a page');

  const flat = await expandSitemapIndex(index(['https://a.com/sitemap-1.xml']), fetchXml, () => {});
  assert(flat.urls.join(',') === 'https://a.com/p1,https://a.com/p2', 'single-level index still works');

  // Deeper than the cap: stop and say so rather than recursing forever.
  const notes = [];
  const deep = u => `<sitemapindex><loc>${u}-x</loc></sitemapindex>`;
  const endless = await expandSitemapIndex(deep('https://a.com/s'), async u => deep(u), m => notes.push(m));
  assert(endless.urls.length === 0 && notes.some(n => n.includes('nests deeper')), 'depth cap stops and reports');
  assert(endless.sitemaps === INDEX_DEPTH_CAP, 'depth cap stops after exactly the capped number of levels');

  assert(findMojibake('cafÃ© naÃ¯ve').length > 0, 'mojibake detected');
  assert(findMojibake('café naïve — clean copy').length === 0, 'clean text is not mojibake');
  assert(findMojibake('<code>cafÃ©</code> is what mojibake looks like').length === 0, 'code samples exempt from mojibake');

  // Charset handling: a legacy-encoded page must survive the round trip, or every text
  // check below runs on U+FFFD instead of the real copy.
  const latin1 = Uint8Array.from([0x63, 0x61, 0x66, 0xe9]); // "café" as ISO-8859-1
  assert(decodeBody(latin1, 'text/html; charset=iso-8859-1') === 'café', 'header charset honoured');
  assert(decodeBody(latin1, 'text/html') !== 'café', 'undeclared latin-1 is not silently repaired');
  const metaTagged = new TextEncoder().encode('<meta charset="utf-8"><p>café</p>');
  assert(decodeBody(metaTagged, 'text/html').includes('café'), 'meta charset used when the header has none');
  assert(decodeBody(new TextEncoder().encode('café'), 'text/html; charset=bogus-9') === 'café',
    'unknown charset label falls back to utf-8');
  assert(findMojibake(decodeBody(latin1, 'text/html; charset=iso-8859-1')).length === 0,
    'correctly-served latin-1 is not reported as mojibake');
  // A UTF-8 BOM on a page whose header lies about the charset (common on legacy CMS
  // exports) must win, or the whole body decodes to mojibake.
  const bom = Uint8Array.from([0xef, 0xbb, 0xbf, 0x63, 0x61, 0x66, 0xc3, 0xa9]);
  assert(decodeBody(bom, 'text/html; charset=iso-8859-1').endsWith('café'), 'BOM outranks a lying header');
  const utf16 = Uint8Array.from([0xff, 0xfe, 0x63, 0x00, 0x61, 0x00, 0x66, 0x00, 0xe9, 0x00]);
  assert(decodeBody(utf16, 'text/html').endsWith('café'), 'UTF-16LE BOM decoded (meta sniff is blind to it)');

  const good = `<title>T</title><meta name="description" content="d">
    <link rel="canonical" href="https://a.com/p/"><meta name="robots" content="index,follow">`;
  assert(checkHtml(good, 'https://a.com/p/').problems.length === 0, 'clean page passes');
  assert(checkHtml(good, 'https://a.com/other/').problems.some(p => p.includes('canonical')), 'canonical mismatch caught');
  assert(checkHtml('<title>T</title>', 'https://a.com/p/').problems.length === 2, 'missing canonical + description counted');
  assert(checkHtml(good.replace('index,follow', 'noindex'), 'https://a.com/p/')
    .problems.some(p => p.includes('noindex')), 'noindex caught');

  // Unquoted attribute values are legal HTML5 and ghost.org ships them.
  const bare = `<title>T</title><meta name=description content=d>
    <link rel=canonical href=https://a.com/p/><meta name=robots content=noindex>`;
  assert(checkHtml(bare, 'https://a.com/p/').problems.length === 1, 'unquoted attributes are read, not reported missing');
  assert(checkHtml(bare, 'https://a.com/p/').problems.some(p => p.includes('noindex')), 'unquoted noindex caught');
  assert(attrValue('<link rel="canonical" href=https://a.com/x>', 'href') === 'https://a.com/x', 'unquoted href');
  assert(attrValue("<a href='/q'>", 'href') === '/q', 'single-quoted href');
  assert(attrValue('<a data-href="/no">', 'href') === undefined, 'a prefixed attribute is not href');
  // A `>` inside a quoted value must not end the tag, or a page with one loses the attribute.
  assert(checkHtml(`<title>T</title><meta name="description" content="Compare A > B today">
    <link rel="canonical" href="https://a.com/p/">`, 'https://a.com/p/').problems.length === 0,
    'a > inside a quoted attribute value does not truncate the tag');
  assert(internalLinks('<a title="A > B" href="/a">1</a>', 'https://a.com/')[0] === 'https://a.com/a',
    'a > inside a quoted value does not hide the href');
  // rel is a space-separated token list.
  assert(checkHtml(`<title>T</title><meta name="description" content="d">
    <link rel="alternate canonical" href="https://a.com/p/">`, 'https://a.com/p/').problems.length === 0,
    'rel with several tokens still counts as canonical');
  assert(attrValue('<a title="see href=/evil" href="/real">', 'href') === '/real',
    'a quoted href wins over the text of another attribute');
  // The canonical must come from a rel=canonical link, not the first <link> on the page.
  assert(checkHtml(`<title>T</title><meta name="description" content="d">
    <link rel="stylesheet" href="/s.css"><link rel="canonical" href="https://a.com/p/">`,
    'https://a.com/p/').problems.length === 0, 'canonical found past an earlier <link>');

  const links = internalLinks('<a href="/a">1</a><a href="https://x.com/b">2</a><a href="/c.css">3</a><a href="#top">4</a>', 'https://a.com/p/');
  assert(links.length === 1 && links[0] === 'https://a.com/a', 'internalLinks filters off-origin, assets, fragments');
  // A fragment used to void the whole href, so /pricing#plans was never checked at all.
  assert(internalLinks('<a href="/pricing#plans">p</a>', 'https://a.com/')[0] === 'https://a.com/pricing',
    'a fragment is stripped, not treated as an unlinkable href');
  assert(internalLinks('<a href="/cdn-cgi/l/email-protection#a1b2">e</a>', 'https://a.com/').length === 0,
    "Cloudflare's email-protection stub is not a page of the site");
  assert(internalLinks('<a href=/bare>b</a>', 'https://a.com/')[0] === 'https://a.com/bare', 'unquoted href harvested');

  // Framework binding attributes are not links — matching inside them invents 404s.
  const vue = internalLinks(
    `<a :href="(cardRefs['1']?.selectedUrl) || '/products/x'">a</a>` +
    "<a :href='`/products/${item.handle}`'>b</a>" +
    '<a v-bind:href="u">c</a><a x-bind:href="u">d</a><a [href]="u">e</a>' +
    '<a href="/real">f</a>', 'https://a.com/');
  assert(vue.length === 1 && vue[0] === 'https://a.com/real', 'dynamic :href/v-bind/x-bind/[href] bindings are not treated as links');
  // A server-side template that leaked into the served HTML is also not a URL.
  assert(internalLinks('<a href="/p/{{ slug }}">x</a><a href="/p/<%= id %>">y</a>', 'https://a.com/').length === 0,
    'unrendered template placeholders in a real href are skipped');
  assert(internalLinks('<a\nhref="/a">x</a>', 'https://a.com/').length === 1, 'newline before href still matches');

  assert(internalLinks('<article data-x="1" href="/nope">x</article><a href="/yes">y</a>', 'https://a.com/')
    .join(',') === 'https://a.com/yes', 'only <a> is harvested, not <article>/<audio>');

  assert(isHtml('text/html; charset=utf-8') && isHtml('') && isHtml(null), 'html and unknown types are checked');
  assert(!isHtml('text/markdown; charset=utf-8') && !isHtml('application/pdf'), 'non-HTML sitemap entries are not run through the HTML checks');

  const seeded = seedFromHome('<a href="/">home</a><a href="/a">1</a><a href="https://x.com/b">2</a>', 'https://a.com');
  assert(seeded.join(',') === 'https://a.com/,https://a.com/a', 'seedFromHome leads with home, dedupes it, drops off-origin');

  const crawlText = renderText({
    site: 'https://a.com', sitemap: { url: 'https://a.com/sitemap.xml', count: 0 }, crawledFromHome: true,
    pages: [{ url: 'https://a.com/', problems: [] }], brokenLinks: [], issues: ['sitemap https://a.com/sitemap.xml returned 404'],
  }, ['sitemap https://a.com/sitemap.xml returned 404'], 0);
  assert(crawlText.includes('crawled from the homepage'), 'fallback crawl is disclosed in the report');
  assert(crawlText.includes('https://a.com/'), 'fallback crawl still lists the pages it checked');

  // A site with no sitemap has only site-level issues and zero pages; the emailed report
  // must name them, not just count them.
  const siteOnly = {
    site: 'https://a.com', sitemap: { url: 'https://a.com/sitemap.xml', count: 0 },
    pages: [], brokenLinks: [],
    issues: ['robots.txt returned 404', 'sitemap https://a.com/sitemap.xml returned 404'],
  };
  const text = renderText(siteOnly, siteOnly.issues, 0);
  assert(siteOnly.issues.every(m => text.includes(m)), 'site-level issues are printed, not just counted');
  assert(text.includes('2 issue(s) found'), 'issue count still summarised');

  console.log('selftest: all checks passed');
  return 0;
}

// ---------- cli ----------

const HELP = `sitepreflight — pre-flight checks for a static site, then tell the search engines.

  sitepreflight check <url> [--limit N] [--json]
  sitepreflight submit <url> [url...] --key <indexnow-key>
  sitepreflight --selftest

check   robots.txt, sitemap, then every page: status, <title>, meta description,
        rel=canonical, noindex, mojibake, and internal links that 404.
        Exits 1 if anything fails, so it gates a deploy in CI.
submit  pings IndexNow (Bing, Yandex, Seznam, Naver) after verifying your key file.
        Google does not participate in IndexNow.
`;

// npx installs the bin as a symlink, so compare the resolved path — not argv[1] verbatim.
const invokedDirectly = await (async () => {
  if (!process.argv[1]) return false;
  const { realpath } = await import('node:fs/promises');
  const { pathToFileURL } = await import('node:url');
  try { return import.meta.url === pathToFileURL(await realpath(process.argv[1])).href; }
  catch { return false; }
})();

if (invokedDirectly) {
  // Node caps response headers at 16KB and a bigger set is a HARD fetch failure
  // ("Headers Overflow Error"), which we reported as "unreachable". webflow.com sends ~20KB
  // of Set-Cookie, so every one of its URLs looked broken — five invented broken links on
  // the first real Webflow site we tried. The cap is process-wide and settable only by flag.
  const http = await import('node:http');
  if (process.argv[2] === 'check' && http.default.maxHeaderSize < 65536 && !process.env.SITEPREFLIGHT_HEADER_CAP) {
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const r = spawnSync(process.execPath,
      ['--max-http-header-size=65536', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
      { stdio: 'inherit', env: { ...process.env, SITEPREFLIGHT_HEADER_CAP: '1' } });
    process.exit(r.status ?? 1);
  }

  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = args.indexOf(name);
    return i === -1 ? fallback : args[i + 1];
  };
  const cmd = args[0];
  try {
    let code;
    if (args.includes('--selftest')) code = await selftest();
    else if (cmd === 'check') code = await check(args[1], { limit: Number(flag('--limit', 50)), json: args.includes('--json') });
    else if (cmd === 'submit') code = await submit(args.slice(1).filter(a => a.startsWith('http')), flag('--key'));
    else { console.log(HELP); code = args.length ? 1 : 0; }
    process.exit(code);
  } catch (err) {
    console.error('  error: ' + err.message);
    process.exit(1);
  }
}
