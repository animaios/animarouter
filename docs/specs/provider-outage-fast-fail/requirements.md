# Provider-Outage Fast-Fail — Requirements

## 1. Problem Statement

When an upstream **provider** (not model) returns 5xx for every model it serves, the proxy's retry loop burns through **every key on every model** on that provider before giving up. In the observed incident ("bluesminds"), a single provider served two models (kimi-k2.6, glm-5.1) behind ~15 keys. The upstream returned 503 "No available channel" for both models on every key, producing this pathological loop:

```
Key#83 + kimi-k2.6  → 503 → exhausted (2 retries)
Key#83 + glm-5.1    → 503 → exhausted (2 retries)
Key#84 + kimi-k2.6  → 503 → exhausted
Key#84 + glm-5.1    → 503 → exhausted
...                         (×15 keys)
Key#97 + kimi-k2.6  → 503 → exhausted
Key#97 + glm-5.1    → 503 → exhausted
→ 429 All models exhausted
```

**30+ retry attempts** were wasted on a provider that was **entirely down**. A single 503 from a second model on the same provider would have been sufficient evidence that the outage is provider-wide — at which point every remaining key on every model from that provider will also fail.

### Root Cause

The retry loop treats each `(platform, model, key)` failure independently. It has no concept of a **provider-level outage**: when the same provider returns a 5xx for N ≥ 2 distinct models within one request, it is overwhelmingly likely the provider itself is down — not individual models.

### Why Existing Mechanisms Don't Solve This

| Mechanism | Why it doesn't help |
|---|---|
| **degradation.ts** | Penalizes *models* independently. The router oscillates back and forth between models, so `consecutiveMajorHits` never reaches the critical threshold on any single model. Penalty compounds but never triggers a provider-level *skip*. |
| **skipModels** set | Only populated for 404/403 (model removed/forbidden). 503 is not a model-identity error so it never adds the model to `skipModels`. |
| **cooldowns** | Per `(platform, model, key)`. Each key gets a 90s transient cooldown for 503, but the *next* key on the same provider has no cooldown yet — so the loop continues. |
| **key-exhaustion.ts** | Tracks per-key exhaustion — useful for cycling keys *within* a model, but doesn't detect that all models on a provider are dead. |
| **canUseProvider** | Only enforces daily request caps — not outage detection. |

---

## 2. User Stories

### US-1: Fast Provider-Outage Detection
**As an operator**, I want the proxy to detect a provider-wide outage after seeing 5xx errors on N distinct models from the same platform within a single request, so it stops wasting retry slots on a provider that can't serve any model.

### US-2: Immediate Skip, Not Gradual Demotion
**As an operator**, I want the proxy to **skip** all remaining models from a downed provider for the request's lifetime — not just gradually lower their routing score. Gradual demotion still wastes attempts; I want those attempts redirected to healthy providers immediately.

### US-3: No Persistence Needed
**As an operator**, I want provider-outage detection to be scoped to a single request (no DB writes, no new tables). The next request starts with a clean slate — if the provider has recovered, it routes normally. Longer-term backoff is already handled by the existing degradation + cooldown systems.

### US-4: Conservative Trigger
**As an operator**, I want the fast-fail trigger to require failures on ≥2 distinct models from the same platform, so a single model's 503 (which could be model-specific) doesn't prematurely skip a provider that may still serve other models.

### US-5: Observable
**As an operator**, I want to see when a provider fast-fails in the live-event stream and dashboard, so I can distinguish "provider is down" from "all keys exhausted" in my monitoring.

### US-6: Configurable Threshold
**As an operator**, I want the model-count threshold to be configurable via an environment variable, so I can tune sensitivity (or disable the feature entirely by setting threshold=0).

### US-7: No Breaking Changes
**As an existing user**, provider-outage fast-fail must not alter the retry behavior for providers that serve only one model, or where failures are rate-limit (429) rather than infrastructure (5xx). A provider with zero 5xx errors must behave identically to today.

---

## 3. Functional Requirements

### FR-1: Provider-Outage Detection
Within a single request's retry loop, the proxy shall track 5xx failures **per platform** across distinct models. When the number of distinct models from one platform that have returned a 5xx error reaches a configurable threshold (default 2), the proxy shall consider that provider in outage.

**5xx definition**: Any error classified as `'major'` by the existing `classifyError()` in `degradation.ts`. This includes HTTP 500/502/503/504, network timeouts, connection refused, DNS failures, and TLS errors.

**What does NOT count toward the threshold**:
- HTTP 429 (rate limit) — these are key/model-level, not provider-level
- HTTP 402 (payment required) — keyed model-level
- HTTP 4xx client errors — configuration issues, not outages
- HTTP 404/403 — already handled by `skipModels` for model-identity errors

