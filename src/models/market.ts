import { ApiError } from "../utils/ApiError";
export type JsonObject = Record<string, unknown>;
export interface Stock {
  trading_code: string; ltp: number | null; open: number | null; high: number | null;
  low: number | null; close: number | null; ycp: number | null; change: number | null;
  change_percent: number | null; trade: number | null; value_mn: number | null; volume: number | null;
  category: string | null; board: string | null; sector: string | null; asset_type: string | null; source: "dse";
}
export interface HistoricalBar {
  trading_code: string; date: string; open: number | null; high: number | null; low: number | null;
  close: number | null; ltp: number | null; ycp: number | null; volume: number | null;
  value_mn: number | null; trade: number | null; source: "dse";
}
export function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(502, "Unexpected DSE response format.", "UPSTREAM_SCHEMA");
  }
  return value as JsonObject;
}
export function number(value: unknown): number | null {
  if (typeof value === "string") {
    const text = value.trim().replace(/,/g, "");
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return null;
    value = Number(text);
  }
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function price(value: unknown) {
  const n = number(value); return n !== null && n > 0 ? n : null;
}
function quantity(value: unknown) {
  const n = number(value); return n !== null && n >= 0 ? n : null;
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
export function decodePrices(value: unknown): { rows: Stock[]; session: unknown } {
  const wire = object(value);
  if (!Array.isArray(wire.cols) || !Array.isArray(wire.rows) || !wire.rows.length ||
      wire.cols.some(c => typeof c !== "string") || new Set(wire.cols).size !== wire.cols.length) {
    throw new ApiError(502, "DSE prices are unavailable or the feed schema changed.", "UPSTREAM_SCHEMA");
  }
  const cols = wire.cols as string[];
  if (!["code", "ltp", "ycp", "volume", "value", "trades"].every(c => cols.includes(c))) {
    throw new ApiError(502, "DSE price columns changed.", "UPSTREAM_SCHEMA");
  }
  const seen = new Set<string>();
  const rows = wire.rows.map(row => {
    if (!Array.isArray(row) || row.length !== cols.length) throw new ApiError(502, "DSE price row has an unexpected shape.", "UPSTREAM_SCHEMA");
    const r = Object.fromEntries(cols.map((c, i) => [c, row[i]]));
    const code = text(r.code)?.toUpperCase();
    if (!code || !/^[A-Z0-9][A-Z0-9._&()-]{0,31}$/.test(code) || seen.has(code)) {
      throw new ApiError(502, "DSE price identifiers are invalid.", "UPSTREAM_SCHEMA");
    }
    seen.add(code);
    const ltp = price(r.ltp), ycp = price(r.ycp);
    const change = ltp !== null && ycp !== null ? ltp - ycp : null;
    return {
      trading_code: code, ltp, ycp, open: price(r.open), high: price(r.high), low: price(r.low), close: price(r.close),
      change: change === null ? null : Number(change.toFixed(6)),
      change_percent: change !== null && ycp !== null ? change / ycp * 100 : null,
      trade: quantity(r.trades), value_mn: quantity(r.value), volume: quantity(r.volume),
      category: text(r.category), board: text(r.board), sector: text(r.sector), asset_type: text(r.assetType), source: "dse" as const,
    };
  });
  if (!rows.some(r => r.ltp !== null)) throw new ApiError(502, "DSE returned no usable prices.", "UPSTREAM_SCHEMA");
  return { rows, session: wire.session ?? null };
}
export function legacyStock(r: Stock) {
  const value = (n: number | null) => n === null ? "" : String(n);
  return {
    "TRADING CODE": r.trading_code, "LTP*": value(r.ltp), HIGH: value(r.high), LOW: value(r.low), "CLOSEP*": value(r.close),
    "YCP*": value(r.ycp), CHANGE: value(r.change), TRADE: value(r.trade), "VALUE (mn)": value(r.value_mn), VOLUME: value(r.volume),
  };
}
