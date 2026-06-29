// ─── Racing mode handler ─────────────────────────────────────────────────────
// When the routing strategy is 'racing', we fire requests to all available
// models in parallel (1 key per model). The first model to respond wins and
// its response is streamed to the client; all others are cancelled.

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatMessage,
  ThinkingConfig,
  ThinkingEffort,
} from "@animarouter/shared/types.js";
import type { Request, Response } from "express";
import { getDb } from "../db/index.js";
import type { BaseProvider, CompletionOptions } from "../providers/base.js";
import { recordFailure, recordSuccess } from "../services/degradation.js";
import { publish } from "../services/events.js";
import { getFeatureSetting } from "../services/feature-settings.js";
import { recordActivity } from "../services/heartbeat.js";
import {
  getRelayTransport,
  isRelayTransportConfigured,
} from "../services/proxy-transport.js";
import { recordRequest, recordTokens } from "../services/ratelimit.js";
import { type RouteResult, routeRacingRequest } from "../services/router.js";

interface RacingModeParams {
  req: Request;
  res: Response;
  requestId: string;
  messages: ChatMessage[];
  estimatedTotal: number;
  estimatedInputTokens: number;
  hasImage: boolean;
  wantsTools: boolean;
  stream: boolean | undefined;
  temperature: number | undefined;
  max_tokens: number | undefined;
  top_p: number | undefined;
  // Using permissive types since zod validation makes everything optional
  // We coerce to proper types in buildCompletionOptions
  tools: unknown[] | undefined;
  tool_choice: unknown;
  parallel_tool_calls: boolean | undefined;
  reasoning_effort: ThinkingEffort | undefined;
  thinking: ThinkingConfig | undefined;
  sessionKey: string;
  start: number;
  pinnedModelId: string | undefined;
}

export async function handleRacingMode(
  params: RacingModeParams,
): Promise<void> {
  const {
    req,
    res,
    requestId,
    messages,
    estimatedTotal,
    hasImage,
    wantsTools,
    stream,
    start,
  } = params;

  // ── Get all racing candidates (one key per model) ──
  let candidates: RouteResult[];
  try {
    candidates = routeRacingRequest(estimatedTotal, hasImage, wantsTools);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "All models exhausted";
    res.setHeader("X-Routed-Via", "racing/none");
    res.status(429).json({ error: { message: msg, type: "rate_limit_error" } });
    return;
  }

  if (candidates.length === 0) {
    res.setHeader("X-Routed-Via", "racing/none");
    res.status(429).json({
      error: {
        message:
          "No models available for racing. Add more API keys or check provider status.",
        type: "rate_limit_error",
      },
    });
    return;
  }

  publish({
    type: "racing.start",
    id: requestId,
    candidates: candidates.map((c) => `${c.platform}/${c.modelId}`),
    stream: !!stream,
    at: Date.now(),
  });

  if (stream) {
    await handleRacingStream(params, candidates);
  } else {
    await handleRacingNonStream(params, candidates);
  }
}

/**
 * Resolve whether proxy transport should be used for a given route,
 * and return the transport object if so. Mirrors proxy.ts logic but
 * self-contained so racing mode doesn't depend on outer-loop variables.
 */
function resolveProxyTransport(route: RouteResult): {
  useProxy: boolean;
  transport: ReturnType<typeof getRelayTransport>;
} {
  const proxyTransportEnabled = getFeatureSetting(
    "proxy_transport_enabled",
  ) as boolean;
  const transport = getRelayTransport(route.transportId);
  const useProxy =
    !!transport &&
    proxyTransportEnabled &&
    isRelayTransportConfigured(route.transportId);
  return { useProxy, transport };
}

/** Resolve the upstream base URL for proxy transport. */
function getBaseUrl(provider: BaseProvider): string {
  const url = provider.baseUrl;
  if (url) return url;
  throw new Error(
    `Proxy transport requires a provider with a baseUrl; ${provider.name} does not expose one.`,
  );
}

/** Build CompletionOptions from the racing params. */
function buildCompletionOptions(params: RacingModeParams): CompletionOptions {
  return {
    temperature: params.temperature,
    max_tokens: params.max_tokens,
    top_p: params.top_p,
    tools: coerceTools(params.tools),
    tool_choice: coerceToolChoice(params.tool_choice),
    parallel_tool_calls: params.parallel_tool_calls,
    reasoning_effort: params.reasoning_effort,
    thinking: params.thinking,
  };
}

