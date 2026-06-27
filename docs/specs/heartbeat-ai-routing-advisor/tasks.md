# Heartbeat AI Routing Advisor — Task List

## Phase 1: Core Infrastructure (no AI yet)

- [ ] **T1.1** Create `server/src/services/heartbeat-advisor.ts` — empty module with `isAdvisorEnabled()` function reading the feature flag
- [ ] **T1.2** Add `heartbeat_advisor_enabled`, `heartbeat_advisor_max_input_tokens`, `heartbeat_advisor_max_output_tokens` feature settings to the DB seed + `feature-settings.ts` defaults
- [ ] **T1.3** Add `AdvisoryPayload`, `RoutingAdvice`, `AdviceResult` types to `shared/types.ts`
- [ ] **T1.4** Extend `LiveEventBase` in `events.ts` with `heartbeat.advisor_parsed`, `heartbeat.advisor_failed`, `heartbeat.advisor_applied` types
- [ ] **T1.5** Update `LiveEvent` union in `client/src/components/live-events.tsx` to handle new event types

## Phase 2: Payload Construction

- [ ] **T2.1** Implement `buildAdvisoryPayload()` — aggregate key health, model stats, cooldowns, daily usage, routing config into `AdvisoryPayload` (see Design §9.8 for the implementation sketch with concrete data sources)
- [ ] **T2.2** Implement `sanitizePayload()` — strip any values that exceed privacy rules (key IDs only, no secrets, truncate error strings, map raw errors to categories)
- [ ] **T2.3** Implement `truncateToTokenBudget()` — estimate token count from JSON string length (≈4 chars/token) and trim deepest nesting level if over budget
- [ ] **T2.4** Unit tests for `buildAdvisoryPayload` — verify no key material leaked, payload size within budget, all required fields present
- [ ] **T2.5** Add `lastPingLatencyMs` to the `AdvisoryPayload.keys[].models[]` type (already available in `KeyHealth` from `getKeyHealth()`) so the AI advisor can see heartbeat RTT per key+model

## Phase 3: Advisory Prompt & Response Parsing

- [ ] **T3.1** Implement `buildAdvisoryMessages(payload)` — returns `{ messages: ChatMessage[] }` with system prompt + payload as user content
- [ ] **T3.2** Implement `parseAdviceResponse(responseText)` — tries JSON parse first, falls back to colon-separated format, falls back to `{ confidence: 0, selfScore: 0, cooldownHint: 0, recheckSooner: false }` on any error
- [ ] **T3.3** Unit tests for `parseAdviceResponse` — cover JSON format, compact format, garbage input, empty response, partial JSON

## Phase 4: Advice Application

- [ ] **T4.1** Implement `applyAdvice(advice, modelDbId, platform, modelId, keyId)` — applies score boost/penalty (capped ±2), cooldown factor (capped 0.5×–2×), recheck scheduling (50% of normal delay)
- [ ] **T4.2** Wire `applyAdvice` output into `publish()` for `heartbeat.advisor_applied` events
- [ ] **T4.3** Unit tests for `applyAdvice` — verify caps, verify no-op when confidence=0, verify recheck delay halving

## Phase 5: Integration into `pingKey()`

- [ ] **T5.1** Modify `pingKey()` — when advisor enabled, call `buildAdvisoryPayload` → `buildAdvisoryMessages` → send advisory prompt; parse response → `applyAdvice`; when disabled, keep current `"hi"` behavior
- [ ] **T5.2** Update `pingKey()` to use `heartbeat_advisor_max_output_tokens` as `max_tokens` when advisor is active (default 8 instead of 5)
- [ ] **T5.3** Integration test: advisor-enabled ping cycle produces `heartbeat.advisor_parsed` or `heartbeat.advisor_failed` events
- [ ] **T5.4** Integration test: advisor-disabled ping cycle produces no advisory events, identical to current behavior

## Phase 6: Dashboard (optional, can defer)

- [ ] **T6.1** Add advisor event badges to the live event stream in `live-events.tsx`
- [ ] **T6.2** Add advisor status indicator to the FallbackPage health panel — "Advisor: Active | Idle | Disabled"
- [ ] **T6.3** Add advisor toggle to SettingsPage under the Resilience group

## Phase 7: Validation & Hardening

- [ ] **T7.1** Fuzz test `parseAdviceResponse` with random strings, truncated JSON, unicode edge cases
- [ ] **T7.2** Privacy regression test — snapshot advisory payload for a fixture DB, assert no key material / PII
- [ ] **T7.3** Cost measurement — log input/output token counts per advisory ping for 24h ping cycle, compare against budget estimate
- [ ] **T7.4** Feedback loop detection — log when advisor-recommended adjustments are contradicted by subsequent ping results (measures hallucination rate)

---

