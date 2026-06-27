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

## Goals

- **Backward-compatible** — if parsing fails or the advisor is disabled, heartbeat falls back to the current binary health check with identical behavior.
- **Budget-controlled** — the advisory prompt+response must stay within the existing `max_tokens: 5` budget for the *proxy cost* (see Design for the trick: we use the response tokens for the advisor payload, not extra input tokens).
- **Privacy-safe** — the advisory payload must NOT include raw API keys, user messages, or any PII. Only aggregate statistics and error categories.
- **Low-latency** — advisory parsing must not delay the health-check result. The ping timeout still governs.
- **Incrementally adoptable** — a feature flag to enable/disable the advisor; the system degrades gracefully if a provider's model doesn't follow the advisory format.

## Non-Goals

- Replacing the existing rule-based router. The advisor is *advisory* — it produces suggestions that feed into the scoring system, not direct routing decisions.
- Supporting multi-turn advisory conversations. Each ping is a standalone query.
- Sending advisory prompts to providers that charge per-input-token differently (cost guardrails handled in Design).
