# Spec: Include Reasoning Tokens in Speed Score + Reset Historical Data

## Problem

`tokPerSec` (used for speed scoring in routing and fallback ordering) = `(wOut * 1000) / wLat`, where `wOut` sums `output_tokens` from the `requests` table. **Reasoning tokens are not included in `output_tokens`**, but the latency includes the time the model spent thinking. This makes reasoning models (o3, Claude extended-thinking, DeepSeek R1, etc.) look unfairly slow.

Additionally: existing historical data was recorded without reasoning tokens — mixing old (undercounted) and new (correct) data would produce inconsistent speed scores. A reset is needed.

---

## File-by-File Changes

### 1. `shared/types.ts` — Extend `TokenUsage`

**Symbol:** `shared/types.ts::TokenUsage#type` (line 288)

Add optional `reasoning_tokens`:

```typescript
interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  reasoning_tokens?: number;  // thinking/reasoning tokens produced by the model
}
```

---

### 2. `server/src/db/migrations.ts` — Schema: new column + data reset

#### 2a. Add column to `CREATE TABLE IF NOT EXISTS requests`

In `createTables` function, the `requests` table definition (~line 161), add after `output_tokens`:

```sql
reasoning_tokens INTEGER NOT NULL DEFAULT 0,
```

#### 2b. Idempotent ALTER for existing DBs

Add a new schema migration function (next to `migrateSchemaV31ApiFormat`):

```typescript
function migrateSchemaV34ReasoningTokens(db: Database.Database) {
  const columns = db.prepare('PRAGMA table_info(requests)').all() as { name: string }[];
  if (!columns.some(col => col.name === 'reasoning_tokens')) {
    db.prepare('ALTER TABLE requests ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0').run();
    console.log('✅ Added reasoning_tokens column to requests');
  }
}
```

Call it in `migrateDbSchema`, alongside the other `migrateSchemaV3x` calls (~line 21).

#### 2c. Data reset: bump `CURRENT_DATA_VERSION` from 2 → 3

Add inside the version-guarded block (before `db.pragma('user_version = ...')`):

```typescript
if (version < 3) {
  // Reset request analytics so speed scores are calculated from a clean
  // baseline that includes reasoning tokens. Old data has reasoning_tokens=0
  // which would undercount reasoning model speed until enough new data
  // overwhelms it — better to start fair.
  db.prepare('DELETE FROM requests').run();
  db.prepare('DELETE FROM model_stats_cache').run();
  console.log('✅ Reset request analytics for reasoning-token fairness (V3)');
}
```

Then bump the constant at top of file:
```typescript
const CURRENT_DATA_VERSION = 3;
```

---

### 3. `server/src/providers/anthropic.ts` — Propagate reasoning tokens in translateUsage

**Symbol:** `server/src/providers/anthropic.ts::AnthropicCompatProvider.translateUsage#method` (line 366)

Anthropic's `output_tokens` already **includes** thinking tokens in its count, but the API doesn't break them out. So Anthropic's `completion_tokens` is actually `visible_output + thinking_output` combined — which is already fair for speed counting! But for correctness of the `reasoning_tokens` column in our DB, we should note this.

**Change:** Add `reasoning_tokens: 0` to the returned object. The actual counting will happen at the proxy level where we can see the thinking blocks.

```typescript
private translateUsage(usage?: AnthropicResponse['usage']): TokenUsage {
    const input = usage?.input_tokens ?? 0;
    const output = usage?.output_tokens ?? 0;
    return {
      prompt_tokens: input,
      completion_tokens: output,  // Anthropic: this already includes thinking
      total_tokens: input + output,
      reasoning_tokens: 0,  // not broken out by Anthropic; counted at proxy level
    };
  }
```

**IMPORTANT NOTE for implementor:** Because Anthropic's `completion_tokens` already includes thinking, the non-streaming Anthropic path is actually **fair already** for speed — `output_tokens` in the DB will include thinking. The **streaming Anthropic path** is the one that needs fixing, because there we count via `text.length / 4` and the thinking text is emitted as `reasoning_content` deltas, not `content` deltas.

---

