/**
 * Log deduplication throttle.
 *
 * Computes a stable "signature" from an event's type + identity fields
 * (excluding volatile fields like `at`, `latencyMs`, `tokens`).
 * If an identical signature is seen within a per-type TTL window, the
 * event is suppressed and a counter is incremented. When the TTL expires
 * and a new event of the same signature arrives, the event is emitted
 * with an added `_suppressed` count showing how many were held back.
 *
 * This keeps the SSE feed informative without drowning the dashboard in repeated "still healthy" or "still unhealthy" heartbeat events.
 */

/** Fields to include in the dedup signature, keyed by event type. */
const SIGNATURE_FIELDS: Record<string, string[]> = {
  'heartbeat.ping': ['type', 'provider', 'model', 'keyId', 'success', 'error'],
  'heartbeat.recheck': ['type', 'provider', 'model', 'keyId', 'success', 'error', 'attempt'],
  'heartbeat.cycle_skipped': ['type', 'reason'],
  'degradation.hit': ['type', 'modelDbId', 'tier'],
  'degradation.recovery': ['type', 'modelDbId'],
};

/** Per-event-type dedup window in milliseconds. */
const DEFAULT_TTLS: Record<string, number> = {
  'heartbeat.ping': 30_000,        // 30s — one per heartbeat cycle
  'heartbeat.recheck': 15_000,     // 15s — recheck debounce
  'heartbeat.cycle_skipped': 60_000, // 60s — don't repeat idle notices
  'degradation.hit': 5_000,        // 5s — dedupe burst 429s
  'degradation.recovery': 10_000,  // 10s — dedupe rapid recoveries
};

const FALLBACK_TTL = 5_000; // 5s default for unlisted types

/**
 * Create a deterministic signature for an event based on its type and identity fields.
 * Volatile fields like timestamps, latency, and token counts are excluded.
 */
function createSignature(evt: Record<string, any>): string {
  const type = evt.type as string;
  const fields = SIGNATURE_FIELDS[type];

  let obj: Record<string, any>;
  if (fields) {
    // Use only the specified fields for this event type
    obj = {};
    for (const field of fields) {
      if (field in evt) {
        obj[field] = evt[field];
      }
    }
  } else {
    // Fallback: use all fields except known volatile ones
    obj = {};
    for (const [key, value] of Object.entries(evt)) {
      if (!['at', 'latencyMs', 'tokens', '_suppressed', 'ttfbMs'].includes(key)) {
        obj[key] = value;
      }
    }
  }

  // Sort keys for deterministic output
  const sortedObj: Record<string, any> = {};
  Object.keys(obj).sort().forEach(key => {
    sortedObj[key] = obj[key];
  });

  return JSON.stringify(sortedObj);
}

export class LogThrottle {
  private ttlOverrides: Record<string, number>;
  private entries: Map<string, { expiresAt: number; suppressed: number }>;

  constructor(ttls?: Record<string, number>) {
    this.ttlOverrides = ttls ?? {};
    this.entries = new Map();
  }

  /**
   * Determine if an event should be emitted based on deduplication rules.
   *
   * @param evt The event to check
   * @param now Optional current timestamp (defaults to Date.now())
   * @returns Object with `emit` boolean and `suppressed` count of duplicates skipped
   */
  shouldEmit(evt: Record<string, any>, now: number = Date.now()): { emit: boolean; suppressed: number } {
    // Lazy eviction: if map gets too large, remove expired entries
    if (this.entries.size > 1000) {
      for (const [key, entry] of this.entries.entries()) {
        if (now >= entry.expiresAt) {
          this.entries.delete(key);
        }
      }
    }

    const signature = createSignature(evt);
    const type = evt.type as string;
    const ttl = this.ttlOverrides[type] ?? DEFAULT_TTLS[type] ?? FALLBACK_TTL;
    const entry = this.entries.get(signature);

    if (!entry || now >= entry.expiresAt) {
      // Either no previous entry or TTL expired
      const suppressed = entry ? entry.suppressed : 0;
      // Reset the entry for this signature
      this.entries.set(signature, { expiresAt: now + ttl, suppressed: 0 });
      return { emit: true, suppressed };
    } else {
      // Still within TTL window, increment suppression counter
      entry.suppressed++;
      return { emit: false, suppressed: 0 };
    }
  }

  /** Clear all throttling state (useful for tests) */
  flush(): void {
    this.entries.clear();
  }

  // Expose for testing
  static createSignature = createSignature;
}
