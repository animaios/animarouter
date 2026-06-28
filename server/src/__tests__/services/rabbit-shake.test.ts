import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, initDb, setSetting } from "../../db/index.js";
import {
  REGISTRY,
  saveFeatureSettings,
} from "../../services/feature-settings.js";
import {
  collectOscillatorStats,
  detectMeow,
  executeOscillator,
  getOscillatorConfig,
  getRabbitCandidates,
  getRabbitOscillatorDecision,
  getRabbitWeights,
  isComplexReasoningPrompt,
  isRabbitLoadShedActive,
  isRabbitOscillatorEligible,
  logOscillatorResult,
  type OscillatorConfig,
  parseRabbitWeights,
  RABBIT_DEFAULT_WEIGHTS,
  type RabbitCandidate,
  resolveFoundationCandidates,
  resolveInjectionModel,
} from "../../services/rabbit-shake.js";

function candidate(overrides: Partial<RabbitCandidate>): RabbitCandidate {
  return {
    modelDbId: 1,
    platform: "alpha",
    modelId: "alpha-1",
    displayName: "Alpha 1",
    enabled: true,
    reliability: 0.8,
    speed: 0.5,
    intelligence: 0.8,
    latency: 0.5,
    degradationFactor: 1,
    boost: 1,
    score: 0.8,
    totalRequests: 0,
    intelligenceRank: 1,
    sizeLabel: "Frontier",
    supportsVision: false,
    supportsTools: false,
    contextWindow: null,
    rabbitScore: 0.8,
    ...overrides,
  };
}

function config(overrides: Partial<OscillatorConfig> = {}): OscillatorConfig {
  return {
    enabled: true,
    foundationSelection: "auto",
    injectionSelection: "divergent",
    rabbitWeights: RABBIT_DEFAULT_WEIGHTS,
    minIntelligenceGap: 0,
    injectionMaxSentences: 2,
    meowPatterns: [],
    loadShedThreshold: 21,
    stepTimeoutMs: 30000,
    fallbackMode: "foundation_only",
    ...overrides,
  };
}

