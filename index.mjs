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

export function checkHtml(html, url) {
  const problems = [];
  const pick = re => (html.match(re) || [])[1];

  const title = pick(/<title[^>]*>([^<]*)<\/title>/i);
  if (!title || !title.trim()) problems.push('no <title>');

  const robots = pick(/<meta[^>]+name=["']robots["'][^>]*content=["']([^"']+)["']/i) || '';
  if (/noindex/i.test(robots)) problems.push(`meta robots says noindex ("${robots}")`);

  const canonical = pick(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
  if (!canonical) problems.push('no rel=canonical');
  else if (normalise(canonical) !== normalise(url)) problems.push(`canonical points elsewhere (${canonical})`);

  const desc = pick(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i);
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

export function internalLinks(html, base) {
  const hrefs = [...html.matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi)].map(m => m[1]);
  const out = new Set();
  for (const h of hrefs) {
    let abs;
    try { abs = new URL(h, base); } catch { continue; }
    if (abs.origin !== new URL(base).origin) continue;
    if (/\.(png|jpe?g|gif|svg|webp|ico|css|js|pdf|xml|txt)$/i.test(abs.pathname)) continue;
    out.add(abs.origin + abs.pathname);
  }
  return [...out];
}

// ---------- network ----------

async function get(url, method = 'GET') {
  try {
    const res = await fetch(url, { method, headers: { 'user-agent': UA }, redirect: 'follow' });
    const body = method === 'GET' ? await res.text() : '';
    return { status: res.status, body, url: res.url };
  } catch (err) {
    return { status: 0, body: '', url, error: err.message };
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
      // ponytail: one level of nesting only — an index of indexes is legal but vanishingly rare.
      const children = urls.slice(0, CHILD_SITEMAP_CAP);
      if (urls.length > children.length)
        console.log(`  note: sitemap index lists ${urls.length} sitemaps, reading the first ${children.length}`);
      const nested = await mapLimit(children, 6, async u => {
        const r = await get(u);
        if (r.status !== 200) { fail(`sitemap ${u} returned ${r.status || r.error}`); return []; }
        return parseSitemap(r.body);
      });
      urls = [...new Set(nested.flat())];
      report.sitemap_index = { url: sitemapUrl, sitemaps: children.length };
    }
    if (!urls.length) fail(`sitemap ${sitemapUrl} lists no <loc> entries`);
    const foreign = urls.filter(u => { try { return new URL(u).origin !== origin; } catch { return true; } });
    if (foreign.length) fail(`sitemap lists ${foreign.length} URL(s) off-origin, e.g. ${foreign[0]}`);
  }
  report.sitemap = { url: sitemapUrl, count: urls.length };
  // Everything failed so far is site-level (robots/sitemap); later fails are per-page and
  // get printed alongside their page. Snapshot so the text report can show these too.
  const siteIssues = report.issues.slice();

  const targets = urls.slice(0, limit);
  const linkTargets = new Set();
  report.pages = await mapLimit(targets, 6, async url => {
    const res = await get(url);
    if (res.status !== 200) {
      fail(`${url} → ${res.status || res.error}`);
      return { url, status: res.status, problems: ['not reachable'] };
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
    `  sitemap: ${report.sitemap.count} URLs (${report.sitemap.url})`,
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

function selftest() {
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

  assert(findMojibake('cafÃ© naÃ¯ve').length > 0, 'mojibake detected');
  assert(findMojibake('café naïve — clean copy').length === 0, 'clean text is not mojibake');
  assert(findMojibake('<code>cafÃ©</code> is what mojibake looks like').length === 0, 'code samples exempt from mojibake');

  const good = `<title>T</title><meta name="description" content="d">
    <link rel="canonical" href="https://a.com/p/"><meta name="robots" content="index,follow">`;
  assert(checkHtml(good, 'https://a.com/p/').problems.length === 0, 'clean page passes');
  assert(checkHtml(good, 'https://a.com/other/').problems.some(p => p.includes('canonical')), 'canonical mismatch caught');
  assert(checkHtml('<title>T</title>', 'https://a.com/p/').problems.length === 2, 'missing canonical + description counted');
  assert(checkHtml(good.replace('index,follow', 'noindex'), 'https://a.com/p/')
    .problems.some(p => p.includes('noindex')), 'noindex caught');

  const links = internalLinks('<a href="/a">1</a><a href="https://x.com/b">2</a><a href="/c.css">3</a><a href="#top">4</a>', 'https://a.com/p/');
  assert(links.length === 1 && links[0] === 'https://a.com/a', 'internalLinks filters off-origin, assets, fragments');

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
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = args.indexOf(name);
    return i === -1 ? fallback : args[i + 1];
  };
  const cmd = args[0];
  try {
    let code;
    if (args.includes('--selftest')) code = selftest();
    else if (cmd === 'check') code = await check(args[1], { limit: Number(flag('--limit', 50)), json: args.includes('--json') });
    else if (cmd === 'submit') code = await submit(args.slice(1).filter(a => a.startsWith('http')), flag('--key'));
    else { console.log(HELP); code = args.length ? 1 : 0; }
    process.exit(code);
  } catch (err) {
    console.error('  error: ' + err.message);
    process.exit(1);
  }
}
