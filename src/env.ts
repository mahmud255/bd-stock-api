import "dotenv/config";

function integer(name: string, fallback: number, min: number, max: number): number {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}.`);
  return value;
}
export interface ApiConfig {
  port: number; dseBaseUrl: string; timeoutMs: number; cacheTtlMs: number; staleTtlMs: number;
  historyTtlMs: number; apiKey: string; corsOrigins: string[]; rateLimit: number; trustProxyHops: number;
}
const upstream = new URL(process.env.DSE_BASE_URL || "https://www.dse.com.bd");
if (!["https:", "http:"].includes(upstream.protocol) || upstream.username || upstream.password ||
    (process.env.NODE_ENV === "production" && upstream.protocol !== "https:")) {
  throw new Error("DSE_BASE_URL must be an HTTP(S) origin without credentials; production requires HTTPS.");
}
export const config: ApiConfig = {
  port: integer("PORT", 4000, 1, 65535), dseBaseUrl: upstream.origin,
  timeoutMs: integer("UPSTREAM_TIMEOUT_MS", 15000, 100, 30000),
  cacheTtlMs: integer("CACHE_TTL_SECONDS", 60, 1, 3600) * 1000,
  staleTtlMs: integer("STALE_TTL_SECONDS", 300, 0, 3600) * 1000,
  historyTtlMs: integer("HISTORY_CACHE_TTL_SECONDS", 3600, 1, 86400) * 1000,
  apiKey: process.env.API_KEY?.trim() || "",
  corsOrigins: (process.env.CORS_ORIGINS || "").split(",").map(v => v.trim()).filter(Boolean),
  rateLimit: integer("RATE_LIMIT_PER_MINUTE", 120, 1, 10000),
  trustProxyHops: integer("TRUST_PROXY_HOPS", 0, 0, 5),
};
