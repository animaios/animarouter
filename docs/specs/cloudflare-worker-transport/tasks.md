# Cloudflare Worker Transport Layer — Tasks

## Phase 1: Core Infrastructure (Gateway Side)

### T1.1 — DB Schema + Router Plumbing ✅
- [x] Add `use_proxy` column to `api_keys` table via `ensureApiKeysUseProxyColumn()`
- [x] Add `use_proxy: number` to `KeyRow` interface
- [x] Add `useProxy: boolean` to `RouteResult` interface
- [x] Set `useProxy` from `key.use_proxy === 1` in `routeRequest()` return
- **Files:** `server/src/db/migrations.ts`, `server/src/services/router.ts`

### T1.2 — Feature Setting + Event Type ✅
- [x] Add `proxy_transport_enabled` boolean setting to REGISTRY
- [x] Add `routing.worker_affinity_selected` to `LiveEventBase`
- **Files:** `server/src/services/feature-settings.ts`, `server/src/services/events.ts`

### T1.3 — Proxy Transport Service ✅
- [x] Create `server/src/services/proxy-transport.ts` with:
  - `isProxyTransportConfigured()`, `buildProxyUrl()`, `proxyChatCompletion()`, `proxyStreamChatCompletion()`, `computeWorkerIndex()`
  - Error propagation with `retryAfterMs` on both streaming and non-streaming paths
- **Files:** `server/src/services/proxy-transport.ts` (NEW)

### T1.4 — Proxy.ts Integration ✅
- [x] After getting `route` from `routeRequest()`, check `route.useProxy && getFeatureSetting('proxy_transport_enabled') && isProxyTransportConfigured()`
- [x] If proxy: call `proxyFetch`/`proxyStreamFetch` instead of `route.provider.chatCompletion`/`streamChatCompletion`
- [x] Publish `routing.worker_affinity_selected` event when proxy transport activates
- [x] `resolveProviderBaseUrl()` helper throws for providers without baseUrl (e.g. Cloudflare)
- [x] All post-processing (degradation, logging, sticky model, token accounting) preserved
- **Files:** `server/src/routes/proxy.ts`

### T1.5 — Keys API CRUD ✅
- [x] Add `useProxy` optional boolean to `addKeySchema`
- [x] Add `useProxy` optional boolean to `updateKeySchema`
- [x] Include `use_proxy` in INSERT statement for new keys
- [x] Include `useProxy` in GET response mapping
- [x] Include `useProxy` in PATCH update handler
- **Files:** `server/src/routes/keys.ts`

### T1.6 — Code Review ✅
- [x] Critical: Added `retryAfterMs` to streaming error path
- [x] Critical: Added `resolveProviderBaseUrl()` — throws for providers without baseUrl
- [x] Critical: Fixed feature setting description (correct env var names)
- Remaining: Unit tests, migration test, configurable worker count

### T1.7 — Unit Tests (TODO)
- [ ] Unit tests for `proxy-transport.ts`
- [ ] Migration test for `use_proxy` column
- [ ] Integration test for transport decision logic

## Phase 2: FreeLLMProxy Router Modifications
- Session-aware worker hashing (X-Proxy-Session-Id → deterministic worker)
- Worker health tracking (in-memory counters)
- `/healthz` endpoint
- Unhealthy worker failover
- **Note:** FreeLLMProxy is a git submodule — changes go upstream to `vadash/llm-proxy`

## Phase 3: Client/UI
- "Use Proxy" toggle in Keys page
- Proxy status indicator in live events panel
