import { ErrorRequestHandler } from "express";
import { ApiError } from "../utils/ApiError";
export const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) { next(error); return; }
  const known = error instanceof ApiError;
  const status = known ? error.status : error?.type === "entity.parse.failed" ? 400 : 500;
  if (!known && status === 500) console.error("Unhandled API error:", error);
  res.status(status).set("Cache-Control", "no-store").json({
    success: false, data: null,
    error: { code: known ? error.code : status === 400 ? "INVALID_JSON" : "INTERNAL_ERROR",
      message: known ? error.message : status === 400 ? "Invalid JSON request." : "Internal server error." },
  });
};
