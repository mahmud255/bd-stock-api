import { Router, Request, Response, NextFunction } from "express";
import { StockDataService, Cached } from "../services/DsePriceService";
import { ApiError } from "../utils/ApiError";
import { count, scalar, symbol } from "../utils/validation";
import { number, object, Stock } from "../models/market";

const asyncRoute = (handler: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { Promise.resolve(handler(req, res)).catch(next); };
function send<T>(res: Response, result: Cached<T>, extra = {}) {
  res.set("Cache-Control", "no-store");
  return res.json({ success: true, data: result.data, message: "", meta: { ...result.meta, ...extra } });
}

export function dseRouter(service: StockDataService) {
  const router = Router();
  router.get("/hello", (_req, res) => res.json({ message: "Hello World" }));

  router.get("/stocks", asyncRoute(async (req, res) => {
    const search = scalar(req.query.search, "search")?.trim().toUpperCase();
    const board = scalar(req.query.board, "board")?.toUpperCase();
    const category = scalar(req.query.category, "category")?.toUpperCase();
    const sector = scalar(req.query.sector, "sector");
    const limit = count(req.query.limit, 1000, 1000);
    const result = await service.latest();
    const rows = result.data.rows.filter(r => (!search || r.trading_code.includes(search)) &&
      (!board || r.board === board) && (!category || r.category === category) &&
      (!sector || r.sector?.toLowerCase() === sector.toLowerCase()));
    return send(res, { ...result, data: rows.slice(0, limit) }, {
      session: result.data.session, total: rows.length, returned: Math.min(limit, rows.length),
      change_basis: "ltp_vs_ycp",
    });
  }));
  router.get("/stocks/:symbol", asyncRoute(async (req, res) => {
    const code = symbol(req.params.symbol), result = await service.latest();
    const stock = result.data.rows.find(r => r.trading_code === code);
    if (!stock) throw new ApiError(404, "Trading code was not found in the current price feed.", "SYMBOL_NOT_FOUND");
    return send(res, { ...result, data: stock }, { session: result.data.session, change_basis: "ltp_vs_ycp" });
  }));
  router.get("/indices", asyncRoute(async (_req, res) => {
    const result = await service.market();
    const indices = (result.data.indices as unknown[]).map(v => {
      const i = object(v);
      return { symbol: i.key, value: number(i.value), change: number(i.change),
        change_percent: number(i.percent), previous: number(i.prev) };
    });
    return send(res, { ...result, data: indices }, { session: result.data.session, market_as_of: object(result.data.totals).tradeTime ?? null });
  }));
  router.get("/market/summary", asyncRoute(async (_req, res) => {
    const result = await service.market();
    const t = object(result.data.totals), b = object(result.data.breadth);
    const valueMn = number(t.turnover), cap = number(t.marketCap);
    return send(res, { ...result, data: {
      trade: number(t.trades), volume: number(t.volume), value_mn: valueMn,
      value_crore: valueMn === null ? null : valueMn / 10,
      market_cap_bdt: cap, market_cap_mn: cap === null ? null : cap / 1000000,
      advanced: number(b.advanced), declined: number(b.declined), unchanged: number(b.unchanged),
      traded_instruments: number(b.traded), session: result.data.session,
      market_as_of: t.tradeTime ?? null,
    } });
  }));
  router.get("/market/movers", asyncRoute(async (req, res) => {
    const type = scalar(req.query.type, "type") || "gainers", limit = count(req.query.limit);
    const board = scalar(req.query.board, "board")?.toUpperCase();
    if (!["gainers", "losers", "volume", "value", "trade"].includes(type)) {
      throw new ApiError(400, "type must be gainers, losers, volume, value or trade.", "INVALID_MOVER_TYPE");
    }
    const result = await service.latest();
    let rows = result.data.rows.filter(r => (!board || r.board === board) && r.ltp !== null &&
      (r.trade ?? 0) > 0);
    let key: keyof Stock;
    if (type === "gainers" || type === "losers") {
      key = "change_percent";
      rows = rows.filter(r => r.change_percent !== null && (type === "gainers" ? r.change_percent > 0 : r.change_percent < 0));
    } else key = type === "value" ? "value_mn" : type === "volume" ? "volume" : "trade";
    rows = rows.filter(r => typeof r[key] === "number");
    rows.sort((a, b) => {
      const av = a[key] as number, bv = b[key] as number;
      return (type === "losers" ? av - bv : bv - av) || a.trading_code.localeCompare(b.trading_code);
    });
    return send(res, { ...result, data: rows.slice(0, limit) }, {
      session: result.data.session, ranking: type, change_basis: "ltp_vs_ycp", total: rows.length,
    });
  }));
  router.get("/history/:symbol", asyncRoute(async (req, res) => {
    const result = await service.history(symbol(req.params.symbol), req.query.start, req.query.end);
    return send(res, result, { interval: "1d", adjusted: false, coverage: "source_returned_rows", total: result.data.length });
  }));
  router.get("/symbols", asyncRoute(async (_req, res) => send(res, await service.instruments())));

  // Preserve the original dashboard's routes and header-keyed payloads.
  router.get("/latest", asyncRoute(async (_req, res) => {
    const result = await service.latest();
    const { legacyStock } = await import("../models/market");
    return send(res, { ...result, data: result.data.rows.map(legacyStock) }, { session: result.data.session });
  }));
  router.get("/top30", asyncRoute(async (_req, res) =>
    res.json({ success: true, data: await service.getTop30(), message: "" })));
  router.get("/dsexdata", asyncRoute(async (req, res) =>
    res.json({ success: true, data: await service.getDsexData(req.query.symbol === undefined ? undefined : symbol(req.query.symbol)), message: "" })));
  router.get("/historical", asyncRoute(async (req, res) =>
    res.json({ success: true, data: await service.getHistData(req.query.start, req.query.end, symbol(req.query.code)), message: "" })));
  return router;
}