### FR-2: Fast-Fail Action
When a provider is detected as in-outage, the proxy shall add **all** enabled `model_db_id`s for that platform to the existing `skipModels` set. This causes `routeRequest()` to skip those models on all subsequent routing attempts within the same request.

The proxy shall then `continue outerLoop` — the next routing attempt will pick models from other providers (if any). If no other providers have available models, the existing 429 "All models exhausted" path fires naturally.

### FR-3: Event Emission
When a provider fast-fails, the proxy shall emit a `routing.provider_fastfail` event via the existing `publish()` event system with the following shape:

```typescript
{
  type: 'routing.provider_fastfail',
  id: string,            // request ID
  provider: string,      // platform slug (e.g. "bluesminds")
  failedModelCount: number, // distinct models that 5xx'd
  at: number             // timestamp ms
}
```

### FR-4: Dashboard Rendering
The client's `live-events.tsx` shall render `routing.provider_fastfail` events with a visible **warning** indicator, distinct from the info-level key_exhausted and model_switch messages.

### FR-5: Configuration
The threshold shall be configurable via the `feature-settings.ts` registry (resolution order: **DB → env var → default**), exposed in the Settings UI as "Fast-Fail Threshold":

| Setting key | Env var fallback | Default | Description |
|---|---|---|---|
| `provider_fastfail_threshold` | `PROVIDER_FASTFAIL_THRESHOLD` | `2` | Distinct models on one platform that must 5xx before the platform is skipped. `0` disables the feature entirely. |

The value is read through `getFeatureSetting('provider_fastfail_threshold')` at module level in `proxy.ts` (cached after first read; restart to change). The env var alone is **not** the primary config path — it serves as a fallback when no DB override exists.

### FR-6: Data Structure
The tracking data structure shall be a `Map<string, Set<number>>` local to the retry loop — **not** module-level, **not** persisted. Key is the platform slug; value is the set of `modelDbId`s that 5xx'd on that platform during this request. The map is garbage-collected when the request completes.

### FR-7: Integration Point
The fast-fail check shall execute **after** the existing key-exhaustion block (after `markExhausted`, `setCooldown`, `skipKeys.add`, `publish key_exhausted`). It inspects `lastError` via `classifyError(lastError)` and the current `route.platform` / `route.modelDbId`.

---

## 4. Non-Functional Requirements

### NFR-1: Performance
- The `providerFailures` map lookup + `Set.add` + `Set.size` check is O(1) per exhaustion event
- The one-time query to fetch all models for a platform (`SELECT id FROM models WHERE platform = ?`) runs at most once per provider per request — acceptable cost
- No additional database queries during `routeRequest()` — the query runs in the proxy layer, not the router

### NFR-2: Backward Compatibility
- Providers with a single model never trigger the fast-fail (threshold=2, single-model size never reaches 2)
- 429-only failures never trigger the fast-fail (only 5xx classified as `'major'` counts)
- No changes to `router.ts`, `scoring.ts`, `ratelimit.ts`, or `key-exhaustion.ts`
- Existing tests pass without modification

### NFR-3: Correctness
- The `providerFailures` map must be scoped to the retry loop (local variable), not module-level state
- A 5xx on model A + a 429 on model B from the same provider = only 1 count against the threshold (only 5xx counts)
- Fast-fail on a provider must add ALL enabled model_db_ids for that platform, not just the ones that have already failed
- If `skipModels` already contains some of a provider's models, the fast-fail must add the *remaining* ones (set union, not replacement)
- The fast-fail must not prevent the degradation engine from recording the failure (both systems run; they are complementary)

### NFR-4: Observability
- The `routing.provider_fastfail` event must be emitted exactly once per provider per request (when the threshold is first crossed, not on every subsequent exhaustion)
- The event must appear in the SSE event stream like all other routing events

### NFR-5: Pinned Model Interaction
- Pinned requests on a fast-failed provider must return `PINNED_MODEL_EXHAUSTED` immediately (the model is in `skipModels`, so `routeRequest` throws, and the existing pin-mode catch returns the 429). No new logic needed — the existing path handles this correctly.

---

## 5. Out of Scope

- **Persistent provider-outage state** — Not needed. The existing degradation engine handles longer-term backoff across requests. The fast-fail is a within-request optimization only.
- **Cross-request provider health tracking** — Out of scope. Degradation + cooldowns already penalize failing providers across requests.
- **Provider-level retry budget** — Counting total attempts per provider and capping them. The fast-fail replaces this need by making the skip decision early.
- **HTTP 429 fast-fail** — Rate limits are per-model/per-key, not provider-wide. A 429 on one model doesn't mean the provider's other models are also rate-limited.
- **Dashboard UI for provider health** — The live-event stream short-term; degradation dashboard for long-term. No new UI components needed.
