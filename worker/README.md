# AnimaRouter Anonymizing Worker

Cloudflare Worker relay for AnimaRouter's first outbound transport.

Request shape expected by `server/src/services/proxy-transport.ts`:

```text
POST /{PROXY_AUTH_KEY}/1/{base64url(upstreamUrl)}
Authorization: Bearer <selected provider API key>
X-Proxy-Session-Id: <AnimaRouter session key>
Content-Type: application/json
```

The Worker validates the shared auth key, decodes the upstream URL, strips
client/internal headers, forwards the selected provider API key, and streams the
upstream response back unchanged.

Deploy:

```bash
npm run deploy -w worker
```

Set the shared secret:

```bash
npx wrangler secret put PROXY_AUTH_KEY --config worker/wrangler.toml
```

AnimaRouter server config:

```env
PROXY_TRANSPORT_ENABLED=true
PROXY_ROUTER_URL=https://animarouter-anon-transport.<account>.workers.dev
PROXY_AUTH_KEY=<same secret>
```

`ALLOWED_HOSTS` defaults to `*` for custom-provider compatibility. To restrict
it, set a comma-separated list such as:

```toml
ALLOWED_HOSTS = "api.openai.com,*.example.internal"
```
