<div align="center">

# [Anima](https://github.com/animaios/airi)Router

**One endpoint. Any provider. Every free tier. Smart routing that learns.**

<img width="256" height="384" alt="AnimAIOS mascot" src="https://github.com/user-attachments/assets/52efcf2a-6cf3-40ad-bb14-d2092c7b4f0e" />
<br>
<br>

<!--
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)
-->

[![DeepSource](https://app.deepsource.com/gh/animaios/animarouter.svg/?label=code+coverage&show_trend=true&token=c4KmjW5MkxAjVRTm0xZ9utwK)](https://app.deepsource.com/gh/animaios/animarouter/)
[![DeepSource](https://app.deepsource.com/gh/animaios/animarouter.svg/?label=active+issues&show_trend=true&token=c4KmjW5MkxAjVRTm0xZ9utwK)](https://app.deepsource.com/gh/animaios/animarouter/)
[![DeepSource](https://app.deepsource.com/gh/animaios/animarouter.svg/?label=resolved+issues&show_trend=true&token=c4KmjW5MkxAjVRTm0xZ9utwK)](https://app.deepsource.com/gh/animaios/animarouter/)

<sub> Fork of [`MLuqmanBR/api-gateway`](https://github.com/MLuqmanBR/api-gateway) re-attached to [`tashfeenahmed/freellmapi`](https://github.com/tashfeenahmed/freellmapi)) for better visibility. </sub> <br> <br>

</div>

<details>
<summary><h2>📸 Screenshots</h2> (click to expand)</summary>
<img width="1513" height="979" alt="screenshot1" src="https://github.com/user-attachments/assets/b6754378-8ec0-4fa0-a6ab-e2ae9af0a204" />
<img width="1494" height="928" alt="screenshot2" src="https://github.com/user-attachments/assets/93015b52-9cf6-4906-b2a3-b39b2c2bd272" />
<img width="1508" height="816" alt="screenshot3" src="https://github.com/user-attachments/assets/56d0cfdc-4535-4500-b222-2acffbb1f111" />
</details>

---

## 📑 Contents

- [What AnimaRouter adds](#what-animarouter-adds)
- [In Development](#in-development)
- [Quick Start](#quick-start)
- [Docker](#docker)
- [Cloud Proxy](#cloud-proxy)
- [Using the API](#using-the-api)
- [Context Handoff](#context-handoff)
- [Supported Providers](#supported-providers)
- [Custom Platforms and Models](#custom-platforms-and-models)
- [Screenshots](#screenshots)
- [Limitations](#limitations)
- [Contributing](#contributing)
- [Terms of Service Review](#terms-of-service-review)
- [Disclaimer](#disclaimer)
- [License](#license)

## ✨ What AnimaRouter adds
What follows is only what AnimaRouter adds on top of `api-gateway`. Upstream already ships OpenAI-compatible routing, Thompson-sampling bandits, per-key rate tracking, recovery, custom provider CRUD, context handoff, encrypted storage, dark-mode dashboard, and more. If it's not listed here, `api-gateway` already has it.

### 👾 Routing & Resilience

| Feature | What | Why it matters |
|---------|------|---------------|
| **Dynamic Degradation** | Severity-weighted progressive penalties replacing the flat `rateLimitFactor`. 429 → minor (2 min half-life), 5xx → major (15 min), consecutive hard failures → critical (60 min). Compounding exponential penalties + sigmoid degradation factor. Dashboard-visible + env-configurable. | Flat rate-limit penalties can't distinguish a polite retry from a burning server. Degradation matches the penalty to the problem. *(spec: `docs/specs/dynamic-degradation/`)* |
| **Strict model pinning** | When you pin a model, it stays pinned — even on error. | Upstream silently falls through to a different model on failure, which breaks workflows that depend on a specific model's behaviour. |
| **Free-only enforcement** | OpenRouter and OpenCode routes restricted to `:free` models only. Monthly token budget system removed in favour of simpler quotas. | AnimaRouter is about stacking free tiers; accidentally hitting a paid endpoint through those routes costs real money. |
| **Keyless custom providers** | Local servers that don't need auth can be added without a key. | Upstream requires a key for every provider — a blocker for self-hosted/Ollama-style endpoints that have no auth layer. |
| **Archive instead of hard-delete** | Custom providers and models get archived (restorable), not cascade-deleted. | Upstream cascade-deletes on removal. One misclick and your whole custom provider config is gone. Archive is reversible. |

### 🧠 Benchmarks & Intelligence

| Feature | What | Why it matters |
|---------|------|---------------|
| **Benchmark Unification** | Merges Artificial Analysis, SWE-rebench, and NIMStats into a single composite intelligence score. Per-source columns, canonical model keys, incremental recomputation, configurable weights. | Upstream has no benchmark integration. A single composite score replaces guessing which single benchmark to trust. *(spec: `docs/specs/benchmark-unification/`)* |
| **SWE-rebench for intelligence** | Replaced SWE-bench with SWE-rebench for model intelligence scoring. | SWE-rebench is a more reliable, less-contaminated benchmark for real-world coding ability. |
| **Reasoning token fairness** | `tokPerSec` speed score includes reasoning/thinking tokens so reasoning models aren't unfairly penalised. | Upstream doesn't count reasoning tokens in speed calc — a thinking model that outputs 100 tok/s of reasoning + 30 tok/s of visible text looks "slower" than a 40 tok/s non-reasoning model. Unfair. *(spec: `docs/specs/reasoning-speed-fairness.md`)* |

### 🩹 Provider Support

| Feature | What | Why it matters |
|---------|------|---------------|
| **CommandCode provider** | Full NDJSON translation layer, built-in. | Upstream doesn't ship it. CommandCode has a non-standard streaming format that needs a dedicated adapter. |
| **NVIDIA NIM hardening** | Robust handling of NIM-specific API quirks. | NIM's API diverges from the OpenAI spec in subtle ways; without hardening, requests silently fail or return malformed data. |
| **End-to-end thinking/reasoning passthrough** | `reasoning_content` deltas, Gemini thought signatures, thinking block handling across all providers. | Reasoning models (DeepSeek, Gemini, etc.) emit thinking tokens that must be preserved end-to-end, not silently dropped. |
| **`max_output_tokens` fallback** | Uses catalog `max_output_tokens` as `max_tokens` fallback when the request doesn't specify. | Prevents truncation when a client omits `max_tokens` but the provider enforces a default cap. |

### 📊 Dashboard & UX

| Feature | What | Why it matters |
|---------|------|---------------|
| **Live model filter** | Search/filter on Models page with punctuation normalisation (`kimi k2.6` → `kimi-k2.6`). | Model names are inconsistent across providers; normalised search actually finds what you're looking for. |
| **Enabled rows float to top** | In the fallback chain, disabled models sink to the bottom. | Long chains are hard to scan when disabled entries clutter the top; float makes the active set visible at a glance. |
| **Toast notifications** | e.g. when auto-discovery adds new models. | Silent model additions are confusing — "where did that come from?" Toasts make changes visible. |

### 🏗️ Infrastructure

| Feature | What | Why it matters |
|---------|------|---------------|
| **`api` CLI** | `api start`, `api stop`, `api status`, multi-instance tracking, log rotation. | Upstream has no CLI. Running the server means remembering `node server/dist/index.js` flags. |
| **Server log rotation** | Prevents disk fill from unbounded logs. | Long-running instances silently eat disk until something breaks. |
| **DeepSource coverage** | Integrated test-coverage reporting pipeline. | Continuous coverage visibility catches regressions before merge. |

## 🚧 In Development

| Spec | Status |
|------|--------|
| `docs/specs/dynamic-degradation/` | Implemented, dashboard controls pending polish |
| `docs/specs/benchmark-unification/` | Composite scorer live, incremental recomputation in progress |
| `docs/specs/reasoning-speed-fairness.md` | Reasoning tokens counted in `tokPerSec`; per-model toggle pending |
| `docs/specs/freellmproxy-integration/` | `npm run proxy:up` zero-config deploy replacing `proxy:deploy` |
| `docs/specs/provider-outage-fast-fail/` | Spec complete — reactive within-request provider-level skip on repeated 5xx |
| `docs/specs/provider-health-heartbeat/` | Spec complete — proactive cross-request periodic health pings feeding degradation engine |
| `docs/specs/global-settings-panel/` | Spec complete — dashboard Settings tab to toggle experimental features with DB persistence |

## 💯 Quick Start

**Prerequisites:** Node.js 20+, npm. (Docker also works — see [Docker](#docker).)

```bash
git clone https://github.com/animaios/animarouter.git
cd animarouter
npm install
cp .env.example .env

# Generate an encryption key for at-rest key storage
ENCRYPTION_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
printf "ENCRYPTION_KEY=%s\nPORT=3001\n" "$ENCRYPTION_KEY" > .env

npm run dev
```

Open http://localhost:5173 (the Vite dev UI), add your provider keys on the **Keys** page, reorder the **Fallback Chain** to taste, and grab your unified API key from the **Keys** page header. That unified key is what you point your OpenAI SDK at.

> **Reaching the dev UI from another device on your LAN?** Use `npm run dev:lan` — it passes `--host` through to Vite. (Plain `npm run dev -- --host` does *not* work: the root `dev` script is a `concurrently` wrapper, so the flag never reaches Vite.)

For a production build without Docker:

```bash
npm run build
node server/dist/index.js     # server + dashboard both served on :3001
```

`ENCRYPTION_KEY` is required for startup. The server only falls back to a database-stored development key when `DEV_MODE=true` and `NODE_ENV` is not `production`; do not use that fallback with real provider keys.

Request analytics are retained for 90 days or 100000 request rows by default, whichever limit prunes first. Set `REQUEST_ANALYTICS_RETENTION_DAYS=0` or `REQUEST_ANALYTICS_MAX_ROWS=0` in `.env` to disable either retention limit.

## 🌩️ Cloud Proxy (under construction)

AnimaRouter ships a Cloudflare Workers proxy layer for IP rotation and header stripping. Deploy it to route requests through geographically-distributed exit IPs so upstream providers see consistent, non-identifying IP addresses instead of your real one.

**Prerequisites:** [wrangler](https://developers.cloudflare.com/workers/wrangler/) installed and logged in (`npm i -g wrangler && wrangler login`).

```bash
npm run proxy:up
```

That's it. The first run automatically:

1. Checks wrangler auth
2. Initializes the `freellmproxy` git submodule
3. Installs proxy dependencies
4. Generates secure secrets (`freellmproxy/.env`)
5. Deploys proxy workers + router to Cloudflare
6. Detects and prints your working endpoint URL

After deployment, register the proxy as a custom provider in the dashboard:

1. Base64url-encode your target URL: `node -e "console.log(Buffer.from('https://api.example.com/v1').toString('base64url'))"`
2. Construct: `https://{ROUTER_URL}/{AUTH_KEY}/{PROXY_NUM}/{BASE64_URL}`
3. Add as a custom provider with that URL as the base URL

**Custom domain (optional):** Add `ROUTER_DOMAIN=your.domain.com` to `freellmproxy/.env` before deploying. This replaces the `workers.dev` subdomain with your own domain. The domain must be a Cloudflare-proxied zone.

| Command | Purpose |
|---------|----------|
| `npm run proxy:up` | Deploy everything to Cloudflare |
| `npm run proxy:dev` | Local dev server via wrangler |
| `npm run proxy:status` | Show deployment status |
| `npm run proxy:test` | Run proxy test suite |

Adjust `PROXY_COUNT` in `freellmproxy/.env`. See [the proxy's README](freellmproxy/README.md) for the full architecture.

## 🏭 Using the API

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

If no vision-capable model is enabled in your Fallback Chain, an image request returns `422` (`code: "no_vision_model"`) rather than silently dropping the image.

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

## Context Handoff

When AnimaRouter falls over to a different model mid-conversation (quota, rate limit, cooldown), the new model has no idea it is picking up someone else's task. **Context handoff** adds a single compact `system` message to the outbound request that tells the new model exactly that:

```
AnimaRouter context handoff:
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
ANIMAROUTER_CONTEXT_HANDOFF=on_model_switch
```

**How it works:**

- Messages per session are stored in memory (TTL: 3 hours).
- Only injected when the selected model changes for a given session key.
- Not injected on the first request, on same-model continuations, or if a handoff message is already present.
- Session key: `X-Session-Id` header if present, otherwise SHA-1 of the first user message (same as sticky sessions).
- Storage is in-memory only. Nothing is written to disk or logged.

> **Important:** Context Handoff improves continuity for conversations routed through AnimaRouter. It cannot recover provider-internal hidden state or messages that were never sent to the proxy.

## Supported Providers

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

<p align="center"><strong>Don't see yours? Add it.</strong> Any OpenAI-compatible endpoint — cloud service, local server, homelab GPU — becomes a provider in under a minute. It gets the same fallback chain, the same intelligent routing, the same rate-limit protection as every built-in. <a href="#what-animarouter-adds">See Custom Providers →</a></p>

## Custom Platforms and Models

The built-in provider list is a starting point, not a boundary. From the Keys page, the **Platforms** grid is the unified catalog — every built-in platform you've added a key for, alongside every custom platform you've registered. The grid ends with an **Add New Platform** tile that opens a modal for:

- **Slug** — a short identifier like `my-ollama` (lowercase letters, digits, dashes; 2-32 chars; cannot collide with a built-in).
- **Display name** — shown in the dashboard.
- **Base URL** — the OpenAI-compatible endpoint, e.g. `http://192.168.1.10:11434/v1`.
- **Rate limits** (optional) — RPM, RPD, TPM, TPD caps enforced per-provider.
- **Max parallel requests** (optional) — concurrency ceiling so this provider never hogs all connection slots.

Once a platform exists, its models are automatically discovered from the endpoint's `/v1/models` during creation by default. However, discovered models are **disabled by default** and must be manually enabled. You can also re-run discovery at any time via `POST /api/custom-providers/:slug/sync-models`, and there's an option to auto-enable discovered models during creation.

- **Model ID** and **Display name** — required.
- **Context window**, **Supports tools**, **Supports vision** — basic flags.
- **Advanced** toggle exposes intelligence rank, speed rank, size label, per-model rate limits, and max output tokens.

The model joins the fallback chain at the lowest priority and shows up everywhere built-in models do — `/v1/models`, the Fallback page, the Analytics page. You can edit any model (built-in or custom) later: adjust ranks, toggle tools/vision, cap output tokens, change rate limits — all from the dashboard.

Adding an API key for a custom platform works the same as for a built-in: pick the custom slug in the **Add a provider key** form, paste the bearer (or leave blank for local servers that don't need one), and the key routes to your endpoint.

Removing a custom platform archives it — models, keys, and fallback entries are preserved and restorable. Hard-delete is available but off by default.

## ❕ Limitations

Stacking free tiers — even with custom providers in the mix — has real trade-offs:

- **No frontier models out of the box.** The free-tier catalog tops out around Llama 3.3 70B, GLM-4.5, Qwen 3 Coder, and Gemini 2.5 Pro. For hard problems, pay for a real API — or bring your own paid provider as a custom platform.
- **Intelligence degrades as the day progresses.** Your top-ranked models have the lowest daily caps. Once they hit their limits, the router falls down your priority chain to smaller/weaker models. Expect the effective intelligence to drop in the late hours — then reset at UTC midnight.
- **Latency is highly variable.** Cerebras and Groq are extremely fast; others are not. You get whichever one is available at the moment.
- **Free tiers can change without notice.** Providers regularly tighten, loosen, or remove free tiers. When that happens you'll see 429s or auth errors until the catalog catches up.
- **No SLA, by definition.** If you need reliability, use a paid provider with a contract — either directly or plugged into AnimaRouter as a custom platform.
- **Local-first.** No multi-tenant auth. Run this for yourself; don't expose it to the internet.

## 🩹 Contributing

Contributors welcome! Good first PRs:

- **Add a provider** — copy `server/src/providers/openai-compat.ts` as a template, wire it into `server/src/providers/index.ts`, seed its models in `server/src/db/migrations.ts`, add a test in `server/src/__tests__/providers/`.
- **Add an endpoint** — images, moderations, audio. The provider base class can grow new methods; adapters declare which they support.

**Development loop:**

```bash
npm install
npm run dev      # server on :3001, dashboard on :5173, both with HMR
npm test         # server vitest + client typecheck
npm run build    # compile server and dashboard
```

Or use the `api` CLI: `api start`, `api stop`, `api status`.

PRs should include a test, keep the existing test suite green, and match the `.editorconfig` / tsconfig defaults. Issues and discussions are open.

### 🥇 Contributors

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

## ⚖️ Terms of Service Review

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

Rules of thumb: **one account per provider**, **no reselling**, **no sharing your endpoint with other humans**, **don't hammer a free tier as a paid production backend**. This is informational, not legal advice — read each provider's ToS and make your own call.

## 🧑‍⚖️ Disclaimer

**This project is for personal experimentation and learning, not production.** Free tiers exist so developers can prototype against them; they aren't a stable, supported inference substrate and shouldn't be treated as one. If you build something real on top of AnimaRouter, swap in a paid API before you ship. Your relationship with each upstream provider is governed by the terms you accepted when you created your account — those terms still apply when the traffic is proxied through this project, and you're responsible for complying with them.

***

Built on [MLuqmanBR/api-gateway](https://github.com/MLuqmanBR/api-gateway) (itself a fork of [tashfeenahmed/freellmapi](https://github.com/tashfeenahmed/freellmapi)). Maintained by [animaios](https://github.com/animaios).

## License

[MIT](./LICENSE) — © upstream contributors + AnimAIOS project.
