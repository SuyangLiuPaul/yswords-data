# yswords-data

Central data source for the [YsWords](https://yswords.netlify.app)
Bible study app.

> Live: <https://yswords-data.netlify.app/>

## What's here

| Path | What | Refresh |
|---|---|---|
| `data/bible_evidence.json` | Archaeological / manuscript / scientific / historical entries | Manual edits |
| `data/daily_news.json` | Bilingual world / china / australia headlines + Bible reflections | GitHub Actions, hourly |
| `data/daily_verses.json` | 3,650 daily Bible verse references (10-year cycle) | Manual edits |
| `data/news_verse_corpus.json` | 99 curated verses + tags the daily-news AI matches against | Manual edits |
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
update; cold-cache runs take ~10–16 min with the Gemini free-tier
5 RPM throttle, so a tighter schedule risked the next run queuing
behind a slow predecessor. See `.github/workflows/refresh.yml`.
The script:

1. Pulls 10 RSS feeds (Guardian / BBC / SBS / DW)
2. Dedupes + balances per section (10–18 items each)
3. Loads `data/news_verse_corpus.json` (99 curated verses across 20
   topical categories — war/peace, justice, compassion, leadership,
   creation, hope, persecution, etc.)
4. For each story, runs **one deep-reasoning Gemini call** that:
   - reasons about the story's underlying spiritual / human question,
   - picks the SINGLE best-fitting verse from the catalog,
   - writes a bilingual summary + reflection in one structured response.
5. Caches the AI's verse choice per story id so the same headline keeps
   the same Scripture across the day's four publishing windows.
6. Writes `data/daily_news.json`, validates against schema, regenerates
   `data/_manifest.json`, commits, triggers Netlify rebuilds.

If the AI is unavailable (no key, network error, malformed JSON), the
pipeline falls back to a keyword classifier that maps the story to one
of 11 themes and picks a corpus verse mapped to that theme. The output
schema is identical either way; consumers can't tell which path ran.

### Required GitHub secrets

- `OPENAI_API_KEY` — the Gemini key. Without it the refresh still
  runs but ships English-only summaries from the keyword fallback.
- `OPENAI_BASE_URL` — defaults to
  `https://generativelanguage.googleapis.com/v1beta/openai`
- `OPENAI_MODEL` — defaults to `gemini-2.5-pro` (thinking-capable;
  override to `gemini-2.5-flash` if you want cheaper/faster but
  shallower verse matching).
- `OPENAI_TEMPERATURE` — defaults to `0.2` for stable verse picks
  across consecutive runs.

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
