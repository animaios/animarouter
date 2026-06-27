# Heartbeat AI Routing Advisor — Requirements

## Problem

The heartbeat system currently pings each key with a plain `"hi"` message and only uses the binary success/failure signal. It ignores a wealth of operational data the proxy already collects:

- **Per-key per-model success/failure rates** from the `requests` table
- **Latency and throughput distributions** (p50/p95) per key–model pair
- **Rate-limit cooldown history** and escalation patterns
- **Degradation state** (penalty, tier, consecutive failures) per model
- **Cooldown hit severity** (escalating durations: 2min → 10min → 1hr → 24hr)
- **KeyHealth map** (penalty counts, last errors per key+model)
- **Provider-level daily exhaustion** signals

Meanwhile, the heartbeat pings are *wasted tokens* — they send `max_tokens: 5` and throw away the response. The proxy pays for the ping but learns nothing beyond "did it 200?".

## Vision

**Make each heartbeat ping double as a routing advice query.** Instead of sending `"hi"`, send a tiny prompt that includes a structured summary of the proxy's operational state and asks the model to return routing recommendations. The response is parsed, not discarded, yielding:

1. **AI-informed routing adjustments** — the model can spot patterns the rule-based scorer misses (e.g., "this provider's latency is degrading steadily across your keys, not just this one").
2. **Zero-cost intelligence** — we're already paying for the ping request; we might as well get useful work out of it.
3. **Cross-provider insight** — models on one provider can advise on another provider's patterns (e.g., Claude noticing OpenAI rate-limit patterns from the summary).

## Rabbit Shake User Story

**As an** AI Platform Engineer,
**I want to** implement a model-agnostic, context-sanitizing, sequential routing pipeline for the highest-intelligence eligible model and a divergent injection model,
**So that** we can inject alternative reasoning into complex prompts to break logic loops ("Rabbit Shake") without causing token collisions, context corruption ("meowing"), or cascading latency timeouts.

The implementation must not hardcode any specific model family or provider. In one installation, the selected foundation and injection models might be GLM and Nemotron; in another, they might be any two enabled models from the routing pool. Selection is driven by current routing eligibility, intelligence scores, health, model capability, provider availability, and load-shed state.

### Rabbit Shake Acceptance Criteria

1. **Context Bridge & Sanitization**
   - Given the foundation model generates a response,
   - When its output is routed to a different injection model,
   - Then the router must intercept and strip model-specific special tokens, system markers, and structural artifacts, converting them into clean, standardized plain text such as `[Thought Context: ...]`.

2. **Sequential Oscillator**
   - Given a user initiates a complex reasoning prompt,
   - When the oscillator is enabled and the request is eligible,
   - Then the router must execute a sequential 3-step pattern:
     - Step 1 (Foundation): select the top eligible foundation model from the enabled routing pool and generate base logic.
     - Step 2 (Injection): select a divergent eligible model from the pool, pass cleaned foundation context, and require an alternative perspective limited to the configured sentence count (default: exactly 2 sentences).
     - Step 3 (Anchor): return to the same foundation model from Step 1 for final synthesis.

3. **Dynamic Foundation Fallback**
   - Given the top foundation model is unavailable, unhealthy, times out, or fails the Step 1 call,
   - When another eligible high-intelligence model exists,
   - Then the router should select the next eligible foundation candidate and retry the oscillator selection path, rather than hard-failing on the original top model.

4. **Dynamic Load-Shedding**
   - Given live concurrent traffic is above the configured load-shed threshold (default: 21),
   - When a complex reasoning request arrives,
   - Then the router must bypass the oscillator and route through the normal single-model path using the best currently eligible model.
   - When traffic falls below the threshold, oscillator eligibility should resume automatically without manual intervention.

5. **Stability & Anti-Meow Validation**
   - Given the router is actively mixing foundation and injection models,
   - When analyzing the final output,
   - Then the combined response must preserve logical coherence and must not expose raw structural tags, provider control tokens, abrupt style fragmentation, or gibberish.

## Goals

- **Backward-compatible** — if parsing fails or the advisor is disabled, heartbeat falls back to the current binary health check with identical behavior.
- **Budget-controlled** — the advisory prompt+response must stay within the existing `max_tokens: 5` budget for the *proxy cost* (see Design for the trick: we use the response tokens for the advisor payload, not extra input tokens).
- **Privacy-safe** — the advisory payload must NOT include raw API keys, user messages, or any PII. Only aggregate statistics and error categories.
- **Low-latency** — advisory parsing must not delay the health-check result. The ping timeout still governs.
- **Incrementally adoptable** — a feature flag to enable/disable the advisor; the system degrades gracefully if a provider's model doesn't follow the advisory format.
- **Model-agnostic oscillator** — Rabbit Shake must select models dynamically from the enabled routing pool. No provider or model ID is special-cased.

## Non-Goals

- Replacing the existing rule-based router. The advisor is *advisory* — it produces suggestions that feed into the scoring system, not direct routing decisions.
- Supporting multi-turn advisory conversations. Each ping is a standalone query.
- Sending advisory prompts to providers that charge per-input-token differently (cost guardrails handled in Design).
- Hardcoding a fixed GLM/Nemotron pair. Those may be common top candidates in one deployment, but the system must work for any enabled model pool.
