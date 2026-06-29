import type { ChatCompletionChunk } from "@animarouter/shared/types.js";
import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BaseProvider, CompletionOptions } from "../../providers/base.js";
import type { RouteResult } from "../../services/router.js";

const mocks = vi.hoisted(() => ({
  routeRacingRequest: vi.fn(),
  publish: vi.fn(),
  getFeatureSetting: vi.fn(),
  recordFailure: vi.fn(),
  recordSuccess: vi.fn(),
  recordRequest: vi.fn(),
  recordTokens: vi.fn(),
  recordActivity: vi.fn(),
  getDb: vi.fn(),
}));

vi.mock("../../services/router.js", () => ({
  routeRacingRequest: mocks.routeRacingRequest,
}));

vi.mock("../../services/events.js", () => ({
  publish: mocks.publish,
}));

vi.mock("../../services/feature-settings.js", () => ({
  getFeatureSetting: mocks.getFeatureSetting,
}));

vi.mock("../../services/degradation.js", () => ({
  recordFailure: mocks.recordFailure,
  recordSuccess: mocks.recordSuccess,
}));

vi.mock("../../services/ratelimit.js", () => ({
  recordRequest: mocks.recordRequest,
  recordTokens: mocks.recordTokens,
}));

vi.mock("../../services/heartbeat.js", () => ({
  recordActivity: mocks.recordActivity,
}));

vi.mock("../../db/index.js", () => ({
  getDb: mocks.getDb,
}));

const { handleRacingMode } = await import("../../services/racing-mode.js");

function chunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): ChatCompletionChunk {
  return {
    id: "chunk-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function makeProvider(
  streamChatCompletion: BaseProvider["streamChatCompletion"],
): BaseProvider {
  return {
    platform: "groq",
    name: "Test Provider",
    chatCompletion: vi.fn(),
    streamChatCompletion: vi.fn(streamChatCompletion),
    validateKey: vi.fn(),
  } as unknown as BaseProvider;
}

function makeRoute(
  provider: BaseProvider,
  overrides: Partial<RouteResult> = {},
): RouteResult {
  return {
    provider,
    modelId: "model",
    modelDbId: 123,
    apiKey: "key",
    keyId: 456,
    platform: "groq",
    displayName: "Model",
    rpdLimit: null,
    tpdLimit: null,
    maxOutputTokens: null,
    release: vi.fn(),
    useProxy: false,
    transportId: "direct",
    ...overrides,
  };
}

function makeResponse() {
  const chunks: string[] = [];
  const res = {
    chunks,
    setHeader: vi.fn(),
    status: vi.fn(function status(_code: number) {
      return this;
    }),
    json: vi.fn(function json(_body: unknown) {
      return this;
    }),
    write: vi.fn((body: string) => {
      chunks.push(body);
      return true;
    }),
    end: vi.fn(),
  };
  return res as unknown as Response & typeof res;
}

describe("racing mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getFeatureSetting.mockReturnValue(false);
    mocks.getDb.mockReturnValue({
      prepare: vi.fn(() => ({ run: vi.fn() })),
    });
  });

  it("passes abort signals to streaming candidates, aborts losers, and releases each route once", async () => {
    let winnerSignal: AbortSignal | undefined;
    let loserSignal: AbortSignal | undefined;

    const winnerProvider = makeProvider(async function* (
      _apiKey: string,
      _messages,
      _modelId: string,
      options?: CompletionOptions,
    ) {
      winnerSignal = options?.signal;
      yield chunk({ content: "winner" });
      yield chunk({}, "stop");
    });

    const loserProvider = makeProvider(async function* (
      _apiKey: string,
      _messages,
      _modelId: string,
      options?: CompletionOptions,
    ) {
      loserSignal = options?.signal;
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) {
          resolve();
          return;
        }
        options?.signal?.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
    });

    const winner = makeRoute(winnerProvider);
    const loser = makeRoute(loserProvider, { modelDbId: 124, keyId: 457 });
    mocks.routeRacingRequest.mockReturnValue([winner, loser]);

    const req = { aborted: false } as Request;
    const res = makeResponse();

    await handleRacingMode({
      req,
      res,
      requestId: "racing-test",
      messages: [{ role: "user", content: "race" }],
      estimatedTotal: 10,
      estimatedInputTokens: 3,
      hasImage: false,
      wantsTools: false,
      stream: true,
      temperature: undefined,
      max_tokens: undefined,
      top_p: undefined,
      tools: undefined,
      tool_choice: undefined,
      parallel_tool_calls: undefined,
      reasoning_effort: undefined,
      thinking: undefined,
      sessionKey: "session",
      start: Date.now(),
      pinnedModelId: undefined,
    });

    expect(winnerSignal).toBeDefined();
    expect(loserSignal).toBeDefined();
    expect(loserSignal?.aborted).toBe(true);
    expect(winner.release).toHaveBeenCalledTimes(1);
    expect(loser.release).toHaveBeenCalledTimes(1);
    expect(res.chunks.join("")).toContain("winner");
    expect(res.chunks.join("")).toContain("data: [DONE]");
  });
});
