#!/usr/bin/env node
// sitepreflight — pre-flight checks for a static site, then tell the search engines.
// Zero dependencies. Node 18+.
//
//   sitepreflight check https://example.com [--limit N] [--json]
//   sitepreflight submit https://example.com/page/ ... --key <indexnow-key>
//
// Exit code is 1 when any check fails, so it works as a CI gate.

import { gunzipSync, gzipSync } from 'node:zlib';
import net from 'node:net';

// Happy Eyeballs gives each address family only 250ms by default. On a machine with no
// IPv6 route (most CI runners), a host whose IPv4 handshake takes longer than that —
// anything geographically distant — has its working v4 attempt cancelled, the v6 attempt
// fails ENETUNREACH, and `fetch` reports ETIMEDOUT for a site that is perfectly healthy.
// typo3.org did exactly this: curl 200, our robots.txt + sitemap + homepage all "timed out"
// in 300ms, three fabricated failures and a red CI build on a live site. 2s is still far
// below any real request timeout, so a genuinely dead address is not slowed down much.
// Guarded: the API landed in Node 18.18, and package.json allows >=18.
if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout === 'function') {
  net.setDefaultAutoSelectFamilyAttemptTimeout(2000);
}

const UA = 'sitepreflight/0.1 (+https://github.com/iamphera/sitepreflight)';
const ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const CHILD_SITEMAP_CAP = 50;
const INDEX_DEPTH_CAP = 3;

// ---------- pure helpers (covered by --selftest) ----------

// A <loc> holds XML, not a URL: a query string is REQUIRED to arrive as
// "?type=pages&amp;page=1". Requesting that literally is a different URL, and
// BigCommerce's sitemap index (saddlebackleather.com) 404s on every one of them —
// five fabricated dead sitemaps from a file that is perfectly valid.
// One pass, so "&amp;lt;" decodes to "&lt;" and not to "<".
export function decodeXmlEntities(s) {
  return s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));/gi, (m, dec, hex, name) => {
    // fromCodePoint throws RangeError above 0x10FFFF, and the input is a stranger's markup:
    // one "&#99999999;" in one <loc> would abort the entire check with a stack trace.
    if (dec || hex) {
      const n = dec ? Number(dec) : parseInt(hex, 16);
      return n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name.toLowerCase()];
  });
}

export function parseSitemap(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m => decodeXmlEntities(m[1]));
}

// A <sitemapindex> lists other sitemaps, not pages. Astro, Next.js and Yoast all emit one
// by default, so treating its <loc>s as pages means checking XML files for a <title>.
export function isSitemapIndex(xml) {
  return /<sitemapindex[\s>]/i.test(xml);
}

// Adopt a redirected origin only for the www/apex and http→https cases — those are the same
// site under another name. A robots.txt redirected to an unrelated host is NOT the site
// moving house, and a failed fetch (url echoed back) must not move the goalposts either.
const bareHost = h => h.replace(/^www\./i, '');
export function canonicalOrigin(requested, finalUrl) {
  try {
    const f = new URL(finalUrl), r = new URL(requested);
    if (f.pathname !== '/robots.txt') return requested;
    if (bareHost(f.hostname) !== bareHost(r.hostname) || f.port !== r.port) return requested;
    // An https→http DOWNGRADE would re-create the very bug this exists to fix: every https
    // URL in the sitemap would then read as off-origin. Upgrade or same scheme only.
    return f.protocol === r.protocol || (r.protocol === 'http:' && f.protocol === 'https:')
      ? f.origin : requested;
  } catch { return requested; }
}

// robots.txt may declare many sitemaps, and the first one is not necessarily this site's.
// typo3.org lists four typo3.com sitemaps, then typo3.community, and only then its own —
// taking [0] produced a whole report about typo3.com, plus "290 URLs off-origin" as the
// headline finding on a site whose own sitemap is fine. Prefer the site's own origin
// (www/apex counts as the same site, as it does everywhere else here); fall back to the
// first declared one only when nothing on-origin was offered.
// EXACT origin first, and only then a www/apex sibling: the off-origin check downstream
// compares URL.origin strictly, so preferring www's sitemap on an apex site would report
// every URL inside it as off-origin — re-creating the false positive this exists to kill.
// docs.readthedocs.io keeps serving its own robots.txt (200, no redirect) while the docs
// themselves have moved to docs.readthedocs.com — so canonicalOrigin above sees nothing and
// every URL in the sitemap reads as off-origin on a site that is merely mid-migration.
// The discriminator is the ROOT redirect, not the hostname: typo3.org listing typo3.com
// sitemaps is a genuine mistake and its root does not move. Only claim a move when EVERY
// listed URL sits on one single other origin; the caller then has to confirm it by redirect.
export function movedOrigin(urls, origin) {
  if (!urls.length) return null;
  const origins = new Set();
  for (const u of urls) {
    try { origins.add(new URL(u).origin); } catch { return null; }
  }
  if (origins.size !== 1) return null;
  const [only] = origins;
  return only === origin ? null : only;
}

export function pickSitemap(sitemaps, origin) {
  const home = (() => { try { return new URL(origin); } catch { return null; } })();
  if (!home) return sitemaps[0] || null;
  const parsed = sitemaps.map(s => {
    try { return { s, u: new URL(s) }; } catch { return null; }
  }).filter(Boolean);
  const exact = parsed.find(p => p.u.origin === home.origin);
  // A site whose robots.txt only offers the OTHER of www/apex: still its own sitemap, and
  // still a better report than a stranger's. The off-origin line then fires honestly —
  // an apex site listing www URLs is a real canonicalisation inconsistency.
  const sibling = parsed.find(p => bareHost(p.u.hostname) === bareHost(home.hostname));
  return (exact || sibling)?.s || sitemaps[0] || null;
}