function addModel(opts: {
  platform: string;
  modelId: string;
  name: string;
  intelligenceRank: number;
  speedRank: number;
  sizeLabel: string;
  priority: number;
  withKey?: boolean;
}) {
  const db = getDb();
  db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(
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
  if (opts.withKey !== false) {
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, 'key', 'enc', 'iv', 'tag', 'healthy', 1)
    `).run(opts.platform);
  }
  return modelDbId;
}

describe("Rabbit Shake routing helpers", () => {
  beforeEach(() => {
    process.env.DEV_MODE = "true";
    process.env.NODE_ENV = "test";
    initDb(":memory:");
    getDb().exec(`
      DELETE FROM fallback_config;
      DELETE FROM api_keys;
      DELETE FROM models;
      DELETE FROM requests;
      DELETE FROM settings
      WHERE key LIKE 'rabbit_%' OR key LIKE 'oscillator_%' OR key = 'routing_strategy';
    `);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults Rabbit weights to Smartest and normalizes optional JSON overrides", () => {
    expect(getRabbitWeights()).toEqual(RABBIT_DEFAULT_WEIGHTS);
    expect(parseRabbitWeights("")).toBeUndefined();
    expect(parseRabbitWeights("{bad json")).toBeUndefined();

    setSetting(
      "rabbit_weights",
      JSON.stringify({
        reliability: 3,
        speed: 1,
        intelligence: 4.5,
        latency: 1.5,
      }),
    );

    expect(getRabbitWeights()).toEqual(RABBIT_DEFAULT_WEIGHTS);
  });

  it("reads oscillator config from feature settings", () => {
    setSetting("rabbit_enabled", "true");
    setSetting("oscillator_foundation_selection", "top_rank");
    setSetting("oscillator_injection_selection", "different_tier");
    setSetting("oscillator_min_intelligence_gap", "25");
    setSetting("oscillator_injection_max_sentences", "3");
    setSetting("oscillator_load_shed_threshold", "12");
    setSetting("oscillator_step_timeout_ms", "15000");

    expect(getOscillatorConfig()).toMatchObject({
      enabled: true,
      foundationSelection: "top_rank",
      injectionSelection: "different_tier",
      minIntelligenceGap: 25,
      injectionMaxSentences: 3,
      loadShedThreshold: 12,
      stepTimeoutMs: 15000,
      fallbackMode: "foundation_only",
    });
  });

  it("allows numeric model ID overrides through feature settings", () => {
    expect(
      saveFeatureSettings({
        oscillator_foundation_selection: "30",
        oscillator_injection_selection: "40",
      }),
    ).toEqual([]);

    expect(getOscillatorConfig()).toMatchObject({
      foundationSelection: 30,
      injectionSelection: 40,
    });
  });

  it("allows zero to disable Rabbit load-shedding", () => {
    const definition = REGISTRY.find(
      (entry) => entry.key === "oscillator_load_shed_threshold",
    );

    expect(definition?.min).toBe(0);
    expect(saveFeatureSettings({ oscillator_load_shed_threshold: 0 })).toEqual(
      [],
    );
    expect(getOscillatorConfig().loadShedThreshold).toBe(0);
  });

  it("orders DB-backed foundation candidates by Rabbit score and requires an enabled key", () => {
    addModel({
      platform: "smart",
      modelId: "foundation",
      name: "Foundation",
      intelligenceRank: 1,
      speedRank: 10,
      sizeLabel: "Frontier",
      priority: 1,
    });
    addModel({
      platform: "fast",
      modelId: "speedy",
      name: "Speedy",
      intelligenceRank: 9,
      speedRank: 1,
      sizeLabel: "Small",
      priority: 2,
    });
    addModel({
      platform: "nokey",
      modelId: "ignored",
      name: "No Key",
      intelligenceRank: 1,
      speedRank: 1,
      sizeLabel: "Frontier",
      priority: 3,
      withKey: false,
    });

    const candidates = getRabbitCandidates();

    expect(candidates.map((entry) => entry.modelId)).toEqual([
      "foundation",
      "speedy",
    ]);
    expect(candidates[0].rabbitScore).toBeGreaterThan(
      candidates[1].rabbitScore,
    );
  });

  it("resolves foundation candidates by auto, top-rank, and explicit override", () => {
    const candidates = [
      candidate({
        modelDbId: 10,
        modelId: "auto-first",
        intelligenceRank: 4,
        rabbitScore: 0.9,
      }),
      candidate({
        modelDbId: 20,
        modelId: "rank-first",
        intelligenceRank: 1,
        rabbitScore: 0.7,
      }),
      candidate({
        modelDbId: 30,
        modelId: "explicit",
        intelligenceRank: 2,
        rabbitScore: 0.5,
      }),
    ];

    expect(
      resolveFoundationCandidates(config(), candidates).map(
        (item) => item.modelDbId,
      ),
    ).toEqual([10, 20, 30]);
    expect(
      resolveFoundationCandidates(
        config({ foundationSelection: "top_rank" }),
        candidates,
      ).map((item) => item.modelDbId),
    ).toEqual([20, 30, 10]);
    expect(
      resolveFoundationCandidates(
        config({ foundationSelection: 30 }),
        candidates,
      ).map((item) => item.modelDbId),
    ).toEqual([30, 10, 20]);
  });

  it("resolves injection model without hardcoded providers or model names", () => {
    const candidates = [
      candidate({
        modelDbId: 1,
        platform: "alpha",
        modelId: "foundation",
        sizeLabel: "Frontier",
        intelligenceRank: 1,
        rabbitScore: 0.95,
      }),
      candidate({
        modelDbId: 2,
        platform: "alpha",
        modelId: "same-provider",
        sizeLabel: "Frontier",
        intelligenceRank: 2,
        rabbitScore: 0.9,
      }),
      candidate({
        modelDbId: 3,
        platform: "beta",
        modelId: "divergent",
        sizeLabel: "Large",
        intelligenceRank: 3,
        rabbitScore: 0.85,
      }),
      candidate({
        modelDbId: 4,
        platform: "gamma",
        modelId: "top-rank",
        sizeLabel: "Frontier",
        intelligenceRank: 1,
        rabbitScore: 0.7,
      }),
    ];

    expect(resolveInjectionModel(config(), 1, candidates)?.modelDbId).toBe(3);
    expect(
      resolveInjectionModel(
        config({ injectionSelection: "top_rank" }),
        1,
        candidates,
      )?.modelDbId,
    ).toBe(4);
    expect(
      resolveInjectionModel(
        config({ injectionSelection: "different_tier" }),
        1,
        candidates,
      )?.modelDbId,
    ).toBe(3);
    expect(
      resolveInjectionModel(config({ injectionSelection: 2 }), 1, candidates)
        ?.modelDbId,
    ).toBe(2);
  });

  it("respects explicit injection overrides before intelligence-gap filtering", () => {
    const candidates = [
      candidate({ modelDbId: 1, intelligence: 0.91, modelId: "foundation" }),
      candidate({ modelDbId: 2, intelligence: 0.9, modelId: "explicit-peer" }),
    ];

    expect(
      resolveInjectionModel(
        config({ injectionSelection: 2, minIntelligenceGap: 50 }),
        1,
        candidates,
      )?.modelDbId,
    ).toBe(2);
  });

  it("executes the Rabbit oscillator sequentially with sanitized context bridges", async () => {
    const candidates = [
      candidate({
        modelDbId: 1,
        platform: "alpha",
        modelId: "foundation",
        rabbitScore: 0.9,
      }),
      candidate({
        modelDbId: 2,
        platform: "beta",
        modelId: "injection",
        rabbitScore: 0.8,
      }),
    ];
    const calls: Array<{
      step: string;
      modelDbId: number;
      messages: string[];
    }> = [];

    const result = await executeOscillator({
      messages: [{ role: "user", content: "Analyze the tradeoffs." }],
      sessionKey: "thread-1",
      config: config({ stepTimeoutMs: 1000 }),
      candidates,
      callModel: async ({ step, candidate: selected, messages }) => {
        calls.push({
          step,
          modelDbId: selected.modelDbId,
          messages: messages.map((message) => String(message.content)),
        });
        if (step === "foundation") {
          return "<|assistant|> Base logic with assumptions.";
        }
        if (step === "injection") {
          return "[SYS] Alternative perspective. Watch the loop. Extra sentence should be trimmed.";
        }
        return "Final answer reconciles the tradeoffs.";
      },
    });

    expect(result.status).toBe("completed");
    expect(result.text).toBe("Final answer reconciles the tradeoffs.");
    expect(calls.map((call) => call.step)).toEqual([
      "foundation",
      "injection",
      "anchor",
    ]);
    expect(calls[1].modelDbId).toBe(2);
    expect(calls[1].messages.join("\n")).toContain(
      "[Thought Context: [Assistant Context] Base logic with assumptions.]",
    );
    expect(calls[1].messages.join("\n")).not.toContain("<|assistant|>");
    expect(calls[2].modelDbId).toBe(1);
    expect(calls[2].messages.join("\n")).toContain(
      "[Thought Context: Alternative perspective. Watch the loop.]",
    );
    expect(calls[2].messages.join("\n")).not.toContain(
      "Extra sentence should be trimmed.",
    );
    expect(calls[2].messages.join("\n")).not.toContain("[SYS]");
  });

  it("tries the next foundation candidate when the first foundation step fails", async () => {
    const candidates = [
      candidate({ modelDbId: 1, platform: "alpha", modelId: "first" }),
      candidate({ modelDbId: 2, platform: "beta", modelId: "second" }),
      candidate({ modelDbId: 3, platform: "gamma", modelId: "injector" }),
    ];
    const attempts: number[] = [];

    const result = await executeOscillator({
      messages: [{ role: "user", content: "Debug this plan." }],
      sessionKey: "thread-2",
      config: config({ stepTimeoutMs: 1000 }),
      candidates,
      callModel: async ({ step, candidate: selected }) => {
        if (step === "foundation") {
          attempts.push(selected.modelDbId);
          if (selected.modelDbId === 1) {
            return undefined;
          }
          return "Recovered foundation.";
        }
        if (step === "injection") return "A different angle. Keep it brief.";
        return "Recovered final answer.";
      },
    });

    expect(result.status).toBe("completed");
    expect(result.foundation?.modelDbId).toBe(2);
    expect(result.foundationAttempts).toBe(2);
    expect(attempts).toEqual([1, 2]);
  });

  it("falls back to the selected foundation when a later oscillator step times out", async () => {
    vi.useFakeTimers();
    const candidates = [
      candidate({ modelDbId: 1, platform: "alpha", modelId: "foundation" }),
      candidate({ modelDbId: 2, platform: "beta", modelId: "injection" }),
    ];

    const pending = executeOscillator({
      messages: [{ role: "user", content: "Analyze the architecture." }],
      sessionKey: "thread-3",
      config: config({ stepTimeoutMs: 5 }),
      candidates,
      callModel: async ({ step }) => {
        if (step === "foundation") return "Foundation answer.";
        if (step === "injection") return "Second view. Concise.";
        return new Promise<string>(() => {});
      },
    });

    await vi.advanceTimersByTimeAsync(6);
    const result = await pending;

    expect(result.status).toBe("foundation_fallback");
    expect(result.failedStep).toBe("anchor");
    expect(result.text).toBe("Foundation answer.");
    expect(result.error).toMatch(/timed out/);
  });

  it("falls back to normal single-model routing when every foundation candidate fails", async () => {
    const candidates = [
      candidate({ modelDbId: 1, platform: "alpha", modelId: "first" }),
      candidate({ modelDbId: 2, platform: "beta", modelId: "second" }),
    ];

    const result = await executeOscillator({
      messages: [{ role: "user", content: "Debug this failing plan." }],
      sessionKey: "thread-4",
      config: config({ stepTimeoutMs: 1000 }),
      candidates,
      callModel: async ({ step, candidate: selected }) => {
        if (step === "foundation") {
          throw new Error(`failed ${selected.modelDbId}`);
        }
        return "unreachable";
      },
    });

    expect(result.status).toBe("single_model_fallback");
    expect(result.failedStep).toBe("foundation");
    expect(result.foundationAttempts).toBe(2);
    expect(result.error).toBe("failed 2");
  });

  it("falls back to foundation output when no divergent injection model is available", async () => {
    const candidates = [
      candidate({ modelDbId: 1, platform: "alpha", modelId: "foundation" }),
    ];

    const result = await executeOscillator({
      messages: [{ role: "user", content: "Analyze the plan." }],
      sessionKey: "thread-5",
      config: config({ stepTimeoutMs: 1000 }),
      candidates,
      callModel: async () => "Foundation only.",
    });

    expect(result.status).toBe("foundation_fallback");
    expect(result.failedStep).toBe("injection");
    expect(result.text).toBe("Foundation only.");
    expect(result.error).toMatch(/No eligible/);
  });

  it("falls back to foundation output when anchor validation detects meowing", async () => {
    const candidates = [
      candidate({ modelDbId: 1, platform: "alpha", modelId: "foundation" }),
      candidate({ modelDbId: 2, platform: "beta", modelId: "injection" }),
    ];

    const result = await executeOscillator({
      messages: [{ role: "user", content: "Analyze the reasoning." }],
      sessionKey: "thread-6",
      config: config({ stepTimeoutMs: 1000 }),
      candidates,
      callModel: async ({ step }) => {
        if (step === "foundation") return "Coherent foundation.";
        if (step === "injection") return "Alternative view. Concise.";
        return "Final answer leaked <|assistant|> marker.";
      },
    });

    expect(result.status).toBe("foundation_fallback");
    expect(result.failedStep).toBe("validation");
    expect(result.text).toBe("Coherent foundation.");
    expect(result.meow?.reason).toBe("structural_tag");
  });

  it("applies basic oscillator eligibility gates", () => {
    expect(
      isRabbitOscillatorEligible({
        strategy: "rabbit",
        promptText: "Analyze this architecture and explain the tradeoffs.",
        config: config(),
      }),
    ).toBe(true);
    expect(
      isRabbitOscillatorEligible({
        strategy: "smartest",
        promptText: "Analyze this architecture and explain the tradeoffs.",
        config: config(),
      }),
    ).toBe(false);
    expect(
      isRabbitOscillatorEligible({
        strategy: "rabbit",
        promptText: "Analyze this architecture and explain the tradeoffs.",
        pinnedModelDbId: 1,
        config: config(),
      }),
    ).toBe(false);
  });

  it("load-sheds only above the configured concurrent request threshold", () => {
    expect(isRabbitLoadShedActive(config({ loadShedThreshold: 21 }), 21)).toBe(
      false,
    );
    expect(isRabbitLoadShedActive(config({ loadShedThreshold: 21 }), 22)).toBe(
      true,
    );
    expect(isRabbitLoadShedActive(config({ loadShedThreshold: 0 }), 999)).toBe(
      false,
    );
  });

  it("returns a proxy-facing single-model decision when Rabbit is load-shed", () => {
    expect(
      getRabbitOscillatorDecision({
        strategy: "rabbit",
        promptText: "Analyze this architecture and explain the tradeoffs.",
        currentConcurrent: 22,
        config: config({ loadShedThreshold: 21 }),
      }),
    ).toMatchObject({
      mode: "single_model",
      loadShedActive: true,
      skipReason: "load_shed",
    });
  });

  it("returns oscillator mode only for enabled complex unpinned Rabbit requests under the load threshold", () => {
    expect(
      getRabbitOscillatorDecision({
        strategy: "rabbit",
        promptText: "Analyze this architecture and explain the tradeoffs.",
        currentConcurrent: 21,
        config: config({ loadShedThreshold: 21 }),
      }),
    ).toMatchObject({
      mode: "oscillator",
      loadShedActive: false,
    });
  });

  it("explains non-load-shed Rabbit oscillator skips for normal single-model fallback", () => {
    expect(
      getRabbitOscillatorDecision({
        strategy: "smartest",
        promptText: "Analyze this architecture.",
        config: config(),
      }).skipReason,
    ).toBe("non_rabbit_strategy");
    expect(
      getRabbitOscillatorDecision({
        strategy: "rabbit",
        promptText: "Analyze this architecture.",
        config: config({ enabled: false }),
      }).skipReason,
    ).toBe("disabled");
    expect(
      getRabbitOscillatorDecision({
        strategy: "rabbit",
        promptText: "Analyze this architecture.",
        pinnedModelDbId: 1,
        config: config(),
      }).skipReason,
    ).toBe("pinned_model");
    expect(
      getRabbitOscillatorDecision({
        strategy: "rabbit",
        promptText: "Analyze this architecture.",
        pinnedModelDbId: 0,
        config: config(),
      }).skipReason,
    ).toBe("pinned_model");
    expect(
      getRabbitOscillatorDecision({
        strategy: "rabbit",
        promptText: "hello",
        config: config(),
      }).skipReason,
    ).toBe("simple_prompt");
  });

  it("treats null prompt text as non-complex instead of throwing", () => {
    expect(isComplexReasoningPrompt(null)).toBe(false);
    expect(
      isRabbitOscillatorEligible({
        strategy: "rabbit",
        promptText: null,
        config: config(),
      }),
    ).toBe(false);
  });

  it("detects structural tag leakage and obvious corruption", () => {
    expect(
      detectMeow("Final answer <|assistant|> leaked marker").detected,
    ).toBe(true);
    expect(detectMeow("[INST] hidden prompt artifact [/INST]").detected).toBe(
      true,
    );
    expect(detectMeow(`ok ${"x".repeat(30)}`).reason).toBe(
      "repeated_character",
    );
    expect(detectMeow("bad replacement chars ���").reason).toBe(
      "replacement_character",
    );
  });

  it("supports custom meow patterns", () => {
    expect(
      detectMeow("the router emitted RABBIT_BAD_TOKEN", ["RABBIT_BAD_TOKEN"])
        .detected,
    ).toBe(true);
    expect(detectMeow("normal response", ["RABBIT_BAD_TOKEN"]).detected).toBe(
      false,
    );
  });

  it("flags extreme Unicode script fragmentation but not normal prose", () => {
    const fragmented =
      "abcабвδεζمرح你好世界abcабвδεζمرح你好世界abcабвδεζمرح你好世界";
    const normal =
      "The answer compares latency, reliability, and cost. Короткое пояснение рядом is acceptable.";
    const delayedFragmentation = `${"plain ".repeat(180)}${fragmented}`;

    expect(detectMeow(fragmented).reason).toBe("script_fragmentation");
    expect(detectMeow(normal).detected).toBe(false);
    expect(detectMeow(delayedFragmentation).detected).toBe(false);
    expect(
      detectMeow(
        "Here is a TypeScript example: const total = 1 + 2; return total.",
      ).detected,
    ).toBe(false);
  });

  it("persists oscillator results and aggregates advisor-facing stats", async () => {
    const foundationId = addModel({
      platform: "alpha",
      modelId: "foundation",
      name: "Foundation",
      intelligenceRank: 1,
      speedRank: 5,
      sizeLabel: "Frontier",
      priority: 1,
    });
    const injectionId = addModel({
      platform: "beta",
      modelId: "injection",
      name: "Injection",
      intelligenceRank: 2,
      speedRank: 4,
      sizeLabel: "Large",
      priority: 2,
    });
    const candidates = [
      candidate({
        modelDbId: foundationId,
        platform: "alpha",
        modelId: "foundation",
      }),
      candidate({
        modelDbId: injectionId,
        platform: "beta",
        modelId: "injection",
      }),
    ];

    const result = await executeOscillator({
      messages: [{ role: "user", content: "Analyze this routing issue." }],
      sessionKey: "thread-stats",
      config: config(),
      candidates,
      callModel: async ({ step }) => {
        if (step === "foundation") return "Foundation answer.";
        if (step === "injection") return "Alternative view. Keep it short.";
        return "Anchored final answer.";
      },
    });

    logOscillatorResult({
      sessionKey: "thread-stats",
      result,
      totalLatencyMs: 1234,
      stepLatencies: {
        foundation: 100,
        injection: 200,
        anchor: 300,
      },
    });

    const row = getDb()
      .prepare("SELECT * FROM oscillator_results WHERE session_key = ?")
      .get("thread-stats") as {
      foundation_model_db_id: number;
      injection_model_db_id: number;
      step1_latency_ms: number;
      step2_latency_ms: number;
      step3_latency_ms: number;
      total_latency_ms: number;
      complete: number;
      failed_step: number | null;
      status: string;
      meow_detected: number;
    };

    expect(row).toMatchObject({
      foundation_model_db_id: foundationId,
      injection_model_db_id: injectionId,
      step1_latency_ms: 100,
      step2_latency_ms: 200,
      step3_latency_ms: 300,
      total_latency_ms: 1234,
      complete: 1,
      failed_step: null,
      status: "completed",
      meow_detected: 0,
    });

    expect(collectOscillatorStats(60_000)).toMatchObject({
      attempts: 1,
      successes: 1,
      failures: 0,
      avgLatencyMs: 1234,
      meowCount: 0,
      loadShedActive: false,
    });
  });

  it("counts meow validation fallbacks as oscillator failures", async () => {
    const foundationId = addModel({
      platform: "alpha",
      modelId: "foundation",
      name: "Foundation",
      intelligenceRank: 1,
      speedRank: 5,
      sizeLabel: "Frontier",
      priority: 1,
    });
    const injectionId = addModel({
      platform: "beta",
      modelId: "injection",
      name: "Injection",
      intelligenceRank: 2,
      speedRank: 4,
      sizeLabel: "Large",
      priority: 2,
    });

    const result = await executeOscillator({
      messages: [{ role: "user", content: "Analyze this routing issue." }],
      sessionKey: "thread-meow",
      config: config(),
      candidates: [
        candidate({
          modelDbId: foundationId,
          platform: "alpha",
          modelId: "foundation",
        }),
        candidate({
          modelDbId: injectionId,
          platform: "beta",
          modelId: "injection",
        }),
      ],
      callModel: async ({ step }) => {
        if (step === "foundation") return "Foundation answer.";
        if (step === "injection") return "Alternative view. Keep it short.";
        return "Leaked raw marker <|assistant|>.";
      },
    });

    logOscillatorResult({
      sessionKey: "thread-meow",
      result,
      totalLatencyMs: 900,
    });

    expect(collectOscillatorStats(60_000)).toMatchObject({
      attempts: 1,
      successes: 0,
      failures: 1,
      avgLatencyMs: 0,
      meowCount: 1,
    });
  });
});
