import { beforeEach, describe, expect, it } from "vitest";
import { getDb, initDb, setSetting } from "../../db/index.js";
import { saveFeatureSettings } from "../../services/feature-settings.js";
import {
  detectMeow,
  getOscillatorConfig,
  getRabbitCandidates,
  getRabbitWeights,
  isComplexReasoningPrompt,
  isRabbitOscillatorEligible,
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
});
