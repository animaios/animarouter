import type { Request, Response } from "express";
import { Router } from "express";
import { subscribeSse } from "../services/events.js";

export const eventsRouter = Router();

/**
 * GET /api/events — Server-Sent Events stream of live routing activity.
 *
 * The dashboard subscribes to this endpoint for real-time visibility into what
 * the proxy is doing: key exhaustions, retries, model switches,
 * request successes/failures.
 *
 * Auth: requires the dashboard session cookie (same as other /api/* routes).
 * Up to 8 concurrent subscribers; oldest is evicted when the limit is hit.
 */
eventsRouter.get("/", (_req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // nginx: don't buffer

  // Send an initial comment so the client knows the stream is alive.
  res.write(": connected\n\n");

  subscribeSse(res);
});
