import { ApiError } from "./ApiError";
export function symbol(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z0-9][A-Z0-9._&()-]{0,31}$/i.test(value.trim())) {
    throw new ApiError(400, "A valid trading code is required.", "INVALID_SYMBOL");
  }
  return value.trim().toUpperCase();
}
export function date(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(400, `${name} must be YYYY-MM-DD.`, "INVALID_DATE");
  }
  const parsed = new Date(value + "T00:00:00Z");
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ApiError(400, `${name} must be a valid date.`, "INVALID_DATE");
  }
  return value;
}
export function range(start: unknown, end: unknown, maxDays = 366) {
  const from = date(start, "start"), to = date(end, "end");
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  if (days < 0 || days > maxDays) {
    throw new ApiError(400, `The date range must be ordered and no longer than ${maxDays} days.`, "INVALID_RANGE");
  }
  return { from, to };
}
export function count(value: unknown, fallback = 20, max = 100): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) {
    throw new ApiError(400, `limit must be an integer between 1 and ${max}.`, "INVALID_LIMIT");
  }
  return Number(value);
}
export function scalar(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 100) {
    throw new ApiError(400, `${name} must be a single string of at most 100 characters.`, "INVALID_QUERY");
  }
  return value;
}
