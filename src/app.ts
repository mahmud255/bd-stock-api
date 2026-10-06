import express, { RequestHandler } from "express";
import cors from "cors";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { config, ApiConfig } from "./env";
import { StockDataService } from "./services/DsePriceService";
import { dseRouter } from "./controllers/DseController";
import { errorHandler } from "./middlewares/ErrorMiddleware";
import { ApiError } from "./utils/ApiError";
import { openApi, docsHtml } from "./apiDocs";

function access(settings: ApiConfig): RequestHandler {
  const clients = new Map<string, { count: number; reset: number }>();
  return (req, res, next) => {
    if (settings.apiKey) {
      const supplied = req.get("X-API-Key") || "";
      const a = Buffer.from(supplied), b = Buffer.from(settings.apiKey);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        next(new ApiError(401, "A valid X-API-Key header is required.", "UNAUTHORIZED")); return;
      }
    }
    const now = Date.now(), key = req.ip || "unknown";
    if (clients.size >= 10000) for (const [ip, entry] of clients) if (entry.reset <= now) clients.delete(ip);
    if (clients.size >= 10000 && !clients.has(key)) {
      next(new ApiError(503, "Request capacity is busy.", "API_BUSY")); return;
    }
    let entry = clients.get(key);
    if (!entry || entry.reset <= now) { entry = { count: 0, reset: now + 60000 }; clients.set(key, entry); }
    entry.count++;
    if (entry.count > settings.rateLimit) {
      res.set("Retry-After", String(Math.max(1, Math.ceil((entry.reset - now) / 1000))));
      next(new ApiError(429, "Too many requests. Retry shortly.", "RATE_LIMITED")); return;
    }
    next();
  };
}

export function createApp(service = new StockDataService(), settings: ApiConfig = config) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", settings.trustProxyHops);
  app.use((_req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer");
    next();
  });
  app.use(cors({
    origin: (origin, callback) => callback(null, !!origin && settings.corsOrigins.includes(origin)),
    methods: ["GET", "HEAD", "OPTIONS"], allowedHeaders: ["X-API-Key", "Content-Type"], credentials: false,
  }));
  app.use(express.json({ limit: "16kb" }));
  app.get("/health", (_req, res) => res.set("Cache-Control", "no-store").json({
    status: "ok", service: "bd-stock-api", version: "1.1.0", timestamp: new Date().toISOString(),
  }));
  app.get("/ready", (_req, res) => {
    const status = service.readiness();
    res.status(status.ready ? 200 : 503).set("Cache-Control", "no-store").json(status);
  });
  app.get("/openapi.json", (_req, res) => res.json(openApi(!!settings.apiKey)));
  app.get("/docs", (_req, res) => res.type("html").send(docsHtml));
  app.use("/v1/dse", access(settings), dseRouter(service));
  app.use("/v1", (_req, _res, next) => next(new ApiError(404, "API route was not found.", "NOT_FOUND")));
  app.use(express.static(path.join(__dirname, "../../public")));
  app.use((_req, _res, next) => next(new ApiError(404, "Route was not found.", "NOT_FOUND")));
  app.use(errorHandler);
  return app;
}

if (require.main === module) {
  const server = createApp().listen(config.port, "0.0.0.0", () =>
    console.log(`BD Stock API listening on port ${config.port}; docs at /docs`));
  const stop = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
