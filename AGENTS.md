# AGENTS.md — start here

Entry point for anyone, human or AI, picking up `yswords-data`. Read it
before touching anything.

This repo is a **data source, not an app**. It publishes JSON that other
apps read over CORS. Nothing here has a UI.

Its most-consumed dataset is `data/daily_news.json`, the feed behind
**Yahweh's World** (`~/Documents/CodingProject/yahwehs_world`). That
app's `AGENTS.md` is worth reading too — the two repos are one system,
and a change here is visible to users without any app release, because
the app builds its filter chips from whatever desks this feed contains.

`README.md` is the long-form technical description and is largely
accurate; this file is the contract and the traps.

---

## Commands

```bash
npm test            # 52 tests, ~200ms, must be clean
npm run refresh     # full pipeline — SPENDS API QUOTA, see below
node -c scripts/refresh-news.mjs
```

CI is `.github/workflows/refresh.yml`, on `workflow_dispatch` and a
`0 */4 * * *` cron. It deploys via `netlify-cli` because Netlify's own
git clone has been broken for this repo for months
(`Host key verification failed`); that needs the `NETLIFY_AUTH_TOKEN`
secret.

---

## Rules that are not negotiable

**Do not run the refresh repeatedly to test something.** The Gemini free
tier is a **per-key daily request cap**, and it is the binding
constraint on this entire repo's output quality. Four manual runs in 90
minutes on 2026-08-25 burned a whole day's budget and left that day's
final run with zero fresh matches. If you need to check feed wiring,
fetch the RSS directly instead of running the pipeline.

**Do not put the cron back to hourly.** A deep-match that 429s is
persisted as `translationState=fallback` and retried by every later run,
so ~100 poisoned entries cost ~200 calls an hour and re-killed the quota
shortly after each midnight-PDT reset. Hourly polling converts one bad
run into a permanent one.

**Do not pin `OPENAI_MODEL` in the workflow `env:` block.** It used to
be pinned to `gemini-2.5-flash` and silently overrode the script's
default, so a fix to the script did nothing at all. If a config change
appears to have no effect, grep the workflow before re-reading the
script.

**`gemini-2.5-flash` free tier is ~20 requests/day**, not the 1500 an
old comment claimed. Measured on an untouched daily budget: 15
successes, then 429 on everything. Never make it the default.

**Secrets never get printed or committed.** Keys live in
`~/.config/yswords/secrets/`. The repo's CI key is the
`OPENAI_API_KEY` Actions secret — write-only, you cannot read it back.

**Commit messages carry no attribution lines.**

---

## How the model ladder works

`callGeminiChat` walks `AI_MODEL_CHAIN` (`OPENAI_MODEL_CHAIN` to
override). On a 429 or 5xx it steps **down to the next model** rather
than retrying the one that just refused, because a per-day cap cannot be
waited out with backoff. Default order:

```
gemini-2.5-flash-lite  ->  gemini-3-flash-preview  ->  gemini-2.5-flash
```

That order is evidence-based, not alphabetical: `gemini-3-flash-preview`
absorbed the step-down traffic successfully while all 192 calls that
reached `gemini-2.5-flash` came back 429.

The three key env vars (`GEMINI_API_KEYS`, `GEMINI_API_KEY`,
`OPENAI_API_KEY`) are **additive and deduped**, then round-robined. They
were a `||` precedence chain until 2026-08-25, where setting one
silently disabled another — which matters because GitHub secrets are
write-only, so you cannot read the existing value to merge by hand.

---

## Why sections rotate

`rotateSectionOrder` changes which desk is built first, once per 4-hour
window. Budget is consumed as the section loop runs, so a fixed order
does not ration a scarce budget — it always starves whoever sorts last.
Measured before the fix: world 18/18, china 10/10, australia 16/16, then
science 2/26, technology 1/18, creation 3/18.

The offset comes from **absolute time, not hour-of-day**: with a
4-hourly cron `hour % 8` yields only `{0, 4}`, so six of the eight desks
would never lead. A test pins this.

Sections are re-keyed into canonical order before writing, so the
rotation does not reshuffle the JSON keys and turn every refresh into a
whole-file diff.

---

## Feeds

30 RSS feeds across 8 desks; `sourceCatalog` in `scripts/refresh-news.mjs`
is the list. Two techniques are in use:

- plain feeds, taken whole;
- broad feeds narrowed by `matchKeywords` (title + summary, lowercased
  substring) — used for the China desk and for the Documentary desk,
  where no dedicated trade feed survives a bot-UA fetch.

**Before adding a feed, fetch it with the pipeline's actual
User-Agent** (`DailyMannaDispatchBot/1.0`), not a browser one. Several
candidates behave differently: Mongabay 403s intermittently on a short
browser UA, RealScreen returns a challenge page.

`determineTargetCount` sizes each desk by **same-day supply**, which
crowds out weeklies — that is why `science` carries a `maxItems: 26`
override for Nature.

---

## State as of 2026-09-04

Live feed, edition `2026-09-04`: **111 stories, 111 deep-matched, zero
keyword-fallback** — full coverage on every desk, on a single API key.
On 2026-08-25 the same pipeline was at 72/132 with three desks near
zero. Runs take 10–17 minutes.

Known stale spots in `README.md`, both cosmetic: it says the corpus has
149 verses (it has 159), and it calls adding a second API key "the
highest-value lever on deep-match coverage" — written mid-debugging,
before a single key turned out to be sufficient once the model chain and
cadence were right.
