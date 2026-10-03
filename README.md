# Receipt Ledger

A mobile-first, self-hosted expense tracker written in TypeScript, running on Bun
with PostgreSQL. Capture receipts quickly, let a vision model extract their line
items in the background, and correct everything before using it in your reports.

## What works

- Camera capture and multiple image uploads (JPEG, PNG, WebP).
- Optional photo confirmation, remembered in the browser.
- Independent uploads: start the next photo without waiting for extraction.
- Durable PostgreSQL jobs, bounded retries, lease recovery, and stale-worker fencing.
- OpenAI-compatible vision extraction with validated structured output.
- Editable shop, purchase date, currency, total, notes, every product field,
  quantities, prices, categories, brands/manufacturers, discounts, and fees.
- Compact line-item summaries; expand only the items you want to edit.
- Settings for categories (rename/archive/unarchive) and merchant grouping rules.
- Headless UI controls, keyboard-accessible tabs/disclosures, and focused dialogs,
  styled with the application's shared CSS rather than a separate CSS framework.
- Daily, Monday-based weekly, and monthly statistics; date, shop, category,
  brand, and manufacturer filters. Currencies are always separate.
- Responsive capture, receipt editor, settings, and insights pages.

This first version is **single-user with authentication delegated to the reverse
proxy**. The application itself has no login. Do not expose it directly to the
internet or untrusted networks. Receipt images and financial data are private.

## Run with Docker

Requires Docker Engine and Docker Compose.

1. Copy `.env.example` to `.env`.
2. Set `POSTGRES_PASSWORD` to a long random alphanumeric value.
3. Supply `AI_API_BASE_URL`, `AI_API_KEY`, and `AI_MODEL` in your private `.env`.
   Never commit API keys. The base URL should include the provider's API prefix,
   e.g. `https://api.openai.com/v1`, not `/chat/completions`.
4. Start:

   ```sh
   docker compose up -d --build
   ```

5. Open `http://localhost:3000`, or configure your authenticated reverse proxy.

Compose runs two containers: the application and PostgreSQL 17. The app serves
the built React UI, API, and worker in one process. Migrations run automatically
under a PostgreSQL advisory lock at startup. The image runs as the non-root `bun`
user. Bun is pinned to **1.4.2**, the installed stable version used for validation;
change `BUN_VERSION` when upgrading and rerun the checks before deploying.

The app binds to the host's loopback interface by default. PostgreSQL is not
published to the host. Named volumes persist both PostgreSQL data and uploaded
images. **Back up both volumes**; database-only backups cannot restore originals.
Do not use `docker compose down -v` unless you intend to erase all stored data.

If AI credentials/model are absent, uploads are still accepted and safely queued.
The capture page displays a setup notice. Set the variables and recreate the app
container (`docker compose up -d app`) to begin processing.

### Reverse proxy

TLS termination and authentication belong at the reverse proxy. Preserve the
original `Host` header; browser write requests are checked against it. Protect
**all routes**, including `/api`, receipt images, and the frontend. Same-origin
checks are not authentication.

Example routing **inside an already authenticated nginx server block**:

```nginx
location / {
    client_max_body_size 17m;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:3000;
}
```

Adjust the proxy body limit if `MAX_UPLOAD_MB` changes. If the reverse proxy is
another container, attach it to the Compose network and use `app:3000` rather
than container-local `127.0.0.1`. No internal TLS is needed. Serve the browser
over HTTPS at the proxy for privacy and full mobile browser capabilities.

### Configuration

| Variable | Default / meaning |
| --- | --- |
| `DATABASE_URL` | Required for native Bun; Compose constructs it internally |
| `POSTGRES_PASSWORD` | Required by Compose; use alphanumeric characters for URL interpolation |
| `AI_API_BASE_URL` | `https://api.openai.com/v1` |
| `AI_API_KEY` | Empty; provide privately |
| `AI_MODEL` | Empty; choose a vision-capable model from your provider |
| `AI_RESPONSE_FORMAT` | `json_schema`; explicitly use `json_object` for providers without strict schema support |
| `AI_TIMEOUT_SECONDS` | `90`, range 1–600 |
| `AI_MAX_CONCURRENCY` | `2`, range 1–10 per app process |
| `MAX_UPLOAD_MB` | `15`, range 1–50 |
| `UPLOAD_DIR` | `./data/uploads` natively; `/app/data/uploads` in Docker |
| `HOST` | Native bind address `127.0.0.1`; image uses `0.0.0.0` inside the container |
| `PORT` | Native HTTP port, `3000` |
| `APP_PORT` | Published Compose host port, `3000` |
| `BUN_VERSION` | Docker runtime/build version, `1.4.2` |

