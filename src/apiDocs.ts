const parameter = (name: string, location: string, schema: object, required = false) =>
  ({ name, in: location, required, schema });
const str = { type: "string" };
const limit = parameter("limit", "query", { type: "integer", minimum: 1, maximum: 100 });
const code = parameter("symbol", "path", { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._&()-]{0,31}$" }, true);
const dates = ["start", "end"].map(name => parameter(name, "query", { type: "string", format: "date" }, true));
export function openApi(keyEnabled: boolean) {
  const endpoint = (summary: string, parameters: object[] = []) => ({
    get: { summary, parameters, ...(keyEnabled ? { security: [{ ApiKey: [] }] } : {}),
      responses: {
        "200": { description: "Successful response. Inspect meta.stale and meta.fetched_at.",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Envelope" } } } },
        ...Object.fromEntries([400, 401, 404, 429, 502, 503, 504].map(status => [status, {
          description: { 400: "Invalid input", 401: "Invalid API key", 404: "Not found", 429: "Rate limited",
            502: "DSE unavailable or schema changed", 503: "Capacity busy", 504: "DSE timeout" }[status],
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        }])),
      },
    },
  });
  return {
    openapi: "3.0.3", info: { title: "BD Stock API", version: "1.1.0",
      description: "Unofficial adapter to public DSE website feeds. Fetched time is not quote time. Daily history is unadjusted." },
    servers: [{ url: "/" }],
    paths: {
      "/v1/dse/stocks": endpoint("Normalized quotes; includes equities, funds and debt instruments", [
        parameter("search", "query", str), parameter("board", "query", str),
        parameter("category", "query", str), parameter("sector", "query", str),
        parameter("limit", "query", { type: "integer", minimum: 1, maximum: 1000 }),
      ]),
      "/v1/dse/stocks/{symbol}": endpoint("One current instrument", [code]),
      "/v1/dse/indices": endpoint("DSEX, DS30 and DSES values"),
      "/v1/dse/market/summary": endpoint("Official market totals, breadth and session"),
      "/v1/dse/market/movers": endpoint("Rank traded instruments against yesterday's close", [
        parameter("type", "query", { type: "string", enum: ["gainers", "losers", "volume", "value", "trade"] }),
        parameter("board", "query", str), limit,
      ]),
      "/v1/dse/history/{symbol}": endpoint("Daily OHLCV; required range up to 366 days", [code, ...dates]),
      "/v1/dse/symbols": endpoint("Instrument codes available in the archive"),
      "/v1/dse/latest": endpoint("Compatibility: header-keyed prices"),
      "/v1/dse/top30": endpoint("Compatibility: DS30 constituent prices"),
      "/v1/dse/dsexdata": endpoint("Compatibility: DSEX constituent prices, not a numeric index", [parameter("symbol", "query", str)]),
      "/v1/dse/historical": endpoint("Compatibility: one instrument's day-end rows", [...dates, parameter("code", "query", str, true)]),
      "/health": { get: { summary: "Process liveness; makes no upstream request", responses: { "200": { description: "Process is running" } } } },
      "/ready": { get: { summary: "Cached data readiness; makes no upstream request", responses: {
        "200": { description: "Fresh valid prices exist" }, "503": { description: "No fresh valid prices yet" },
      } } },
    },
    components: {
      securitySchemes: { ApiKey: { type: "apiKey", in: "header", name: "X-API-Key" } },
      schemas: {
        Envelope: { type: "object", required: ["success", "data"], properties: {
          success: { type: "boolean", enum: [true] }, data: {},
          message: { type: "string" },
          meta: { type: "object", properties: {
            source: { type: "string", enum: ["dse"] }, fetched_at: { type: "string", format: "date-time" },
            quote_time: { type: "string", nullable: true }, timezone: { type: "string", enum: ["Asia/Dhaka"] },
            cache_age_seconds: { type: "integer" }, stale: { type: "boolean" },
          } },
        } },
        Error: { type: "object", properties: { success: { type: "boolean", enum: [false] },
          data: { nullable: true }, error: { type: "object", properties: { code: str, message: str } } } },
      },
    },
  };
}
export const docsHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>BD Stock API</title>
<style>body{max-width:900px;margin:48px auto;padding:0 24px;font:16px/1.6 system-ui;color:#17263b}
a{color:#1357ab}code,pre{background:#f1f5f9;padding:4px;border-radius:4px}td,th{padding:10px;border-bottom:1px solid #e2e8f0;text-align:left}
table{width:100%}small{color:#516072}</style></head><body><h1>BD Stock API</h1>
<p>Current quotes, market totals, index values and daily historical data from the public DSE website.</p>
<p><a href="/openapi.json">OpenAPI specification</a> · <a href="/health">Service health</a></p>
<table><thead><tr><th>GET endpoint</th><th>Purpose</th></tr></thead><tbody>
<tr><td><code>/v1/dse/stocks</code></td><td>Quotes; filter with search, board, category or sector.</td></tr>
<tr><td><code>/v1/dse/stocks/GP</code></td><td>One instrument.</td></tr>
<tr><td><code>/v1/dse/indices</code></td><td>DSEX, DS30, DSES.</td></tr>
<tr><td><code>/v1/dse/market/summary</code></td><td>Totals, breadth and exchange session.</td></tr>
<tr><td><code>/v1/dse/market/movers?type=gainers</code></td><td>Gainers, losers, volume, value or trade rankings.</td></tr>
<tr><td><code>/v1/dse/history/GP?start=2026-09-01&amp;end=2026-10-06</code></td><td>Daily history; maximum 366-day range.</td></tr>
<tr><td><code>/v1/dse/symbols</code></td><td>Archive instrument list.</td></tr></tbody></table>
<p>When API_KEY is configured, send <code>X-API-Key</code> from your server. Keep it out of frontend code.</p>
<p><code>meta.fetched_at</code> is retrieval time, <code>meta.quote_time</code> is null when unknown, and
<code>meta.stale</code> identifies cached data served during a temporary upstream failure.</p>
<p>Prices use BDT; <code>value_mn</code> uses millions of BDT. History is daily and unadjusted.</p>
<small>Unofficial service. DSE's public website feeds can change; this API reports unavailable data explicitly.</small>
</body></html>`;
