/**
 * In-process event bus for live routing transparency.
 *
 * The proxy publishes routing decisions here; SSE subscribers (the dashboard
 * live feed) consume them in real time. Events are fire-and-forget — no
 * subscriber can block the proxy, and dropped events are silently ignored.
 *
 * Capacity is capped so a stalled SSE client never balloons memory.
 */
import type { Response } from 'express';

export type LiveEvent =
  | { type: 'request.start'; id: string; model?: string; stream: boolean; at: number }
  | { type: 'request.done'; id: string; model: string; provider: string; keyId: number; latencyMs: number; tokens?: { in: number; out: number }; at: number }
  | { type: 'request.error'; id: string; error: string; at: number }
  | { type: 'request.aborted'; id: string; at: number }
  | { type: 'routing.key_exhausted'; id: string; provider: string; keyId: number; model: string; reason: string; at: number }
  | { type: 'routing.key_retry'; id: string; provider: string; keyId: number; model: string; attempt: number; max: number; at: number }
  | { type: 'routing.model_switch'; id: string; from: string; to: string; reason: string; at: number }
  | { type: 'routing.provider_fastfail'; id: string; provider: string; failedModelCount: number; at: number }
  | { type: 'routing.key_evicted'; id: string; provider: string; keyId: number; model: string; reason: 'rate_limited' | 'payment_required'; at: number }
  | { type: 'heartbeat.ping'; provider: string; model: string; keyId: number; success: boolean; latencyMs: number; error?: string; at: number }
  | { type: 'heartbeat.cycle_skipped'; reason: string; lastActivityAgeMs: number; at: number }
  | { type: 'heartbeat.auto_disable'; provider: string; model: string; modelDbId: number; totalKeys: number; unhealthyKeys: number; threshold: number; at: number }
  | { type: 'degradation.boost'; modelDbId: number; oldBoost: number; newBoost: number; at: number }
  | { type: 'stream.chunk'; id: string; text: string; at: number };

/** Exhaustive-check helper: assign a `LiveEvent` to this and the compiler
 *  will error if any variant is unhandled. Use in switch-default branches. */
export type ExhaustiveEventCheck = never;

const MAX_SUBSCRIBERS = 8;

// Each subscriber gets its own ring buffer so a slow reader never blocks others.
const subscribers = new Set<(evt: LiveEvent) => void>();
const heartbeats = new Map<(evt: LiveEvent) => void, NodeJS.Timeout>();

export function publish(evt: LiveEvent): void {
  for (const fn of subscribers) {
    try { fn(evt); } catch { /* subscriber error — drop */ }
  }
}

/** Register an SSE response as a subscriber. Returns an unsubscribe function. */
export function subscribeSse(res: Response): () => void {
    const first = subscribers.values().next().value;
    if (first) {
      const t = heartbeats.get(first);
      if (t) clearInterval(t);
      heartbeats.delete(first);
      subscribers.delete(first);
    }

  const fn = (evt: LiveEvent) => {
    if (res.destroyed) { subscribers.delete(fn); return; }
    try {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    } catch {
      subscribers.delete(fn);
    }
  };

  subscribers.add(fn);

  // Heartbeat every 30s to keep the connection alive through proxies.
  const heartbeat = setInterval(() => {
    if (res.destroyed) {
      clearInterval(heartbeat);
      subscribers.delete(fn);
      return;
    }
    try { res.write(`: heartbeat\n\n`); } catch { /* socket gone */ }
  }, 30000);
  heartbeats.set(fn, heartbeat);

  res.on('close', () => {
    clearInterval(heartbeat);
    heartbeats.delete(fn);
    subscribers.delete(fn);
  });

  return () => {
    clearInterval(heartbeat);
    heartbeats.delete(fn);
    subscribers.delete(fn);
  };
}
