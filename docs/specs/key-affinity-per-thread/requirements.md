# Key Affinity Per Thread — Requirements

## 1. Problem Statement

### Current Behavior (The "Bug" Users Observe)

When users have multiple API keys for the same provider+model, the router cycles through them using round-robin (`roundRobinIndex` map). However, this round-robin is **global** — it advances on every request regardless of which session/thread the request belongs to.

In practice, this manifests as:
- **Low-traffic or single-session workloads**: Requests appear to "stick" to one API key because the round-robin index advances slowly
- **High-traffic multi-session workloads**: Keys are shared unevenly — some sessions may consistently hit the same key due to timing coincidences

More critically, there **is** a per-provider `sticky_sessions_enabled` column on `custom_providers` that would enable thread-scoped key affinity via deterministic hashing, but it's **broken by two coupling bugs**:

1. **Coupling Bug 1**: The session key (`stickySessionKey`) passed to `routeRequest()` is only computed when `context_handoff_mode !== 'off'` (proxy.ts L712). Default config has context handoff OFF, so `sessionKey = ''` → `stickySessionKey = undefined` → key affinity never activates even when `sticky_sessions_enabled = 1` on the custom provider.

2. **Coupling Bug 2**: Key-level affinity only exists for **custom providers** (reads from `custom_providers.sticky_sessions_enabled`). Built-in providers (OpenAI, Google, Anthropic, Cerebras, Cohere, Cloudflare) have no equivalent column and cannot use key affinity at all.

### Desired Behavior

Users want an **optional, globally-configured** feature that:
- When **enabled**: Routes all requests from the same **thread** (identified by the first user message hash) to the **same API key** within the selected model's pool. This maximizes upstream KV-cache reuse for cache-heavy providers and gives predictable load distribution.
- When **disabled** (default): Uses the existing round-robin behavior.
- Works for **ALL providers** (built-in + custom), not just custom providers.
- Is configurable in the **Settings page** under "Sessions" group.

## 2. Requirements

### FR-1: Global Feature Setting
Add a new feature setting `key_affinity_enabled` (boolean, default `false`, group "Sessions") in `server/src/services/feature-settings.ts`:
- Label: "Key Affinity Per Thread"
- Description: "Route all requests in the same conversation thread (identified by the first message) to the same API key. Maximizes upstream KV-cache reuse for cache-heavy providers. When disabled, keys are rotated round-robin."
- Effect: `live` (no restart needed)
- Environment variable: `KEY_AFFINITY_ENABLED`

### FR-2: Thread-Scoped Key Affinity Logic
Modify `routeRequest()` in `server/src/services/router.ts`:
- When `key_affinity_enabled === true` AND a `sessionKey` is available:
  - Compute deterministic key index from `sessionKey` (SHA1 hash → modulo key count)
  - Apply within **healthy keys first**, then unhealthy keys
  - Do NOT advance `roundRobinIndex` for this model (preserve rotation state for non-affinity traffic)
- When `key_affinity_enabled === false` OR no `sessionKey`:
  - Use existing round-robin logic (unchanged)

### FR-3: Decouple Session Key from Context Handoff
Modify `proxy.ts` to compute the session key **whenever key affinity is enabled**, regardless of context handoff mode:
- New logic: `const sessionKey = (getFeatureSetting('key_affinity_enabled') || getContextHandoffMode() !== 'off') ? getSessionKey(messages, sessionIdHeader) : '';`
- This ensures `stickySessionKey` flows to `routeRequest` when key affinity is on, even if context handoff is off.

### FR-4: Universal Provider Support
Extend key affinity to **all providers**, not just custom ones:
- Remove the dependency on `custom_providers.sticky_sessions_enabled` column
- The `stickyEnabled` check in `router.ts` should be: `const stickyEnabled = getFeatureSetting('key_affinity_enabled') as boolean;`
- (Keep the per-provider column for backward compat, but make it a NO-OP when global key affinity is enabled)

### FR-5: Settings Page Integration
Add the new setting to the Settings page in the client:
- Location: "Sessions" group, below "Sticky Sessions" toggle
- Depends on: Nothing (standalone toggle)
- When enabled, shows a helper note: "This works independently of Context Handoff."

### FR-6: Preserve Existing Behavior When Disabled
When `key_affinity_enabled = false` (default):
- Round-robin behavior is **identical** to current behavior
- Per-provider `sticky_sessions_enabled` column on custom providers continues to work **only when context handoff is also enabled** (preserves existing behavior for users who rely on it)

## 3. Non-Functional Requirements

### NFR-1: Performance
- Session key hashing: SHA1 (existing algorithm, fast)
- No additional DB queries in hot path
- In-memory `roundRobinIndex` unchanged for non-affinity traffic

### NFR-2: Backward Compatibility
- Default `key_affinity_enabled = false` → zero behavior change for existing deployments
- Per-provider `sticky_sessions_enabled` column remains in DB and API (no migration needed)

### NFR-3: Observability
- Log when key affinity selects a key: `[Proxy] Key affinity selected key ${keyId} for session ${sessionKey.slice(0,8)}`
- SSE event: `routing.key_affinity_selected` with `sessionKey` (truncated), `keyId`, `model`

## 4. Scope Boundaries

### In Scope
- New global feature setting
- Router key selection logic modification
- Proxy session key computation decoupling
- Settings page UI
- SSE event for key affinity selections

### Out of Scope
- Per-provider key affinity overrides (global only for now)
- Key affinity for embeddings endpoint (future)
- Persistence of affinity state across server restarts (session key is deterministic, no state needed)
- Dashboard analytics for key affinity effectiveness (future)

## 5. Acceptance Criteria

| ID | Scenario | Expected Result |
|----|----------|-----------------|
| AC-1 | `key_affinity_enabled = false` (default) | Round-robin key selection works exactly as before |
| AC-2 | `key_affinity_enabled = true`, single-thread conversation | All requests in conversation hit the same key |
| AC-3 | `key_affinity_enabled = true`, two parallel threads (different first messages) | Thread A hits Key 1, Thread B hits Key 2 (deterministic) |
| AC-4 | `key_affinity_enabled = true`, context handoff = 'off' | Key affinity still works (session key computed) |
| AC-5 | `key_affinity_enabled = true`, built-in provider (e.g., OpenAI) | Key affinity works for built-in providers |
| AC-6 | Key becomes exhausted during affinity session | Router falls through to next key (skips exhausted), next request from same thread re-hashes → may hit same key again if healthy, or next available key |
| AC-7 | Settings page toggle persists after reload | Setting saved to DB, takes effect immediately (live) |
| AC-8 | Multiple keys, some unhealthy | Affinity hashes over healthy keys first, only falls to unhealthy if all healthy exhausted |