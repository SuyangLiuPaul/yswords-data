# yswords-data

Central data source for the [YsWords](https://yswords.netlify.app)
Bible study app.

> Live: <https://yswords-data.netlify.app/>

## What's here

| Path | What | Refresh |
|---|---|---|
| `data/bible_evidence.json` | Archaeological / manuscript / scientific / historical entries | Manual edits |
| `data/daily_news.json` | Bilingual news across 8 desks (world / china / hongkong / australia / science / technology / creation / documentary) + Bible reflections | GitHub Actions, hourly |
| `data/daily_verses.json` | 3,650 daily Bible verse references (10-year cycle) | Manual edits |
| `data/news_verse_corpus.json` | 149 curated verses + tags the daily-news AI matches against | Manual edits |
| `data/songs.json` | 543 church songs from 3 sites — metadata + audio / video / sheet-music links | GitHub Actions, weekly |
| `data/_manifest.json` | Index with sha256 checksums + sizes | Auto-regenerated on every push |
| `schemas/*.schema.json` | JSON Schema definitions for each dataset | Hand-maintained |

## Why this repo exists

YsWords used to bundle every dataset as a Flutter asset, so any data
edit required a full app rebuild + redeploy. DailyNews lived in a
separate repo whose only role was running a cron and exposing JSON.
This repo collapses both:

- One place to edit data
- One Netlify site hosting everything with `Access-Control-Allow-Origin: *`
- One CI workflow validating against schemas before publish
- One manifest making cache invalidation trivial for any consumer

YsWords still bundles a snapshot at build time so the app works
offline / on first launch — but every consumer can refresh from this
URL at runtime.

## Adding a new dataset

1. Drop the JSON in `data/`.
2. Write a schema in `schemas/<name>.schema.json`.
3. Add an entry to the `datasets` array in `scripts/validate.mjs`.
4. (If applicable) update `index.html` so it shows up in the listing.
5. `npm run build` locally — runs validate + regenerate manifest.
6. Open a PR. CI re-runs validate and blocks the merge if anything fails.

## The songs catalogue

`data/songs.json` is generated, not hand-edited. It combines three
church catalogues, each entry tagged with the `source` it came from:

| `source` | Site | Songs |
|---|---|---|
| `fydt` | [fydt.org](https://fydt.org) — 福音电台 | 213 (zh) |
| `cdc` | [christiandiscipleschurch.org](https://www.christiandiscipleschurch.org) | 283 (en + zh) |
| `cahaya` | [cahayapengharapan.org](https://cahayapengharapan.org) | 47 (id) |

Only metadata and media URLs live here — the audio, video and PDFs
stay on each church's own servers. All three are published by the same
church's pastors, who approved this use.

```sh
npm run refresh:songs   # re-sync from the three sites
npm run verify:songs    # HEAD-check every media URL in the catalogue
npm run build           # validate + manifest
```

**Link rot is checked, not assumed.** CDC's media URLs are *derived*
from its catalogue codes rather than published, and ~23 of ~566 files
were never uploaded — those are HEAD-checked during the sync and
dropped. `--verify` then re-checks the whole catalogue and exits
non-zero if anything is dead, which is what the weekly workflow runs.
This matters: the consuming app's Songs feature was deleted once
because links rotted silently after fydt.org migrated its backend.

> `fuyindiantai.org` is **not** a fourth source. It is fydt.org under
> its former domain, its songs are already here under `fydt`, and its
> DNS delegation is currently broken (SERVFAIL — the NS records still
> point at `ns1/ns2.fydt.org`, which stopped serving the zone when
> fydt.org moved to DigiCert DNS).

## Editing existing data

```sh
git clone https://github.com/SuyangLiuPaul/yswords-data
cd yswords-data
npm install

# edit data/<file>.json

npm run build   # validate + manifest
npm test        # smoke tests
git commit -am "data: <what you changed>"
git push
```

Netlify auto-deploys on push to main; YsWords picks up the change on
each user's next launch (5-minute browser cache + 5-minute manifest
TTL on the YsWords side).

## Refresh pipeline (`scripts/refresh-news.mjs`)

GitHub Actions runs hourly (`0 * * * *`). Each run pulls RSS, hits
the per-story deep-match cache for headlines already seen, and only
commits if `data/daily_news.json` actually changed. So ~24 cron
fires/day, typically ~6–12 commits/day plus one Netlify rebuild per
commit. The hourly cadence matches how often the source RSS feeds
update; cold-cache runs take ~10–15 min with the Gemini free-tier
throttle (~7 s between deep-match calls × 38 stories) plus the free
Google Translate pass for body text. See `.github/workflows/refresh.yml`.

What each run does:

1. **Pulls 30 RSS feeds** across 8 desks — world / china / hongkong /
   australia / science / technology / creation / documentary — from
   Guardian, BBC, SBS, DW, SCMP, HKFP, RTHK, Nature, ScienceDaily,
   Phys.org, Ars Technica, Mongabay, Yale E360, and IndieWire.
2. **Dedupes + balances** per section (10–18 items each).
3. **Body extraction.** RSS gives us a short summary; for the
   long-form body we try in order:
   - the feed's `<content:encoded>` (Guardian feeds always have this);
   - else fetch the article URL and extract paragraphs from the
     page's `<article>` (or `<main>`) container via a readability
     heuristic. Catches BBC / SBS / DW which don't ship full bodies
     in their RSS. Capped at ~2800 chars per story.
4. **Deep-match (Gemini).** Loads `data/news_verse_corpus.json` (149
   curated verses across 24 topical categories) and asks
   `gemini-2.5-flash` to:
   - reason about the story's underlying spiritual / human question,
   - pick the single best-fitting verse from the catalog,
   - write a bilingual summary + reflection in one structured call.
   Per-story cache keyed by story id makes repeat headlines free.
   Few-shot examples baked into the prompt anchor editorial voice;
   per-section diversity hint stops one section ending up with five
   identical verse picks.
5. **Body translation.** The long-form body is translated to
   Simplified Chinese via the **free** Google Translate web endpoint
   (`translate.googleapis.com/translate_a/single`). No API key, no
   quota, ~750 ms / story. Runs independently of Gemini state — even
   when Gemini's daily quota is exhausted, body translation still
   succeeds. Override via `NEWS_TRANSLATE_BODY`:
   - `free` (default) — free Google Translate.
   - `ai` — use Gemini for body translation (paid key recommended).
   - `off` — skip body translation; the detail page falls back to
     `summary.zh`.
6. **Image fallback chain.** RSS feeds carry photos in different
   slots; the pipeline tries `<enclosure>` → `<media:content>` →
   `<media:thumbnail>` → first `<img>` in `content:encoded`. The
   Flutter detail page renders a section-tinted gradient
   placeholder when all four come up empty.
7. **Validates** against `schemas/daily_news.schema.json`,
   regenerates `data/_manifest.json`, commits, **CLI-deploys** to
   Netlify (bypasses the broken Netlify ↔ GitHub clone link), and
   pings the DailyNews build hook so newsbible.netlify.app refreshes.

If Gemini is unavailable (no key, daily quota hit, network error,
malformed JSON), the pipeline falls back to a keyword classifier
that picks a corpus verse mapped to one of 11 themes. The output
schema is identical either way; consumers can't tell which path ran.
Body translation still runs because it's quota-independent.

### Required GitHub secrets

- `OPENAI_API_KEY` (or `GEMINI_API_KEY` / `GEMINI_API_KEYS`) — the
  Gemini key. Without it the refresh still runs but ships keyword-
  picked verses + free-translated body.
- `OPENAI_BASE_URL` — defaults to
  `https://generativelanguage.googleapis.com/v1beta/openai`.
- `OPENAI_MODEL` — defaults to `gemini-2.5-flash` (1500 RPD free
  tier, fast, capable enough for pick-a-verse + reflect). Override
  to `gemini-2.5-pro` if you have a paid key.
- `OPENAI_TRANSLATE_MODEL` — defaults to `gemini-2.5-flash` for the
  paid-AI body-translation path. Only consulted when
  `NEWS_TRANSLATE_BODY=ai`.
- `OPENAI_TEMPERATURE` — defaults to `0.2` for stable verse picks.
- `NETLIFY_AUTH_TOKEN` — required for the CLI-deploy step. Without
  it the workflow falls back to the legacy build-hook trigger, which
  is currently broken because Netlify can't clone the repo
  (`Host key verification failed`).

## Consumers

- **YsWords** (`https://yswords.netlify.app`) — Flutter web/mobile.
  Reads all three datasets via `lib/services/remote_data_service.dart`.
- **(legacy) DailyNews** — `https://newsbible.netlify.app/` is now a
  redirect to YsWords. The `/data/latest-news.json` endpoint is kept
  alive for any external consumer; it just proxies to this repo.

## Validation + tests

```sh
npm run validate   # JSON Schema check, all datasets
npm test           # smoke tests (Node built-in test runner)
npm run build      # validate + regenerate manifest
```

CI runs both on every PR and every push (see
`.github/workflows/validate.yml`).
