# BD Stock API

A TypeScript/Express API for building a Bangladesh stock-market website from the current public DSE website feeds.

The previous scraper used retired PHP pages. This version uses the JSON endpoints served by the new DSE website, preserves the existing dashboard routes, and adds normalized stock, index, market and daily-history responses.

This is an unofficial adapter, not an exchange-issued API. It depends on the public website's availability and response formats.

## Run locally

Requires Node.js 22 or newer.

```bash
npm ci
cp .env.example .env
npm run build
npm start
```

Default service URL: `http://localhost:4000`
- Existing dashboard: `http://localhost:4000/`
- API documentation: `http://localhost:4000/docs`
- OpenAPI contract: `http://localhost:4000/openapi.json`

For development: `npm run dev`.

## Website endpoints

Every data endpoint returns `{ success, data, message, meta }`. Missing numeric fields remain null.

| GET endpoint | Purpose |
| --- | --- |
| `/v1/dse/stocks` | All current instrument quotes. Optional `search`, `board`, `category`, `sector` and `limit` (1–1000). |
| `/v1/dse/stocks/GP` | One current instrument; symbol lookup is case-insensitive. |
| `/v1/dse/indices` | DSEX, DS30 and DSES numeric index values. |
| `/v1/dse/market/summary` | Official totals, market breadth and exchange-session information. |
| `/v1/dse/market/movers?type=gainers&limit=20` | Daily `gainers`, `losers`, `volume`, `value` or `trade` rankings. Optional `board`. |
| `/v1/dse/history/GP?start=2026-09-01&end=2026-10-06` | Daily OHLCV archive for one instrument. Both dates required; maximum span 366 days. |
| `/v1/dse/symbols` | Instrument codes available in the historical archive. |
| `/health` | Process liveness; never scrapes DSE. |
| `/ready` | Cached-data readiness; 503 until a fresh, valid price fetch has succeeded. Never initiates a scrape. |

`/stocks` includes equities, funds and debt instruments when present in DSE's feed. Use the actual `board` or `asset_type` values to select the intended universe. `search` matches trading-code text.

Stock fields: `trading_code`, `ltp`, `open`, `high`, `low`, `close`, `ycp`, `change`, `change_percent`, `trade`, `value_mn`, `volume`, `category`, `board`, `sector`, `asset_type`, `source`.

- Prices use BDT.
- `value_mn` uses millions of BDT; divide by 10 to get crore.
- `change_percent` and daily mover rankings use LTP versus yesterday's close, and exclude untraded instruments from movers.
- The market summary uses DSE's own totals and breadth, which can have a different coverage/basis from a filtered quote list.
- Daily historical bars are unadjusted. Sparse price snapshots are not minute candles.

## Compatibility routes

The existing frontend continues to use these header-keyed routes:

| GET endpoint | Meaning |
| --- | --- |
| `/v1/dse/latest` | Latest prices with original table-header keys. |
| `/v1/dse/top30` | DS30 constituent prices, not the largest daily gainers. |
| `/v1/dse/dsexdata?symbol=GP` | DSEX constituent prices. This is not a numeric index response; use `/indices` for index values. |
| `/v1/dse/historical?start=2026-09-01&end=2026-10-06&code=GP` | Original day-end field names for one instrument. |

The unrestricted all-instrument historical query has been replaced with a required `code` to bound scraping work. Original data errors now return explicit non-2xx JSON errors rather than successful empty arrays.

## Data freshness and failures

Inspect these metadata fields:

- `fetched_at`: timezone-aware UTC retrieval time.
- `quote_time`: null when the source does not expose a reliable exact quote timestamp.
- `timezone`: `Asia/Dhaka`, for interpreting source session times.
- `cache_age_seconds`: elapsed time since the successful upstream request.
- `stale`: true when a bounded cached result is used during an upstream failure.
- `session` on stock/index responses: source-provided open/closed state and session date.
- `market_as_of` on index/summary responses: DSE's textual market timestamp.

