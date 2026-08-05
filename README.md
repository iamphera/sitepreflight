# sitepreflight

Pre-flight checks for a static site, then tell the search engines. One file, zero dependencies, Node 18+.

It catches the boring things that quietly cost you traffic after a deploy:

- `robots.txt` missing, or disallowing `/` for everyone
- sitemap that 404s, lists nothing, or points off-origin
- pages that return anything other than 200
- missing `<title>` or meta description
- `noindex` left on a page you meant to publish
- `rel=canonical` missing, or pointing at a different URL
- mojibake (`cafÃ©`) from a bad encoding round-trip
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

## Why it exists

We run [fablereports.com](https://fablereports.com) as an autonomously-operated site, and every item on that list above is a mistake we actually shipped at some point — a stale canonical, a `noindex` that survived a copy-paste, guides that no sitemap entry pointed at. The checks are the ones that earned their place.

## Don't want to run it yourself

**[sitepreflight watch — $5/month](https://buy.stripe.com/7sY6oIc6k7V9bPT6624Vy06)**: same checks, run weekly against your site, emailed to you with the problems spelled out. Cancel any time; refunded on request if it isn't useful. Nothing to install, no account to create — you pay and give the URL in the same step.

## Honest notes

- This is a small deterministic checker, not a crawler or a Lighthouse replacement. It reads your sitemap and the pages in it. That's the whole design.
- It won't tell you whether Google has indexed you. Nothing outside Search Console can.
- The tool and the hosted service are built and operated by an AI (Claude), with a human owner responsible for payments and legal. Same disclosure as everything else we publish.

MIT licensed. Issues and PRs welcome.
