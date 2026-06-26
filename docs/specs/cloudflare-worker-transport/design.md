# Cloudflare Worker Transport Layer — Deep Sticky-Key Integration

## 1. Architecture Overview

This specification describes a deep integration of the Cloudflare Worker proxy as a **transport layer** rather than a separate provider. The proxy becomes a configurable transport option for any API key, providing IP rotation and header stripping while preserving all existing affinity, scoring, degradation, and routing features.

### Current Architecture (Limited Integration)
```
Client → Gateway (router, scoring, key affinity) → [Custom Provider: FreeLLMProxy] 
                                                  ↓
                                          FreeLLMProxy Router (round-robin)
                                                  ↓
                                          FreeLLMProxy Workers (IP rotation)
                                                  ↓
                                          Upstream Provider (OpenAI, Anthropic, etc.)
```

### Target Architecture (Deep Integration)
```
Client → Gateway (router, scoring, key affinity, sticky model) 
         ↓
   [Transport Decision: Direct OR Proxy] 
         ↓
   If Direct: Provider API (unchanged)
   If Proxy: 
         ↓
   FreeLLMProxy Router (session-aware worker affinity) 
         ↓
   FreeLLMProxy Worker N (consistent IP per session) 
         ↓
   Upstream Provider (unchanged)
```

**Key Innovation**: The proxy is no longer a "provider" but a **transport wrapper** that can be enabled per-API-key. This preserves:
- Key affinity (same key per session)
- Sticky model (same model per session) 
- Worker affinity (same worker IP per session ← NEW!)
- Degradation scoring (measures real provider, not proxy)
- Heartbeat, 429 exclusion, fast-fail (all unchanged)

## 2. Component Changes

### 2.1 Database Schema Update

Add `use_proxy` boolean column to `api_keys` table:

```sql
ALTER TABLE api_keys ADD COLUMN use_proxy INTEGER NOT NULL DEFAULT 0;
```

### 2.2 KeyRow Interface Update

Update `KeyRow` interface in `server/src/services/router.ts`:

```typescript
interface KeyRow {
  id: number;
  platform: string;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  status: string;
  enabled: number;
  base_url: string | null;
  use_proxy: number; // 0 or 1
}
```

### 2.3 Proxy Transport Decision Logic

Modify `proxy.ts` to check `key.use_proxy` before calling provider directly:

```typescript
// In the request handling loop, after getting route from routeRequest:
if (route.provider instanceof OpenAICompatProvider && 
    /* Check if the underlying API key has use_proxy=true */) {
  // Route through Cloudflare Worker proxy
  const proxiedResponse = await proxyRouter.fetch({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Proxy handles authentication via its own mechanism
      'X-Proxy-Session-Id': sessionId || '', // For worker affinity
      'X-Proxy-Key-Id': String(route.keyId), // For proxy-level metrics
    },
    body: JSON.stringify({
      // Forward the original request body, but:
      // - Remove provider auth header (proxy adds its own)
      // - Preserve everything else (model, messages, parameters, etc.)
      ...requestBody,
      // Add session ID for worker affinity if present
      ...(sessionId && { session_id: sessionId })
    })
  });
  // Process response from proxy...
} else {
  // Direct call to provider (existing behavior)
  const result = await route.provider.chatCompletion(
    route.apiKey, outboundMessages, route.modelId, options
  );
}
```

### 2.4 FreeLLMProxy Router Modifications

The FreeLLMProxy's `src/router.ts` needs enhancements:

#### New Features:
1. **Session-aware Worker Selection**: Hash `X-Proxy-Session-Id` to consistently select worker
2. **Worker Health Tracking**: Per-worker failure/success counters
3. **Health Endpoint**: `/healthz` returning worker status
4. **Unhealthy Worker Failover**: Skip unhealthy workers in selection

#### Modified Request Flow:
```
Ingress Request → 
  [Extract Session ID from X-Proxy-Session-Id header] →
  [Hash to select worker index] → 
  [Check worker health] →
  [If unhealthy: try next healthy worker OR round-robin among healthy] →
  [Forward to selected Worker] →
  [Worker: IP rotation + header strip] →
  [Upstream Provider]
```