## Phase 8: Context Bridge & Sanitization (Rabbit Shake)

- [ ] **T8.1** Create `server/src/services/context-bridge.ts` with `PROVIDER_SANITIZERS` registry for token patterns (reusing `parseTokenDialect` from `tool-call-rescue.ts`)
- [ ] **T8.2** Implement `sanitizeForCrossProvider(responseText, sourceProvider)` — strips `<|...|>` tokens, structural blocks, maps system markers to plain text
- [ ] **T8.3** Implement `buildContextBridge()` — wraps `maybeInjectContextHandoff`, adds `[Thought Context: ...]` with sanitized prior response
- [ ] **T8.4** Unit tests for `sanitizeForCrossProvider` — each provider's tokens, structural blocks, generic `<|...|>` fallback
- [ ] **T8.5** Unit tests for `buildContextBridge` — standard handoff, oscillator handoff, no artifact leakage

## Phase 9: Rabbit Routing Strategy

- [x] **T9.1** Add `rabbit` to the routing strategy model (`RoutingStrategy`, validation, API schema) and label it **Rabbit** in the dashboard strategy selector
- [x] **T9.2** Add `rabbit_enabled` and optional `rabbit_weights` settings. Default Rabbit weights must match the existing Smartest preset: intelligence 45%, reliability 30%, latency 15%, speed 10%
- [x] **T9.3** Create `server/src/services/rabbit-shake.ts` with `OscillatorConfig` type and Rabbit eligibility helpers
- [x] **T9.4** Implement `resolveFoundationCandidates(config)` — returns an ordered model-agnostic candidate list by `foundationSelection` (`auto` = eligible models by Rabbit / Smartest-weight score, `top_rank` = rank=1 first, numeric override first)
- [x] **T9.5** Implement `resolveInjectionModel(config, foundationModelDbId)` — selects a divergent eligible model by `injectionSelection` (`divergent` = diff provider from selected foundation, `top_rank`, `different_tier`) without hardcoded model/provider names
- [ ] **T9.6** Implement `executeOscillator()` — 3-step pipeline: Foundation → Context Bridge → Injection → Context Bridge → Anchor
- [ ] **T9.7** Implement per-step timeout and graceful fallback (Step 1 candidate fail → try next foundation candidate; all Step 1 candidates fail → normal Smartest-weight single-model path; Step 2/3 fail → return selected Foundation)
- [x] **T9.8** Implement `detectMeow(text, patterns)` — structural tag leakage, Unicode script fragmentation, repeated chars, system markers
- [ ] **T9.9** Implement load-shedding: check `providerInFlight` count vs `oscillator_load_shed_threshold` before entering oscillator; when load-shed, continue with normal Rabbit / Smartest-weight single-model routing
- [ ] **T9.10** Unit tests for Rabbit strategy selection, `resolveFoundationCandidates`, and `resolveInjectionModel` with various config combos, including top-candidate failure and no hardcoded GLM/Nemotron assumptions
- [x] **T9.11** Unit tests for `detectMeow` — positive/negative cases, false positive rate on normal text

## Phase 10: Oscillator Integration

- [ ] **T10.1** Wire Rabbit strategy into `proxy.ts` request handler — when routing strategy is `rabbit`, use Rabbit / Smartest-weight ordering and call `executeOscillator` only for eligible complex reasoning requests
- [ ] **T10.2** Ensure non-eligible Rabbit requests, pinned-model requests, load-shed requests, and all-Step-1-failed requests fall back to normal best-eligible Smartest-weight single-model routing
- [ ] **T10.3** Add oscillator metrics logging to `logOscillatorResult()` for heartbeat advisor payload
- [ ] **T10.4** Add `oscillator_results` SQLite table + `logOscillatorResult()` persistence
- [ ] **T10.5** Implement `collectOscillatorStats(windowMs)` for advisory payload (§10.2)
- [ ] **T10.6** Add Rabbit / oscillator feature settings (T9 config keys) to DB seed + `feature-settings.ts`
- [ ] **T10.7** Add oscillator SSE events (`oscillator.started`, `.step_complete`, `.complete`, `.failed`, `.load_shed`, `.meow_detected`)

## Phase 11: Advisor ↔ Oscillator Feedback Loop

- [ ] **T11.1** Extend `RoutingAdvice` with `oscillatorHint`, `injectionModel`, `injectionBrevity` fields
- [ ] **T11.2** Update `applyAdvice()` to handle `oscillatorHint` (enable/disable with confidence thresholds) and `injectionModel` suggestions
- [ ] **T11.3** Update advisory system prompt to include oscillator control fields
- [ ] **T11.4** Integration test: advisor recommends Rabbit / oscillator control change → `rabbit_enabled` or oscillator eligibility override applied → verified on next cycle
