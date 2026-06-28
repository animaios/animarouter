import { getSetting, setSetting } from "../db/index.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface FeatureSettingDef {
  key: string;
  label: string;
  description: string;
  type: "boolean" | "number" | "string";
  default: boolean | number | string;
  min?: number;
  max?: number;
  options?: string[];
  envVar?: string;
  effect: "live" | "restart";
  group: string;
  /** For number/string settings paired with a boolean/string toggle: the toggle's key. */
  parentToggle?: string;
  /** For settings that should be disabled when another setting is ON (inverse of parentToggle). */
  disableWhen?: string;
}

// ── Registry ───────────────────────────────────────────────────────────────

export const REGISTRY: FeatureSettingDef[] = [
  // ── Rate Limiting ──
  {
    key: "proxy_rate_limit_rpm",
    label: "Proxy Rate Limit (RPM)",
    description:
      "Maximum requests per minute per client IP for the /v1 proxy. Set to 0 to disable rate limiting entirely.",
    type: "number",
    default: 120,
    min: 0,
    max: 10000,
    envVar: "PROXY_RATE_LIMIT_RPM",
    effect: "restart",
    group: "Rate Limiting",
  },
  // ── Resilience ──
  {
    key: "provider_fastfail_enabled",
    label: "Provider-Outage Fast-Fail",
    description:
      "When ≥N distinct models on the same provider return 5xx within one request, skip all remaining models from that provider.",
    type: "boolean",
    default: true,
    envVar: "PROVIDER_FASTFAIL_ENABLED",
    effect: "restart",
    group: "Resilience",
  },
  {
    key: "provider_fastfail_threshold",
    label: "Fast-Fail Threshold",
    description:
      "Number of distinct models on one provider that must 5xx before the provider is skipped. Set to 0 to disable.",
    type: "number",
    default: 2,
    min: 0,
    max: 10,
    envVar: "PROVIDER_FASTFAIL_THRESHOLD",
    effect: "restart",
    group: "Resilience",
    parentToggle: "provider_fastfail_enabled",
  },
  {
    key: "heartbeat_enabled",
    label: "Provider Health Heartbeat",
    description:
      "Send periodic health-check pings to each provider. Feeds the degradation engine so the router avoids sick providers proactively.",
    type: "boolean",
    default: false,
    envVar: "HEARTBEAT_ENABLED",
    effect: "restart",
    group: "Resilience",
  },
  {
    key: "heartbeat_interval_min",
    label: "Heartbeat Interval",
    description: "Minutes between health-check ping cycles.",
    type: "number",
    default: 10,
    min: 1,
    max: 60,
    envVar: "HEARTBEAT_INTERVAL_MIN",
    effect: "restart",
    group: "Resilience",
    parentToggle: "heartbeat_enabled",
  },
  {
    key: "heartbeat_activity_window_min",
    label: "Activity Window",
    description:
      "Maximum minutes since the last user request for heartbeat pings to fire. Prevents pinging when nobody is using the system.",
    type: "number",
    default: 15,
    min: 5,
    max: 60,
    envVar: "HEARTBEAT_ACTIVITY_WINDOW_MIN",
    effect: "restart",
    group: "Resilience",
    parentToggle: "heartbeat_enabled",
  },
  {
    key: "heartbeat_timeout_ms",
    label: "Heartbeat Timeout (ms)",
    description:
      "How long to wait for a heartbeat ping response before considering it a failure. Shorter values detect outages faster but may false-positive on slow providers.",
    type: "number",
    default: 10000,
    min: 2000,
    max: 30000,
    envVar: "HEARTBEAT_TIMEOUT_MS",
    effect: "restart",
    group: "Resilience",
    parentToggle: "heartbeat_enabled",
  },
  {
    key: "heartbeat_stagger_ms",
    label: "Heartbeat Stagger (ms)",
    description:
      "Random delay added between pings to different providers to avoid thundering-herd bursts.",
    type: "number",
    default: 2000,
    min: 0,
    max: 10000,
    envVar: "HEARTBEAT_STAGGER_MS",
    effect: "restart",
    group: "Resilience",
    parentToggle: "heartbeat_enabled",
  },
  {
    key: "heartbeat_concurrency",
    label: "Heartbeat Concurrency",
    description:
      "Maximum number of concurrent heartbeat ping requests. Higher values complete cycles faster but may cause burst-rate-limit issues with less forgiving providers. Default is 4 — a safe middle ground. Set to 1 to restore sequential behavior.",
    type: "number",
    default: 4,
    min: 1,
    max: 16,
    envVar: "HEARTBEAT_CONCURRENCY",
    effect: "restart",
    group: "Resilience",
    parentToggle: "heartbeat_enabled",
  },
  {
    key: "heartbeat_advisor_enabled",
    label: "Heartbeat AI Routing Advisor",
    description:
      "Use heartbeat pings to request compact routing advice from the pinged model. Falls back to the normal health check if parsing fails.",
    type: "boolean",
    default: false,
    envVar: "HEARTBEAT_ADVISOR_ENABLED",
    effect: "live",
    group: "Resilience",
    parentToggle: "heartbeat_enabled",
  },
  {
    key: "heartbeat_advisor_max_input_tokens",
    label: "Advisor Input Budget",
    description:
      "Approximate maximum input tokens for the sanitized heartbeat advisor telemetry payload.",
    type: "number",
    default: 400,
    min: 100,
    max: 2000,
    envVar: "HEARTBEAT_ADVISOR_MAX_INPUT_TOKENS",
    effect: "live",
    group: "Resilience",
    parentToggle: "heartbeat_advisor_enabled",
  },
  {
    key: "heartbeat_advisor_max_output_tokens",
    label: "Advisor Output Budget",
    description:
      "Maximum output tokens for heartbeat advisor responses. Kept tiny so heartbeat cost stays close to the old ping.",
    type: "number",
    default: 8,
    min: 1,
    max: 32,
    envVar: "HEARTBEAT_ADVISOR_MAX_OUTPUT_TOKENS",
    effect: "live",
    group: "Resilience",
    parentToggle: "heartbeat_advisor_enabled",
  },
  {
    key: "heartbeat_exhausted_recheck_sec",
    label: "Exhausted-Key Recheck (sec)",
    description:
      "Seconds after a key is marked unhealthy before the heartbeat automatically re-pings it. Lower values recover faster but may waste API budget on keys with long cooldowns.",
    type: "number",
    default: 90,
    min: 15,
    max: 600,
    envVar: "HEARTBEAT_EXHAUSTED_RECHECK_SEC",
    effect: "restart",
    group: "Resilience",
    parentToggle: "heartbeat_enabled",
  },
  {
    key: "heartbeat_exhausted_max_rechecks",
    label: "Max Recheck Attempts",
    description:
      "Maximum re-ping attempts before giving up on an exhausted key. After this, the next regular heartbeat cycle handles recovery. Limits token spend on stubbornly-unhealthy keys.",
    type: "number",
    default: 3,
    min: 1,
    max: 10,
    envVar: "HEARTBEAT_EXHAUSTED_MAX_RECHECKS",
    effect: "restart",
    group: "Resilience",
    parentToggle: "heartbeat_enabled",
  },
  // ── Sessions ──
  {
    key: "sticky_session_enabled",
    label: "Sticky Sessions",
    description:
      "Route all requests in a conversation to the same model to prevent mid-conversation model switches and hallucination.",
    type: "boolean",
    default: false,
    envVar: "STICKY_SESSION_ENABLED",
    effect: "live",
    group: "Sessions",
  },
  {
    key: "context_handoff_mode",
    label: "Context Handoff",
    description:
      'Inject a conversation summary when the router switches the model mid-session. "on_model_switch" enables handoff on model change; "off" disables it.',
    type: "string",
    default: "off",
    options: ["off", "on_model_switch"],
    envVar: "ANIMAROUTER_CONTEXT_HANDOFF",
    effect: "live",
    group: "Sessions",
  },
  {
    key: "session_ttl_min",
    label: "Session Memory TTL (min)",
    description:
      "How long the proxy remembers session context (messages, last model) before discarding it. Longer TTLs use more memory but survive longer gaps between requests.",
    type: "number",
    default: 180,
    min: 30,
    max: 1440,
    effect: "restart",
    group: "Sessions",
  },
  {
    key: "sticky_session_ttl_min",
    label: "Sticky Session TTL (min)",
    description:
      "How long the router pins a session to the same model. After this period the router is free to choose a different model on the next request.",
    type: "number",
    default: 30,
    min: 5,
    max: 1440,
    effect: "restart",
    group: "Sessions",
    parentToggle: "sticky_session_enabled",
  },
  {
    key: "key_affinity_enabled",
    label: "Key Affinity Per Thread",
    description:
      "Route all requests in the same conversation thread (identified by the first message) to the same API key. Maximizes upstream KV-cache reuse for cache-heavy providers. When disabled, keys are rotated round-robin.",
    type: "boolean",
    default: true,
    envVar: "KEY_AFFINITY_ENABLED",
    effect: "live",
    group: "Sessions",
  },

  // ── Models ──
  {
    key: "model_grouping_enabled",
    label: "Model Grouping",
    description:
      "Treat provider variants of the same underlying model as one routing group. The router chooses the best healthy provider inside the selected group.",
    type: "boolean",
    default: false,
    envVar: "MODEL_GROUPING_ENABLED",
    effect: "live",
    group: "Models",
  },

  // ── Retry & Failover ──
  {
    key: "global_retry_limit",
    label: "Max Retry Attempts",
    description:
      "Maximum number of models the router tries before giving up. Higher values increase resilience at the cost of latency for failing requests.",
    type: "number",
    default: 5,
    min: 1,
    max: 50,
    effect: "live",
    group: "Retry & Failover",
  },
  {
    key: "transient_cooldown_sec",
    label: "Transient 429 Cooldown (sec)",
    description:
      "How long a model+key is benched after a per-minute 429 (rate limit). Short values recover faster; long values avoid re-hitting a tight RPM quota.",
    type: "number",
    default: 90,
    min: 5,
    max: 300,
    effect: "live",
    group: "Retry & Failover",
  },
  {
    key: "payment_cooldown_hours",
    label: "Payment-Required Cooldown (hours)",
    description:
      "How long a model+key is benched after a 402 (out of credits). Payment issues rarely self-resolve within a day; use a high value to avoid hammering dead keys.",
    type: "number",
    default: 24,
    min: 1,
    max: 168,
    effect: "live",
    group: "Retry & Failover",
  },
  {
    key: "forbidden_cooldown_hours",
    label: "Model-Forbidden Cooldown (hours)",
    description:
      "How long a model+key is benched after a 403 (key tier cannot access this model). This rarely changes, so a long bench avoids wasting retries.",
    type: "number",
    default: 24,
    min: 1,
    max: 168,
    effect: "live",
    group: "Retry & Failover",
  },

  // ── Degradation ──
  {
    key: "degrade_minor_half_life_min",
    label: "Minor Half-Life (min)",
    description:
      "Decay half-life for minor errors (timeouts, network issues). Shorter half-lives make the engine forget errors faster; longer half-lives make it more cautious.",
    type: "number",
    default: 2,
    min: 0.5,
    max: 30,
    envVar: "DEGRADE_MINOR_HALF_LIFE_MIN",
    effect: "restart",
    group: "Degradation",
  },
  {
    key: "degrade_major_half_life_min",
    label: "Major Half-Life (min)",
    description:
      "Decay half-life for major errors (server errors). A 15-min half-life means a major error counts for half its weight after 15 minutes of no further failures.",
    type: "number",
    default: 15,
    min: 1,
    max: 120,
    envVar: "DEGRADE_MAJOR_HALF_LIFE_MIN",
    effect: "restart",
    group: "Degradation",
  },
  {
    key: "degrade_critical_half_life_min",
    label: "Critical Half-Life (min)",
    description:
      "Decay half-life for critical errors (auth failures, invalid keys). Critical penalties are long-lived by design to keep the router away from fundamentally broken keys.",
    type: "number",
    default: 60,
    min: 5,
    max: 480,
    envVar: "DEGRADE_CRITICAL_HALF_LIFE_MIN",
    effect: "restart",
    group: "Degradation",
  },
  {
    key: "degrade_max_penalty",
    label: "Max Penalty Score",
    description:
      "Upper bound for the accumulated penalty. A model at max penalty is effectively dead to the router (score near zero).",
    type: "number",
    default: 100,
    min: 10,
    max: 500,
    envVar: "DEGRADE_MAX_PENALTY",
    effect: "restart",
    group: "Degradation",
  },
  {
    key: "degrade_success_recovery",
    label: "Success Recovery Rate",
    description:
      "Fraction of penalty removed per successful request. 0.3 = 30% penalty reduction on each success. Higher values forgive faster.",
    type: "number",
    default: 0.3,
    min: 0.01,
    max: 1.0,
    envVar: "DEGRADE_SUCCESS_RECOVERY",
    effect: "restart",
    group: "Degradation",
  },
  {
    key: "degrade_critical_threshold",
    label: "Critical Consecutive Threshold",
    description:
      "Number of consecutive failures that trigger the critical tier. Once hit, the half-life ratchets to the critical value, making recovery much slower.",
    type: "number",
    default: 3,
    min: 2,
    max: 20,
    envVar: "DEGRADE_CRITICAL_THRESHOLD",
    effect: "restart",
    group: "Degradation",
  },
  {
    key: "degrade_minor_weight",
    label: "Minor Error Weight",
    description:
      "Penalty weight added per minor error (429, 402). Higher values make the router avoid models with recent rate-limit issues more aggressively.",
    type: "number",
    default: 1.0,
    min: 0.1,
    max: 10,
    envVar: "DEGRADE_MINOR_WEIGHT",
    effect: "restart",
    group: "Degradation",
  },
  {
    key: "degrade_major_weight",
    label: "Major Error Weight",
    description:
      "Penalty weight added per major error (5xx, connection refused). Should be significantly higher than minor weight.",
    type: "number",
    default: 3.0,
    min: 0.5,
    max: 20,
    envVar: "DEGRADE_MAJOR_WEIGHT",
    effect: "restart",
    group: "Degradation",
  },
  {
    key: "degrade_critical_weight",
    label: "Critical Error Weight",
    description:
      "Penalty weight added per critical error (401, 403, invalid key). Should be the highest weight — critical errors indicate fundamental issues.",
    type: "number",
    default: 6.0,
    min: 1,
    max: 50,
    envVar: "DEGRADE_CRITICAL_WEIGHT",
    effect: "restart",
    group: "Degradation",
  },
  {
    key: "degrade_compound_factor",
    label: "Compound Factor",
    description:
      "Multiplier applied to penalty for consecutive failures. 1.5 = each consecutive failure adds 50% more penalty than the last. Set to 1.0 to disable compounding.",
    type: "number",
    default: 1.5,
    min: 1.0,
    max: 3.0,
    envVar: "DEGRADE_COMPOUND_FACTOR",
    effect: "restart",
    group: "Degradation",
  },
  {
    key: "degrade_damp_strength",
    label: "Dampening Strength",
    description:
      "Softens the penalty curve to prevent extreme swings. Higher values produce smoother, more gradual score changes.",
    type: "number",
    default: 50,
    min: 1,
    max: 200,
    envVar: "DEGRADE_DAMP_STRENGTH",
    effect: "restart",
    group: "Degradation",
  },
  {
    key: "degrade_boost_min",
    label: "Min Boost Multiplier",
    description:
      "Lower bound for the boost applied after degradation. Models with a clean record can get a score boost up to this minimum.",
    type: "number",
    default: 0.1,
    min: 0.01,
    max: 1.0,
    envVar: "DEGRADE_BOOST_MIN",
    effect: "restart",
    group: "Degradation",
  },
  {
    key: "degrade_boost_max",
    label: "Max Boost Multiplier",
    description:
      "Upper bound for the boost multiplier. Healthy models can score up to this many times their base score.",
    type: "number",
    default: 100.0,
    min: 2,
    max: 1000,
    envVar: "DEGRADE_BOOST_MAX",
    effect: "restart",
    group: "Degradation",
  },

  // ── Analytics & Data ──
  {
    key: "analytics_retention_days",
    label: "Request Log Retention (days)",
    description:
      "How many days of request analytics to keep. Older rows are pruned automatically. Reduce on storage-constrained deployments; increase for long-term trend analysis.",
    type: "number",
    default: 90,
    min: 7,
    max: 365,
    envVar: "REQUEST_ANALYTICS_RETENTION_DAYS",
    effect: "live",
    group: "Analytics & Data",
  },
  {
    key: "analytics_max_rows",
    label: "Max Request Rows",
    description:
      "Hard cap on the number of rows in the request log. When exceeded, the oldest rows are pruned regardless of retention days.",
    type: "number",
    default: 100000,
    min: 0,
    max: 1000000,
    envVar: "REQUEST_ANALYTICS_MAX_ROWS",
    effect: "live",
    group: "Analytics & Data",
  },

  // ── Scoring ──
  {
    key: "scoring_window_days",
    label: "Stats Look-back Window (days)",
    description:
      "How far back the scoring engine looks for request history. A 7-day window balances stability (enough data) with responsiveness (old failures fade out).",
    type: "number",
    default: 7,
    min: 1,
    max: 30,
    effect: "restart",
    group: "Scoring",
  },
  {
    key: "scoring_decay_half_life_days",
    label: "Stats Decay Half-Life (days)",
    description:
      "Decay rate for the scoring engine. A 2-day half-life means a request from 2 days ago counts for half as much as one from today.",
    type: "number",
    default: 2,
    min: 0.5,
    max: 14,
    effect: "restart",
    group: "Scoring",
  },
  {
    key: "scoring_cache_ttl_sec",
    label: "Score Cache TTL (sec)",
    description:
      "How long the scoring engine caches its stats before re-querying. Lower values make the dashboard and routing more responsive; higher values reduce DB load.",
    type: "number",
    default: 60,
    min: 5,
    max: 600,
    effect: "restart",
    group: "Scoring",
  },
  {
    key: "routing_intelligence_threshold_pct",
    label: "Smartest Intelligence Floor",
    description:
      "Minimum intelligence score required when Smartest routing is active.",
    type: "number",
    default: 60,
    min: 0,
    max: 100,
    effect: "live",
    group: "Scoring",
  },
  {
    key: "routing_fastness_threshold_pct",
    label: "Fastness Threshold",
    description:
      "Minimum combined speed/latency required when Fastest routing is active.",
    type: "number",
    default: 60,
    min: 0,
    max: 100,
    effect: "live",
    group: "Scoring",
  },
  {
    key: "routing_reliability_threshold_pct",
    label: "Reliability Threshold",
    description:
      "Minimum success rate required when Most Reliable routing is active.",
    type: "number",
    default: 60,
    min: 0,
    max: 100,
    effect: "live",
    group: "Scoring",
  },
  // ── Routing ──
  // —— Routing ——
  {
    key: "iterative_refinement_weights",
    label: "Iterative Refinement Weights",
    description:
      'Optional JSON weight override. Leave blank to use Smartest defaults: {"reliability":0.30,"speed":0.10,"intelligence":0.45,"latency":0.15}.',
    type: "string",
    default: "",
    envVar: "ITERATIVE_REFINEMENT_WEIGHTS",
    effect: "live",
    group: "Routing",
  },
  {
    key: "oscillator_foundation_selection",
    label: "Foundation Selection",
    description:
      "How Iterative Refinement chooses Step 1 and Step 3 foundation candidates. Auto orders eligible models by Iterative Refinement / Smartest-weight score; top rank tries intelligence rank 1 first. Can also be a numeric model ID override.",
    type: "string",
    default: "auto",
    envVar: "OSCILLATOR_FOUNDATION_SELECTION",
    effect: "live",
    group: "Routing",
  },
  {
    key: "oscillator_injection_selection",
    label: "Injection Selection",
    description:
      "How Iterative Refinement chooses the Step 2 injection model. Divergent prefers a high-intelligence model on a different provider from the selected foundation. Can also be a numeric model ID override.",
    type: "string",
    default: "divergent",
    envVar: "OSCILLATOR_INJECTION_SELECTION",
    effect: "live",
    group: "Routing",
  },
  {
    key: "oscillator_min_intelligence_gap",
    label: "Minimum Intelligence Gap",
    description:
      "Minimum intelligence-axis gap between foundation and injection models. Lower values allow closer peers; higher values demand a more distinct second perspective.",
    type: "number",
    default: 0,
    min: 0,
    max: 100,
    envVar: "OSCILLATOR_MIN_INTELLIGENCE_GAP",
    effect: "live",
    group: "Routing",
  },
  {
    key: "oscillator_injection_max_sentences",
    label: "Injection Sentences",
    description:
      "Maximum sentences the injection model may return. The default is exactly 2 to keep the divergent perspective concise.",
    type: "number",
    default: 2,
    min: 1,
    max: 5,
    envVar: "OSCILLATOR_INJECTION_MAX_SENTENCES",
    effect: "live",
    group: "Routing",
  },
  {
    key: "oscillator_load_shed_threshold",
    label: "Load-Shed Threshold",
    description:
      "Concurrent request count above which Iterative Refinement bypasses the oscillator and uses normal Smartest-weight single-model routing.",
    type: "number",
    default: 21,
    min: 0,
    max: 100,
    envVar: "OSCILLATOR_LOAD_SHED_THRESHOLD",
    effect: "live",
    group: "Routing",
  },
  {
    key: "oscillator_step_timeout_ms",
    label: "Step Timeout (ms)",
    description:
      "Timeout for each Iterative Refinement oscillator step before falling back to the foundation response or normal single-model routing.",
    type: "number",
    default: 30000,
    min: 5000,
    max: 120000,
    envVar: "OSCILLATOR_STEP_TIMEOUT_MS",
    effect: "live",
    group: "Routing",
  },
  // ── Proxy Transport ──
  {
    key: "proxy_transport_enabled",
    label: "FreeLLMProxy Transport",
    description:
      "Route requests through FreeLLMProxy instead of connecting directly to providers. Requires PROXY_ROUTER_URL and PROXY_AUTH_KEY environment variables. When enabled, keys flagged with use_proxy will route through the proxy.",
    type: "boolean",
    default: false,
    envVar: "PROXY_TRANSPORT_ENABLED",
    effect: "live",
    group: "Proxy Transport",
  },
];

