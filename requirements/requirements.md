# Dynamic Degradation System — Requirements

## 1. Problem Statement

The current Thompson-sampling bandit router treats all failures flatly: a 429 and a catastrophic 503 both apply the same linear penalty, decay at the same fixed rate, and cap at the same shallow 0.6 multiplier. A model that hard-crashes every request for 10 minutes recovers to full score in 20 minutes — before it's actually stable again. Meanwhile, a model experiencing transient hiccups gets the same demotion curve as one that's completely dead.

The system needs **progressive, severity-weighted degradation** that:
- Pushes failing models meaningfully down the Thompson ranking (not a shallow 0.6 cap)
- Scales penalty magnitude to failure severity (429 < timeout < 5xx < consecutive hard failures)
- Uses dynamic, severity-linked expiry so a catastrophic failure recovers slowly, a rate limit recovers quickly
- Compounds penalties for consecutive failures (the penalty accelerates, not linear-adds)
- Integrates naturally into the existing `combineScore` architecture as a new multiplicative guardrail axis

## 2. User Stories

### US-1: Severity-Weighted Penalties
**As an operator**, I want a model that returns a 503 to be demoted much harder than one that returns a 429, so that truly broken endpoints don't waste retry slots that could go to healthy alternatives.

### US-2: Progressive Compounding
**As an operator**, I want consecutive failures on the same model to compound exponentially, so that a model in a death spiral (every request fails) falls to the bottom of the chain quickly rather than lingering mid-pack.

### US-3: Dynamic Expiry Based on Severity
**As an operator**, I want a rate-limited model (429) to recover its standing quickly (within minutes), while a hard-crashed model (5xx) should take much longer to climb back, so that the system naturally trusts models proportionally to how serious their problem was.

### US-4: Success as Counterweight
**As an operator**, I want a successful response from a penalized model to reduce its penalty — substantially for a minor penalty, gradually for a severe one — so recovery is gradual but real successes are rewarded.

### US-5: Observable and Configurable
**As an operator**, I want to see the degradation state of every model (severity level, current penalty, time-to-recovery) in the dashboard, and tune the severity multipliers and decay rates to match my risk tolerance.

### US-6: No Breaking Changes
**As an existing user**, the degradation system must coexist with the current strategy presets (balanced/smartest/fastest/reliable/priority) and not alter the behavior of completely healthy models. A model with zero failures must route identically to today.

## 3. Functional Requirements

### FR-1: Severity Classification
Failures shall be classified into three tiers:

| Tier | Trigger | Severity Weight (default) | Symbolic Name |
|------|---------|---------------------------|---------------|
| **Minor** | HTTP 429 rate limit (soft/transient only — see quota note), HTTP 402 payment required | 1.0× | `minor` |
| **Major** | HTTP 5xx server errors (500, 502, 503, 504), timeouts, connection refused (ECONNREFUSED, ECONNRESET, ETIMEDOUT), DNS failure (ENOTFOUND), TLS errors (EPROTO, ECONNABORTED) | 3.0× | `major` |
| **Critical** | 3+ **consecutive major** failures in a row without a single success (minor failures in between do NOT count toward this threshold) | 6.0× | `critical` |

**Classification implementation**: Errors shall be classified by their `status` numeric field first (from the HTTP library), falling back to `err.message` substring matching only when a numeric status is absent. This avoids fragile string-parsing on well-formed HTTP errors.

**Hard quota distinction**: A 429 containing "quota" or "insufficient" in the message (indicating a spent billing quota, not a transient rate window) shall return `null` — these are operator configuration issues, not server health signals. Only soft/transient 429s (per-minute rate windows) degrade the model.

**Client-side aborts**: `AbortError` from `AbortController` shall return `null` — the client cancelled the request, not the provider.

Non-retryable errors (4xx client errors, 401, 403 model access denied) shall **not** contribute to degradation — those are configuration problems, not server health signals.

### FR-2: Progressive Penalty Accumulation
Each failure shall compound the penalty multiplicatively rather than additively:

```
consecutiveHits increments BEFORE computing (starts at 0)
exponent = max(0, consecutiveHits - 1)
increment = severity_weight × compounding_factor^exponent
penalty = previous_penalty + increment
```

where:
- `compounding_factor` defaults to 1.5
- `consecutiveHits` counts all classified failures since the last success (reset to 0 on any success)
- The first hit uses exponent 0 (no compounding: `compounding_factor^0 = 1`)
- The second consecutive hit uses exponent 1, third uses 2, etc.
- `previous_penalty` is the stored penalty after applying time-decay to the stored value