### 4. `server/src/routes/proxy.ts` — The main file, 5 changes

#### 4a. Streaming path: add `totalReasoningTokens` counter

Where `let totalOutputTokens = 0;` is declared (~line 885), add:

```typescript
let totalReasoningTokens = 0;
```

#### 4b. Streaming path: count reasoning_content deltas

Reasoning content arrives on chunks where `choice.delta.reasoning_content` is set (from Anthropic's `thinking` → `reasoning_content` mapping, and from DeepSeek/Z.ai natively). Insert this **before** the `const text = ...` line (~line 971):

```typescript
// Count reasoning tokens from thinking/reasoning deltas for fair speed scoring.
const reasoningText = typeof choice.delta?.reasoning_content === 'string' ? choice.delta.reasoning_content : '';
if (reasoningText.length > 0) {
  totalReasoningTokens += Math.ceil(reasoningText.length / 4);
}
```

#### 4c. Streaming success path: pass reasoning tokens to logRequest

At the streaming success `logRequest` call (~line 1073), add the new parameter:

```typescript
logRequest(route.platform, route.modelId, route.keyId, 'success',
  estimatedInputTokens + injectedHandoffTokens, totalOutputTokens, Date.now() - start,
  null, ttfbMs, pinnedModelId, totalReasoningTokens);
```

Also update the `publish` event (~line 1074) to include reasoning tokens if desired (optional, for WS events).

#### 4d. Non-streaming path: extract reasoning_tokens from provider usage

Before the non-stream `logRequest` call (~line 1161), add:

```typescript
// OpenAI-compatible providers report reasoning tokens in completion_tokens_details.
// Anthropic's completion_tokens already include thinking (see §3 above).
const reasoningTokens = (result.usage as any)?.completion_tokens_details?.reasoning_tokens ?? 0;
```

Update the logRequest call:

```typescript
logRequest(
  route.platform, route.modelId, route.keyId, 'success',
  result.usage?.prompt_tokens ?? 0,
  result.usage?.completion_tokens ?? 0,
  Date.now() - start, null, null, pinnedModelId, reasoningTokens,
);
```

#### 4e. Update `logRequest` function signature + INSERT

**Symbol:** `server/src/routes/proxy.ts::logRequest#function` (line 1285)

Add `reasoningTokens` parameter with default 0:

```typescript
export function logRequest(
  platform: string,
  modelId: string,
  keyId: number,
  status: string,
  inputTokens: number,
  outputTokens: number,
  latencyMs: number,
  error: string | null,
  ttfbMs: number | null = null,
  requestedModel: string | null = null,
  reasoningTokens: number = 0,   // ← NEW, default 0 for backward compat
) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, ttfb_ms, requested_model, reasoning_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(platform, modelId, keyId, status, inputTokens, outputTokens, latencyMs, error, ttfbMs, requestedModel, reasoningTokens);
  } catch (e) {
    console.error('Failed to log request:', e);
  }
}
```

**All other `logRequest` call sites** (error paths in proxy.ts and responses.ts) don't need changes — they use positional args up to `requestedModel` (or fewer), and `reasoningTokens` defaults to `0`, which is correct for errors (no output to count).

**Call site inventory (12 total):**

| File | Line | Type | Needs change? |
|------|------|------|---------------|
| `proxy.ts` | 944 | stream error | No (default 0) |
| `proxy.ts` | 1073 | stream success | **Yes** — pass `totalReasoningTokens` |
| `proxy.ts` | 1086 | stream mid-stream error | No (default 0) |
| `proxy.ts` | 1161 | non-stream success | **Yes** — pass `reasoningTokens` |
| `proxy.ts` | 1175 | non-stream error | No (default 0) |
| `responses.ts` | 513 | stream error | No (default 0) |
| `responses.ts` | 554 | stream error | No (default 0) |
| `responses.ts` | 593 | stream success | **Yes** — pass `totalReasoningTokens` |
| `responses.ts` | 626 | non-stream error | No (default 0) |
| `responses.ts` | 646 | non-stream success | **Yes** — pass `reasoningTokens` |
| `responses.ts` | 653 | catch error | No (default 0) |

---

### 5. `server/src/services/router.ts` — Include reasoning_tokens in tokPerSec

The stats query (~line 309) currently:

```sql
SUM(CASE WHEN status = 'success' THEN output_tokens ELSE 0 END) AS succ_out,
```

Change to:

```sql
SUM(CASE WHEN status = 'success' THEN output_tokens + reasoning_tokens ELSE 0 END) AS succ_out,
```

This is the single line that actually makes speed fair. The `tokPerSec` formula stays the same — it just now includes reasoning in the numerator.

**No other changes needed in router.ts.** The `model_stats_temp` table, the `tokPerSec` calculation, and the in-memory cache all work through `succ_out` which is now correct.

---

### 6. `server/src/routes/responses.ts` — Same treatment as proxy.ts

#### 6a. Streaming path (~line 383): add counter

Where `let totalOutputTokens = 0;` is declared, add:

```typescript
let totalReasoningTokens = 0;
```

Where text deltas are counted (~line 453), add reasoning delta counting (same pattern as proxy.ts):

```typescript
const reasoningText = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '';
if (reasoningText.length > 0) {
  totalReasoningTokens += Math.ceil(reasoningText.length / 4);
}
```

#### 6b. Streaming success (~line 593): pass to logRequest

```typescript
logRequest(route.platform, route.modelId, route.keyId, 'success',
  estimatedInputTokens, totalOutputTokens, Date.now() - start, null,
  null, null, totalReasoningTokens);
```

#### 6c. Non-streaming path (~line 622-646): extract reasoning tokens

```typescript
const reasoningTokens = (result.usage as any)?.completion_tokens_details?.reasoning_tokens ?? 0;
const completionTokens = result.usage?.completion_tokens ?? Math.ceil(text.length / 4);
```

Then at the logRequest call (~line 646):

```typescript
logRequest(route.platform, route.modelId, route.keyId, 'success',
  promptTokens, completionTokens, Date.now() - start, null,
  null, null, reasoningTokens);
```

---

## Provider-specific behavior notes

| Provider | Non-stream `completion_tokens` | Stream `reasoning_content` | Fairness after fix |
|----------|------|------|---|
| OpenAI/o-series | `completion_tokens` = visible only; `completion_tokens_details.reasoning_tokens` has the thinking count | Not streamed as `reasoning_content` (only as internal events) | ✅ Non-stream: we extract `reasoning_tokens`. Stream: no reasoning deltas → 0 (but latency is also lower without thinking) |
| Anthropic (thinking) | `output_tokens` **includes** thinking tokens already | Thinking emitted as `reasoning_content` on delta | ✅ Non-stream: already fair. Stream: we count `reasoning_content` |
| DeepSeek / Z.ai | `completion_tokens` = visible only | `reasoning_content` on delta | ✅ Non-stream: need details field. Stream: we count `reasoning_content` |
| Non-reasoning models | `completion_tokens` = all output | No reasoning deltas | ✅ `reasoning_tokens` = 0, formula unchanged |

---

## Data reset rationale

Old `requests` rows have `reasoning_tokens = 0` (the column didn't exist). If we keep them, reasoning models' `tokPerSec` would be dragged down by the old undercounted data until enough new requests overwhelm the decay-weighted average. A clean break is simpler and fairer. The data loss is acceptable because speed stats recalibrate within hours of normal traffic.

The `DELETE FROM requests` in the V3 migration clears all old rows. `DELETE FROM model_stats_cache` clears the derived table. Both repopulate automatically from live traffic.

---

## Testing checklist

- [ ] `npx tsc --noEmit` passes
- [ ] Existing `scoring.test.ts` still passes (speed formula inputs unchanged; only `output_tokens` column now has more data)
- [ ] Existing `router-bandit.test.ts` still passes (adds history with `output_tokens=100`; new column defaults to 0, so `succ_out = 100 + 0 = 100` — same as before)
- [ ] Manual: send a request to a reasoning model and verify `reasoning_tokens > 0` in the `requests` table
- [ ] Manual: verify `tokPerSec` for reasoning models increases after the fix