If raising the AI timeout above 90 seconds, also increase Compose's
`stop_grace_period` beyond the timeout to allow graceful shutdown. Even a forced
shutdown is recovered by job leases on restart; the external model request may
be repeated and billed twice. No distributed system can promise exactly-once
calls to a third-party API without that provider's idempotency support.

## Capture and review

1. Take a photo or choose files. If confirmation is enabled, inspect the preview
   and confirm or discard it.
2. Wait for **Saved** before leaving the app. Uploading/failed/preview files live
   only in memory; a refresh or closed tab loses those pending local files.
3. Continue capturing while processing runs in the background.
4. Open a receipt to view its original and edit the extracted fields. Line items
   start as compact rows with quantity, category, and subtotal. Expand a row to
   edit all its fields; collapsing it retains your draft. New items open for editing.
5. Choose **Save · Ready** or **Save · Needs review**.
6. After checking a receipt, choose **Mark as reviewed**. In the receipt list,
   filter **Review status → Not reviewed** to find the ones you still need to check.
   The filter stays selected when you return from receipt details.

Review tracking is separate from extraction status: even a `Ready` receipt starts
as **Not reviewed**. Opening or saving it does not mark it reviewed automatically.
The flag is saved in the database for the shared ledger, not separately per browser
or person. You can **Mark as not reviewed** to revisit a receipt. Save unsaved edits
before changing the flag; queued/processing receipts must finish first.
Existing receipts start as not reviewed when the migration runs, since previous
reviews were not tracked. Redetection/retry resets the flag for another check.

`Ready` requires a date, currency, total, at least one line item, known line and
adjustment amounts, and reconciliation within **0.01 currency units**. AI warnings
also trigger review. This is a consistency check, not a guarantee that AI text
recognition is correct. Saving a manual correction recalculates structural
warnings; review the original before marking it ready.

Unknown amounts remain blank/null, never silently zero. Discounts are signed
negative amounts; deposits/fees have their actual sign. Do not add tax twice.
Printed descriptions are retained separately from normalized product names.
Unknown brand/manufacturer stays empty rather than being inferred from a brand.

Purchase dates preserve the receipt's printed local calendar date. The extraction
prompt never converts it to UTC or the server/browser timezone, even when a
printed offset would cross midnight in UTC. A missing timezone does not invalidate
a legible date; genuinely ambiguous dates remain unknown with a warning. The app
stores dates only, not purchase times or timezone identifiers. These instructions
apply to new extractions; use **Redetect receipt** to reprocess an existing receipt.

Pending/processing receipts are locked for editing and redetection. On the receipt
details page, choose **Redetect receipt** to extract again from the original image,
including after manual edits or a failed extraction. Confirming discards unsaved
changes; successful extraction replaces the saved detected details, items, and
adjustments, but keeps saved notes. Existing saved details are retained until
extraction succeeds. Concurrent edits and actions use revision checks; a conflict
retains your draft and offers an explicit refresh.

Choose **Delete receipt** on the same page to permanently remove a receipt, its
items, extraction history, and original image. Deletion requires confirmation and
is also available while processing; a late extraction cannot restore a deleted
receipt. The receipt disappears from the ledger and statistics. If image cleanup
fails after database deletion, the app warns you and the server logs identify the
orphaned image for administrator cleanup.

## Merchant grouping

Open **Settings → Merchants** to add, edit, or delete grouping rules. The default
rule groups `REWE Viettz ihr Frischemarkt` and other `REWE …` branches as `REWE`.
Merchant rules group shops without changing the printed `merchantName` or extraction
data. Receipt summaries and details expose a derived `merchantGroup` (a canonical
name, or `null` when no rule matches). Changes apply on the next request to both
existing and newly extracted receipts; no re-extraction or backfill is needed.

Rules contain `id`, `matchName`, `merchantName` (canonical group), and `matchType`
(`exact` or `prefix`). Matching ignores case and trims/collapses whitespace. Prefixes
match complete whitespace-separated tokens: `REWE` matches
`REWE Viettz ihr Frischemarkt`, but not `REWEX`. Exact matches win; otherwise the
longest matching prefix wins, with rule ID as a deterministic final tie-breaker.
The migration seeds a `REWE` → `REWE` prefix rule once. You can edit or delete it;
restarting or rerunning migrations will not restore a deleted seed.