### 2.5 Worker Affinity Implementation

In FreeLLMProxy router:
```typescript
// Hash session ID to get consistent worker index
function getWorkerIndex(sessionId: string | undefined, workerCount: number): number {
  if (!sessionId) return Math.floor(Math.random() * workerCount); // fallback to random
  
  const hash = crypto.createHash('sha1').update(sessionId).digest();
  const hashInt = hash.readUInt32BE(0);
  return hashInt % workerCount;
}

// Track worker health (in-memory, reset on restart)
interface WorkerStats {
  failures: number;
  successes: number;
  lastFailure: number | null;
}

const workerStats: Map<number, WorkerStats> = new Map();

// When selecting worker:
const workerIndex = getWorkerIndex(sessionId, PROXY_COUNT);
// If worker unhealthy, try next healthy or fallback
```

### 2.6 Configuration Changes

Add feature setting for proxy transport default:

In `server/src/services/feature-settings.ts`, add to REGISTRY:
```typescript
{
  key: 'proxy_transport_enabled',
  label: 'Proxy Transport Layer',
  description: 'Enable Cloudflare Worker transport for IP rotation and header stripping. When enabled, API keys can be configured to route through the proxy instead of connecting directly.',
  type: 'boolean',
  default: false,
  envVar: 'PROXY_TRANSPORT_ENABLED',
  effect: 'restart', // Requires restart to pick up new keys with use_proxy flag
  group: 'Resilience',
}
```

## 3. Data Flow Changes

### 3.1 Request Flow with Proxy Transport Enabled

1. **Client Request** arrives at `/v1/chat/completions` with optional `X-Session-Id`
2. **Session Key Computation**: `getSessionKey()` creates hash from first user message or header
3. **Key Affinity Check**: If `key_affinity_enabled=true`, compute deterministic key index
4. **Route Selection**: `routeRequest()` returns `RouteResult` with provider, model, decrypted key
5. **Transport Decision**: Check if the API key has `use_proxy=true`
6. **If Proxy Transport**:
   - Build request to FreeLLMProxy router
   - Include `X-Proxy-Session-Id: <sessionKey>` header
   - Include `X-Proxy-Key-Id: <keyId>` for metrics
   - Forward original request body (minus provider auth)
   - Process proxy response
7. **If Direct Transport**: Call provider directly (existing behavior)
8. **Response Handling**: Log request, update degradation, publish events (unchanged)

### 3.2 Response Flow

The flow is symmetric - responses travel back the same path:
- Proxy Worker strips upstream identifiers and applies IP rotation
- Gateway receives clean response
- Gateway logs, updates degradation, sends to client

## 4. Affinity Composition

With all three affinity layers active, a session gets:

```
Session ID "abc123" → 
  Key Affinity: SHA1("abc123") % key = sk-ABCDE...
  Sticky Model:  sessionMap["abc123"] = model_db_id=42 (gpt-4)
  Worker Affinity: SHA("abc123") % 3 = worker 2 (104.16.248.119)
```

All subsequent requests in the same session:
- Use the same API key (key affinity)
- Route to the same model (sticky model) 
- Go through the same proxy worker (worker affinity ← NEW!)

## 5. Failure Handling & Failover

### 5.1 Worker-Level Failures
- If selected worker fails (service binding error, timeout):
  - Proxy router marks worker as unhealthy temporarily
  - Request retried with next healthy worker (or round-robin if all unhealthy)
  - Session may shift to different IP on failure (acceptable failover behavior)

### 5.2 Key-Level Failures  
- Unchanged: 429/402 from upstream → key evicted via heartbeat
- Proxy doesn't interfere with status code propagation

### 5.3 Model-Level Failures
- Unchanged: 404/403 → model skipped for this request
- Sticky model session map entry cleared on model switch

### 5.4 Provider-Level Outages
- Unchanged: ≥N models 5xx → provider fast-failed for this request
- Detection happens at upstream level (beyond proxy)