The penalty shall be capped at `MAX_PENALTY` (default 100) to prevent arithmetic overflow, but this cap should be high enough that a model at max penalty is effectively excluded from selection (score ≈ 0).

**Critical escalation uses a separate `consecutiveMajorHits` counter**: This counter increments only on `major`-classified failures and resets on any success **or** on any `minor` failure (since a minor failure is a different class of problem and shouldn't contribute to the "repeated 5xx" heuristic). When `consecutiveMajorHits >= critical.consecutiveThreshold`, the effective tier for that hit becomes `critical`. This ensures the spec's intent — "3+ major failures in a row" — is met precisely.

### FR-3: Dynamic Expiry (Recovery)
Each severity tier shall have its own half-life. The penalty shall decay exponentially rather than linearly:

```
penalty(t) = penalty_at_last_hit × 0.5^(t / half_life)
```

| Tier | Default Half-Life |
|------|--------------------|
| Minor | 2 minutes |
| Major | 15 minutes |
| Critical | 60 minutes |

**Half-life ratchet policy**: When a failure arrives, the effective half-life for the **entire accumulated penalty** becomes `max(currentHalfLife, newTierHalfLife)`. This prevents a major failure from being "washed out" by a short minor half-life. The half-life does NOT automatically decrease — it ratchets up and stays high.

**Half-life relaxation (downgrade path)**: The half-life resets to `minor` tier's default ONLY when the penalty reaches 0 (fully healthy). This is an intentional stickiness design: a model that hard-crashed (critical, 60min) and then recovered through successes will still have a 60min half-life for any residual penalty, making re-escalation on a follow-up failure faster. Operators who want faster recovery can tune `DEGRADE_CRITICAL_HALF_LIFE_MIN` lower.

**Float snapping**: Exponential decay on floating-point numbers never reaches exactly 0. Any decayed penalty below 0.01 shall snap to exactly 0. This prevents "ghost" penalties from persisting indefinitely in memory.

### FR-4: Success Recovery
A successful request shall reduce the penalty. The amount depends on the current penalty magnitude:

```
recovery = min(current_penalty, max(1, floor(current_penalty × success_recovery_rate)))
new_penalty = max(0, current_penalty - recovery)
```

where `success_recovery_rate` defaults to 0.3 (30% of current penalty, minimum 1 point). The `floor()` ensures deterministic integer recovery — no fractional drift across cycles.

This ensures that a model at high penalty (e.g., 80) drops to 56 on a success (floor(80×0.3)=24, 80-24=56), while a model at low penalty (e.g., 3) drops to 2 (floor(3×0.3)=0 → max(1,0)=1, 3-1=2). Success also resets `consecutiveHits` and `consecutiveMajorHits` to 0.

**Definition of "success"**: A success is any response reaching the proxy layer with an HTTP 2xx status and no exception thrown by the provider adapter. This includes completions that streamed to completion and non-streaming JSON responses. A 206 partial is NOT a success. A 200 response where the streaming body contains an error payload (some providers do this) is treated as a success at the transport layer and will trigger recovery — the system trusts the HTTP status code.

### FR-5: Score Integration
The degradation penalty shall feed into the existing `combineScore` via a new degradation multiplier that replaces the current `rateLimitFactor`:

```
normalized = penalty / MAX_PENALTY
degradation_factor = 1 / (1 + normalized² × DAMP_STRENGTH)
```

where `DAMP_STRENGTH` defaults to 50. This produces a sigmoid-like curve (values verified against the formula; `MAX_PENALTY=100`):
- At penalty 0 → factor 1.0 (no effect)
- At penalty 5 (minor 429 burst) → factor 0.889 (gentle nudge)
- At penalty 10 → factor 0.667 (clear demotion)
- At penalty 25 (sustained 5xx) → factor 0.242 (heavily demoted)
- At penalty 50 → factor 0.074 (barely selectable)
- At penalty 100 (max) → factor 0.020 (effectively excluded)

The existing `rateLimitFactor` guardrail shall be **replaced** by this degradation factor (not stacked — they serve the same purpose now). The degradation factor becomes the single multiplicative guardrail in `combineScore`.

### FR-6: Persistence and Dashboard
Degradation state shall be persisted to the database (new table `model_degradation`) so it survives server restarts. The dashboard shall expose:

- Current penalty per model (decay-adjusted for display)
- Severity tier — **based on current penalty magnitude** (not the peak historical tier; see Tier Display Policy below)
- Consecutive failure count (both `consecutiveHits` and `consecutiveMajorHits`)
- Estimated time to recovery (time until penalty < 1; null when already below 1)
- Last failure timestamp and type

Via the existing `/api/fallback/routing` and a new `/api/fallback/degradation` endpoint.

**Tier Display Policy** (distinct from half-life selection logic):
| Penalty Range | Display Tier |
|---------------|---------------|
| 0 | `healthy` |
| 1–10 | `minor` |
| 10–30 | `major` |
| >30 | `critical` |

The half-life on the internal state still follows the ratchet policy from FR-3. The display tier is purely cosmetic — it tells the operator how serious the current penalty is, not what historical tier caused it.

### FR-7: Configuration
All tuning parameters shall be environment-configurable with sensible defaults:

| Parameter | Env Var | Default |
|-----------|---------|---------|
| Minor severity weight | `DEGRADE_MINOR_WEIGHT` | 1.0 |
| Major severity weight | `DEGRADE_MAJOR_WEIGHT` | 3.0 |
| Critical severity weight | `DEGRADE_CRITICAL_WEIGHT` | 6.0 |
| Compounding factor | `DEGRADE_COMPOUND_FACTOR` | 1.5 |
| Minor half-life (min) | `DEGRADE_MINOR_HALF_LIFE_MIN` | 2 |
| Major half-life (min) | `DEGRADE_MAJOR_HALF_LIFE_MIN` | 15 |
| Critical half-life (min) | `DEGRADE_CRITICAL_HALF_LIFE_MIN` | 60 |
| Success recovery rate | `DEGRADE_SUCCESS_RECOVERY` | 0.3 |
| Damp strength | `DEGRADE_DAMP_STRENGTH` | 50 |
| Max penalty | `DEGRADE_MAX_PENALTY` | 100 |
| Consecutive major threshold for critical | `DEGRADE_CRITICAL_THRESHOLD` | 3 |

## 4. Non-Functional Requirements

### NFR-1: Performance
- Penalty computation must be O(1) per routing decision (simple arithmetic, no DB queries in the hot path)
- The degradation factor formula (`1/(1 + normalized² × DAMP_STRENGTH)`) is 3 FP ops with no transcendentals
- The time-decay formula (`penalty × 0.5^(elapsed/halfLife)`) uses `Math.pow` which V8 optimizes heavily; this is acceptable as it runs once per routing decision, not per request body
- No additional database queries during `routeRequest()` — degradation state must be cached in-memory
- No per-mutation DB writes on the hot path — persistence is periodic (every 60 seconds), not per-request

### NFR-2: Backward Compatibility
- All existing routing strategy presets must produce identical scores for penalty=0 models
- The `rateLimitFactor` function signature shall remain but be backed by the new degradation calculation
- Existing tests for `scoring.ts` and `router.ts` must pass without modification (or with minimal, semantically-equivalent updates)
- The dashboard penalty display currently shows the old penalty values; this must be updated but should display meaningful degradation values

### NFR-3: Observability
- Every penalty change (hit, decay, success recovery) must emit a structured event via the existing `publish()` event system
- Penalty values must be logged at `debug` level so operators can tune the parameters

### NFR-4: Correctness
- Penalty must never go negative
- Penalty must never exceed MAX_PENALTY
- A model with 0 failures must have penalty 0 and degradation_factor 1.0
- The degradation factor must be monotonically decreasing with penalty
- Concurrent hits from different requests must not create race conditions (in-memory Map with atomic-ish operations is acceptable for single-process Node)
- `lastHitAt` must always be a valid timestamp — defaults to `Date.now()` on state creation, never `undefined` or `null`
- `getPenalty()` is a pure lazy read — it returns the decayed value but never mutates stored state
- Memory leak prevention: models with penalty < 0.01 after decay are evicted from memory during the periodic flush cycle, even if no success event triggers their cleanup

### NFR-5: State Consistency Model
The system uses **lazy-read decay** exclusively:
- The stored penalty is the value at the **time of the last mutation** (recordFailure or recordSuccess)
- Reads (`getPenalty`, `getDegradationFactor`) compute decay on-the-fly without mutating stored state
- Writes (recordFailure, recordSuccess) apply time-decay to the stored penalty BEFORE applying their mutation — this re-anchors the stored penalty to the current time
- The periodic DB flush persists the stored penalty as-is (no pre-decay during flush); on startup, the load process applies decay to each DB row before loading into memory

## 5. Out of Scope (for this iteration)

- Per-key degradation (currently per-model; per-key tracking is tracked in `rate_limit_usage` separately)
- Dashboard UI slider controls for parameters (env vars only for now; dashboard can expose read-only state)
- Degradation-aware sticky sessions (sticky model selection ignores degradation for continuity)
- Cross-provider correlation (a Cloudflare 503 doesn't penalize the same model on NVIDIA)
- Historical degradation analytics / time-series charts
