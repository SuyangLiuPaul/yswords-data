# yswords-data

Central data source for the [YsWords](https://yswords.netlify.app)
Bible study app.

> Live: <https://yswords-data.netlify.app/>

## What's here

| Path | What | Refresh |
|---|---|---|
| `data/bible_evidence.json` | 209 archaeological / manuscript / scientific / historical entries | Manual edits |
| `data/daily_news.json` | Bilingual world / china / australia headlines + Bible reflections | GitHub Actions, 4× / day Sydney time |
| `data/daily_verses.json` | 3,650 daily Bible verse references (10-year cycle) | Manual edits |
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

GitHub Actions runs hourly but only writes/commits at four Sydney
hours. See `.github/workflows/refresh.yml`. The script:

1. Pulls 10 RSS feeds (Guardian / BBC / SBS / DW)
2. Dedupes + balances per section (10–18 items each)
3. Calls Gemini via OpenAI-compatible endpoint for bilingual
   translations + reflection
4. Writes `data/daily_news.json`
5. Validates against the schema
6. Regenerates `data/_manifest.json`
7. Commits with message `chore: refresh daily news`

### Required GitHub secrets

- `OPENAI_API_KEY` — the Gemini key. Without it the refresh still
  runs but ships English-only summaries (graceful degrade).
- `OPENAI_BASE_URL` — defaults to
  `https://generativelanguage.googleapis.com/v1beta/openai`
- `OPENAI_MODEL` — defaults to `gemini-2.5-flash`

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
