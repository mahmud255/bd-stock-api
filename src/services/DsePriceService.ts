import { AxiosInstance } from "axios";
import { config, ApiConfig } from "../env";
import { createUpstreamClient } from "../utils/axiosConfig";
import { ApiError } from "../utils/ApiError";
import { range, symbol } from "../utils/validation";
import { decodePrices, HistoricalBar, legacyStock, number, object } from "../models/market";
interface Entry<T> { data: T; fetchedAt: number; ttl: number }
export interface Cached<T> {
  data: T;
  meta: { source: "dse"; fetched_at: string; quote_time: null; timezone: "Asia/Dhaka"; cache_age_seconds: number; stale: boolean };
}
export class StockDataService {
  private cache = new Map<string, Entry<unknown>>();
  private pending = new Map<string, Promise<unknown>>();
  private failures = new Map<string, number>();
  private active = 0;
  constructor(
    private settings: ApiConfig = config,
    private client: AxiosInstance = createUpstreamClient(settings),
    private now: () => number = Date.now,
  ) {}
  private envelope<T>(entry: Entry<T>, stale = false): Cached<T> {
    return { data: entry.data, meta: {
      source: "dse", fetched_at: new Date(entry.fetchedAt).toISOString(), quote_time: null,
      timezone: "Asia/Dhaka", cache_age_seconds: Math.floor((this.now() - entry.fetchedAt) / 1000), stale,
    } };
  }
  private async cached<T>(key: string, ttl: number, fetcher: () => Promise<T>): Promise<Cached<T>> {
    const prior = this.cache.get(key) as Entry<T> | undefined;
    const age = prior ? this.now() - prior.fetchedAt : Infinity;
    if (prior && age < ttl) return this.envelope(prior);
    const staleAllowed = prior && age < ttl + this.settings.staleTtlMs;
    if (this.now() - (this.failures.get(key) ?? -Infinity) < 5000) {
      if (staleAllowed) return this.envelope(prior, true);
      throw new ApiError(502, "DSE is temporarily unavailable. Retry shortly.", "UPSTREAM_UNAVAILABLE");
    }
    let inflight = this.pending.get(key) as Promise<Entry<T>> | undefined;
    if (!inflight) {
      if (this.pending.size >= 8) throw new ApiError(503, "Upstream request capacity is busy. Retry shortly.", "UPSTREAM_BUSY");
      inflight = (async () => {
        const entry: Entry<T> = { data: await fetcher(), fetchedAt: this.now(), ttl };
        if (this.cache.size >= 256 && !this.cache.has(key)) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, entry); this.failures.delete(key); return entry;
      })();
      this.pending.set(key, inflight);
    }
    try { return this.envelope(await inflight); }
    catch (error) {
      if (this.failures.size >= 256) this.failures.delete(this.failures.keys().next().value!);
      this.failures.set(key, this.now());
      if (staleAllowed) return this.envelope(prior, true);
      throw error;
    } finally { if (this.pending.get(key) === inflight) this.pending.delete(key); }
  }
  private async request(path: string, params: Record<string, string | number> = {}, asText = false) {
    if (this.active >= 4) throw new ApiError(503, "Upstream request capacity is busy.", "UPSTREAM_BUSY");
    this.active++;
    try {
      const response = await this.client.get(path, { params, responseType: asText ? "text" : "json" });
      return response.data as unknown;
    } catch (error: any) {
      const timeout = error?.code === "ECONNABORTED" || error?.code === "ETIMEDOUT";
      throw new ApiError(timeout ? 504 : 502, timeout ? "DSE request timed out." : "DSE is temporarily unavailable.", "UPSTREAM_UNAVAILABLE");
    } finally { this.active--; }
  }
  latest() {
    return this.cached("prices", this.settings.cacheTtlMs, async () => decodePrices(await this.request("/api/live/prices")));
  }
  market() {
    return this.cached("market", this.settings.cacheTtlMs, async () => {
      const data = object(await this.request("/api/live/market"));
      if (!Array.isArray(data.indices) || !data.indices.length || !data.totals || !data.breadth ||
          !data.indices.some(v => number(object(v).value) !== null)) {
        throw new ApiError(502, "DSE market data is unavailable or changed.", "UPSTREAM_SCHEMA");
      }
      return data;
    });
  }
  instruments() {
    return this.cached("instruments", this.settings.historyTtlMs, async () => {
      const data = object(await this.request("/api/live/data-archive/instruments"));
      if (!Array.isArray(data.instruments) || !data.instruments.length) {
        throw new ApiError(502, "DSE instrument list is unavailable.", "UPSTREAM_SCHEMA");
      }
      return data.instruments;
    });
  }
  members(index: "DSEX" | "DS30") {
    return this.cached("members:" + index, this.settings.historyTtlMs, async () => {
      const data = object(await this.request("/api/live/index-constituents", { code: index }));
      if (!Array.isArray(data.rows) || !data.rows.length) {
        throw new ApiError(502, "DSE index constituents are unavailable.", "UPSTREAM_SCHEMA");
      }
      const codes = data.rows.map(value => object(value).code);
      if (codes.some(code => typeof code !== "string" || !/^[A-Z0-9][A-Z0-9._&()-]{0,31}$/.test(code)) ||
          new Set(codes).size !== codes.length || (index === "DS30" && codes.length !== 30)) {
        throw new ApiError(502, "DSE constituent identifiers changed.", "UPSTREAM_SCHEMA");
      }
      return codes as string[];
    });
  }
  async history(code: string, start: unknown, end: unknown) {
    const tradingCode = symbol(code), dates = range(start, end);
    return this.cached(`history:${tradingCode}:${dates.from}:${dates.to}`, this.settings.historyTtlMs, async () => {
      const raw: unknown[] = []; let page = 1; let total = Infinity;
      do {
        const data = object(await this.request("/api/live/data-archive/day-end", {
          from: dates.from, to: dates.to, inst: tradingCode, page,
        }));
        if (!Array.isArray(data.rows) || !Number.isInteger(data.total) ||
            !Number.isInteger(data.pageSize) || (data.pageSize as number) <= 0 || (data.total as number) < 0) {
          throw new ApiError(502, "DSE history response changed.", "UPSTREAM_SCHEMA");
        }
        total = data.total as number;
        if (total > 400 || page > 20 || (!data.rows.length && raw.length < total)) {
          throw new ApiError(502, "DSE history is incomplete or exceeds request bounds.", "UPSTREAM_SCHEMA");
        }
        raw.push(...data.rows); page++;
      } while (raw.length < total);
      return this.decodeHistory(raw, tradingCode, dates.from, dates.to);
    });
  }
  private decodeHistory(rows: unknown[], code: string, from: string, to: string): HistoricalBar[] {
    const seen = new Set<string>();
    return rows.map(value => {
      const r = object(value), date = typeof r.date === "string" ? r.date.slice(0, 10) : "";
      const tradingCode = String(r.code ?? r.tradingCode ?? "").toUpperCase();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < from || date > to || tradingCode !== code || seen.has(date)) {
        throw new ApiError(502, "DSE history contains invalid identifiers or dates.", "UPSTREAM_SCHEMA");
      }
      seen.add(date);
      const positive = (v: unknown) => { const n = number(v); return n !== null && n > 0 ? n : null; };
      const bar: HistoricalBar = {
        trading_code: code, date, open: positive(r.open ?? r.openp), high: positive(r.high), low: positive(r.low),
        close: positive(r.close ?? r.closep), ltp: positive(r.ltp), ycp: positive(r.ycp),
        volume: number(r.volume), value_mn: number(r.value), trade: number(r.trades ?? r.trade), source: "dse",
      };
      const prices = [bar.open, bar.close].filter(v => v !== null) as number[];
      if (bar.high !== null && bar.low !== null &&
          (bar.high < bar.low || prices.some(v => v > bar.high! || v < bar.low!))) {
        throw new ApiError(502, "DSE history contains inconsistent OHLC values.", "UPSTREAM_SCHEMA");
      }
      return bar;
    }).sort((a, b) => a.date.localeCompare(b.date));
  }
  readiness() {
    const entry = this.cache.get("prices");
    return { ready: !!entry && this.now() - entry.fetchedAt < entry.ttl && !this.failures.has("prices"),
      last_successful_fetch: entry ? new Date(entry.fetchedAt).toISOString() : null };
  }
  async getStockData() { return (await this.latest()).data.rows.map(legacyStock); }
  async getDsexData(code?: string) {
    const [prices, members] = await Promise.all([this.latest(), this.members("DSEX")]);
    return prices.data.rows.filter(r => members.data.includes(r.trading_code) && (!code || r.trading_code === code)).map(legacyStock);
  }
  async getTop30() {
    const [prices, members] = await Promise.all([this.latest(), this.members("DS30")]);
    const rows = prices.data.rows.filter(r => members.data.includes(r.trading_code));
    if (rows.length !== 30) throw new ApiError(502, "DSE constituent prices are incomplete.", "UPSTREAM_SCHEMA");
    return rows.map(legacyStock);
  }
  async getHistData(start: unknown, end: unknown, code: string) {
    return (await this.history(code, start, end)).data.map((r, i) => ({
      "#": i + 1, DATE: r.date, "TRADING CODE": r.trading_code, "LTP*": r.ltp,
      HIGH: r.high, LOW: r.low, "OPENP*": r.open, "CLOSEP*": r.close, "YCP*": r.ycp,
      TRADE: r.trade, "VALUE (mn)": r.value_mn, VOLUME: r.volume,
    }));
  }
}
