import type { NextFunction, Request, Response } from "express";
import { isTrustedRequest } from "../lib/ip-trust.js";
import { validateSession } from "../services/auth.js";

// Gate the /api/* admin surface behind a dashboard session (#35, item #2).
// The token is the opaque session token issued by /api/auth/login|setup, sent
// as `Authorization: Bearer <token>`. The /v1 proxy is NOT gated by this — it
// keeps its own unified-API-key auth for app clients.
//
// Single-user convenience: a caller whose source IP is on the local machine or
// the local network (loopback, RFC1918, link-local, IPv6 ULA / link-local) is
// treated as already authenticated. The dashboard is intended for one operator
// on a trusted network, so the login form is suppressed for those callers.
// Remote callers still need a valid session token. See server/src/lib/ip-trust.ts
// for the full policy and its limitations.
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (isTrustedRequest(req)) {
    next();
    return;
  }
  const token =
    req.headers.authorization?.replace(/^Bearer\s+/i, "") ??
    (req.headers["x-dashboard-token"] as string | undefined);
  const session = validateSession(token);
  if (!session) {
    res.status(401).json({
      error: {
        message: "Authentication required",
        type: "authentication_error",
      },
    });
    return;
  }
  (req as Request & { user?: typeof session }).user = session;
  next();
}