// `base` is the robots.txt URL. The spec says a Sitemap: line must be absolute, but real
// sites write `Sitemap: /sitemap.xml` (october.com does) — resolving it is the difference
// between reading their sitemap and throwing ERR_INVALID_URL at it.
export function parseRobots(txt, base) {
  const lines = txt.split('\n').map(l => l.replace(/#.*/, '').trim()).filter(Boolean);
  const sitemaps = [];
  let star = false, blocksAll = false;
  for (const line of lines) {
    const [rawKey, ...rest] = line.split(':');
    const key = rawKey.toLowerCase().trim();
    const value = rest.join(':').trim();
    if (key === 'sitemap' && value) {
      let resolved = value;
      if (base) try { resolved = new URL(value, base).href; } catch { /* keep it raw; pickSitemap already tolerates junk */ }
      sitemaps.push(resolved);
    }
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

// Search engines index these file types, so listing them in a sitemap is correct and telling
// the owner to remove them is bad advice — dfg.de has 2,658 PDFs in its sitemap on purpose.
// They have no <title>/description/canonical to check, so they pass without HTML findings.
// text/xml and text/markdown are NOT here: those are files that leaked into a page sitemap.
const INDEXABLE_DOCS = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/rtf',
  'text/plain',
  'text/csv',
]);
export const isIndexableDoc = contentType =>
  INDEXABLE_DOCS.has((contentType || '').split(';')[0].trim().toLowerCase());

// A WAF interstitial served with HTTP 200 is not the customer's page. silverstripe.org
// answers every request (Chrome UA included) with a 948-byte Incapsula shim carrying
// `<META NAME="ROBOTS" CONTENT="NOINDEX, NOFOLLOW">` and no title — so we reported "no
// <title>", "noindex", "no rel=canonical" and "no meta description" against a homepage that
// has all four. Same class as inventing a 404: four confidently wrong findings, and the
// noindex one would send an owner hunting for a tag that is not in their template.
// Both conditions are required. A real page can carry the word "challenge-platform" in an
// analytics snippet; a real page is not 2KB long. Length is what keeps this from firing on
// genuine content.
const BOT_WALL = /_Incapsula_Resource|\/cdn-cgi\/challenge-platform|cf-browser-verification|Checking your browser|Just a moment\.\.\.|Attention Required! \| Cloudflare|_pxhc|\/akam\/|DataDome/i;
export const isBotWall = body =>
  typeof body === 'string' && body.length < 2048 && BOT_WALL.test(body);

// HTML5 allows unquoted attribute values and real sites ship them: ghost.org serves
// `<link rel="canonical" href=https://ghost.org/about/>`, so a quotes-only regex reported
// "no rel=canonical" on six pages that all had one. Telling a paying customer to add a tag
// they already have is the same class of failure as inventing a 404.
// `name` is always a literal here; it is interpolated into the pattern unescaped.
// Quoted forms are tried first: a quoted value may contain the text `href=`, and preferring
// the quoted match means `<a title="see href=/evil" href="/real">` resolves to /real.
export function attrValue(tag, name) {
  // Entity-decoded for the same reason as <loc>: an HTML attribute is markup, so a link to
  // /search?a=1&b=2 is REQUIRED to be written href="/search?a=1&amp;b=2". Fetching it
  // literally asks for a different URL and invents a dead link.
  const q = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  if (q) return decodeXmlEntities(q[1] !== undefined ? q[1] : q[2]);
  const u = tag.match(new RegExp(`\\s${name}\\s*=\\s*([^\\s"'\`=<>]+)`, 'i'));
  return u ? decodeXmlEntities(u[1]) : undefined;
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

  // Present-but-empty is a different bug from absent, and saying "no <title>" to an owner
  // whose page HAS `<meta name="description" content="">` sends them looking for a tag they
  // will find, then disbelieving the report. mozilla.org/en-US/products/monitor/ ships
  // exactly that empty description.
  const title = pick(/<title[^>]*>([^<]*)<\/title>/i);
  if (title === undefined) problems.push('no <title>');
  else if (!title.trim()) problems.push('<title> is empty');

  const robots = meta('robots') || '';
  if (/noindex/i.test(robots)) problems.push(`meta robots says noindex ("${robots}")`);

  // The tag is looked up separately from its attribute: `<link rel="canonical">` with no
  // href is a present tag with nothing in it, and calling that "no rel=canonical" sends the
  // owner hunting for a tag they will find.
  const canonTag = tagsWhere(html, 'link', 'rel', 'canonical')[0];
  const canonical = attrValue(canonTag || '', 'href');
  if (!canonTag) problems.push('no rel=canonical');
  else if (!canonical || !canonical.trim()) problems.push('rel=canonical has an empty href');
  else if (normalise(canonical) !== normalise(url)) problems.push(`canonical points elsewhere (${canonical})`);

  const descTag = tagsWhere(html, 'meta', 'name', 'description')[0];
  const desc = attrValue(descTag || '', 'content');
  if (!descTag) problems.push('no meta description');
  else if (!desc || !desc.trim()) problems.push('meta description is empty');

  const mojibake = findMojibake(html);
  if (mojibake.length) problems.push(`mojibake: ${mojibake.slice(0, 4).join(' ')}`);

  return { title, problems };
}

export function hasPath(u) {
  try { return new URL(u).pathname.replace(/\/+$/, '') !== ''; } catch { return false; }
}

function normalise(u) {
  try {
    const p = new URL(u);
    return (p.origin + p.pathname).replace(/\/+$/, '') || p.origin;
  } catch { return u; }
}

// Where the response actually came from, when that is not where we asked. drupal.org is
// mid-migration: every URL 302s to new.drupal.org and self-canonicalises there, which is
// CORRECT — but we compared the canonical against the URL we requested, so we told them
// "canonical points elsewhere" on every single page. A false positive of that shape on
// every page is how an owner decides the whole report is noise.
export function redirectedTo(asked, res) {
  return res.url && normalise(res.url) !== normalise(asked) ? res.url : null;
}

// craftcms.com's sitemap lists /about, which 302s to the homepage. Judging the page where it
// landed found a healthy homepage and passed it — but a sitemap URL that redirects to the site
// root is dead content: Google files it under "Page with redirect" and never indexes it, and
// one such URL is not a collision so collidingLandings never sees it. Only a non-root path
// landing on root counts, so http→https and trailing-slash normalisation never trip this.
export function redirectedToRoot(asked, finalUrl) {
  if (!finalUrl) return null;
  try {
    const f = new URL(finalUrl);
    if (new URL(asked).pathname === '/' || f.pathname !== '/') return null;
    // finalUrl is the RAW response URL while normalise() strips query and fragment, so
    // /product → /?p=123 and /app → /#/app both have a root pathname and are still live
    // pages. Query- and hash-routed destinations are not the homepage.
    if (f.search || f.hash) return null;
  } catch { return null; }
  return 'redirects to the site root — the page is gone; remove it from the sitemap or restore it';
}

export function collidingLandings(pages) {
  const landings = new Map();
  for (const p of pages) {
    const dest = normalise(p.finalUrl || p.url);
    landings.set(dest, [...(landings.get(dest) || []), p.url]);
  }
  return [...landings]
    .filter(([, from]) => from.length > 1)
    .map(([dest, from]) => `${from.length} URLs all redirect to ${dest} — ${from.join(', ')}`);
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
  let bytes = new Uint8Array(buf);
  // Google accepts a gzipped sitemap and real sites ship one (g2.com declares
  // sitemap_index.xml.gz in robots.txt). It arrives as application/gzip with no
  // Content-Encoding, so fetch does not unwrap it and the XML parse silently finds
  // zero <loc>s — i.e. we would tell the owner their sitemap is empty when it is fine.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    // Cap the output: gzip amplifies ~1000x, so an unbounded gunzip of a small download can
    // OOM-kill the process and the CI gate dies with no report at all. The sitemap protocol
    // caps an uncompressed sitemap at 50MB, so nothing legitimate is refused here.
    try { bytes = new Uint8Array(gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 })); }
    catch { /* truncated, corrupt, or absurdly large — decode as-is and report unreadable */ }
  }
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

