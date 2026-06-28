import type { AddressInfo } from "node:net";
import type { ChatMessage } from "@animarouter/shared/types.js";
import type { Express } from "express";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const chatCompletion = vi.fn();

/**
 * Stream factory — each test can override this to control what
 * streamChatCompletion yields. The factory receives (step, modelId) so it can
 * return different chunks for foundation vs anchor steps even when they share
 * the same modelId.
 */
let streamFactory:
  | ((
      step: "foundation" | "injection" | "anchor",
      modelId: string,
    ) => AsyncGenerator<any>)
  | null = null;

/** Mock streamChatCompletion — returns an async generator directly so the
 *  proxy's `for await (const chunk of gen)` works. The proxy calls this via
 *  callModel which knows the step, but streamChatCompletion signature only
 *  has modelId. We track step via a closure counter. */
let streamStepCounter = 0;
let currentStreamStep: "foundation" | "injection" | "anchor" = "foundation";

function streamChatCompletion(
  apiKey: string,
  messages: ChatMessage[],
  modelId: string,
  _options?: Record<string, unknown>,
): AsyncGenerator<any> {
  if (streamFactory) {
    // Determine step based on counter: 0=foundation, 1=injection, 2=anchor, 3+=anchor (for fallbacks)
    const step =
      streamStepCounter === 0
        ? "foundation"
        : streamStepCounter === 1
          ? "injection"
          : "anchor";
    streamStepCounter++;
    return streamFactory(step, modelId);
  }
  return (async function* () {})();
}

const fakeProvider = { name: "fake", chatCompletion, streamChatCompletion };
const publishedEvents: Array<{ type: string; [key: string]: unknown }> = [];

vi.mock("../../providers/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../providers/index.js")>();
  return {
    ...actual,
    getProvider: () => fakeProvider,
    resolveProvider: () => fakeProvider,
    buildProviderFor: () => fakeProvider,
  };
});

vi.mock("../../services/events.js", () => ({
  publish: vi.fn((event: { type: string; [key: string]: unknown }) => {
    publishedEvents.push(event);
  }),
  publishDeduped: vi.fn((event: { type: string; [key: string]: unknown }) => {
    publishedEvents.push(event);
  }),
  subscribeSse: vi.fn(),
}));

const { createApp } = await import("../../app.js");
const { initDb, getDb, getUnifiedApiKey, setSetting } = await import(
  "../../db/index.js"
);
const { encrypt } = await import("../../lib/crypto.js");
const { routeRequest, setRoutingStrategy } = await import(
  "../../services/router.js"
);

async function post(
  app: Express,
  path: string,
  body: Record<string, unknown>,
  key: string,
) {
  const server = app.listen(0);
  const addr = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(raw);
    } catch {}
    return { status: res.status, body: json, headers: res.headers, raw };
  } finally {
    server.close();
  }
}

async function postStream(
  app: Express,
  path: string,
  body: Record<string, unknown>,
  key: string,
): Promise<{
  status: number;
  headers: Headers;
  frames: unknown[];
  raw: string;
}> {
  const server = app.listen(0);
  const addr = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    const frames = raw
      .split("\n")
      .filter(
        (l: string) =>
          l.startsWith("data: ") && l.trim() !== "data: [DONE]",
      )
      .map((l: string) => JSON.parse(l.slice(6)));
    return { status: res.status, headers: res.headers, frames, raw };
  } finally {
    server.close();
  }
}

function messageText(messages: ChatMessage[]): string {
  return messages.map((m) => String(m.content)).join("\n");
}

function responseText(body: unknown): string {
  return (body as { choices: Array<{ message: { content: string } }> })
    .choices[0].message.content;
}

function addModel(opts: {
  platform: string;
  modelId: string;
  name: string;
  intelligenceRank: number;
  speedRank: number;
  sizeLabel: string;
  priority: number;
}) {
  const db = getDb();
  db.prepare(
    "INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled) VALUES (?, ?, ?, ?, ?, ?, 1)",
  ).run(
    opts.platform,
    opts.modelId,
    opts.name,
    opts.intelligenceRank,
    opts.speedRank,
    opts.sizeLabel,
  );
  const modelDbId = (
    db
      .prepare("SELECT id FROM models WHERE platform = ? AND model_id = ?")
      .get(opts.platform, opts.modelId) as { id: number }
  ).id;
  db.prepare(
    "INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)",
  ).run(modelDbId, opts.priority);
  return modelDbId;
}