// ── Resolution ─────────────────────────────────────────────────────────────

/** Returns parsed number if valid (not NaN, within min/max bounds), otherwise undefined. */
function parseNumber(raw: string, def: FeatureSettingDef): number | undefined {
  const parsed = parseFloat(raw);
  if (Number.isNaN(parsed)) return undefined;
  if (def.min !== undefined && parsed < def.min) return undefined;
  if (def.max !== undefined && parsed > def.max) return undefined;
  return parsed;
}

function resolveSetting(def: FeatureSettingDef): boolean | number | string {
  // Priority: DB → env var → default
  try {
    const dbValue = getSetting(def.key);
    if (dbValue !== undefined) {
      if (def.type === "boolean") return dbValue === "true";
      if (def.type === "number") {
        const parsed = parseNumber(dbValue, def);
        if (parsed !== undefined) return parsed;
        // invalid DB value — fall through to env → default
      } else {
        return dbValue; // string — return as-is
      }
    }
  } catch {
    // DB not initialized — fall through to env → default
  }

  if (def.envVar && process.env[def.envVar] !== undefined) {
    const raw = process.env[def.envVar];
    if (raw === undefined) return def.default;
    if (def.type === "boolean") return raw === "true";
    if (def.type === "number") {
      const parsed = parseNumber(raw, def);
      if (parsed !== undefined) return parsed;
      // invalid env value — fall through to default
    } else {
      return raw; // string
    }
  }

  return def.default;
}