## 6. Implementation Plan

### Phase 1: Core Infrastructure
- [ ] Add `use_proxy` column to `api_keys` table
- [ ] Update `KeyRow` interface and SQL queries
- [ ] Modify `proxy.ts` to check `key.use_proxy` and route accordingly
- [ ] Implement proxy transport decision logic (direct vs proxied)
- [ ] Add feature flag `proxy_transport_enabled`

### Phase 2: Proxy Router Enhancements  
- [ ] Modify FreeLLMProxy `router.ts` to:
  - Extract `X-Proxy-Session-Id` header
  - Implement consistent worker hashing
  - Add worker health tracking
  - Add `/healthz` endpoint
  - Implement unhealthy worker failover
- [ ] Update `deploy.ts` to make `ROUTER_DOMAIN` optional (workers.dev mode)
- [ ] Add session ID forwarding logic

### Phase 3: Testing & Validation
- [ ] Unit tests for worker affinity hashing
- [ ] Integration test: session → consistent worker IP
- [ ] Integration test: worker failover → IP change
- [ ] Verify existing affinity features still work
- [ ] Performance benchmark: proxy overhead measurement

### Phase 4: Observability
- [ ] Add metrics: proxy_requests_total, proxy_worker_errors
- [ ] Enhance logging to show transport mode (direct/proxy)
- [ ] Consider exposing worker health via `/metrics` endpoint

## 7. Backward Compatibility

✅ **Fully Backward Compatible**:
- Existing keys have `use_proxy=0` (default) → direct connections unchanged
- No changes to provider interfaces or scoring algorithms
- No changes to heartbeat, degradation, or exhaustion systems
- Feature flag defaults to disabled (`proxy_transport_enabled=false`)
- Existing custom provider configurations unaffected

## 8. Security Considerations

### 8.1 Trust Boundary
- The proxy sees decrypted API keys (for forwarding to upstream)
- This is acceptable because:
  - The proxy is already trusted infrastructure (runs in our Cloudflare account)
  - Same trust boundary as the gateway itself
  - Alternative (end-to-end encryption to upstream) would break proxy functionality

### 8.2 Session Privacy
- Session IDs are hashed before sending to proxy (never raw content)
- Proxy only sees the hash for worker affinity, not session content
- No application-level data exposed to proxy beyond what's necessary for routing

### 8.3 Rate Limiting
- Proxy implements its own rate limiting per upstream provider
- Gateway-level rate limits still apply (dual protection)
- 429 responses propagate correctly to trigger key eviction

## 9. Open Questions & Future Work

### 9.1 Per-Key Proxy Configuration UI
- Add "Use Proxy" toggle in Keys page when adding/editing keys
- Default to off, respecting `proxy_transport_enabled` feature flag

### 9.2 Dynamic Worker Count
- Currently hardcoded to match FreeLLMProxy's `PROXY_COUNT` (default 3)
- Could expose `/info` endpoint to discover actual worker count
- Or make configurable via feature setting

### 9.3 Advanced Worker Selection
- Least-connections instead of pure hashing
- Latency-based worker selection
- Geographic affinity (if users send location hints)

### 9.4 Mutual TLS
- For higher security environments, consider mTLS between gateway and proxy
- Would require provisioning client certs to gateway instances

## 10. Conclusion

This design transforms the Cloudflare Worker from an opaque external service into a deeply integrated transport layer that:
1. **Preserves all existing affinity properties** (key, model) 
2. **Adds worker affinity** for consistent IP per session
3. **Maintains zero changes** to core routing, scoring, degradation systems
4. **Provides operational simplicity** via feature flag and per-key opt-in
5. **Delivers the requested sticky worker semantics** while improving architectural clarity

The implementation leverages existing session infrastructure (X-Session-Id header, session key computation) and extends it naturally to the transport layer, creating a cohesive affinity system where:
> **Same Session ID → Same API Key → Same Model → Same Worker IP**

This provides the ideal balance of performance (connection reuse via KV cache), privacy (consistent egress IP), and resilience (graceful failover when workers fail).