# Cloudflare Worker Transport Layer — Requirements

> **Status:** Approved
> **Spec:** `docs/specs/cloudflare-worker-transport/design.md`

---

## R1: Per-Key Proxy Transport
**The gateway MUST support routing any API key's requests through a Cloudflare Worker proxy instead of direct provider connections.**

- An API key can be flagged `use_proxy=true`
- When a flagged key is selected by the router, the request is forwarded through the FreeLLMProxy router
- Keys without the flag continue using direct connections (no change)
- The proxy is a **transport layer**, NOT a separate provider — scoring, degradation, and affinity all operate on the real provider identity

## R2: Session-Sticky Worker Affinity
**The same session MUST consistently use the same proxy worker for IP consistency.**

- The gateway sends `X-Proxy-Session-Id` (derived from the existing session key) with proxied requests
- The FreeLLMProxy router uses this header to deterministically select a worker (SHA1 hash modulo worker count)
- Same session → same key → same model → same worker IP
- If the sticky worker is unhealthy, failover to the next healthy worker (acceptable IP change on failure)

## R3: Feature Flag Guard
**Proxy transport MUST be gated behind a feature flag, defaulting to off.**

- New feature setting `proxy_transport_enabled` (boolean, default `false`)
- When disabled, keys with `use_proxy=true` are treated as direct (proxy transport is skipped)
- Environment variable override: `PROXY_TRANSPORT_ENABLED`

## R4: Dual-Mode Streaming Support
**Proxy transport MUST support both streaming (SSE) and non-streaming (JSON) response paths.**

- Streaming: the proxy transport relays upstream SSE chunks to the gateway's existing stream processing pipeline
- Non-streaming: the proxy transport returns the JSON response body
- All existing proxy.ts post-processing applies (tool-call rescue, dialect detection, argument repair, sticky model updates, degradation tracking)

## R5: Backward Compatibility
**No existing behavior changes when the feature is disabled.**

- Existing keys get `use_proxy=0` (default) — no migration of data needed
- Existing provider interfaces, scoring algorithms, heartbeat, degradation, exhaustion systems are unchanged
- Error classification (`classifyError`) works the same whether the error came direct or through proxy (status codes are passed through)

## R6: API Key CRUD Support
**The keys API MUST support reading and writing the `useProxy` flag.**

- `GET /api/keys` returns `useProxy: boolean` per key
- `POST /api/keys` accepts optional `useProxy` field (default `false`)
- `PATCH /api/keys/:id` accepts `useProxy` in the update schema
- `DELETE` is unchanged

## R7: Observability
**Proxy transport routing decisions MUST be visible in the SSE event stream.**

- New event type `routing.worker_affinity_selected` published when proxy transport is used with a session
- Event includes: session key (truncated), key ID, worker index, model
- Existing `routing.key_affinity_selected` event fires before this one (key affinity happens at routing time, worker affinity at transport time)

## R8: Configuration
**Proxy transport requires two environment variables to function.**

- `PROXY_ROUTER_URL` — the FreeLLMProxy router endpoint (e.g. `https://llm-proxy-router.xxx.workers.dev`)
- `PROXY_AUTH_KEY` — the auth key for the proxy router (from FreeLLMProxy's `.env`)
- When `proxy_transport_enabled=true` but either variable is missing, log a warning and fall back to direct transport