// ── Running-value snapshot (for restart detection) ─────────────────────────

const runningValues = new Map<string, boolean | number | string>();

/** Snapshot all resolved values at startup. Called once from index.ts. */
export function captureRunningValues(): void {
  for (const def of REGISTRY) {
    runningValues.set(def.key, resolveSetting(def));
  }
}

/** True when any restart-effect setting's saved value differs from its running value. */
export function hasPendingRestart(): boolean {
  for (const def of REGISTRY) {
    if (def.effect === "restart") {
      const running = runningValues.get(def.key);
      const saved = resolveSetting(def);
      if (running !== saved) return true;
    }
  }
  return false;
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Resolve current value for a setting key (DB → env → default). */
export function getFeatureSetting(key: string): boolean | number | string {
  const def = REGISTRY.find((d) => d.key === key);
  if (!def) throw new Error(`Unknown feature setting: ${key}`);
  return resolveSetting(def);
}

/** Get all settings with full metadata for the API response. */
export function getAllFeatureSettings(): Array<
  FeatureSettingDef & { value: boolean | number | string }
> {
  return REGISTRY.map((def) => ({ ...def, value: resolveSetting(def) }));
}

/** Validate and write a partial update of settings to the DB. */
export function saveFeatureSettings(
  updates: Record<string, boolean | number | string>,
): string[] {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(updates)) {
    const def = REGISTRY.find((d) => d.key === key);
    if (!def) {
      errors.push(`Unknown setting: ${key}`);
      continue;
    }
    if (def.type === "boolean" && typeof value !== "boolean") {
      errors.push(`${key}: expected boolean, got ${typeof value}`);
    }
    if (def.type === "number") {
      if (typeof value !== "number" || Number.isNaN(value)) {
        errors.push(`${key}: expected number`);
      } else if (def.min !== undefined && value < def.min) {
        errors.push(`${key}: must be ≥ ${def.min}`);
      } else if (def.max !== undefined && value > def.max) {
        errors.push(`${key}: must be ≤ ${def.max}`);
      }
    }
    if (def.type === "string") {
      if (typeof value !== "string") {
        errors.push(`${key}: expected string, got ${typeof value}`);
      } else if (def.options && !def.options.includes(value)) {
        errors.push(`${key}: must be one of ${def.options.join(", ")}`);
      }
    }
  }
  if (errors.length > 0) return errors;

  for (const [key, value] of Object.entries(updates)) {
    setSetting(key, String(value));
  }
  return [];
}