// Node collapses every DNS/TLS/socket failure into the same "fetch failed" and hides the
// actual reason on err.cause. potion.so's certificate had EXPIRED and all we told the owner
// was "robots.txt returned fetch failed" three times — an expired cert is exactly the kind
// of deploy-blocking fault this tool exists to catch, so report the deepest cause instead.
// A transport failure (status 0) is a fact about the network between US and the target, not
// a verdict on the owner's link. getkirby.com links to plugins.getkirby.com, which this
// checker's host cannot reach at all; five live pages were reported as "broken link →
// unreachable" while curl fetched every one of them with 200. Claiming a working link is
// dead is the same credibility failure as a fabricated 404.
// The exceptions are the transport errors that ARE evidence about the target: a name that
// does not resolve, a host that actively refuses, and a certificate that no visitor's
// browser would accept either. Everything else — timeouts, resets, unroutable networks —
// we cannot tell apart from our own plumbing, so we do not claim it.
// Matched on .code, never on the message: a hostname inside the message must not decide it.
const DEAD_HOST = /^(ENOTFOUND|EAI_NONAME|ECONNREFUSED|ERR_INVALID_URL|ERR_UNSUPPORTED_PROTOCOL|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME_INVALID|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN)$/;
export const isDeadHost = res => res.status === 0 && DEAD_HOST.test(res.code || '');
export const isOurNetwork = res => res.status === 0 && !isDeadHost(res);

// Node wraps dual-stack connect failures in an AggregateError whose own message is empty
// and whose real reasons hang off .errors, not .cause. Skipping it left every such failure
// as the bare "fetch failed", which is exactly the case where the code (ETIMEDOUT vs
// ENOTFOUND) decides whether the link is the owner's problem or ours. And the two branches
// of a dual stack routinely disagree — v6 ENETUNREACH beside v4 CERT_HAS_EXPIRED — so take
// the decisive one rather than whichever Node happened to list first.
function bestCause(err) {
  let c = err, best = err;
  for (let depth = 0; depth < 5; depth++) { // depth cap: cause chains can cycle
    const kids = Array.isArray(c.errors) ? c.errors : [];
    const next = c.cause || kids.find(e => DEAD_HOST.test(e?.code || '')) || kids[0];
    if (!next) break;
    c = next;
    if (c.message) best = c;
  }
  return best;
}

function fetchErrorReason(err) {
  const best = bestCause(err);
  return (best.code ? `${best.message} (${best.code})` : best.message) || 'fetch failed';
}

// A 429 (and a 503) is "come back later", not a verdict on the URL. natori.com's Shopify
// login endpoint answered 429 to our own burst of requests and we printed "broken link →
// 429" for a URL that serves 200 to the very same headers a second later. Telling an owner
// their login link is dead because WE were throttled is the same credibility failure as a
// fabricated 404 — so a throttle is never taken at face value.
export const isThrottled = status => status === 429 || status === 503;