API:
- `GET /api/merchant-rules` → `{ rules: MerchantRule[] }`
- `POST /api/merchant-rules` → `{ rule: MerchantRule }` (201)
- `PATCH /api/merchant-rules/:id` → `{ rule: MerchantRule }` (200)
- `DELETE /api/merchant-rules/:id` → 204

POST and PATCH require all three fields: `{ matchName, merchantName, matchType }`.
Names are normalized for whitespace and must contain 1–200 characters. An identical
case-insensitive normalized match with the same match type returns 409, including
concurrent writes; exact and prefix rules may coexist for the same match name.
Invalid input/UUID/JSON returns 400, and missing rule IDs return 404.

Statistics combine merchant totals by canonical group, falling back to the printed
name (or `Unknown`). The merchant filter is a case-insensitive, whitespace-normalized
substring search over **either** canonical or printed name. Currency separation and
item-filter accounting are unchanged. Receipt-list/detail reads and statistics use
repeatable-read snapshots so one response cannot mix old and new rule sets.

## Statistics rules

- Only `Ready` receipts count by default. `Needs review` is an explicit opt-in.
- Dates use the printed purchase date, not upload time; bounds are inclusive.
- Main totals, timeline, and shop breakdown use printed receipt totals.
- Applying a category, brand, or manufacturer filter switches these to matching
  **item subtotals**, clearly labeled in the UI.
- Category/brand/manufacturer breakdowns always use item subtotals. Receipt-level
  discounts and fees are **not allocated** among products.
- Shop filtering is case-insensitive substring matching. Brand/manufacturer
  filtering is case-insensitive exact matching.
- `excludedReceipts` counts status-eligible, otherwise-matching receipts missing
  a date, currency, or receipt total. Date-less receipts cannot match a date
  filter. Nonmatching items/statuses are not exclusions. Unknown item amounts are
  omitted from breakdowns, so review-inclusive reports may be partial.
- Decimal strings cross API/database boundaries; sums use decimal arithmetic,
  not floating point. There is no currency conversion.

## Native development

Install Bun, then:

```sh
bun install --frozen-lockfile
cp .env.example .env
# Edit .env: password, native DATABASE_URL, and optional AI configuration.
docker compose -f compose.yaml -f compose.dev.yaml up -d db
bun run dev
```

In another terminal:

```sh
bun run dev:web
```

Open Vite's printed URL (normally `http://localhost:5173`). Vite proxies `/api`
to Bun on port 3000. Bun automatically loads `.env`. Alternatively, build once
with `bun run build` and use `bun start` to serve everything from port 3000.

## Verification

```sh
bun run typecheck
bun test
bun run build
docker compose --env-file .env.example config --quiet
```

For browser UI checks without PostgreSQL or AI, run `bun run test:ui`. This builds
the app and tests mocked API workflows at mobile and desktop widths: a 25-item
receipt, preserved edits, keyboard interaction, settings CRUD/errors, focus
restoration, receipt redetection/deletion confirmations and errors, and locked
processing receipts. Use `PLAYWRIGHT_CHANNEL=msedge` or
`chrome` for an installed browser, or install Chromium with
`bunx --bun playwright install chromium`. `SCREENSHOT_PATH` optionally saves the
mobile receipt editor. These checks supplement, not replace, the database suite.

The same command also uses synthetic API fixtures to exercise capture confirmation, navigation,
receipt review, unsaved-edit protection, insights, and categories at 320, 390,
844, and 1365px widths. It also checks keyboard access and horizontal overflow.
Set `UI_SCREENSHOT_DIR` to save synthetic-data desktop and mobile screenshots.

