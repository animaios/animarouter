import type { NextFunction, Request, Response } from "express";
import { sanitizeProviderErrorMessage } from "../lib/error-redaction.js";

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  console.error("[Error]", err.message);

  if (res.headersSent) return next(err);

  const status = (err as any).status ?? 500;
  res.status(status).json({
    error: {
      message: sanitizeProviderErrorMessage(err.message),
      type: err.name ?? "server_error",
    },
  });
}