// Honour Retry-After when it is a sane number of seconds; a host that asks for an hour is
// not worth waiting for inside a pre-flight check, so clamp and move on.
export function retryAfterMs(header, fallback = 2000) {
  const secs = Number(header);
  if (!Number.isFinite(secs) || secs <= 0) return fallback;
  return Math.min(secs, 5) * 1000;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// What we say about a page that did not answer 200. A 429 survived the retry in get(), so it
// is still an issue — silently passing a page we never read would be worse. But bubble.io
// answered 429 to all six sitemap pages, and to a single spaced-out curl too: that is rate
// limiting, not six broken pages. Name which it is, or the owner hunts a defect that is not
// there — the same credibility failure as a fabricated 404.
export const statusProblem = res => `returned ${res.status || res.error}`
  + (isThrottled(res.status) ? ' — rate limited, not necessarily a page defect' : '');

async function get(url, method = 'GET', attempt = 0) {
  try {
    // Node's default `Accept: */*` is not what a visitor sends, and some hosts refuse it:
    // Shopify's customer-account OAuth page answers 406 to */*, so hydrogen.shop/account was
    // reported as a broken link when a browser gets a page. Ask for what a browser asks for.
    // */*;q=0.8 keeps sitemaps/robots.txt acceptable, so nothing else changes.
    const headers = { 'user-agent': UA, accept: ACCEPT };
    const res = await fetch(url, { method, headers, redirect: 'follow' });
    if (isThrottled(res.status) && attempt === 0) {
      await res.arrayBuffer().catch(() => {}); // release the socket before sleeping on it
      await sleep(retryAfterMs(res.headers.get('retry-after')));
      return get(url, method, 1);
    }
    const body = method === 'GET'
      ? decodeBody(await res.arrayBuffer(), res.headers.get('content-type'))
      : '';
    return { status: res.status, body, url: res.url, type: res.headers.get('content-type') || '' };
  } catch (err) {
    const cause = bestCause(err);
    return { status: 0, body: '', url, type: '', error: fetchErrorReason(err), code: cause.code || '' };
  }
}

// HEAD is cheap but not universally served: sitecore.com answers 403 to HEAD on /search and
// on every localised /platform/* page, and 200 to GET — so six live pages were reported as
// broken links. A fabricated 404 is the one output that makes an owner bin the whole report,
// so never believe a failing HEAD until a GET agrees with it.
async function linkStatus(url, fetchOne = get) {
  const head = await fetchOne(url, 'HEAD');
  if (head.status > 0 && head.status < 400) return head;
  return fetchOne(url);
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
  let origin = new URL(base).origin;
  const report = { site: origin, pages: [], issues: [], checkedAt: new Date().toISOString() };
  const fail = msg => report.issues.push(msg);
  // Issues printed next to their own page/link below. Everything else has to be printed by
  // renderText, or it gets counted in the summary and never shown — the failure that made
  // tailwindcss.com report "2 issue(s) found." and list nothing in 0.1.1.
  const inline = new Set();
  const failInline = msg => { inline.add(msg); fail(msg); };

  const robotsRes = await get(origin + '/robots.txt');
  // Ask for www.saddlebackleather.com, land on saddlebackleather.com: the site's real origin
  // is the one it redirects to, and its sitemap lists that one. Comparing against the origin
  // we happened to TYPE reported all 807 URLs as off-origin on a site with nothing wrong.
  origin = canonicalOrigin(origin, robotsRes.url);
  report.site = origin;
  let sitemapUrls = [];
  if (robotsRes.status !== 200) {
    fail(`robots.txt ${statusProblem(robotsRes)}`);
  } else {
    const { sitemaps, blocksAll } = parseRobots(robotsRes.body, robotsRes.url || origin + '/robots.txt');
    if (blocksAll) fail('robots.txt disallows / for all crawlers — nothing will be indexed');
    if (!sitemaps.length) fail('robots.txt declares no Sitemap:');
    sitemapUrls = sitemaps;
  }

  const sitemapUrl = pickSitemap(sitemapUrls, origin) || origin + '/sitemap.xml';
  const smRes = await get(sitemapUrl);
  let urls = [];
  if (smRes.status !== 200) {
    const via = redirectedTo(sitemapUrl, smRes);
    fail(`sitemap ${sitemapUrl}${via ? ` (redirected to ${via})` : ''} ${statusProblem(smRes)}`);
  } else {
    urls = parseSitemap(smRes.body);
    if (isSitemapIndex(smRes.body)) {
      const expanded = await expandSitemapIndex(smRes.body, async u => {
        const r = await get(u);
        if (r.status !== 200) { fail(`sitemap ${u} ${statusProblem(r)}`); return null; }
        return r.body;
      }, m => console.log('  note: ' + m));
      urls = expanded.urls;
      report.sitemap_index = { url: sitemapUrl, sitemaps: expanded.sitemaps };
    }
    // "lists no <loc> entries" is the wrong advice when the body is not a sitemap at all —
    // an SPA shell served with 200 for /sitemap.xml, or a .gz we could not decompress.
    if (!urls.length) fail(/<(urlset|sitemapindex)[\s>]/i.test(smRes.body)
      ? `sitemap ${sitemapUrl} lists no <loc> entries`
      : isBotWall(smRes.body)
        ? `sitemap ${sitemapUrl} returned 200 but served a bot-protection page, not a sitemap — allow this checker through your WAF, or the crawlers it stands in for are seeing the same wall`
        : `sitemap ${sitemapUrl} returned 200 but the body is not a readable sitemap`);
    // Confirm a suspected move by asking the root where it goes. One extra fetch, and only
    // on a site that would otherwise get a wall of off-origin noise.
    const moved = movedOrigin(urls, origin);
    if (moved) {
      const root = await get(origin + '/');
      let landed = null;
      try { landed = new URL(root.url).origin; } catch {}
      if (landed === moved) {
        console.log(`  note: ${origin} redirects to ${moved} — checking there`);
        origin = moved;
        report.site = origin;
        report.movedFrom = base;
      }
    }
    const foreign = urls.filter(u => { try { return new URL(u).origin !== origin; } catch { return true; } });
    if (foreign.length) fail(`sitemap lists ${foreign.length} URL(s) off-origin, e.g. ${foreign[0]}`);
  }
  report.sitemap = { url: sitemapUrl, count: urls.length };

  // Missing/empty sitemap meant zero pages checked, so the subscriber got a report about
  // their sitemap and nothing about their site. Crawl from the homepage instead.
  if (!urls.length) {
    const home = await get(origin + '/');
    // g2.com answers 403 to both its sitemap and its homepage (bot protection), which left
    // nothing at all to check — say that outright instead of shipping a bare issue count.
    if (home.status !== 200) fail(`${origin}/ → ${home.status || home.error} — no sitemap and no readable homepage, so no pages could be checked`);
    else {
      urls = seedFromHome(home.body, origin);
      report.crawledFromHome = true;
    }
  }

  // Only the origin survived line 1 of this function, so `check https://site/docs/x --limit 6`
  // reported on six unrelated sitemap pages and never fetched /docs/x — the one page the
  // caller actually named. Check the requested page first; a bare origin keeps the old order.
  const targets = (hasPath(base) ? [base, ...urls.filter(u => normalise(u) !== normalise(base))] : urls)
    .slice(0, limit);
  const linkTargets = new Set();
  report.pages = await mapLimit(targets, 6, async url => {
    const res = await get(url);
    const finalUrl = redirectedTo(url, res);
    const via = finalUrl ? ` (redirected to ${finalUrl})` : '';
    if (res.status !== 200) {
      // "not reachable" told the customer nothing: a 404 to fix, a 403 from their own bot
      // protection, and a timeout are three different jobs. Name the status.
      // A 429 survived the retry in get(), so it is still reported — silently passing a page
      // we never read would be worse. But bubble.io answered 429 to every page (and to a
      // single spaced-out curl), which is rate limiting, not six broken pages. Say which it
      // is, or the owner goes looking for a defect that is not there.
      const p = statusProblem(res);
      failInline(`${url}${via} → ${p.slice('returned '.length)}`);
      return { url, finalUrl, status: res.status, problems: [p] };
    }
    // allbirds.com's sitemap lists /agents.md (text/markdown). Running the HTML checks on it
    // produced three findings that a customer can do nothing useful with; the actionable
    // fact is that a non-page is in the sitemap at all.
    if (!isHtml(res.type)) {
      // A PDF in a sitemap is not a defect — search engines index it. Only flag types that
      // cannot be a search result at all (text/xml, text/markdown, a stray JSON feed).
      if (isIndexableDoc(res.type)) return { url, finalUrl, status: res.status, problems: [] };
      const p = `not an HTML page (${res.type.split(';')[0] || 'unknown type'}) — remove it from the sitemap`;
      failInline(`${url}${via} — ${p}`);
      return { url, finalUrl, status: res.status, problems: [p] };
    }
    // A bot wall behind a 200 has none of the tags we look for, so checkHtml would report the
    // WAF's shim as the owner's page. Say what actually happened instead.
    if (isBotWall(res.body)) {
      const p = 'served a bot-protection page (HTTP 200), so this page could not be checked';
      failInline(`${url}${via} — ${p}`);
      return { url, finalUrl, status: res.status, problems: [p] };
    }
    // res.url, not url: the canonical and the internal links belong to the page we landed on.
    const { title, problems } = checkHtml(res.body, res.url || url);
    const rootHop = redirectedToRoot(url, finalUrl);
    if (rootHop) problems.unshift(rootHop);
    for (const l of internalLinks(res.body, res.url || url)) linkTargets.add(l);
    for (const p of problems) failInline(`${url}${via} — ${p}`);
    return { url, finalUrl, status: res.status, title, problems };
  });

  // Judging a page where it landed closes the false "canonical points elsewhere", but it
  // opens a worse hole: a sitemap whose URLs all 302 to one surviving page now self-canonicals
  // its way to ALL CLEAR, when several dead URLs collapsing onto one page is exactly the
  // duplicate-content defect the owner needs told. Two requested URLs, one destination, is
  // unambiguous — no heuristic about which redirects are legitimate.
  for (const m of collidingLandings(report.pages)) fail(m);

  // Internal links that the sitemap never mentions are the usual source of dead ends.
  const known = new Set(urls.map(normalise));
  const unlisted = [...linkTargets].filter(l => !known.has(normalise(l)));
  const checked = (await mapLimit(unlisted.slice(0, limit), 6, async l => {
    const res = await linkStatus(l);
    // wagtail.org/slack is a redirect to join.slack.com, which 403s every non-browser. Saying
    // only "wagtail.org/slack → 403" sends the owner to look at their own server for a fault
    // that is Slack's; naming the host that answered makes it a 10-second triage.
    // Still throttling after the back-off in get(): we have no evidence the link is dead,
    // and "broken link → 429" is a claim we cannot stand behind. Say nothing.
    if (isThrottled(res.status)) return null;
    if (res.status < 400 && res.status > 0) return null;
    const hit = { url: l, status: res.status, error: res.error, code: res.code, finalUrl: redirectedTo(l, res) };
    return isOurNetwork(res) ? { ...hit, unverified: true } : hit;
  })).filter(Boolean);
  const broken = checked.filter(b => !b.unverified);
  // Never counted as an issue: a timeout or a reset would otherwise fail a customer's build
  // for a fault on our side. Named anyway — "unreachable" threw away the one diagnostic we
  // had, and silence would hide a link we genuinely did not check.
  const unverified = checked.filter(b => b.unverified);
  for (const b of broken) failInline(`internal link ${b.url}${b.finalUrl ? ` (redirected to ${b.finalUrl})` : ''} → ${b.status || b.error}`);
  report.brokenLinks = broken;
  report.unverifiedLinks = unverified;

  console.log(json ? JSON.stringify(report, null, 2)
                   : renderText(report, inline, unlisted.length));
  return report.issues.length ? 1 : 0;
}

// This text IS what a paying subscriber receives by email, so every issue counted in the
// summary line must also be spelled out above it.
function renderText(report, inline, unlistedCount) {
  const siteIssues = report.issues.filter(m => !inline.has(m));
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
    const where = p.finalUrl ? `${p.url} → ${p.finalUrl}` : p.url;
    out.push(`  ${mark} ${where}${p.problems.length ? '\n      ' + p.problems.join('\n      ') : ''}`);
  }
  for (const b of report.brokenLinks) {
    out.push(`  ✗ broken link ${b.url}${b.finalUrl ? ` (redirected to ${b.finalUrl})` : ''} → ${b.status || b.error}`);
  }
  for (const b of report.unverifiedLinks || []) {
    out.push(`  ? ${b.url} — could not be reached from this machine (${b.error}); not counted, verify it yourself`);
  }
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

  // A <loc> or an href is markup: "&amp;" on the wire means "&" in the URL.
  assert(parseSitemap('<loc>https://a.com/s.php?type=pages&amp;page=1</loc>')[0]
    === 'https://a.com/s.php?type=pages&page=1', 'parseSitemap decodes &amp; in a query string');
  assert(decodeXmlEntities('a&#38;b&#x26;c&quot;d&apos;e&lt;f&gt;g') === 'a&b&c"d\'e<f>g',
    'named, decimal and hex entities all decode');
  assert(decodeXmlEntities('&amp;lt;') === '&lt;', 'one pass only — &amp;lt; is not <');
  assert(decodeXmlEntities('a&nbsp;b&notanentity;') === 'a&nbsp;b&notanentity;',
    'unknown entities are left alone rather than mangled');
  assert(attrValue('<a href="/search?a=1&amp;b=2">', 'href') === '/search?a=1&b=2',
    'attrValue decodes an entity-escaped href');

  assert(canonicalOrigin('https://www.a.com', 'https://a.com/robots.txt') === 'https://a.com',
    'www redirecting to apex moves the origin');
  assert(canonicalOrigin('https://a.com', 'https://www.a.com/robots.txt') === 'https://www.a.com',
    'apex redirecting to www moves the origin');
  assert(canonicalOrigin('http://a.com', 'https://a.com/robots.txt') === 'https://a.com',
    'an http to https upgrade moves the origin');
  assert(canonicalOrigin('https://a.com', 'https://cdn.example.net/robots.txt') === 'https://a.com',
    'an unrelated host does not move the origin');
  assert(canonicalOrigin('https://a.com', 'https://a.com/404.html') === 'https://a.com',
    'landing somewhere other than robots.txt does not move the origin');
  assert(canonicalOrigin('https://a.com', 'http://a.com/robots.txt') === 'https://a.com',
    'an https to http downgrade does not move the origin');
  assert(canonicalOrigin('https://a.com', 'https://a.com:8443/robots.txt') === 'https://a.com',
    'a different port does not move the origin');
  // get()'s catch echoes the requested URL back, so this is the real failed-fetch shape.
  assert(canonicalOrigin('https://a.com', 'https://a.com/robots.txt') === 'https://a.com',
    'a failed fetch does not move the origin');
  assert(decodeXmlEntities('&#99999999;x') === '&#99999999;x',
    'an out-of-range numeric entity is left alone rather than throwing');

  // The real docs.readthedocs.io shape: robots.txt stays put, the whole sitemap has moved.
  assert(movedOrigin(['https://docs.readthedocs.com/', 'https://docs.readthedocs.com/a'],
    'https://docs.readthedocs.io') === 'https://docs.readthedocs.com',
    'a sitemap entirely on one other origin is a suspected move');
  assert(movedOrigin(['https://a.com/x', 'https://a.com/y'], 'https://a.com') === null,
    'a sitemap on our own origin is not a move');
  // A few strays among our own URLs is a real off-origin mistake, not a migration.
  assert(movedOrigin(['https://a.com/x', 'https://cdn.net/y'], 'https://a.com') === null,
    'a mixed sitemap is not a move');
  assert(movedOrigin(['/relative'], 'https://a.com') === null,
    'an unparseable entry never claims a move');
  assert(movedOrigin([], 'https://a.com') === null, 'an empty sitemap is not a move');

  // The real typo3.org shape: four other-domain sitemaps declared before its own.
  assert(pickSitemap(['https://typo3.com/sitemap.xml', 'https://typo3.community/sitemap.xml',
    'https://typo3.org/sitemap.xml'], 'https://typo3.org') === 'https://typo3.org/sitemap.xml',
    'the site\'s own sitemap wins over off-origin ones declared before it');
  assert(pickSitemap(['https://cdn.net/sitemap.xml', 'https://www.a.com/sitemap.xml',
    'https://a.com/sitemap.xml'], 'https://a.com') === 'https://a.com/sitemap.xml',
    'an exact-origin sitemap beats a www sibling, whose URLs would all read as off-origin');
  assert(pickSitemap(['https://www.a.com/sitemap.xml'], 'https://a.com') === 'https://www.a.com/sitemap.xml',
    'the other of www/apex is still this site, and beats no sitemap at all');
  assert(pickSitemap(['https://cdn.net/sitemap.xml'], 'not a url') === 'https://cdn.net/sitemap.xml',
    'an unparseable origin falls back to the first declared sitemap rather than throwing');
  assert(pickSitemap(['https://cdn.net/sitemap.xml'], 'https://a.com') === 'https://cdn.net/sitemap.xml',
    'an off-origin sitemap is still used when it is the only one offered');
  assert(pickSitemap(['not a url', 'https://a.com/sitemap.xml'], 'https://a.com') === 'https://a.com/sitemap.xml',
    'an unparseable Sitemap: line does not win and does not throw');
  assert(pickSitemap([], 'https://a.com') === null, 'no declared sitemap falls back to the caller');

  assert(isSitemapIndex('<?xml version="1.0"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
    + '<sitemap><loc>https://a.com/sitemap-0.xml</loc></sitemap></sitemapindex>'), 'isSitemapIndex detects an index');
  assert(!isSitemapIndex('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://a.com/x</loc></url></urlset>'),
    'isSitemapIndex does not flag a plain urlset');

  // The real shape Node throws for an expired certificate: TypeError('fetch failed') whose
  // cause carries the only useful words in the whole object.
  const certErr = Object.assign(new TypeError('fetch failed'),
    { cause: Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }) });
  assert(fetchErrorReason(certErr) === 'certificate has expired (CERT_HAS_EXPIRED)',
    'fetchErrorReason surfaces the cause, not "fetch failed"');
  assert(fetchErrorReason(new Error('boom')) === 'boom', 'fetchErrorReason passes a plain error through');
  const cyclic = new Error('a');
  cyclic.cause = cyclic;
  assert(fetchErrorReason(cyclic) === 'a', 'fetchErrorReason survives a cyclic cause chain');
  const viaAggregate = Object.assign(new TypeError('fetch failed'),
    { cause: Object.assign(new AggregateError([], ''), { cause: new Error('') }) });
  assert(fetchErrorReason(viaAggregate) === 'fetch failed',
    'fetchErrorReason never returns an empty reason');
  assert(fetchErrorReason(Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new AggregateError([], ''), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }),
    }),
  })) === 'connect ECONNREFUSED 127.0.0.1:443 (ECONNREFUSED)',
    'fetchErrorReason skips a message-less AggregateError to reach the real cause');

  const r = parseRobots('User-agent: *\nDisallow: /\nSitemap: https://a.com/sitemap.xml # note');
  assert(r.blocksAll && r.sitemaps[0] === 'https://a.com/sitemap.xml', 'parseRobots blocking');
  assert(!parseRobots('User-agent: *\nAllow: /\nDisallow: /admin/').blocksAll, 'parseRobots allowing');
  assert(!parseRobots('User-agent: badbot\nDisallow: /').blocksAll, 'parseRobots per-agent block is not site-wide');
  assert(parseRobots('Sitemap: /sitemap.xml', 'https://a.com/robots.txt').sitemaps[0] === 'https://a.com/sitemap.xml',
    'a relative Sitemap: line resolves against robots.txt instead of throwing ERR_INVALID_URL');
  assert(parseRobots('Sitemap: https://b.com/s.xml', 'https://a.com/robots.txt').sitemaps[0] === 'https://b.com/s.xml',
    'an absolute Sitemap: line is unchanged by resolution');
  assert(parseRobots('Sitemap: /sitemap.xml').sitemaps[0] === '/sitemap.xml',
    'parseRobots without a base still returns the raw value');

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

  // A link is only broken when GET says so — HEAD-hostile hosts must not fabricate 404s.
  const calls = [];
  const stub = statuses => async (u, method = 'GET') => {
    calls.push(method);
    return { status: statuses[method], body: '', url: u, type: '' };
  };
  assert((await linkStatus('https://a.com/x', stub({ HEAD: 403, GET: 200 }))).status === 200,
    'a link that 403s HEAD but serves GET is not reported broken');
  assert((await linkStatus('https://a.com/x', stub({ HEAD: 404, GET: 404 }))).status === 404,
    'a genuinely dead link is still reported');
  assert((await linkStatus('https://a.com/x', stub({ HEAD: 0, GET: 200 }))).status === 200,
    'a HEAD that errors outright is retried with GET');
  calls.length = 0;
  await linkStatus('https://a.com/x', stub({ HEAD: 200, GET: 200 }));
  assert(calls.join(',') === 'HEAD', 'a healthy HEAD costs exactly one request — no GET retry');

  // Our own network failing is not the owner's broken link.
  const err = code => ({ status: 0, code });
  assert(isOurNetwork(err('ETIMEDOUT')), 'a timeout is our side, not a dead link');
  assert(isOurNetwork(err('ECONNRESET')) && isOurNetwork(err('ENETUNREACH')),
    'a reset or an unroutable network is our side');
  assert(isDeadHost(err('ENOTFOUND')) && !isOurNetwork(err('ENOTFOUND')),
    'a host that does not resolve really is a dead link');
  assert(isDeadHost(err('ECONNREFUSED')) && isDeadHost(err('CERT_HAS_EXPIRED')),
    'a refused connection and an expired certificate are the owner\'s, not ours');
  assert(!isOurNetwork({ status: 404 }) && !isDeadHost({ status: 404 }),
    'a real HTTP status is judged on the status, not the transport');
  assert(isOurNetwork({ status: 0, code: '' }) && isOurNetwork({ status: 0 }),
    'a transport failure with no reason defaults to our side, never to a broken claim');
  // The code decides, not the message — a hostname that merely contains the token must not.
  assert(isOurNetwork({ status: 0, code: 'ETIMEDOUT', error: 'connect to enotfound.example' }),
    'a dead-host token inside the message text never promotes a timeout to a broken link');

  // Dual-stack: the decisive branch wins over whichever Node listed first.
  const agg = Object.assign(new Error('fetch failed'), {
    cause: Object.assign(new AggregateError([
      Object.assign(new Error('connect ENETUNREACH'), { code: 'ENETUNREACH' }),
      Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }),
    ], '')),
  });
  assert(bestCause(agg).code === 'CERT_HAS_EXPIRED',
    'an AggregateError yields the branch that decides, not errors[0]');

  // A throttle is not a dead link.
  assert(isThrottled(429) && isThrottled(503), '429 and 503 are throttles');
  assert(!isThrottled(404) && !isThrottled(403) && !isThrottled(500) && !isThrottled(0),
    'a real failure status is not mistaken for a throttle');
  assert(retryAfterMs('3') === 3000, 'Retry-After seconds honoured');
  assert(retryAfterMs('3600') === 5000, 'an absurd Retry-After is clamped');
  assert(retryAfterMs(null) === 2000 && retryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT') === 2000,
    'a missing or date-form Retry-After falls back');
  assert(statusProblem({ status: 429 }).includes('rate limited'),
    'a throttled page says it was throttled, not that it is broken');
  assert(statusProblem({ status: 404 }) === 'returned 404',
    'a real failure status is reported bare, with no throttle excuse');
  assert(statusProblem({ status: 0, error: 'fetch failed' }) === 'returned fetch failed',
    'a transport failure still names its reason');

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

  // An empty tag is not a missing tag — mozilla.org ships `content=""`.
  const emptyDesc = checkHtml(good.replace('content="d"', 'content=""'), 'https://a.com/p/').problems;
  assert(emptyDesc.length === 1 && emptyDesc[0] === 'meta description is empty', 'empty description not called missing');
  const emptyTitle = checkHtml(good.replace('<title>T</title>', '<title> </title>'), 'https://a.com/p/').problems;
  assert(emptyTitle.length === 1 && emptyTitle[0] === '<title> is empty', 'blank title not called missing');
  const emptyCanon = checkHtml(good.replace('href="https://a.com/p/"', 'href=""'), 'https://a.com/p/').problems;
  assert(emptyCanon.length === 1 && emptyCanon[0].includes('empty href'), 'empty canonical href not called missing');
  assert(checkHtml('<title>T</title>', 'https://a.com/p/').problems
    .every(p => p.startsWith('no ')), 'genuinely absent tags still report as missing');
  assert(checkHtml(good.replace(' content="d"', ''), 'https://a.com/p/').problems[0] === 'meta description is empty',
    'a description tag with no content attribute is empty, not missing');
  assert(checkHtml(good.replace(' href="https://a.com/p/"', ''), 'https://a.com/p/').problems[0].includes('empty href'),
    'a canonical tag with no href attribute is empty, not missing');

  // A redirected page is judged where it landed (drupal.org → new.drupal.org).
  assert(redirectedTo('https://a.com/p', { url: 'https://b.com/p' }) === 'https://b.com/p',
    'a cross-origin redirect is reported');
  assert(redirectedTo('https://a.com/p', { url: 'https://a.com/p/' }) === null,
    'a trailing slash is not a redirect worth naming');
  assert(redirectedTo('https://a.com/p', { url: '' }) === null, 'no final URL means no redirect');
  assert(checkHtml(`<title>T</title><meta name="description" content="d">
    <link rel="canonical" href="https://b.com/p/">`, 'https://b.com/p/').problems.length === 0,
    'a self-canonical on the redirect target is not "points elsewhere"');
  // ...but judging pages where they land must not hide a sitemap collapsing onto one page.
  const collided = collidingLandings([
    { url: 'https://a.com/x', finalUrl: 'https://a.com/home' },
    { url: 'https://a.com/y', finalUrl: 'https://a.com/home' },
    { url: 'https://a.com/z', finalUrl: null },
  ]);
  assert(collided.length === 1 && collided[0].includes('/x') && collided[0].includes('/y'),
    'two URLs landing on one page is reported');
  assert(collidingLandings([
    { url: 'https://a.com/p', finalUrl: 'https://b.com/p' },
    { url: 'https://a.com/q', finalUrl: 'https://b.com/q' },
  ]).length === 0, 'a 1:1 host migration is not a collision');
  // ...nor a single dead URL 302ing to the homepage, which is not a collision at all.
  assert(redirectedToRoot('https://a.com/about', 'https://a.com/'),
    'a sitemap URL redirecting to the site root is reported');
  assert(redirectedToRoot('https://a.com/about', 'https://b.com/'),
    'a cross-origin redirect to a root is reported too');
  assert(redirectedToRoot('https://a.com/', 'https://a.com') === null,
    'the homepage redirecting to itself is not a dead page');
  assert(redirectedToRoot('https://a.com/about', 'https://a.com/about/') === null,
    'a trailing-slash redirect is not a dead page');
  assert(redirectedToRoot('https://a.com/about', null) === null, 'no redirect, no finding');
  assert(redirectedToRoot('https://a.com/product', 'https://a.com/?p=123') === null,
    'a query-routed destination is a live page, not the homepage');
  assert(redirectedToRoot('https://a.com/app', 'https://a.com/#/app') === null,
    'a hash-routed destination is a live page, not the homepage');

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

  assert(isIndexableDoc('application/pdf') && isIndexableDoc('application/pdf; charset=binary'),
    'a PDF in a sitemap is indexable, not a defect to remove');
  assert(!isIndexableDoc('text/xml; charset=utf-8') && !isIndexableDoc('text/markdown')
    && !isIndexableDoc('application/json') && !isIndexableDoc('') && !isIndexableDoc(null),
    'XML/markdown/JSON/unknown in a page sitemap are still flagged');

  // The real silverstripe.org body, trimmed: 200 OK, noindex, no title, no canonical.
  assert(isBotWall('<html><head><META NAME="ROBOTS" CONTENT="NOINDEX, NOFOLLOW">'
    + '<script src="/_Incapsula_Resource?SWJIYLWA=5074a744"></script></head><body></body></html>'),
    'an Incapsula 200 shim is a bot wall, not a page with four missing tags');
  assert(isBotWall('<html><head><title>Just a moment...</title>'
    + '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script></head></html>'),
    'a Cloudflare challenge is a bot wall');
  assert(!isBotWall('<html><head><title>Real page</title></head><body>'
    + 'x'.repeat(3000) + '<script src="/cdn-cgi/challenge-platform/x.js"></script></body></html>'),
    'a full-length page is never a bot wall, even if it mentions a challenge script');
  assert(!isBotWall('<html><head><title>Tiny but real</title></head><body>hi</body></html>')
    && !isBotWall('') && !isBotWall(null) && !isBotWall(undefined),
    'a short ordinary page, an empty body and a missing body are not bot walls');

  const seeded = seedFromHome('<a href="/">home</a><a href="/a">1</a><a href="https://x.com/b">2</a>', 'https://a.com');
  assert(seeded.join(',') === 'https://a.com/,https://a.com/a', 'seedFromHome leads with home, dedupes it, drops off-origin');

  // The requested page must survive the --limit slice, or we report on a site the caller
  // did not ask about. A bare origin must NOT be hoisted (it would change every existing run).
  assert(hasPath('https://a.com/docs/x') && hasPath('https://a.com/docs'), 'a real path is detected');
  assert(!hasPath('https://a.com') && !hasPath('https://a.com/') && !hasPath('https://a.com//'), 'a bare origin has no path');
  const hoist = (base, urls, limit) =>
    (hasPath(base) ? [base, ...urls.filter(u => normalise(u) !== normalise(base))] : urls).slice(0, limit);
  assert(hoist('https://a.com/docs/x', ['https://a.com/1', 'https://a.com/2'], 1)[0] === 'https://a.com/docs/x',
    'the requested page is checked even at --limit 1');
  assert(hoist('https://a.com/docs/x/', ['https://a.com/docs/x', 'https://a.com/1'], 9).length === 2,
    'the requested page is not checked twice when the sitemap lists it (trailing slash included)');
  assert(hoist('https://a.com', ['https://a.com/1'], 9).join(',') === 'https://a.com/1',
    'a bare origin leaves the sitemap order untouched');

  const crawlText = renderText({
    site: 'https://a.com', sitemap: { url: 'https://a.com/sitemap.xml', count: 0 }, crawledFromHome: true,
    pages: [{ url: 'https://a.com/', problems: [] }], brokenLinks: [], issues: ['sitemap https://a.com/sitemap.xml returned 404'],
  }, new Set(), 0);
  assert(crawlText.includes('crawled from the homepage'), 'fallback crawl is disclosed in the report');
  assert(crawlText.includes('https://a.com/'), 'fallback crawl still lists the pages it checked');

  // A site with no sitemap has only site-level issues and zero pages; the emailed report
  // must name them, not just count them.
  const siteOnly = {
    site: 'https://a.com', sitemap: { url: 'https://a.com/sitemap.xml', count: 0 },
    pages: [], brokenLinks: [],
    issues: ['robots.txt returned 404', 'sitemap https://a.com/sitemap.xml returned 404'],
  };
  const text = renderText(siteOnly, new Set(), 0);
  assert(siteOnly.issues.every(m => text.includes(m)), 'site-level issues are printed, not just counted');
  assert(text.includes('2 issue(s) found'), 'issue count still summarised');

  // The 0.1.7 bug: renderText was handed a SNAPSHOT of the issues taken before the homepage
  // fallback ran, so a failed homepage fetch (g2.com → 403) was counted and never printed.
  // Now anything not explicitly marked as printed inline is printed at the top.
  const late = {
    site: 'https://a.com', sitemap: { url: 'https://a.com/sitemap.xml', count: 0 },
    pages: [{ url: 'https://a.com/p', problems: ['no <title>'] }], brokenLinks: [],
    issues: ['sitemap https://a.com/sitemap.xml returned 403', 'https://a.com/ → 403 — nothing checked',
             'https://a.com/p — no <title>'],
  };
  const pageIssue = 'https://a.com/p — no <title>';
  const lateText = renderText(late, new Set([pageIssue]), 0);
  assert(late.issues.filter(m => m !== pageIssue).every(m => lateText.includes(m)),
    'every counted issue that is not shown inline is printed verbatim');
  assert(lateText.includes('https://a.com/ → 403'), 'an issue raised after the sitemap stage is still printed');
  assert(lateText.split('no <title>').length === 2, 'an issue shown next to its page is not printed twice');

  // A gzipped sitemap is legal and g2.com serves one; unwrapped, the XML parse finds no
  // <loc>s and we would report a perfectly good sitemap as empty.
  assert(parseSitemap(decodeBody(gzipSync(Buffer.from('<urlset><loc>https://a.com/x</loc></urlset>')),
    'application/gzip')).join() === 'https://a.com/x', 'gzipped sitemap is decompressed before parsing');
  assert(decodeBody(new TextEncoder().encode('plain'), 'text/html') === 'plain', 'non-gzip bodies untouched');

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