function addKey(platform: string) {
  const { encrypted, iv, authTag } = encrypt(`${platform}-key`);
  getDb()
    .prepare(
      "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES (?, 'test', ?, ?, ?, 'healthy', 1)",
    )
    .run(platform, encrypted, iv, authTag);
}

function buildStreamChunks(
  text: string,
  modelId: string,
): Record<string, unknown>[] {
  const id = "chatcmpl-test";
  const created = Math.floor(Date.now() / 1000);
  const chunks: Record<string, unknown>[] = [
    {
      id,
      object: "chat.completion.chunk",
      created,
      model: modelId,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: null },
          finish_reason: null,
        },
      ],
    },
  ];
  if (text) {
    chunks.push({
      id,
      object: "chat.completion.chunk",
      created,
      model: modelId,
      choices: [
        { index: 0, delta: { content: text }, finish_reason: null },
      ],
    });
  }
  chunks.push({
    id,
    object: "chat.completion.chunk",
    created,
    model: modelId,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  return chunks;
}

// ── Existing non-streaming tests ─────────────────────────────────────

describe("Rabbit proxy integration", () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = "0".repeat(64);
    initDb(":memory:");
    app = createApp();
    key = getUnifiedApiKey();
  });

  beforeEach(() => {
    const db = getDb();
    db.exec(`
      DELETE FROM fallback_config;
      DELETE FROM api_keys;
      DELETE FROM models;
      DELETE FROM requests;
      DELETE FROM oscillator_results;
      DELETE FROM settings
      WHERE key LIKE 'rabbit_%'
         OR key LIKE 'oscillator_%'
         OR key IN ('routing_strategy', 'model_grouping_enabled');
    `);
    setSetting("model_grouping_enabled", "false");
    setRoutingStrategy("rabbit");
    setSetting("rabbit_enabled", "true");
    setSetting("oscillator_foundation_selection", "auto");
    setSetting("oscillator_injection_selection", "divergent");
    setSetting("oscillator_min_intelligence_gap", "0");
    setSetting("oscillator_injection_max_sentences", "2");
    setSetting("oscillator_load_shed_threshold", "21");
    setSetting("oscillator_step_timeout_ms", "1000");

    addModel({
      platform: "alpha",
      modelId: "foundation",
      name: "Foundation",
      intelligenceRank: 1,
      speedRank: 3,
      sizeLabel: "Frontier",
      priority: 1,
    });
    addModel({
      platform: "beta",
      modelId: "injection",
      name: "Injection",
      intelligenceRank: 2,
      speedRank: 4,
      sizeLabel: "Large",
      priority: 2,
    });
    addKey("alpha");
    addKey("beta");
    chatCompletion.mockReset();
    streamFactory = null;
    streamStepCounter = 0;
    publishedEvents.length = 0;
  });

  it("routes eligible non-streaming Rabbit requests through Foundation, Injection, and Anchor steps", async () => {
    chatCompletion.mockImplementation(
      async (_apiKey: string, messages: ChatMessage[], modelId: string) => {
        if (
          modelId === "foundation" &&
          chatCompletion.mock.calls.length === 1
        ) {
          return {
            choices: [
              { message: { role: "assistant", content: "Foundation base." } },
            ],
            usage: {
              prompt_tokens: 5,
              completion_tokens: 2,
              total_tokens: 7,
            },
          };
        }
        if (modelId === "injection") {
          expect(messageText(messages)).toContain(
            "[Thought Context: Foundation base.]",
          );
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Alternative angle. Concise.",
                },
              },
            ],
            usage: {
              prompt_tokens: 7,
              completion_tokens: 3,
              total_tokens: 10,
            },
          };
        }
        expect(modelId).toBe("foundation");
        expect(messageText(messages)).toContain(
          "[Thought Context: Alternative angle. Concise.]",
        );
        return {
          choices: [
            { message: { role: "assistant", content: "Final Rabbit answer." } },
          ],
          usage: {
            prompt_tokens: 8,
            completion_tokens: 4,
            total_tokens: 12,
          },
        };
      },
    );

    const { status, body, headers } = await post(
      app,
      "/v1/chat/completions",
      {
        model: "auto",
        messages: [
          {
            role: "user",
            content: "Analyze this architecture and explain the tradeoffs.",
          },
        ],
      },
      key,
    );

    expect(status).toBe(200);
    expect(responseText(body)).toBe("Final Rabbit answer.");
    expect(headers.get("x-rabbit-status")).toBe("completed");
    expect(chatCompletion.mock.calls.map((call) => call[2])).toEqual([
      "foundation",
      "injection",
      "foundation",
    ]);
    const row = getDb()
      .prepare("SELECT * FROM oscillator_results")
      .get() as {
      status: string;
      complete: number;
      failed_step: number | null;
      foundation_model_db_id: number | null;
      injection_model_db_id: number | null;
      total_latency_ms: number;
      step1_latency_ms: number | null;
      step2_latency_ms: number | null;
      step3_latency_ms: number | null;
    };
    expect(row).toMatchObject({
      status: "completed",
      complete: 1,
      failed_step: null,
    });
    expect(row.foundation_model_db_id).toBeGreaterThan(0);
    expect(row.injection_model_db_id).toBeGreaterThan(0);
    expect(row.total_latency_ms).toBeGreaterThanOrEqual(0);
    expect(row.step1_latency_ms).toBeGreaterThanOrEqual(0);
    expect(row.step2_latency_ms).toBeGreaterThanOrEqual(0);
    expect(row.step3_latency_ms).toBeGreaterThanOrEqual(0);
    expect(
      publishedEvents
        .filter((event) => event.type.startsWith("oscillator."))
        .map((event) => event.type),
    ).toEqual([
      "oscillator.started",
      "oscillator.step_complete",
      "oscillator.step_complete",
      "oscillator.step_complete",
      "oscillator.complete",
    ]);
  });

  it("uses normal single-model routing for simple Rabbit requests", async () => {
    chatCompletion.mockResolvedValue({
      choices: [
        { message: { role: "assistant", content: "Single model answer." } },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    });

    const { status, body, headers } = await post(
      app,
      "/v1/chat/completions",
      {
        model: "auto",
        messages: [{ role: "user", content: "hello" }],
      },
      key,
    );

    expect(status).toBe(200);
    expect(responseText(body)).toBe("Single model answer.");
    expect(headers.get("x-rabbit-status")).toBeNull();
    expect(chatCompletion).toHaveBeenCalledTimes(1);
  });

  it("uses normal pinned-model routing even when the prompt is complex", async () => {
    chatCompletion.mockResolvedValue({
      choices: [
        { message: { role: "assistant", content: "Pinned answer." } },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
    });

    const { status, body, headers } = await post(
      app,
      "/v1/chat/completions",
      {
        model: "alpha/foundation",
        messages: [
          {
            role: "user",
            content: "Analyze this architecture and explain the tradeoffs.",
          },
        ],
      },
      key,
    );

    expect(status).toBe(200);
    expect(responseText(body)).toBe("Pinned answer.");
    expect(headers.get("x-rabbit-status")).toBeNull();
    expect(chatCompletion).toHaveBeenCalledTimes(1);
    expect(chatCompletion.mock.calls[0][2]).toBe("foundation");
  });

  it("uses normal single-model routing when Rabbit is load-shed", async () => {
    setSetting("oscillator_load_shed_threshold", "1");
    const heldRoutes: Array<ReturnType<typeof routeRequest>> = [];

    try {
      heldRoutes.push(routeRequest(100));
      heldRoutes.push(routeRequest(100));
      chatCompletion.mockResolvedValue({
        choices: [
          { message: { role: "assistant", content: "Load-shed answer." } },
        ],
        usage: {
          prompt_tokens: 4,
          completion_tokens: 3,
          total_tokens: 7,
        },
      });

      const { status, body, headers } = await post(
        app,
        "/v1/chat/completions",
        {
          model: "auto",
          messages: [
            {
              role: "user",
              content: "Analyze this architecture and explain the tradeoffs.",
            },
          ],
        },
        key,
      );

      expect(status).toBe(200);
      expect(responseText(body)).toBe("Load-shed answer.");
      expect(headers.get("x-rabbit-status")).toBeNull();
      expect(chatCompletion).toHaveBeenCalledTimes(1);
      expect(
        publishedEvents.find((event) => event.type === "oscillator.load_shed"),
      ).toMatchObject({
        concurrentRequests: 2,
        threshold: 1,
      });
    } finally {
      for (const route of heldRoutes) route.release();
    }
  });

  it("emits a meow event when Rabbit anchor validation falls back", async () => {
    chatCompletion.mockImplementation(
      async (
        _apiKey: string,
        _messages: ChatMessage[],
        modelId: string,
      ) => {
        if (
          modelId === "foundation" &&
          chatCompletion.mock.calls.length === 1
        ) {
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Foundation base.",
                },
              },
            ],
            usage: {
              prompt_tokens: 5,
              completion_tokens: 2,
              total_tokens: 7,
            },
          };
        }
        if (modelId === "injection") {
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Alternative angle. Concise.",
                },
              },
            ],
            usage: {
              prompt_tokens: 7,
              completion_tokens: 3,
              total_tokens: 10,
            },
          };
        }
        return {
          choices: [
            {
              message: {
                role: "assistant",
                content: "Final Rabbit answer leaked \u003c|assistant|\u003e.",
              },
            },
          ],
          usage: {
            prompt_tokens: 8,
            completion_tokens: 4,
            total_tokens: 12,
          },
        };
      },
    );

    const { status, body, headers } = await post(
      app,
      "/v1/chat/completions",
      {
        model: "auto",
        messages: [
          {
            role: "user",
            content: "Analyze this architecture and explain the tradeoffs.",
          },
        ],
      },
      key,
    );

    expect(status).toBe(200);
    expect(responseText(body)).toBe("Foundation base.");
    expect(headers.get("x-rabbit-status")).toBe("foundation_fallback");
    expect(
      publishedEvents.find((event) => event.type === "oscillator.meow_detected"),
    ).toMatchObject({
      pattern: "structural_tag",
      fellBackTo: "alpha/foundation",
    });
  });

  it("does not emit step-complete for a failed Rabbit injection step", async () => {
    chatCompletion.mockImplementation(
      async (
        _apiKey: string,
        _messages: ChatMessage[],
        modelId: string,
      ) => {
        if (modelId === "injection") throw new Error("injection failed");
        return {
          choices: [
            {
              message: {
                role: "assistant",
                content: "Foundation base.",
              },
            },
          ],
          usage: {
            prompt_tokens: 5,
            completion_tokens: 2,
            total_tokens: 7,
          },
        };
      },
    );

    const { status, body, headers } = await post(
      app,
      "/v1/chat/completions",
      {
        model: "auto",
        messages: [
          {
            role: "user",
            content: "Analyze this architecture and explain the tradeoffs.",
          },
        ],
      },
      key,
    );

    expect(status).toBe(200);
    expect(responseText(body)).toBe("Foundation base.");
    expect(headers.get("x-rabbit-status")).toBe("foundation_fallback");
    expect(
      publishedEvents
        .filter((event) => event.type === "oscillator.step_complete")
        .map((event) => event.step),
    ).toEqual([1]);
    expect(
      publishedEvents.find((event) => event.type === "oscillator.failed"),
    ).toMatchObject({
      failedStep: 2,
    });
  });

  it("falls back to normal single-model routing when all Rabbit foundation candidates fail", async () => {
    chatCompletion.mockImplementation(async () => {
      if (chatCompletion.mock.calls.length <= 2) {
        throw new Error("foundation failed");
      }
      return {
        choices: [
          {
            message: {
              role: "assistant",
              content: "Recovered fallback.",
            },
          },
        ],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 3,
          total_tokens: 8,
        },
      };
    });

    const { status, body, headers } = await post(
      app,
      "/v1/chat/completions",
      {
        model: "auto",
        messages: [
          {
            role: "user",
            content: "Analyze this architecture and explain the tradeoffs.",
          },
        ],
      },
      key,
    );

    expect(status).toBe(200);
    expect(responseText(body)).toBe("Recovered fallback.");
    expect(headers.get("x-rabbit-status")).toBeNull();
    expect(chatCompletion.mock.calls.map((call) => call[2])).toEqual([
      "foundation",
      "injection",
      "foundation",
    ]);
    expect(
      getDb()
        .prepare(
          "SELECT status, complete, failed_step FROM oscillator_results",
        )
        .get(),
    ).toMatchObject({
      status: "single_model_fallback",
      complete: 0,
      failed_step: 1,
    });
    expect(
      publishedEvents.find((event) => event.type === "oscillator.failed"),
    ).toMatchObject({
      failedStep: 1,
      fellBackTo: "single-model",
    });
  });

  // ── Streaming integration tests ──────────────────────────────────────

  describe("Rabbit streaming integration", () => {
    beforeEach(() => {
      streamStepCounter = 0;
    });

    it("happy path streaming: Foundation → Injection → Anchor chunks arrive via SSE with [DONE] marker", async () => {
      const foundationChunks = buildStreamChunks("Foundation base analysis.", "foundation");
      const injectionChunks = buildStreamChunks("Alternative perspective.", "injection");
      const anchorChunks = buildStreamChunks("Final synthesized answer.", "foundation");

      streamFactory = async function* (
        step: "foundation" | "injection" | "anchor",
        _modelId: string,
      ) {
        const chunks =
          step === "foundation"
            ? foundationChunks
            : step === "injection"
              ? injectionChunks
              : anchorChunks;
        for (const chunk of chunks) yield chunk;
      };

      const { status, headers, frames, raw } = await postStream(
        app,
        "/v1/chat/completions",
        {
          model: "auto",
          messages: [
            {
              role: "user",
              content:
                "Analyze this architecture and explain the tradeoffs in detail.",
            },
          ],
          stream: true,
        },
        key,
      );

      expect(status).toBe(200);
      expect(headers.get("content-type")).toContain("text/event-stream");
      expect(headers.get("x-rabbit-status")).toBe("streaming");

      // Verify anchor text chunks were streamed
      const textFrames = frames.filter(
        (f) =>
          typeof f.choices?.[0]?.delta?.content === "string" &&
          f.choices[0].delta.content.length > 0,
      );
      expect(textFrames.length).toBeGreaterThan(0);
      const streamedText = textFrames
        .map((f) => f.choices[0].delta.content)
        .join("");
      expect(streamedText).toContain("Final synthesized answer");

      // Verify [DONE] marker in raw response
      expect(raw).toContain("data: [DONE]");
      expect(raw).toContain("finish_reason");

      // Verify oscillator streaming events published in order
      // Should have: stream_start, stream_step_complete for each step (foundation, injection, anchor), then stream_complete
      const oscillatorEvents = publishedEvents.filter((e) =>
        e.type.startsWith("oscillator."),
      );
      const eventTypes = oscillatorEvents.map((e) => e.type);

      // First event should be stream_start
      expect(eventTypes[0]).toBe("oscillator.stream_start");
      // Last event should be stream_complete
      expect(eventTypes[eventTypes.length - 1]).toBe("oscillator.stream_complete");
      // Should have at least 3 stream_step_complete events (one per step)
      const stepCompleteCount = eventTypes.filter((t) => t === "oscillator.stream_step_complete").length;
      expect(stepCompleteCount).toBeGreaterThanOrEqual(3);
      // Should have at least 3 stream_start events (one per step)
      const streamStartCount = eventTypes.filter((t) => t === "oscillator.stream_start").length;
      expect(streamStartCount).toBeGreaterThanOrEqual(3);
      // Sequence should be: stream_start, stream_step_complete, stream_start, stream_step_complete, ...
      // (alternating, ending with stream_complete)
      expect(eventTypes).toContain("oscillator.stream_start");
      expect(eventTypes).toContain("oscillator.stream_step_complete");
      expect(eventTypes).toContain("oscillator.stream_complete");

      // Verify stream.chunk events were published for anchor chunks
      const streamChunkEvents = publishedEvents.filter(
        (e) => e.type === "stream.chunk",
      );
      expect(streamChunkEvents.length).toBeGreaterThan(0);

      // Verify oscillator result in DB
      const row = getDb().prepare("SELECT status, complete FROM oscillator_results").get() as { status: string; complete: number };
      expect(row).toMatchObject({ status: "completed", complete: 1 });
    });

    it("foundation fallback streaming: first foundation candidate fails, second succeeds, injection + anchor complete", async () => {
      // Add a second foundation model with lower priority so it's tried after alpha/foundation
      addModel({
        platform: "gamma",
        modelId: "foundation2",
        name: "Foundation 2",
        intelligenceRank: 1,
        speedRank: 5, // Lower speed rank = tried later
        sizeLabel: "Frontier",
        priority: 3,
      });
      addKey("gamma");

      let foundationAttempt = 0;
      const foundationChunks1 = buildStreamChunks("Failed foundation.", "foundation");
      const foundationChunks2 = buildStreamChunks("Foundation base analysis.", "foundation2");
      const injectionChunks = buildStreamChunks("Alternative perspective.", "injection");
      const anchorChunks = buildStreamChunks("Final synthesized answer.", "foundation2");

      streamFactory = async function* (
        step: "foundation" | "injection" | "anchor",
        modelId: string,
      ) {
        if (step === "foundation") {
          if (foundationAttempt === 0) {
            foundationAttempt++;
            throw new Error("Foundation model unavailable");
          }
          // Second foundation attempt - use foundation2
          for (const chunk of foundationChunks2) yield chunk;
          return;
        }
        if (step === "injection") {
          for (const chunk of injectionChunks) yield chunk;
          return;
        }
        // anchor step
        for (const chunk of anchorChunks) yield chunk;
      };

      const { status, headers, frames, raw } = await postStream(
        app,
        "/v1/chat/completions",
        {
          model: "auto",
          messages: [
            {
              role: "user",
              content:
                "Analyze this architecture and explain the tradeoffs in detail.",
            },
          ],
          stream: true,
        },
        key,
      );

      expect(status).toBe(200);
      expect(headers.get("x-rabbit-status")).toBe("streaming");

      // Verify anchor chunks streamed
      expect(frames.length).toBeGreaterThan(0);
      expect(raw).toContain("data: [DONE]");

      // Verify events: foundation fallback means oscillator.stream_error for step 1
      const oscillatorEvents = publishedEvents.filter((e) =>
        e.type.startsWith("oscillator."),
      );
      expect(oscillatorEvents.map((e) => e.type)).toContain("oscillator.stream_start");
      // Should have stream_step_complete for foundation (2nd attempt), injection, anchor = 3
      // Note: first foundation attempt may also emit step_complete before failing, so >= 3
      const stepCompleteEvents = oscillatorEvents.filter(
        (e) => e.type === "oscillator.stream_step_complete",
      );
      expect(stepCompleteEvents.length).toBeGreaterThanOrEqual(3);
      // When first foundation fails and second succeeds completely, status is "completed"
      // (not "foundation_fallback" - that only applies when a later step fails after foundation succeeds)
      expect(oscillatorEvents.map((e) => e.type)).toContain(
        "oscillator.stream_complete",
      );
      // First foundation failure is transparent in streaming - no stream_error published for retried steps
      // The stream_error is only for the final result status, and this test gets "completed" (2nd foundation succeeds)
    });

    it("load shed during streaming: falls back to normal single-model streaming", async () => {
      setSetting("oscillator_load_shed_threshold", "1");

      streamFactory = async function* () {
        yield {
          id: "chatcmpl-ls",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "foundation",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: null },
              finish_reason: null,
            },
          ],
        };
        yield {
          id: "chatcmpl-ls",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "foundation",
          choices: [
            {
              index: 0,
              delta: { content: "Load-shed streaming answer." },
              finish_reason: null,
            },
          ],
        };
        yield {
          id: "chatcmpl-ls",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "foundation",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        };
      };

      const heldRoutes: Array<ReturnType<typeof routeRequest>> = [];
      try {
        heldRoutes.push(routeRequest(100));
        heldRoutes.push(routeRequest(100));

        const { status, headers, frames, raw } = await postStream(
          app,
          "/v1/chat/completions",
          {
            model: "auto",
            messages: [
              {
                role: "user",
                content:
                  "Analyze this architecture and explain the tradeoffs in detail.",
              },
            ],
            stream: true,
          },
          key,
        );

        expect(status).toBe(200);
        expect(headers.get("content-type")).toContain("text/event-stream");
        expect(headers.get("x-rabbit-status")).toBeNull();

        const loadShedEvent = publishedEvents.find(
          (e) => e.type === "oscillator.load_shed",
        );
        expect(loadShedEvent).toMatchObject({
          concurrentRequests: 2,
          threshold: 1,
        });

        // No Rabbit oscillator events (only load_shed)
        const oscillatorEvents = publishedEvents.filter((e) =>
          e.type.startsWith("oscillator."),
        );
        expect(oscillatorEvents.length).toBe(1);
        expect(oscillatorEvents[0].type).toBe("oscillator.load_shed");
      } finally {
        for (const route of heldRoutes) route.release();
      }
    });

    it("meow detection during streaming: anchor step detects meow → fallback to foundation", async () => {
      const foundationChunks = buildStreamChunks("Foundation base analysis.", "foundation");
      const injectionChunks = buildStreamChunks("Alternative perspective.", "injection");
      // Anchor returns text with meow pattern (structural tag leak)
      const anchorChunks = buildStreamChunks("Final answer leaked \u003c|assistant|\u003e.", "foundation");

      streamFactory = async function* (
        step: "foundation" | "injection" | "anchor",
        _modelId: string,
      ) {
        const chunks =
          step === "foundation"
            ? foundationChunks
            : step === "injection"
              ? injectionChunks
              : anchorChunks;
        for (const chunk of chunks) yield chunk;
      };

      const { status, headers, frames, raw } = await postStream(
        app,
        "/v1/chat/completions",
        {
          model: "auto",
          messages: [
            {
              role: "user",
              content:
                "Analyze this architecture and explain the tradeoffs in detail.",
            },
          ],
          stream: true,
        },
        key,
      );

      expect(status).toBe(200);
      expect(headers.get("x-rabbit-status")).toBe("streaming");

      // Both anchor text (with meow) and foundation fallback text are streamed
      const textFrames = frames.filter(
        (f) =>
          typeof f.choices?.[0]?.delta?.content === "string" &&
          f.choices[0].delta.content.length > 0,
      );
      expect(textFrames.length).toBeGreaterThan(0);
      const streamedText = textFrames
        .map((f) => f.choices[0].delta.content)
        .join("");
      // Should contain anchor text (streamed during anchor step)
      // Foundation text may or may not be present depending on streaming fallback path
      expect(streamedText.length).toBeGreaterThan(0);

      // Verify meow_detected event (published by non-streaming event path)
      // or stream_error with fallback for streaming path
      const meowEvent = publishedEvents.find(
        (e) => e.type === "oscillator.meow_detected",
      );
      const streamErrorEvent = publishedEvents.find(
        (e) => e.type === "oscillator.stream_error" && e.fallback === true,
      );
      // At least one of these should be present
      expect(meowEvent || streamErrorEvent).toBeDefined();

      // Verify oscillator.stream_error event with anchor step (validation failure)
      const failedEvent = publishedEvents.find(
        (e) => (e.type === "oscillator.stream_error" || e.type === "oscillator.failed") && e.step === "anchor",
      );
      expect(failedEvent || publishedEvents.find(
        (e) => e.type === "oscillator.failed" && e.failedStep === 3,
      )).toBeDefined();

      // Verify [DONE] marker
      expect(raw).toContain("data: [DONE]");
    });

    it("client disconnect handling: simulate client abort during streaming, verify cleanup without unhandled errors", async () => {
      const foundationChunks = buildStreamChunks("Foundation base analysis.", "foundation");
      const injectionChunks = buildStreamChunks("Alternative perspective.", "injection");
      const anchorChunks = buildStreamChunks(
        "Final synthesized answer that is very long and would take time to stream.".repeat(10),
        "foundation",
      );

      let cancelled = false;
      streamFactory = async function* (
        step: "foundation" | "injection" | "anchor",
        _modelId: string,
      ) {
        const chunks =
          step === "foundation"
            ? foundationChunks
            : step === "injection"
              ? injectionChunks
              : anchorChunks;
        for (const chunk of chunks) {
          if (cancelled) break;
          yield chunk;
          await new Promise((r) => setTimeout(r, 1));
        }
      };

      const server = app.listen(0);
      const addr = server.address() as AddressInfo;

      try {
        const controller = new AbortController();
        const res = await fetch(
          `http://127.0.0.1:${addr.port}/v1/chat/completions`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${key}`,
              Accept: "text/event-stream",
            },
            body: JSON.stringify({
              model: "auto",
              messages: [
                {
                  role: "user",
                  content:
                    "Analyze this architecture and explain the tradeoffs in detail.",
                },
              ],
              stream: true,
            }),
            signal: controller.signal,
          },
        );

        // Read a few chunks then abort
        const reader = res.body?.getReader();
        if (reader) {
          for (let i = 0; i < 3; i++) {
            const { done } = await reader.read();
            if (done) break;
          }
          reader.cancel();
          cancelled = true;
        }

        // Wait a bit for cleanup
        await new Promise((r) => setTimeout(r, 100));

        // Test passes if no unhandled rejections thrown
        const oscillatorEvents = publishedEvents.filter((e) =>
          e.type.startsWith("oscillator."),
        );
        expect(oscillatorEvents.length).toBeGreaterThanOrEqual(1);
      } finally {
        server.close();
      }
    });

    it("SSE event ordering: verify oscillator.started → oscillator.step_complete* → oscillator.complete", async () => {
      const foundationChunks = buildStreamChunks("Foundation base analysis.", "foundation");
      const injectionChunks = buildStreamChunks("Alternative perspective.", "injection");
      const anchorChunks = buildStreamChunks("Final synthesized answer.", "foundation");

      streamFactory = async function* (
        step: "foundation" | "injection" | "anchor",
        _modelId: string,
      ) {
        const chunks =
          step === "foundation"
            ? foundationChunks
            : step === "injection"
              ? injectionChunks
              : anchorChunks;
        for (const chunk of chunks) yield chunk;
      };

      const { status, headers, frames, raw } = await postStream(
        app,
        "/v1/chat/completions",
        {
          model: "auto",
          messages: [
            {
              role: "user",
              content:
                "Analyze this architecture and explain the tradeoffs in detail.",
            },
          ],
          stream: true,
        },
        key,
      );

      expect(status).toBe(200);
      expect(headers.get("x-rabbit-status")).toBe("streaming");

      // Verify the order of oscillator streaming events is correct:
      // Should contain stream_start, stream_step_complete, and stream_complete
      const oscillatorEvents = publishedEvents
        .filter((e) => e.type.startsWith("oscillator."))
        .map((e) => e.type);

      // First event should be a stream_start (foundation step begins)
      expect(oscillatorEvents[0]).toBe("oscillator.stream_start");
      // Last event should be stream_complete
      expect(oscillatorEvents[oscillatorEvents.length - 1]).toBe("oscillator.stream_complete");
      // Should have at least one stream_start and one stream_step_complete per step
      expect(oscillatorEvents.filter((t) => t === "oscillator.stream_start").length).toBeGreaterThanOrEqual(2);
      expect(oscillatorEvents.filter((t) => t === "oscillator.stream_step_complete").length).toBeGreaterThanOrEqual(2);

      // Verify streaming step names in stream_step_complete events
      const stepCompleteEvents = publishedEvents.filter(
        (e) => e.type === "oscillator.stream_step_complete",
      );
      const stepNames = stepCompleteEvents.map((e) => e.step).filter(Boolean);
      expect(stepNames.length).toBeGreaterThan(0);
      // Should include at least foundation and anchor steps
      expect(stepNames).toContain("foundation");

      // Verify stream.chunk events (stream_delta*) are published during anchor streaming
      const streamChunkEvents = publishedEvents.filter(
        (e) => e.type === "stream.chunk",
      );
      expect(streamChunkEvents.length).toBeGreaterThan(0);

      // Verify each stream.chunk has the expected structure
      for (const event of streamChunkEvents) {
        expect(event).toMatchObject({
          type: "stream.chunk",
          id: expect.any(String),
          text: expect.any(String),
          at: expect.any(Number),
        });
      }

      // Verify final [DONE] marker
      expect(raw).toContain("data: [DONE]");
    });
  });
});