/** Coerce tools array to ChatToolDefinition[]. */
function coerceTools(tools: unknown[] | undefined): CompletionOptions["tools"] {
  if (tools == null) return undefined;
  return tools.map((t) => {
    const raw = t as Record<string, unknown> | undefined;
    const fn = raw?.function as Record<string, unknown> | undefined;
    return {
      type: "function" as const,
      function: {
        name: (fn?.name as string) ?? "",
        description: fn?.description as string | undefined,
        parameters: fn?.parameters as Record<string, unknown> | undefined,
        strict: fn?.strict as boolean | undefined,
      },
    };
  });
}

/** Coerce tool_choice to the expected format. */
function coerceToolChoice(v: unknown): CompletionOptions["tool_choice"] {
  if (v === "required" || v === "none" || v === "auto") return v;
  if (v == null) return undefined;
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const fn = obj.function as Record<string, unknown> | undefined;
    return {
      type: "function" as const,
      function: { name: (fn?.name as string) ?? "" },
    };
  }
  return undefined;
}

/**
 * Coerce a chunk from either a typed provider or a loose relay transport
 * into a ChatCompletionChunk-like shape for property access.
 */
function asChunk(raw: unknown): Partial<ChatCompletionChunk> {
  return raw as Partial<ChatCompletionChunk>;
}

/**
 * Wrap an AsyncGenerator to conform to a uniform AsyncIterable<unknown> interface.
 * Bridges the gap between the strongly-typed provider generator
 * (AsyncGenerator<ChatCompletionChunk>) and the loosely-typed relay transport
 * generator (AsyncGenerator<Record<string, unknown>>).
 */
function wrapAsyncGen<T>(gen: AsyncGenerator<T>): AsyncIterable<unknown> {
  return gen as unknown as AsyncIterable<unknown>;
}

/**
 * Racing mode for streaming requests.
 * Fire all candidates in parallel; the first to produce a valid SSE chunk wins.
 * Stream the winner's response to the client; abort the rest.
 */
