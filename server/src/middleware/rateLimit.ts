import type { Request, Response, NextFunction } from 'express';
import { getFeatureSetting } from '../services/feature-settings.js';

// Per-IP fixed-window rate limiter for the public /v1 proxy (#35, item #6).
//
// The /v1 surface authenticates with the unified API key but has no password
// login like the dashboard does, so without this an attacker who can reach the
// server could brute-force the key or flood upstream providers. This caps how
// many requests a single client IP can make per minute and returns a standard
// OpenAI-shaped 429 once the cap is exceeded.
//
// AnimaRouter is a single-user tool, so the default ceiling is generous. Tune it
// with PROXY_RATE_LIMIT_RPM (requests per minute per IP); set it to 0 to turn
// rate limiting off entirely.

const WINDOW_MS = 60_000;
// Bound the IP map so a flood of distinct (e.g. spoofed) source addresses can't
// grow it without limit; expired entries are pruned opportunistically.
const MAX_TRACKED_IPS = 10_000;

interface WindowState {
  count: number;
  resetAt: number;
}

function getLimit(): number {
  const n = getFeatureSetting('proxy_rate_limit_rpm') as number;
  return Math.max(0, Math.floor(n));
}

export function createProxyRateLimiter() {
  const limit = getLimit();
  const windows = new Map<string, WindowState>();

  return function proxyRateLimit(req: Request, res: Response, next: NextFunction): void {
    if (limit === 0) {
      next();
      return;
    }

    const now = Date.now();
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';

    let state = windows.get(ip);
    if (!state || now >= state.resetAt) {
      state = { count: 0, resetAt: now + WINDOW_MS };
      windows.set(ip, state);
    }
    state.count += 1;

    if (windows.size > MAX_TRACKED_IPS) {
      for (const [key, value] of windows) {
        if (now >= value.resetAt) windows.delete(key);
      }
      // If all entries are still active (not expired), evict the oldest window
      // to guarantee the map never exceeds MAX_TRACKED_IPS.
      if (windows.size > MAX_TRACKED_IPS) {
        let oldestKey = '';
        let oldestReset = Infinity;
        for (const [k, v] of windows) {
          if (v.resetAt < oldestReset) {
            oldestReset = v.resetAt;
            oldestKey = k;
          }
        }
        windows.delete(oldestKey);
      }
    }

    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - state.count)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(state.resetAt / 1000)));

    if (state.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((state.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        error: {
          message: `Rate limit exceeded: more than ${limit} requests per minute. Retry in ${retryAfter}s.`,
          type: 'rate_limit_error',
        },
      });
      return;
    }

    next();
  };
}
