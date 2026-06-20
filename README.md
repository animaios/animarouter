<div align="center">

# [AnimAIOS](https://github.com/animaios/airi) - FreeRouter

**One endpoint. Any provider. Every free tier. More tokens per month than you will ever need.**

Aggregate free tiers from Google, Groq, Cerebras, NVIDIA, Mistral, OpenRouter, GitHub Models, Cohere, Cloudflare, HuggingFace, Z.ai (Zhipu), Ollama, Kilo, Pollinations, LLM7, OVH AI Endpoints, and OpenCode Zen — plus **any OpenAI-compatible endpoint you bring** (llama.cpp, LM Studio, vLLM, local Ollama, or any remote service with an API key) — behind a single `/v1/chat/completions` endpoint. Every provider gets the same fallback chain, the same intelligent routing, the same dashboard. Keys are stored encrypted. A Thompson-sampling bandit picks the best available model for each request, falls over to the next provider when one is rate-limited, and tracks per-key usage so you stay under every cap. If you can reach it over HTTP and it speaks OpenAI, API-Gateway routes to it.

> **This is a fork** of [tashfeenahmed/freellmapi](https://github.com/tashfeenahmed/freellmapi). We add custom provider CRUD, per-provider rate limiting & parallel gating, model auto-discovery, editing of all models (including built-ins), and per-key exhaustion recovery — all detailed in [What this fork adds](#what-this-fork-adds). We track upstream weekly and merge cleanly.

<img width="256" height="384" alt="kawaii anima-chan" src="https://github.com/user-attachments/assets/992ae2fc-0473-40c9-b99b-cea7840b6543" />

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)
[![DeepSource](https://app.deepsource.com/gh/animaios/freeproxy.svg/?label=code+coverage&show_trend=true&token=c4KmjW5MkxAjVRTm0xZ9utwK)](https://app.deepsource.com/gh/animaios/freeproxy/)
[![DeepSource](https://app.deepsource.com/gh/animaios/freeproxy.svg/?label=active+issues&show_trend=true&token=c4KmjW5MkxAjVRTm0xZ9utwK)](https://app.deepsource.com/gh/animaios/freeproxy/)
[![DeepSource](https://app.deepsource.com/gh/animaios/freeproxy.svg/?label=resolved+issues&show_trend=true&token=c4KmjW5MkxAjVRTm0xZ9utwK)](https://app.deepsource.com/gh/animaios/freeproxy/)


</div>

## Contents

- [What this fork adds](#what-this-fork-adds)
- [Why this exists](#why-this-exists)
- [Supported providers](#supported-providers)
- [Features](#features)
- [Not yet supported](#not-yet-supported)
- [Quick start](#quick-start)
- [Docker](#docker)
- [Cloud Proxy](#cloud-proxy)
- [Using the API](#using-the-api)
- [Custom platforms and models](#custom-platforms-and-models)
- [Screenshots](#screenshots)
- [How it works](#how-it-works)
- [Context Handoff](#context-handoff)
- [Limitations](#limitations)
- [Contributing](#contributing)
- [Terms of Service review](#terms-of-service-review)
- [Disclaimer](#disclaimer)

## What this fork adds

This fork tracks [tashfeenahmed/freellmapi](https://github.com/tashfeenahmed/freellmapi) (upstream) and merges every release. On top of that, we ship features that turn API-Gateway from a weekend hack into a daily driver.

### Head-to-head comparison: what the original lacks and how this fork solves it

| Capability | freellmapi (original) | api-gateway (this fork) | What this means for you |
|---|---|---|---|
| **Add your own providers** | ❌ Stuck with the built-in list. No way to add a custom endpoint. | ✅ Add any OpenAI-compatible endpoint — a cloud service, a local Ollama on your LAN, a vLLM server on your homelab. Give it a name, a URL, and optional rate limits. | You can bring your paid APIs, your local models, and any free-tier service you discover — all routed through the same smart fallback chain, no separate tools needed. |
| **Per-provider rate limits & parallel gating** | ❌ No per-provider caps. All providers share a single generic rate limiter, so a slow endpoint can hog slots and a fragile free tier can get hammered. | ✅ Set RPM, RPD, TPM, TPD caps *per provider* plus a `maxParallelRequests` ceiling. Each provider gets its own guardrails. | A local Raspberry Pi model won't starve Groq. A free-tier endpoint with a 4-RPM cap won't get flooded into uselessness. You define the limits; the router enforces them. |
| **Model auto-discovery** | ❌ Manual. You copy-paste model IDs one by one, or edit JSON by hand. | ✅ Register a provider and it automatically pulls `/v1/models`, seeds every model with sensible defaults, and slots them into your fallback chain. | No JSON editing. No guessing model IDs. One click and all models from your endpoint are ready to use. |
| **Edit any model's properties** | ❌ Built-in models are read-only. You can't adjust intelligence rank, speed, context window, or capabilities. | ✅ Every model — built-in or custom — is editable from the dashboard. Intelligence rank, speed, size, context window, max tokens, tools/vision flags, rate limits — all changeable. | If you know your local Mixtral runs smarter than its default score, bump it. If a provider silently shrinks a context window, fix it. Changes take effect immediately, no restart needed. |
| **Model visibility matches reality** | ❌ `/v1/models` returns everything — even models with no keys, dead endpoints, or ones you disabled weeks ago. | ✅ `/v1/models` only returns models that are in your fallback chain *and* have at least one active, healthy key. | Your IDE's model picker only shows models you can actually call. No more errors from picking a model you can't reach. |
| **Key exhaustion recovery** | ❌ Retries once, then gives up. When every key hits its daily quota, the endpoint is dead until you manually intervene. | ✅ Three retries per key on transient failures. When all keys are exhausted, it drops to **1-RPM recovery mode** — probing each key once per minute until one comes back. Normal operation resumes automatically. | Your IDE never sees an error. Even when every key hits its daily cap, the system patiently waits and recovers on its own. You might not even notice. |
| **How it routes differently** | ❌ Static priority chain — always tries provider A, then B, then C. | ✅ **Thompson-sampling bandit** that learns which providers actually deliver. Balanced, smartest-first, fastest-first, and reliability-first presets. Or fall back to classic priority ordering. | The router gets smarter over time. It favors providers that are fast and reliable, and avoids ones that are failing. Your requests hit the best model available *right now*, not just whatever is top of a handwritten list. |
| **How it handles rate limits differently** | ❌ Generic cooldowns per model — a single 429 can bench a provider for everyone. | ✅ Per-key rate tracking (RPM/RPD/TPM/TPD) **before** the request goes out, not after. Keys with capacity get used; keys at their limit get skipped. Cooldowns are per-key, not per-model. | You can have 5 Gemini keys and the router will cycle through them intelligently instead of panicking when the first one hits a limit. Other keys for the same model stay available. |

### Also different from the original

| Difference | freellmapi (original) | api-gateway (this fork) | Why it's better |
|---|---|---|---|
| **Encryption** | AES-256-GCM for API keys at rest (same). | Same encryption, plus sensitive error messages from providers are automatically **redacted** before they reach your client. | Provider error responses sometimes leak key fragments, account IDs, or internal URLs. The fork strips those before you ever see them. |
| **Tool call handling** | Passes tool calls through. | Passes tool calls through **plus** includes automatic repair for common JSON Schema mismatches and a rescue system for inline tool-call dialects some providers emit. | Fewer broken tool loops. Models that emit slightly malformed tool calls get automatically corrected instead of failing. |
| **Context handoff on model switch** | ❌ Not present. | ✅ Optional. When a session falls over to a different model, injects a compact system message so the new model knows it's continuing an existing task instead of starting fresh. | No more "let me start over" when the router switches models mid-conversation. The new model picks up where the last one left off. |
| **Custom provider management** | ❌ Not available. | ✅ Full CRUD from the dashboard. Add, edit, delete custom providers. Auto-discover models on creation. Delete cascades cleanly (removes models, keys, and fallback entries). | Your entire setup — built-in and custom — is managed from one place, with one UI, using one workflow. |
| **Dashboard capability** | Keys, Fallback Chain, Playground, Analytics. | All of the above **plus** model editing, custom provider management, embeddings family configuration, and settings page. | Everything you need is in the dashboard. You rarely touch config files or a terminal. |

We chose this path because we use API-Gateway as a daily driver — not as a weekend project. These features make it faster to set up, harder to break, and more resilient when providers inevitably flake. If you're evaluating API-Gateway for actual daily use, you want this fork.

## Why this exists

Every serious AI lab now offers a free tier — millions of tokens a month, thousands of requests a day. On its own each tier is a toy. Stacked together, they add up to roughly **1.7 billion tokens per month** of working inference capacity, across 100+ models from small-and-fast to frontier-class reasoning.

The problem is that stacking them by hand is painful: a dozen different SDKs, a dozen different rate limits, a dozen places a request can fail. API-Gateway collapses all of that — every free tier, every custom endpoint, every local model — into one OpenAI-compatible endpoint. Point any OpenAI client library at your local server, and it routes transparently across whichever providers you've added keys for.

And when the built-in list isn't enough? You add your own. Any OpenAI-compatible HTTP endpoint becomes a provider in under a minute.

## Supported providers

<table>
<tr>
<td align="center" width="180"><a href="https://ai.google.dev"><b>Google</b><br/>Gemini 2.5 Flash · 3.x previews</a></td>
<td align="center" width="180"><a href="https://groq.com"><b>Groq</b><br/>Llama 3.3, Llama 4, GPT-OSS, Qwen3</a></td>
<td align="center" width="180"><a href="https://cerebras.ai"><b>Cerebras</b><br/>Qwen3 235B</a></td>
<td align="center" width="180"><a href="https://opencode.ai/zen"><b>OpenCode Zen</b><br/>DeepSeek V4 Flash · Nemotron (promo)</a></td>
</tr>
<tr>
<td align="center"><a href="https://mistral.ai"><b>Mistral</b><br/>Large 3 · Medium 3.5 · Codestral · Devstral</a></td>
<td align="center"><a href="https://openrouter.ai"><b>OpenRouter</b><br/>21 free-tier models</a></td>
<td align="center"><a href="https://github.com/marketplace/models"><b>GitHub Models</b><br/>GPT-4.1 · GPT-4o</a></td>
<td align="center"><a href="https://developers.cloudflare.com/workers-ai"><b>Cloudflare</b><br/>Kimi K2 · GLM-4.7 · GPT-OSS · Granite 4</a></td>
</tr>
<tr>
<td align="center"><a href="https://cohere.com"><b>Cohere</b><br/>Command R+ · Command-A (trial)</a></td>
<td align="center"><a href="https://docs.z.ai"><b>Z.ai (Zhipu)</b><br/>GLM-4.5 · GLM-4.7 Flash</a></td>
<td align="center"><a href="https://build.nvidia.com"><b>NVIDIA</b><br/>NIM · 40 RPM free (eval-only ToS)</a></td>
<td align="center"><a href="https://huggingface.co/docs/inference-providers"><b>HuggingFace</b><br/>Router → DeepSeek V4 · Kimi K2.6 · Qwen3</a></td>
</tr>
<tr>
<td align="center"><a href="https://ollama.com"><b>Ollama Cloud</b><br/>GLM-4.7 · Kimi K2 · gpt-oss · Qwen3</a></td>
<td align="center"><a href="https://kilo.ai"><b>Kilo Gateway</b><br/>:free routes (anon ok)</a></td>
<td align="center"><a href="https://pollinations.ai"><b>Pollinations</b><br/>GPT-OSS 20B (anon ok)</a></td>
<td align="center"><a href="https://llm7.io"><b>LLM7</b><br/>GPT-OSS · Llama 3.1 · GLM (anon ok)</a></td>
</tr>
<tr>
<td align="center"><a href="https://endpoints.ai.cloud.ovh.net"><b>OVH AI Endpoints</b><br/>Qwen3.5 397B · GPT-OSS · Llama 3.3 (anon ok)</a></td>
<td align="center"></td>
<td align="center"></td>
<td align="center"></td>
</tr>
</table>

<p align="center"><strong>Don't see yours? Add it.</strong> Any OpenAI-compatible endpoint — cloud service, local server, homelab GPU — becomes a provider in under a minute. It gets the same fallback chain, the same intelligent routing, the same rate-limit protection as every built-in. <a href="#custom-platforms-and-models">See how →</a></p>

## Features

- **OpenAI-compatible** — `POST /v1/chat/completions` and `GET /v1/models` work with the official OpenAI SDKs and any OpenAI-compatible client (LangChain, LlamaIndex, Continue, Cline, Codex, Claude Code via CC Switch, etc.). Just change `base_url`.
- **Responses API** — `POST /v1/responses` (the wire format current Codex CLI versions require) is implemented as a translating shim over the same router, with full streaming events and tool calls.
- **Streaming and non-streaming** — Server-Sent Events for `stream: true`, JSON response otherwise. Every provider adapter implements both.
- **Tool calling** — OpenAI-style `tools` / `tool_choice` requests are passed through, and assistant `tool_calls` + `tool` role follow-up messages round-trip across providers.
- **Embeddings** — `/v1/embeddings` with family-based routing: failover only ever happens between providers serving the *same* model (vectors from different models are incompatible), never across models. See [Embeddings](#embeddings).
- **Intelligent automatic fallover** — If the chosen provider returns a 429, 5xx, or times out, the router skips it, puts the key on a short cooldown, and retries on the next model in your fallback chain. No manual intervention, no dropped requests.
- **Per-key rate tracking** — RPM, RPD, TPM, and TPD counters per `(platform, model, key)` so the router always picks a key that's under its caps. You never accidentally blow through a free tier's daily limit at 9 AM.
- **Per-key exhaustion recovery** — Three retries per key on transient errors. When every key for a model is exhausted, the router doesn't give up — it drops to 1-RPM recovery mode, cycling through keys until one succeeds, then resumes normal operation. Your IDE never sees an error.
- **Provider-level parallel request gating** — Cap concurrent requests per provider so a slow endpoint never starves faster ones of connection slots. Your Groq connection stays fast even when a local model is chewing on a long prompt.
- **Thompson-sampling bandit routing** — The router learns which providers actually deliver and routes accordingly. Balanced, smartest-first, fastest-first, and reliability-first presets. Or fall back to classic manual priority ordering anytime.
- **Sticky sessions** — Multi-turn conversations keep talking to the same model for 30 minutes to avoid the hallucination spike that comes from mid-conversation model switches.
- **Encrypted key storage** — API keys are encrypted with AES-256-GCM before hitting SQLite; decryption happens in-memory just before a request.
- **Unified API key** — Clients authenticate to your proxy with a single `api-gateway-…` bearer token. You never expose upstream provider keys to your apps.
- **LAN auto-trust** — API-Gateway is a single-user tool, so the admin UI and `/api/*` routes skip the login form whenever the request comes from the local machine (loopback, RFC1918, link-local, IPv6 ULA / link-local). Remote callers still need an email + password account (scrypt-hashed, session-token auth), set on first run. The `/v1` proxy keeps its own unified-key auth for apps.
- **Health checks** — Periodic probes mark keys as `healthy`, `rate_limited`, `invalid`, or `error` so the router skips dead ones automatically.
- **Admin dashboard** — React + Vite UI to manage keys, reorder the fallback chain, edit any model's properties, register custom providers (models are auto-discovered on creation), inspect analytics, and run prompts in a playground. Dark mode included.
- **Analytics** — Per-request logging with latency, token counts, success rate, and per-provider breakdowns over 24h / 7d / 30d windows.
- **Context handoff on model switch** — Optional. When a session falls over to a different model, injects one compact system message so the new model knows it is continuing an existing task. Disabled by default; enable with `API_GATEWAY_CONTEXT_HANDOFF=on_model_switch`. See [Context Handoff](#context-handoff).
- **Runs anywhere Node 20+ runs** — Windows, macOS, Linux servers, or a small ARM SBC (Raspberry Pi included). ~40 MB RSS at idle behind PM2 / systemd / whatever supervisor you prefer.

## Not yet supported

The scope is deliberately narrow. If a feature isn't on this list and isn't below, assume it isn't there yet.

- **Image generation** (`/v1/images/*`)
- **Audio / speech** (`/v1/audio/*`)
- **Legacy completions** (`/v1/completions`) — only the chat endpoint is implemented
- **Moderation** (`/v1/moderations`)
- **`n > 1`** (multiple completions per request)
- **Per-user billing / multi-tenant auth** — single-user by design

PRs that add any of these are very welcome. See [Contributing](#contributing).

## Quick start

**Prerequisites:** Node.js 20+, npm. (Docker also works — see [Docker](#docker).)

```bash
git clone https://github.com/MLuqmanBR/api-gateway.git
cd api-gateway
npm install
cp .env.example .env

# Generate an encryption key for at-rest key storage
ENCRYPTION_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
printf "ENCRYPTION_KEY=%s\nPORT=3001\n" "$ENCRYPTION_KEY" > .env

npm run dev
```

Open http://localhost:5173 (the Vite dev UI), add your provider keys on the **Keys** page, reorder the **Fallback Chain** to taste, and grab your unified API key from the **Keys** page header. That unified key is what you point your OpenAI SDK at.

> **Reaching the dev UI from another device on your LAN?** Use `npm run dev:lan` — it passes `--host` through to Vite, which then prints a `Network: http://<your-ip>:5173` URL you can open from a phone or another machine. (Plain `npm run dev -- --host` does *not* work here: the root `dev` script is a `concurrently` wrapper, so the flag never reaches Vite.) API calls go through Vite's dev proxy, so no extra server config is needed.

For a production build without Docker:

```bash
npm run build
node server/dist/index.js     # server + dashboard both served on :3001
```

`ENCRYPTION_KEY` is required for startup. The server only falls back to a database-stored development key when `DEV_MODE=true` and `NODE_ENV` is not `production`; do not use that fallback with real provider keys.

Request analytics are retained for 90 days or 100000 request rows by default, whichever limit prunes first. Set `REQUEST_ANALYTICS_RETENTION_DAYS=0` or `REQUEST_ANALYTICS_MAX_ROWS=0` in `.env` to disable either retention limit.

## Docker

```bash
git clone https://github.com/MLuqmanBR/api-gateway.git
cd api-gateway

# Generate an encryption key
ENCRYPTION_KEY="$(openssl rand -hex 32)"
printf "ENCRYPTION_KEY=%s\nPORT=3001\n" "$ENCRYPTION_KEY" > .env

docker compose up -d --build
```

Open http://localhost:3001. SQLite data is stored in the `api-gateway-data` volume at `/app/server/data`. Keep the same `.env` `ENCRYPTION_KEY` and volume when upgrading.

> **Reaching it from another machine?** By default the container is published only on `127.0.0.1`. To expose it on your LAN — e.g. a Raspberry Pi at `http://192.168.1.x:3001` — start it with `HOST_BIND=0.0.0.0`:
>
> ```bash
> HOST_BIND=0.0.0.0 docker compose up -d --build
> ```
>
> Only do this on a trusted network: the proxy is single-user and guarded only by the unified API key.

More Docker operations and examples live in [docker/README.md](./docker/README.md).

## Cloud Proxy

API-Gateway ships an **optional** Cloudflare Workers proxy layer for IP rotation and header stripping. Deploy it to route requests through geographically-distributed exit IPs so upstream providers see consistent, non-identifying IP addresses instead of your real one.

> **This feature is entirely opt-in.** If you don’t clone the `freellmproxy` submodule or deploy workers, the gateway works exactly as before — no proxy, no errors.

**Prerequisites:** [wrangler](https://developers.cloudflare.com/workers/wrangler/) installed and logged in. Either install globally (`npm i -g wrangler && wrangler login`) or use the devDependency bundled in the proxy submodule (`cd freellmproxy && npx wrangler login`).

```bash
npm run proxy:deploy
```

On first run this automatically:
1. Initializes the `freellmproxy` git submodule
2. Installs proxy dependencies
3. Generates `freellmproxy/.env` with secure defaults (edit `ROUTER_DOMAIN` before production!)
4. Deploys N proxy workers + a router worker to Cloudflare

> **Domain setup:** The deploy script does not yet configure custom domains automatically. After deploying, add your domain in the Cloudflare dashboard: Workers & Pages → `llm-proxy-router` → Settings → Domains.

After deployment, register the proxy as a custom provider in the gateway dashboard:
1. Base64url-encode your target URL: `node -e "console.log(Buffer.from('https://api.example.com/v1').toString('base64url'))"`
2. Construct: `https://{ROUTER_DOMAIN}/{AUTH_KEY}/{PROXY_NUM}/{BASE64_URL}`
3. Add as a custom provider with that URL as the base URL

Other commands:

| Command | Purpose |
|---------|---------|
| `npm run proxy:dev` | Local dev server via wrangler |
| `npm run proxy:deploy` | Deploy all workers to Cloudflare |
| `npm run proxy:status` | Show deployment status |
| `npm run proxy:test` | Run proxy test suite |

Adjust `PROXY_COUNT` and `ROUTER_DOMAIN` in `freellmproxy/.env`. See [the proxy's README](freellmproxy/README.md) for the full architecture.

## Using the API

Any OpenAI-compatible client works. Examples:

**Python**

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3001/v1",
    api_key="api-gateway-your-unified-key",
)

resp = client.chat.completions.create(
    model="auto",  # let the router pick; or specify e.g. "gemini-2.5-flash"
    messages=[{"role": "user", "content": "Summarise the fall of Rome in one sentence."}],
)
print(resp.choices[0].message.content)
print("Routed via:", resp.headers.get("x-routed-via"))
```

**curl**

```bash
curl http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer api-gateway-your-unified-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "hi"}]
  }'
```

**Streaming**

```python
stream = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Stream me a haiku about SQLite."}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

**Tool calling**

Pass OpenAI-style `tools` and `tool_choice`; the assistant response round-trips back through the proxy exactly like the OpenAI API. Multi-step flows (assistant `tool_calls` → `tool` role follow-up → final answer) work across every provider the router can reach.

```python
tools = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get current weather for a city.",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    },
}]

# 1. Model asks for a tool call
first = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "What's the weather in Karachi?"}],
    tools=tools,
    tool_choice="required",
)
call = first.choices[0].message.tool_calls[0]

# 2. You execute the tool, feed the result back
final = client.chat.completions.create(
    model="auto",
    messages=[
        {"role": "user", "content": "What's the weather in Karachi?"},
        first.choices[0].message,
        {"role": "tool", "tool_call_id": call.id, "content": '{"temp_c": 32, "cond": "sunny"}'},
    ],
    tools=tools,
)
print(final.choices[0].message.content)
```

**Vision / image input**

Send images with the standard OpenAI `image_url` content blocks (base64 `data:` URLs or `http(s)` URLs). When a request contains an image, the router restricts itself to **vision-capable models** and ignores text-only ones. Vision models are tagged with a **Vision** badge on the Fallback Chain page.

```python
resp = client.chat.completions.create(
    model="auto",  # auto-routes to a vision model
    messages=[{
        "role": "user",
        "content": [
            {"type": "text", "text": "What's in this image?"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,<...>"}},
        ],
    }],
)
print(resp.choices[0].message.content)
```

If no vision-capable model is enabled in your Fallback Chain, an image request returns a clear `422` (`code: "no_vision_model"`) rather than silently dropping the image.

Every response carries an `X-Routed-Via: <platform>/<model>` header so you can see which provider actually served each call. If a request fell over between providers, you'll also see `X-Fallback-Attempts: N`.

### Embeddings

`/v1/embeddings` is OpenAI-compatible, with one deliberate difference from chat routing: **failover never crosses models.** Vectors from different models live in incompatible spaces — silently switching models would corrupt any vector store built on top of the proxy. So embeddings route by **family** (one model identity + dimension), and failover only walks the providers serving that same family.

```python
resp = client.embeddings.create(
    model="auto",          # default family; or a family name like "bge-m3"
    input=["the quick brown fox", "pack my box with five dozen liquor jugs"],
)
print(len(resp.data), "vectors of", len(resp.data[0].embedding), "dims")
```

```bash
curl http://localhost:3001/v1/embeddings \
  -H "Authorization: Bearer api-gateway-your-unified-key" \
  -H "Content-Type: application/json" \
  -d '{"model": "auto", "input": "hello world"}'
```

`model` accepts `auto` (the configured default family), a family name, or a provider-specific model id (which resolves to its family). Available families:

| Family (`model`) | Dims | Providers (failover order) |
| --- | --- | --- |
| `gemini-embedding-001` *(default)* | 3072 | Google |
| `text-embedding-3-large` | 3072 | GitHub Models |
| `text-embedding-3-small` | 1536 | GitHub Models |
| `embed-v4.0` | 1536 | Cohere |
| `bge-m3` | 1024 | Cloudflare → Hugging Face |
| `qwen3-embedding-0.6b` | 1024 | Cloudflare |
| `nv-embedqa-e5-v5` | 1024 | NVIDIA |
| `llama-nemotron-embed-1b-v2` | 2048 | NVIDIA |
| `llama-nemotron-embed-vl-1b-v2` | 2048 | NVIDIA → OpenRouter |
| `embeddinggemma-300m` | 768 | Cloudflare |

The default family, per-provider toggles, and priorities live on the dashboard's **Models → Embeddings** page.

## Custom platforms and models

The built-in provider list is a starting point, not a boundary. From the Keys page, the **Platforms** grid is the unified catalog — every built-in platform you've added a key for, alongside every custom platform you've registered. The grid ends with an **Add New Platform** tile that opens a modal for:

- **Slug** — a short identifier like `my-ollama` (lowercase letters, digits, dashes; 2-32 chars; cannot collide with a built-in).
- **Display name** — shown in the dashboard.
- **Base URL** — the OpenAI-compatible endpoint, e.g. `http://192.168.1.10:11434/v1`.
- **Rate limits** (optional) — RPM, RPD, TPM, TPD caps enforced per-provider. A local Ollama that can handle 200 RPM gets different treatment than a free-tier cloud endpoint limited to 4.
- **Max parallel requests** (optional) — concurrency ceiling so this provider never hogs all connection slots.

Once a platform exists, its models are automatically discovered from the endpoint's `/v1/models` during creation by default. However, discovered models are **disabled by default** and must be manually enabled. You can also re-run discovery at any time via `POST /api/custom-providers/:slug/sync-models`, and there's an option to auto-enable discovered models during creation.

- **Model ID** and **Display name** — required.
- **Context window**, **Supports tools**, **Supports vision** — basic flags.
- **Advanced** toggle exposes intelligence rank, speed rank, size label, per-model rate limits, and max output tokens.

The model joins the fallback chain at the lowest priority and shows up everywhere built-in models do — `/v1/models`, the Fallback page, the Analytics page. You can edit any model (built-in or custom) later: adjust ranks, toggle tools/vision, cap output tokens, change rate limits — all from the dashboard.

Adding an API key for a custom platform works the same as for a built-in: pick the custom slug in the **Add a provider key** form, paste the bearer (or leave blank for local servers that don't need one), and the key routes to your endpoint.

Removing a custom platform cascades — it drops every model on that platform, every key, and every fallback entry. There's no "leaving a model orphaned" state.

## Screenshots

### Keys

Manage provider credentials and grab the unified API key your apps connect with. Each key shows a status dot and when it was last health-checked. Custom platforms appear alongside built-in ones in the unified grid.

![Keys page](repo-assets/keys.png)

### Playground

Send a chat completion through the router and see which provider served it, with the model ID and latency printed right on the message.

![Playground page](repo-assets/playground.png)

### Analytics

Request volume, success rate, tokens in and out, average latency, and per-provider breakdowns over 24h / 7d / 30d windows.

![Analytics page](repo-assets/analytics.png)

## How it works

```
┌──────────────────┐   Bearer api-gateway-…   ┌─────────────────────────┐
│  OpenAI SDK /    │ ──────────────────────▶ │  Express proxy (:3001)  │
│  curl / any      │ ◀────────────────────── │  /v1/chat/completions   │
│  OpenAI client   │      streamed tokens    └────────────┬────────────┘
└──────────────────┘                                      │
                                                          ▼
                             ┌────────────────────────────────────────────────┐
                             │  Router                                        │
                             │   1. Pick highest-priority model that          │
                             │      (a) has a healthy key and                 │
                             │      (b) is under all its rate limits.         │
                             │   2. Decrypt key, call provider SDK.           │
                             │   3. On 429/5xx → cooldown + retry next model. │
                             │   4. On key exhaustion → cycle keys, 1-RPM.    │
                             └────────────────────────────────────────────────┘
                                          │
   ┌──────────────┬────────────┬──────────┴─────────┬─────────────┬──────────┐
   ▼              ▼            ▼                    ▼             ▼          ▼
 Google         Groq        Cerebras           OpenRouter        HF       …and more
                                +
                        Custom Providers
                    (any OpenAI-compatible endpoint)
```

- **Router** (`server/src/services/router.ts`) — picks a model per request using Thompson-sampling bandit scoring or manual priority chain.
- **Scoring** (`server/src/services/scoring.ts`) — Thompson-sampling bandit: reliability × speed × intelligence, with headroom and rate-limit guardrails.
- **Rate-limit ledger** (`server/src/services/ratelimit.ts`) — in-memory RPM/RPD/TPM/TPD counters backed by SQLite, with cooldowns on 429s.
- **Key exhaustion** (`server/src/services/key-exhaustion.ts`) — per-key 3-retry → key cycling → 1-RPM recovery mode.
- **Provider adapters** (`server/src/providers/*.ts`) — one file per provider, implementing the `Provider` base class: `chatCompletion()` and `streamChatCompletion()`. Custom providers are resolved from the `custom_providers` table at request time.
- **Health service** (`server/src/services/health.ts`) — periodic probe keeps key status fresh.
- **Dashboard** (`client/`) — React + Vite + shadcn/ui admin surface.
- **Storage** — SQLite (`better-sqlite3`) with AES-256-GCM envelope encryption for keys.

## Context Handoff

When API-Gateway falls over to a different model mid-conversation (quota, rate limit, cooldown), the new model has no idea it is picking up someone else's task. **Context handoff** adds a single compact `system` message to the outbound request that tells the new model exactly that:

```
API-Gateway context handoff:
You are taking over an ongoing conversation from another model (groq:llama-3 → google:gemini-flash).
Continue the user's task using the conversation context already provided in this request.
Do not restart the task, re-ask already answered setup questions, or discard prior tool results.
Respect the user's latest message as the highest-priority instruction.

Recent session summary:
User: …
Assistant: …
```

**Enable it in `.env`:**

```env
API_GATEWAY_CONTEXT_HANDOFF=on_model_switch
```

**How it works:**

- Messages per session are stored in memory (TTL: 3 hours).
- Only injected when the selected model changes for a given session key.
- Not injected on the first request, on same-model continuations, or if a handoff message is already present.
- Session key: `X-Session-Id` header if present, otherwise SHA-1 of the first user message (same as sticky sessions).
- Storage is in-memory only. Nothing is written to disk or logged.

> **Important:** Context Handoff improves continuity for conversations routed through API-Gateway. It cannot recover provider-internal hidden state or messages that were never sent to the proxy.

## Limitations

Stacking free tiers — even with custom providers in the mix — has real trade-offs. Be honest with yourself about them:

- **No frontier models out of the box.** The free-tier catalog tops out around Llama 3.3 70B, GLM-4.5, Qwen 3 Coder, and Gemini 2.5 Pro. You will not get GPT-5 or Claude Opus class reasoning through the built-in providers. For hard problems, pay for a real API — or bring your own paid provider as a custom platform.
- **Intelligence degrades as the day progresses.** Your top-ranked models (usually Gemini 2.5 Pro, GPT-4o via GitHub Models) have the lowest daily caps. Once they hit their limits, the router falls down your priority chain to smaller/weaker models. Expect the effective intelligence of the endpoint to drop in the late hours of each day — then reset at UTC midnight.
- **Latency is highly variable.** Cerebras and Groq are extremely fast; others are not. You get whichever one is available at the moment.
- **Free tiers can change without notice.** Providers regularly tighten, loosen, or remove free tiers. When that happens you'll see 429s or auth errors until the catalog catches up. Re-seed scripts live in `server/src/scripts/`.
- **No SLA, by definition.** If you need reliability, use a paid provider with a contract — either directly or plugged into API-Gateway as a custom platform.
- **Local-first.** There's no multi-tenant auth. Run this for yourself; don't expose it to the internet.

## Contributing

Contributors very welcome! Good first PRs:

- **Add a provider** — copy `server/src/providers/openai-compat.ts` as a template, wire it into `server/src/providers/index.ts`, seed its models in `server/src/db/migrations.ts`, add a test in `server/src/__tests__/providers/`.
- **Add an endpoint** — images, moderations, audio. The provider base class can grow new methods; adapters declare which they support.
- **Improve the router** — cost-aware routing (cheapest-healthy-fastest tradeoffs), better latency-weighted priority, regional pinning.
- **Dashboard polish** — charts on the Analytics page, key rotation UX, batch import of keys from `.env`.
- **Docs** — more examples, client library snippets for Go/Rust/etc., a deployment recipe for Docker or Fly.

**Development loop:**

```bash
npm install
npm run dev      # server on :3001, dashboard on :5173, both with HMR
npm test         # server vitest; also runs client tests if the workspace adds them
npm run build    # compile server and dashboard
```

PRs should include a test, keep the existing test suite green, and match the `.editorconfig` / tsconfig defaults already in the repo. Issues and discussions are open.

### Contributors

<a href="https://github.com/moaaz12-web"><img src="https://images.weserv.nl/?url=github.com/moaaz12-web.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@moaaz12-web" /></a>
<a href="https://github.com/lukasulc"><img src="https://images.weserv.nl/?url=github.com/lukasulc.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@lukasulc" /></a>
<a href="https://github.com/VinhPhamAI"><img src="https://images.weserv.nl/?url=github.com/VinhPhamAI.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@VinhPhamAI" /></a>
<a href="https://github.com/deadc"><img src="https://images.weserv.nl/?url=github.com/deadc.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@deadc" /></a>
<a href="https://github.com/zhangyu1324"><img src="https://images.weserv.nl/?url=github.com/zhangyu1324.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@zhangyu1324" /></a>
<a href="https://github.com/Tazrif-Raim"><img src="https://images.weserv.nl/?url=github.com/Tazrif-Raim.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@Tazrif-Raim" /></a>
<a href="https://github.com/hodlmybeer69-bit"><img src="https://images.weserv.nl/?url=github.com/hodlmybeer69-bit.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@hodlmybeer69-bit" /></a>
<a href="https://github.com/phoenixikkifullstack"><img src="https://images.weserv.nl/?url=github.com/phoenixikkifullstack.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@phoenixikkifullstack" /></a>
<a href="https://github.com/jtbrennan-git"><img src="https://images.weserv.nl/?url=github.com/jtbrennan-git.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@jtbrennan-git" /></a>
<a href="https://github.com/praveenkumarpranjal"><img src="https://images.weserv.nl/?url=github.com/praveenkumarpranjal.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@praveenkumarpranjal" /></a>
<a href="https://github.com/nordbyte"><img src="https://images.weserv.nl/?url=github.com/nordbyte.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@nordbyte" /></a>
<a href="https://github.com/mybropro"><img src="https://images.weserv.nl/?url=github.com/mybropro.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@mybropro" /></a>
<a href="https://github.com/danscMax"><img src="https://images.weserv.nl/?url=github.com/danscMax.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@danscMax" /></a>
<a href="https://github.com/jhash"><img src="https://images.weserv.nl/?url=github.com/jhash.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@jhash" /></a>
<a href="https://github.com/JammyJames1234"><img src="https://images.weserv.nl/?url=github.com/JammyJames1234.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@JammyJames1234" /></a>
<a href="https://github.com/Sumit4codes"><img src="https://images.weserv.nl/?url=github.com/Sumit4codes.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@Sumit4codes" /></a>
<a href="https://github.com/meliani"><img src="https://images.weserv.nl/?url=github.com/meliani.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@meliani" /></a>
<a href="https://github.com/thedavidweng"><img src="https://images.weserv.nl/?url=github.com/thedavidweng.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@thedavidweng" /></a>
<a href="https://github.com/bharvey42"><img src="https://images.weserv.nl/?url=github.com/bharvey42.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@bharvey42" /></a>
<a href="https://github.com/yuvrxj-afk"><img src="https://images.weserv.nl/?url=github.com/yuvrxj-afk.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@yuvrxj-afk" /></a>
<a href="https://github.com/Tushar49"><img src="https://images.weserv.nl/?url=github.com/Tushar49.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@Tushar49" /></a>
<a href="https://github.com/nicyoong"><img src="https://images.weserv.nl/?url=github.com/nicyoong.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@nicyoong" /></a>
<a href="https://github.com/Aldo-f"><img src="https://images.weserv.nl/?url=github.com/Aldo-f.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@Aldo-f" /></a>
<a href="https://github.com/Tazrif-Raim"><img src="https://images.weserv.nl/?url=github.com/Tazrif-Raim.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@Tazrif-Raim" /></a>
<a href="https://github.com/m1nuzz"><img src="https://images.weserv.nl/?url=github.com/m1nuzz.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@m1nuzz" /></a>
<a href="https://github.com/LoneRifle"><img src="https://images.weserv.nl/?url=github.com/LoneRifle.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@LoneRifle" /></a>
<a href="https://github.com/ita333"><img src="https://images.weserv.nl/?url=github.com/ita333.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@ita333" /></a>
<a href="https://github.com/barbotkonv"><img src="https://images.weserv.nl/?url=github.com/barbotkonv.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@barbotkonv" /></a>
<a href="https://github.com/Naster17"><img src="https://images.weserv.nl/?url=github.com/Naster17.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@Naster17" /></a>
<a href="https://github.com/StealthTensor"><img src="https://images.weserv.nl/?url=github.com/StealthTensor.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@StealthTensor" /></a>
<a href="https://github.com/EmranAhmed"><img src="https://images.weserv.nl/?url=github.com/EmranAhmed.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@EmranAhmed" /></a>
<a href="https://github.com/itsfuad"><img src="https://images.weserv.nl/?url=github.com/itsfuad.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@itsfuad" /></a>
<a href="https://github.com/RobinHoodO"><img src="https://images.weserv.nl/?url=github.com/RobinHoodO.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@RobinHoodO" /></a>
<a href="https://github.com/hmm183"><img src="https://images.weserv.nl/?url=github.com/hmm183.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@hmm183" /></a>
<a href="https://github.com/duemilionidieuro-bot"><img src="https://images.weserv.nl/?url=github.com/duemilionidieuro-bot.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@duemilionidieuro-bot" /></a>
<a href="https://github.com/hjhhoni"><img src="https://images.weserv.nl/?url=github.com/hjhhoni.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@hjhhoni" /></a>
<a href="https://github.com/immanuelsavio"><img src="https://images.weserv.nl/?url=github.com/immanuelsavio.png&w=60&h=60&fit=cover&mask=circle" width="60" alt="@immanuelsavio" /></a>

## Terms of Service review

A self-hosted, single-user, personal-use setup was re-reviewed against each provider's ToS (May 2026). Summary:

| Provider | Verdict | Notes |
|---|---|---|
| Google Gemini | ⚠️ Caution | March 2026 ToS narrows scope to *"professional or business purposes, not for consumer use"* — a self-hosted developer proxy is still defensible, but the clause is new. |
| Groq | ✅ Likely OK | GroqCloud Services Agreement permits Customer Application integration. |
| Cerebras | ✅ Likely OK | Permitted; explicitly forbids selling/transferring API keys. |
| Mistral | ✅ Likely OK | APIs allowed for personal/internal business use. |
| OpenRouter | ✅ Likely OK | April 2026 ToS sharpens the no-resale / no-competing-service clause; private single-user proxy still fine. |
| Cloudflare Workers AI | ⚠️ Ambiguous | No anti-proxy clause; covered by general Self-Serve Subscription Agreement. |
| NVIDIA NIM | ⚠️ Caution | Trial ToS §1.2 / §1.4: *"evaluation only, not production."* Free access is a recurring 40 RPM rate limit (the 2025 credit system was discontinued), but the evaluation-only scope stands. |
| GitHub Models | ⚠️ Caution | Free tier explicitly scoped to *"experimentation"* and *"prototyping."* |
| Cohere | ❌ Avoid | Terms §14 still forbids *"personal, family or household purposes."* |
| Zhipu (open.bigmodel.cn) | ✅ Likely OK | Personal/non-commercial research carve-out still in the platform docs. |
| Z.ai (api.z.ai) | ⚠️ Caution | Singapore entity (distinct from Zhipu CN). §III.3(l) anti-traffic-redirect clause could plausibly be read against a proxy; no explicit personal-use carve-out. |
| Ollama Cloud | ✅ Likely OK | Free plan permits cloud-model access (1 concurrent, 5-hour session caps). No anti-proxy / anti-resale clauses found. |
| OVH AI Endpoints | ✅ Likely OK | Anonymous access is officially documented (2 req/min per IP per model). OVH reserves the right to introduce token/consumption caps. |

Rules of thumb that keep most providers happy: **one account per provider**, **no reselling**, **no sharing your endpoint with other humans**, **don't hammer a free tier as a paid production backend**. This is informational, not legal advice — read each provider's ToS and make your own call.

## Disclaimer

**This project is for personal experimentation and learning, not production.** Free tiers exist so developers can prototype against them; they aren't a stable, supported inference substrate and shouldn't be treated as one. If you build something real on top of API-Gateway, swap in a paid API before you ship. Your relationship with each upstream provider is governed by the terms you accepted when you created your account — those terms still apply when the traffic is proxied through this project, and you're responsible for complying with them.

***

Built on [tashfeenahmed/freellmapi](https://github.com/tashfeenahmed/freellmapi). Fork maintained by [MLuqmanBR](https://github.com/MLuqmanBR).

## License

[MIT](./LICENSE)