async function handleRacingStream(
  params: RacingModeParams,
  candidates: RouteResult[],
): Promise<void> {
  const { req, res, requestId, start, estimatedInputTokens, pinnedModelId } =
    params;
  const totalCandidates = candidates.length;
  const streamOpts = buildCompletionOptions(params);

  // Latch for the first winner — use an object to avoid TS narrowing to 'never'.
  const state: {
    winner: RouteResult | null;
    winningGen: AsyncIterable<unknown> | null;
    firstChunk: unknown;
  } = {
    winner: null,
    winningGen: null,
    firstChunk: null,
  };

  await new Promise<void>((resolve) => {
    let settled = false;
    let failed = 0;

    for (const route of candidates) {
      (async () => {
        try {
          const { useProxy, transport } = resolveProxyTransport(route);

          const gen =
            useProxy && transport
              ? wrapAsyncGen(
                  transport.streamChatCompletion({
                    providerBaseUrl: getBaseUrl(route.provider),
                    apiKey: route.apiKey,
                    body: {
                      model: route.modelId,
                      messages: params.messages,
                      ...streamOpts,
                    },
                    sessionId: params.sessionKey || undefined,
                  }),
                )
              : wrapAsyncGen(
                  route.provider.streamChatCompletion(
                    route.apiKey,
                    params.messages,
                    route.modelId,
                    streamOpts,
                  ),
                );

          for await (const raw of gen) {
            if (settled) {
              route.release();
              return;
            }
            if (req.aborted) {
              route.release();
              return;
            }

            const chunk = asChunk(raw);
            const choice = chunk.choices?.[0];
            if (!choice) continue;

            const delta = choice.delta;
            if (!delta) continue;

            const hasContent =
              typeof delta.content === "string" && delta.content.length > 0;
            const hasToolCalls =
              Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0;
            const hasReasoning =
              typeof delta.reasoning_content === "string" &&
              delta.reasoning_content.length > 0;

            if (hasContent || hasToolCalls || hasReasoning) {
              settled = true;
              state.winner = route;
              state.winningGen = gen;
              state.firstChunk = raw;
              resolve();
              return;
            }
          }

          failed++;
          if (failed >= totalCandidates && !settled) {
            settled = true;
            resolve();
          }
          route.release();
        } catch (_err: unknown) {
          if (!settled) {
            failed++;
            if (failed >= totalCandidates && !settled) {
              settled = true;
              resolve();
            }
          }
        }
      })();
    }
  });

  const won = state.winner;
  const winningGen = state.winningGen;
  const firstRaw = state.firstChunk;

  if (!won || !winningGen || firstRaw == null) {
    for (const route of candidates) {
      logRacingFailure(route);
    }
    publish({ type: "racing.all_failed", id: requestId, at: Date.now() });
    res.status(502).json({
      error: {
        message: "All racing candidates failed to respond.",
        type: "server_error",
      },
    });
    return;
  }

  // Release loser slots
  for (const c of candidates) {
    if (c !== won) c.release();
  }

  // Winner found — stream its response
  publish({
    type: "racing.winner",
    id: requestId,
    model: `${won.platform}/${won.modelId}`,
    keyId: won.keyId,
    ttfbMs: Date.now() - start,
    at: Date.now(),
  });

  let headerSent = false;
  const lastMeta: { id?: string; model?: string; created?: number } = {};

  const flushHeaders = () => {
    if (headerSent) return;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Routed-Via", `racing/${won.platform}/${won.modelId}`);
    headerSent = true;
  };

  const mkChunk = (delta: Record<string, unknown>, finish: string | null) => ({
    id: lastMeta.id ?? `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk" as const,
    created: lastMeta.created ?? Math.floor(Date.now() / 1000),
    model: lastMeta.model ?? won.modelId,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });

  const writeChunk = (c: unknown) =>
    res.write(`data: ${JSON.stringify(c)}\n\n`);

  flushHeaders();
  const firstChunk = asChunk(firstRaw);
  const firstDelta = firstChunk.choices?.[0]?.delta ?? {};
  const firstFinish = firstChunk.choices?.[0]?.finish_reason ?? null;
  writeChunk(mkChunk(firstDelta as Record<string, unknown>, firstFinish));

  let totalOutputTokens = 0;
  let usageChunk: unknown = null;
  try {
    for await (const raw of winningGen) {
      if (req.aborted) break;

      const chunk = asChunk(raw);
      if (chunk.id) lastMeta.id = chunk.id;
      if (chunk.model) lastMeta.model = chunk.model;
      if (chunk.created) lastMeta.created = chunk.created;

      const choice = chunk.choices?.[0];
      if (!choice) {
        if (chunk.usage) {
          usageChunk = raw;
        }
        continue;
      }

      const delta = choice.delta;
      const finish = choice.finish_reason ?? null;

      if (finish) {
        writeChunk(mkChunk({}, finish));
        break;
      }

      if (typeof delta?.content === "string" && delta.content.length > 0) {
        totalOutputTokens += Math.ceil(delta.content.length / 4);
      }

      writeChunk(mkChunk(delta as Record<string, unknown>, null));
    }
  } catch (err: unknown) {
    console.error(
      "[Racing] Stream error from winner:",
      err instanceof Error ? err.message : err,
    );
  }

  if (usageChunk != null) writeChunk(usageChunk);
  res.write("data: [DONE]\n\n");
  res.end();

  const latencyMs = Date.now() - start;
  won.release();
  recordRequest(won.platform, won.modelId, won.keyId);
  recordTokens(
    won.platform,
    won.modelId,
    won.keyId,
    estimatedInputTokens + totalOutputTokens,
  );
  recordSuccess(won.modelDbId);
  recordActivity();
  publish({
    type: "request.done",
    id: requestId,
    model: won.modelId,
    provider: won.platform,
    keyId: won.keyId,
    latencyMs,
    tokens: { in: estimatedInputTokens, out: totalOutputTokens },
    at: Date.now(),
  });
  logRacingRequest(
    won.platform,
    won.modelId,
    won.keyId,
    "success",
    estimatedInputTokens,
    totalOutputTokens,
    latencyMs,
    null,
    latencyMs,
    pinnedModelId ?? null,
    0,
  );
}

/** Racing mode for non-streaming requests. */
async function handleRacingNonStream(
  params: RacingModeParams,
  candidates: RouteResult[],
): Promise<void> {
  const { res, requestId, start, estimatedInputTokens, pinnedModelId } = params;
  const totalCandidates = candidates.length;
  const chatOpts = buildCompletionOptions(params);

  const state: {
    winner: RouteResult | null;
    response: ChatCompletionResponse | null;
  } = {
    winner: null,
    response: null,
  };
  let failed = 0;

  await new Promise<void>((resolve) => {
    let settled = false;

    for (const route of candidates) {
      (async () => {
        try {
          const { useProxy, transport } = resolveProxyTransport(route);

          const resp: ChatCompletionResponse =
            useProxy && transport
              ? await transport.chatCompletion({
                  providerBaseUrl: getBaseUrl(route.provider),
                  apiKey: route.apiKey,
                  body: {
                    model: route.modelId,
                    messages: params.messages,
                    ...chatOpts,
                  },
                  sessionId: params.sessionKey || undefined,
                })
              : await route.provider.chatCompletion(
                  route.apiKey,
                  params.messages,
                  route.modelId,
                  chatOpts,
                );

          if (settled) {
            route.release();
            return;
          }
          if (!resp.choices || resp.choices.length === 0) {
            throw new Error("Empty response");
          }

          settled = true;
          state.winner = route;
          state.response = resp;
          resolve();
        } catch (_err: unknown) {
          if (!settled) {
            failed++;
            if (failed >= totalCandidates && !settled) {
              settled = true;
              resolve();
            }
          }
        }
      })();
    }
  });

  for (const c of candidates) c.release();

  const won = state.winner;
  const response = state.response;
  if (!won || !response) {
    for (const route of candidates) logRacingFailure(route);
    publish({ type: "racing.all_failed", id: requestId, at: Date.now() });
    res.status(502).json({
      error: {
        message: "All racing candidates failed to respond.",
        type: "server_error",
      },
    });
    return;
  }

  publish({
    type: "racing.winner",
    id: requestId,
    model: `${won.platform}/${won.modelId}`,
    keyId: won.keyId,
    ttfbMs: Date.now() - start,
    at: Date.now(),
  });

  response.model = won.modelId;
  res.setHeader("X-Routed-Via", `racing/${won.platform}/${won.modelId}`);
  res.json(response);

  const latencyMs = Date.now() - start;
  const completionTokens = response.usage?.completion_tokens ?? 0;
  const promptTokens = response.usage?.prompt_tokens ?? 0;

  recordRequest(won.platform, won.modelId, won.keyId);
  recordTokens(
    won.platform,
    won.modelId,
    won.keyId,
    response.usage?.total_tokens ?? promptTokens + completionTokens,
  );
  recordSuccess(won.modelDbId);
  recordActivity();
  publish({
    type: "request.done",
    id: requestId,
    model: won.modelId,
    provider: won.platform,
    keyId: won.keyId,
    latencyMs,
    tokens: { in: promptTokens, out: completionTokens },
    at: Date.now(),
  });
  logRacingRequest(
    won.platform,
    won.modelId,
    won.keyId,
    "success",
    promptTokens,
    completionTokens,
    latencyMs,
    null,
    latencyMs,
    pinnedModelId ?? null,
    0,
  );
}

/** Log a racing request to the requests table (same schema as proxy.ts logRequest). */
function logRacingRequest(
  platform: string,
  modelId: string,
  keyId: number,
  status: string,
  inputTokens: number,
  outputTokens: number,
  latencyMs: number,
  error: string | null,
  ttfbMs: number | null,
  requestedModel: string | null,
  reasoningTokens: number,
) {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, ttfb_ms, requested_model, reasoning_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      platform,
      modelId,
      keyId,
      status,
      inputTokens,
      outputTokens,
      latencyMs,
      error,
      ttfbMs,
      requestedModel,
      reasoningTokens,
    );
  } catch (e) {
    console.error("Failed to log racing request:", e);
  }
}

function logRacingFailure(route: RouteResult) {
  recordFailure(route.modelDbId, "minor");
}