Retrieving a response today does not mean each stock traded today. Use the source session date and market timestamp alongside retrieval metadata.

A failed request returns `success: false`, `data: null` and a public `error.code/message`. Upstream URLs, credentials and stacks are not included.

HTTP statuses: 400 invalid input, 401 invalid API key, 404 unknown code/route, 429 rate limit, 502 upstream unavailable/schema change, 503 busy capacity, 504 upstream timeout.

The cache deduplicates concurrent requests, bounds its entries and upstream concurrency, and briefly suppresses repeat requests after failure. There is no automatic scraper scheduler and no market-data SQLite file in this API.

## Configuration

See `.env.example`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4000` | HTTP listening port. |
| `DSE_BASE_URL` | `https://www.dse.com.bd` | Current DSE website origin. HTTPS is required in production. |
| `UPSTREAM_TIMEOUT_MS` | `15000` | Per-attempt timeout; one retry for timeouts, connection resets or selected transient responses. Maximum two attempts per page. |
| `CACHE_TTL_SECONDS` | `60` | Quote/market cache life. |
| `STALE_TTL_SECONDS` | `300` | Additional bounded stale-cache window. Set 0 to disable stale fallback. |
| `HISTORY_CACHE_TTL_SECONDS` | `3600` | Archive/instrument/membership cache life. |
| `RATE_LIMIT_PER_MINUTE` | `120` | Data requests per client IP, per process. |
| `TRUST_PROXY_HOPS` | `0` | Number of trusted reverse-proxy hops; configure to match the deployment. |
| `API_KEY` | empty | Optional protection for `/v1/dse/*` using the `X-API-Key` header. |
| `CORS_ORIGINS` | empty | Comma-separated permitted browser origins; credentials are disabled. |

Keep `API_KEY` in a server-side website adapter. If you enable it, the bundled static dashboard needs that adapter because it does not include a secret in browser requests. Health and documentation remain public.

The cache and rate limiter are per process. Start with one API instance. Multiple replicas require shared coordination if aggregate upstream load and client limits must remain global.

## Connect a website

From the website server:

```ts
const response = await fetch(
  process.env.BD_STOCK_API_URL + "/v1/dse/stocks/GP",
  { headers: process.env.BD_STOCK_API_KEY
      ? { "X-API-Key": process.env.BD_STOCK_API_KEY }
      : {} }
);
if (!response.ok) throw new Error("Stock data is unavailable");
const { data, meta } = await response.json();
```

Display the returned source/session/freshness metadata and preserve null values. Refresh no faster than the quote cache cadence, and suspend unnecessary polling in hidden browser tabs.

## Docker

```bash
docker compose up --build -d
```

The service listens on port 4000. The image runs as the non-root `node` user, verifies upstream TLS, and uses `/health` for its container health check.

For a public API URL, deploy this Node/container service to a server/container hosting provider with HTTPS. GitHub stores the code; it does not execute this API. Static-only website hosting cannot run this Express process.

No database is needed for the current read-only API. Account portfolios, alert rules, notifications and persistent histories require additional services if added later.

## Validation

```bash
npm run typecheck
npm test
npm run smoke
npm audit --omit=dev
```

`npm test` uses isolated fixture data and mock upstream clients; it never contacts DSE. Fixtures contain clearly identified test symbols and are never loaded by the production service.

`npm run smoke` explicitly checks the running implementation against live DSE responses. Live checks can fail when the upstream is unavailable. CI runs type checks, offline tests, the runtime dependency audit and a Docker build.

## Data sources

The adapter uses public endpoints observed in the current DSE website:
- `/api/live/prices`
- `/api/live/market`
- `/api/live/index-constituents?code=DS30|DSEX`
- `/api/live/data-archive/instruments`
- `/api/live/data-archive/day-end?from=YYYY-MM-DD&to=YYYY-MM-DD&inst=GP&page=1`

These are website implementation endpoints, not a documented exchange API contract. Schema validation fails explicitly if they change. Company financial statements, news, corporate-action adjustments, minute stock candles and order-book depth are outside this version.
