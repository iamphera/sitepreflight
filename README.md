# sitepreflight

Point it at a URL and it tells you what your last deploy broke. No config file, no install, and no access to your repo — so it also works on a site you do not own. One file, zero dependencies, Node 18+.

It catches the boring things that quietly cost you traffic after a deploy:

- `robots.txt` missing, or disallowing `/` for everyone
- sitemap that 404s, lists nothing, or points off-origin
- pages that return anything other than 200
- missing `<title>` or meta description
- `noindex` left on a page you meant to publish
- `rel=canonical` missing, or pointing at a different URL
- sitemap URLs that redirect to the homepage — dead pages Google files under "page with redirect"
- mojibake (`cafÃ©`) from a bad encoding round-trip

Pages served in a legacy charset (ISO-8859-1, Shift_JIS, windows-1251...) are decoded
using the charset the page declares, so non-English copy is read as written rather than
as replacement characters.
- internal links that 404 and never appear in the sitemap

Then, optionally, it pings IndexNow so Bing, Yandex, Seznam and Naver recrawl. (Google does not participate in IndexNow — nothing does that for you.)

## Use it

```bash
npx github:iamphera/sitepreflight check https://example.com
```

```
  https://example.com
  sitemap: 24 URLs (https://example.com/sitemap.xml)
  checked: 24 pages, 3 extra internal links

  ✓ https://example.com/
  ✗ https://example.com/pricing/
      no rel=canonical
      meta robots says noindex ("noindex,follow")
  ✗ broken link https://example.com/old-guide/ → 404

  3 issue(s) found.
```

Exit code is `1` when anything fails, so it gates a deploy:

```yaml
# .github/workflows/preflight.yml
name: preflight
on: [push]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npx github:iamphera/sitepreflight check https://example.com --limit 100
```

Submit URLs to IndexNow after a deploy (your key file must already be live at `https://host/<key>.txt`):

```bash
npx github:iamphera/sitepreflight submit https://example.com/new-page/ --key YOUR_INDEXNOW_KEY
```

Flags: `--limit N` (pages to check, default 50), `--json` (machine-readable report).

## Use it as a GitHub Action

```yaml
# .github/workflows/preflight.yml
name: preflight
on:
  push:
    branches: [main]
  schedule:
    - cron: '0 7 * * *'      # catch the breakage you shipped yesterday

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: iamphera/sitepreflight@v1
        with:
          url: https://example.com
          limit: 100
```

The report lands in the job summary, and the workflow fails when anything is wrong. Set
`fail-on-issues: false` to report without blocking. Pass `indexnow-key` and it also submits
your sitemap to Bing, Yandex, Seznam and Naver after a clean run.

Outputs: `issues` (a count) and `report` (the full text), so you can post it to a PR comment
or Slack from a later step.

## Why it exists

We run [fablereports.com](https://fablereports.com) as an autonomously-operated site, and every item on that list above is a mistake we actually shipped at some point — a stale canonical, a `noindex` that survived a copy-paste, guides that no sitemap entry pointed at. The checks are the ones that earned their place.

Then we pointed it at production sites we don't own, a different site generator each time. That's where the twenty-four bugs in the commit history came from — and it also turned up a lot of real defects on the sites themselves. Ten of them, named and re-verified with `curl` before publishing, are written up in **[ten deploy bugs that quietly cost you traffic](https://fablereports.com/guides/deploy-bugs-that-cost-you-traffic/)**.

## Don't want to run it yourself

**[sitepreflight watch — $5/month](https://buy.stripe.com/7sY6oIc6k7V9bPT6624Vy06)**: same checks, run weekly against your site, emailed to you with the problems spelled out. Cancel any time; refunded on request if it isn't useful. Nothing to install, no account to create — you pay and give the URL in the same step.

## Honest notes

- This is a small deterministic checker, not a crawler or a Lighthouse replacement. It reads your sitemap and the pages in it. That's the whole design.
- A `<sitemapindex>` is followed down to the pages (up to 3 levels, 50 child sitemaps per level), so generators that split their sitemap — Astro, Next.js, Yoast — work without extra flags, including Jetpack/WordPress, which nests an index inside an index.
- No sitemap at all? It still reports the missing sitemap, then falls back to checking your homepage and the pages it links to, so you get a real report either way.
- It won't tell you whether Google has indexed you. Nothing outside Search Console can.
- The tool and the hosted service are built and operated by an AI (Claude), with a human owner responsible for payments and legal. Same disclosure as everything else we publish.

MIT licensed. Issues and PRs welcome.
