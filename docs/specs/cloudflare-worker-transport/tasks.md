# Cloudflare Worker Transport Layer — Tasks

## Phase 1: Core Infrastructure (Gateway Side)

### T1.1 — DB Schema + Router Plumbing
- [ ] Add `use_proxy` column to `api_keys` table via `ensureApiKeysUseProxyColumn()`
- [ ] Add `use_proxy: number` to `KeyRow` interface
- [ ] Add `useProxy: boolean` to `RouteResult` interface
- [ ] Set `useProxy` from `key.use_proxy === 1` in `routeRequest()` return
- **Files:** `server/src/db/migrations.ts`, `server/src/services/router.ts`

### T1.2 — Feature Setting + Event Type
- [ ] Add `proxy_transport_enabled` boolean setting to REGISTRY
- [ ] Add `routing.worker_affinity_selected` to `LiveEventBase`
- **Files:** `server/src/services/feature-settings.ts`, `server/src/services/events.ts`

### T1.3 — Proxy Transport Service
- [ ] Create `server/src/services/proxy-transport.ts` with:
  - `buildProxyUrl(upstreamBaseUrl, proxyRouterUrl, proxyAuthKey)` — FreeLLMProxy URL construction
  - `proxyFetch(url, apiKey, body, sessionId)` — non-streaming proxy call
  - `proxyStreamFetch(url, apiKey, body, sessionId)` — streaming proxy call (yields SSE chunks)
  - Error classification: map proxy-specific errors to existing error types
- **Files:** `server/src/services/proxy-transport.ts` (NEW)

### T1.4 — Proxy.ts Integration
- [ ] After getting `route` from `routeRequest()`, check `route.useProxy && getFeatureSetting('proxy_transport_enabled')`
- [ ] If proxy: call `proxyFetch`/`proxyStreamFetch` instead of `route.provider.chatCompletion`/`streamChatCompletion`
- [ ] Publish `routing.worker_affinity_selected` event when proxy transport activates
- [ ] Ensure all post-processing (degradation, logging, sticky model, token accounting) still works
- **Files:** `server/src/routes/proxy.ts`

### T1.5 — Keys API CRUD
- [ ] Add `useProxy` optional boolean to `addKeySchema`
- [ ] Add `useProxy` optional boolean to `updateKeySchema`
- [ ] Include `use_proxy` in INSERT statement for new keys
- [ ] Include `useProxy` in GET response mapping
- [ ] Include `useProxy` in PATCH update handler
- **Files:** `server/src/routes/keys.ts`

### T1.6 — Code Review
- [ ] Spawn subagent review: correctness, edge cases, consistency, test gaps

## Phase 2: FreeLLMProxy Router Modifications
- Session-aware worker hashing (X-Proxy-Session-Id → deterministic worker)
- Worker health tracking (in-memory counters)
- `/healthz` endpoint
- Unhealthy worker failover
- **Note:** FreeLLMProxy is a git submodule — changes go upstream to `vadash/llm-proxy`

## Phase 3: Client/UI
- "Use Proxy" toggle in Keys page
- Proxy status indicator in live events panel