The UI takes inspiration from [Expensify’s scan-first workflow](https://use.expensify.com/expense-management)
and [green / neutral product palette](https://github.com/Expensify/App/blob/main/src/styles/theme/colors.ts).
Receipt Ledger keeps its own branding, original receipt illustration, and existing
single-user workflow; it does not imply Expensify integration or affiliation.

Without `TEST_DATABASE_URL`, real-database tests are explicitly skipped. For full
verification, provision a **dedicated migrated test database with no other
workers**. Tests use unique rows and remove their own data, but worker claims
could otherwise consume unrelated pending jobs.

```sh
# Supply a private TEST_DATABASE_URL in your shell.
DATABASE_URL="$TEST_DATABASE_URL" bun run db:migrate
bun test
bunx --bun playwright install chromium
bun run test:browser
```

The browser smoke script runs the built application on an ephemeral local port
and checks mobile and desktop capture, confirmation, upload, extraction,
correction, statistics filters, and category archival. Set `PLAYWRIGHT_CHANNEL`
to `msedge` or `chrome` to use an already-installed browser instead. Optional
`SCREENSHOT_PATH` saves a mobile insights screenshot.

AI requests in tests are mocked. No live API key, expense data, or paid model
calls are needed. Real PostgreSQL 17 and a Chromium-based browser were used for
the initial end-to-end verification. A live provider test and Docker image
build/run still need validation in an environment with configured credentials
and a running Docker Engine.

## AI diagnostics and OpenRouter

For OpenRouter, set `AI_API_BASE_URL=https://openrouter.ai/api/v1` and set
`AI_MODEL` to its full model identifier. The model must support image input and
the selected response format. `json_object` changes the provider request format;
it does not turn off application-side validation or repair malformed output.

The **backend terminal** (`bun start` or `bun run dev`, not Vite's terminal)
prints JSON log lines automatically. In Docker, use `docker compose logs -f app`.
Restart the backend after changing environment configuration, then use **Retry
extraction** on the failed, unedited receipt to generate a new attempt.

Follow a receipt's `receiptId`/`jobId` and each AI call's `requestId`:

- `receipt.job.started`: the worker claimed a saved receipt.
- `ai.request.started`: outgoing endpoint, model, format, and image byte count.
  This records the attempt, not proof that a provider received it.
- `ai.response.received`: HTTP status and provider request ID when available.
- `ai.request.completed`: validated output, duration, item count, and provider
  generation ID when available. This is not yet a database commit.
- `ai.request.failed`: safe error message and the exact failure `stage`.
- `receipt.job.completed`, `receipt.job.retry_scheduled`, or
  `receipt.job.failed`: committed database outcome.

Failure stages distinguish network/timeout errors, HTTP rejection, invalid
response JSON, missing message content, malformed receipt JSON, truncation,
refusal, provider errors (including HTTP 200 error envelopes), and application
schema validation. For `application_schema`, `issues` shows field paths and
expected types, for example `total (invalid_type; expected string)`, rather than
claiming every problem is unsupported structured output.

Logs omit API keys, authorization headers, URL credentials/query strings, image
data, prompts, and raw receipt/provider text. Do not paste private raw responses
into shared threads. Raw responses remain in `extraction_runs.raw` in PostgreSQL
for private inspection; validation errors are also saved on the receipt.
Existing failures are not replayed into logs at startup. These application logs
do not control what appears in OpenRouter's activity dashboard.

## Code map and operational limits

- `src/shared/contracts.ts`: shared validation and HTTP contract.
- `src/server/app.ts`: receipt/category/merchant-rule/statistics API.
- `src/server/worker.ts`: durable jobs, leases, retries, and atomic completion.
- `src/server/ai/extractor.ts`: provider adapter, prompt, schema, safe errors.
- `src/server/services/`: reconciliation, statistics, durable image writes.
- `src/server/db/`: relational schema and checksum-protected SQL migrations.
- `src/client/`: React UI and responsive styles.
- `scripts/browser-smoke.ts`, `scripts/ui-smoke.ts`, `tests/`: browser, unit, and
  integration checks.

Original images and raw AI outputs remain stored. Configuring AI means receipt
images are sent to that provider; its retention/privacy policy applies. Use disk
encryption and protected backups where required. Provider keys stay server-side.

Files are synchronized before the database references them (directory fsync on
Linux). On uncertain database commit outcomes, a potential orphan is deliberately
retained rather than risking deletion of a committed original. There is no
automated orphan sweep yet. Do not delete suspected orphans while uploads run.

This MVP supports one image per receipt, purchase dates (not times), flat
categories, and an OpenAI-compatible Chat Completions vision API. No HEIC/PDF
conversion, learned category rules, offline
uploads, receipt deletion, CSV export, built-in accounts, or multi-page receipts
yet. Statistics aggregate selected receipt data in process; very large datasets
will eventually warrant SQL aggregation. Multiple app replicas must share the
same upload volume as well as PostgreSQL.
