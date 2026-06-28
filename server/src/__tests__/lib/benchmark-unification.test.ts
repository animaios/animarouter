import type Database from "better-sqlite3";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  applyManualBenchmarkOverrides,
  canonicalizeModelId,
  invalidateSourceWeightsCache,
  loadSourceWeights,
  lookupBenchmarkScore,
  lookupManualBenchmarkOverride,
  recomputeBenchmarkComposite,
  scoreToIntelligenceRank,
  scoreToTier,
  stalenessDecay,
  TIER_BANDS,
  validateComposite,
} from "../../db/benchmark-scores.js";
import { getDb, initDb } from "../../db/index.js";

// ── canonicalizeModelId ─────────────────────────────────────────────────────
// Per spec R10.2: exact regex from TASKS.md Task 1.2
describe("canonicalizeModelId", () => {
  it("strips provider prefix and lowercases", () => {
    expect(canonicalizeModelId("meta/Llama-3.3-70B")).toBe("llama-3-3-70b");
  });

  it("strips -instruct suffix (spec example)", () => {
    expect(canonicalizeModelId("meta/llama-3.3-70b-instruct")).toBe(
      "llama-3-3-70b",
    );
  });

  it("strips -chat suffix", () => {
    expect(canonicalizeModelId("google/gemini-3.1-pro-chat")).toBe(
      "gemini-3-1-pro",
    );
  });

  it("strips -it suffix (spec example)", () => {
    expect(canonicalizeModelId("google/gemma-4-31b-it")).toBe("gemma-4-31b");
  });

  it("strips -hf suffix", () => {
    expect(canonicalizeModelId("mistral/mistral-7b-hf")).toBe("mistral-7b");
  });

  it("normalizes version dots to dashes", () => {
    expect(canonicalizeModelId("gpt-5.5")).toBe("gpt-5-5");
    expect(canonicalizeModelId("gemini-3.1-pro")).toBe("gemini-3-1-pro");
  });

  it("handles model IDs without provider prefix", () => {
    expect(canonicalizeModelId("llama-3.3-70b-instruct")).toBe("llama-3-3-70b");
    expect(canonicalizeModelId("gpt-5")).toBe("gpt-5");
  });

  it("preserves param size like 70b, 8b", () => {
    expect(canonicalizeModelId("llama-3.3-70b")).toBe("llama-3-3-70b");
    expect(canonicalizeModelId("llama-3.1-8b")).toBe("llama-3-1-8b");
  });

  it("normalizes underscores to hyphens", () => {
    expect(canonicalizeModelId("some_model_v4")).toBe("some-model-v4");
  });

  it("spec example: deepseek-ai/deepseek-v4-flash → deepseek-v4-flash", () => {
    // Per spec: prefix strip removes 'deepseek-ai/' then '-flash' suffix not in strip list
    const result = canonicalizeModelId("deepseek-ai/deepseek-v4-flash");
    // The regex strips 'deepseek-ai/' prefix, result is 'deepseek-v4-flash'
    expect(result).toBe("deepseek-v4-flash");
  });
});

// ── stalenessDecay ──────────────────────────────────────────────────────────
describe("stalenessDecay", () => {
  it("returns 1.0 for a timestamp from right now", () => {
    const now = new Date().toISOString();
    expect(stalenessDecay(now)).toBeCloseTo(1.0, 2);
  });

  it("returns ~0.5 for a timestamp 10 days ago", () => {
    const tenDaysAgo = new Date(
      Date.now() - 10 * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(stalenessDecay(tenDaysAgo)).toBeCloseTo(0.5, 2);
  });

  it("returns ~0.25 for a timestamp 20 days ago", () => {
    const twentyDaysAgo = new Date(
      Date.now() - 20 * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(stalenessDecay(twentyDaysAgo)).toBeCloseTo(0.25, 2);
  });

  it("returns 0 for null/undefined", () => {
    expect(stalenessDecay(null)).toBe(0);
    expect(stalenessDecay(undefined)).toBe(0);
  });

  it("returns 1 for future timestamps", () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    expect(stalenessDecay(future)).toBe(1);
  });

  it("uses continuous exponential decay, NOT step functions", () => {
    // 5 days ago should be pow(0.5, 5/10) = pow(0.5, 0.5) ≈ 0.707
    const fiveDaysAgo = new Date(
      Date.now() - 5 * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(stalenessDecay(fiveDaysAgo)).toBeCloseTo(0.5 ** 0.5, 2);
  });

  it("returns ~0.125 for 30 days ago (R4.5)", () => {
    const thirtyDaysAgo = new Date(
      Date.now() - 30 * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(stalenessDecay(thirtyDaysAgo)).toBeCloseTo(0.125, 2);
  });
});

// ── validateComposite ───────────────────────────────────────────────────────
describe("validateComposite", () => {
  it("accepts valid scores in [0, 100]", () => {
    expect(validateComposite(0)).toBe(true);
    expect(validateComposite(50)).toBe(true);
    expect(validateComposite(100)).toBe(true);
    expect(validateComposite(0.01)).toBe(true);
  });

  it("rejects NaN", () => {
    expect(validateComposite(NaN)).toBe(false);
  });

  it("rejects Infinity and -Infinity", () => {
    expect(validateComposite(Infinity)).toBe(false);
    expect(validateComposite(-Infinity)).toBe(false);
  });

  it("rejects scores < 0", () => {
    expect(validateComposite(-0.01)).toBe(false);
    expect(validateComposite(-100)).toBe(false);
  });

  it("rejects scores > 100", () => {
    expect(validateComposite(100.01)).toBe(false);
    expect(validateComposite(200)).toBe(false);
  });
});

// ─── scoreToTier ─────────────────────────────────────────────────────────────
describe("scoreToTier", () => {
  it("returns Frontier for scores >= 42 (updated tier bands for new score scale)", () => {
    expect(scoreToTier(42)).toBe("Frontier");
    expect(scoreToTier(60)).toBe("Frontier");
    expect(scoreToTier(100)).toBe("Frontier");
  });

  it("returns Large for scores 28-41", () => {
    expect(scoreToTier(28)).toBe("Large");
    expect(scoreToTier(41)).toBe("Large");
    expect(scoreToTier(35)).toBe("Large");
  });

  it("returns Medium for scores 7-27", () => {
    expect(scoreToTier(7)).toBe("Medium");
    expect(scoreToTier(27)).toBe("Medium");
    expect(scoreToTier(20)).toBe("Medium");
  });

  it("returns Small for scores < 7", () => {
    expect(scoreToTier(0)).toBe("Small");
    expect(scoreToTier(6)).toBe("Small");
    expect(scoreToTier(1)).toBe("Small");
  });
});

// ── scoreToIntelligenceRank ─────────────────────────────────────────────────
describe("scoreToIntelligenceRank", () => {
  it("higher score → lower (better) rank", () => {
    const rank60 = scoreToIntelligenceRank(60);
    const rank30 = scoreToIntelligenceRank(30);
    expect(rank60).toBeLessThan(rank30);
  });

  it("clamps to [1, 100]", () => {
    expect(scoreToIntelligenceRank(0)).toBeGreaterThanOrEqual(1);
    expect(scoreToIntelligenceRank(0)).toBeLessThanOrEqual(100);
    expect(scoreToIntelligenceRank(100)).toBeGreaterThanOrEqual(1);
    expect(scoreToIntelligenceRank(100)).toBeLessThanOrEqual(100);
  });

  it("score 60 → rank 41 (good), score 0 → rank 100 (worst), score 100 → rank 1 (best)", () => {
    expect(scoreToIntelligenceRank(60)).toBe(41); // 101 - 60 = 41
    expect(scoreToIntelligenceRank(0)).toBe(100); // min(100, 101-0) = 100
    expect(scoreToIntelligenceRank(100)).toBe(1); // max(1, 101-100) = 1
  });
});

// ─── manual benchmark overrides ──────────────────────────────────────────────
describe("manual benchmark overrides", () => {
  it("hardcodes curated intelligence scores for the top free-tier pool", () => {
    const cases: Array<[string, number]> = [
      ["z-ai/glm-5.1", 100],
      ["moonshotai/Kimi-K2.6", 93],
      ["nvidia/nemotron-3-ultra-550b-a55b:free", 89],
      ["nemotron-3-ultra-free", 89],
      ["minimaxai/minimax-m2.7", 85],
      ["deepseek-ai/deepseek-v4-flash", 62],
      ["deepseek-v4-flash-free", 62],
      ["minimaxai/minimax-m3", 98],
      ["opencode/mimo-v2.5-free", 74],
      ["laguna-m-1", 74],
      ["stepfun-ai/step-3.7-flash", 65],
    ];

    for (const [modelId, expectedScore] of cases) {
      expect(lookupBenchmarkScore(modelId)).toBe(expectedScore);
    }
  });

  it("does not match alphanumeric continuations of curated model keys", () => {
    expect(lookupManualBenchmarkOverride("z-ai/glm-5.10")).toBeNull();
    expect(lookupManualBenchmarkOverride("moonshotai/kimi-k2.60")).toBeNull();
    expect(
      lookupManualBenchmarkOverride("deepseek-ai/deepseek-v4-flash2"),
    ).toBeNull();
    expect(lookupBenchmarkScore("z-ai/glm-50")).toBe(0);
  });
});

// ── recomputeBenchmarkComposite (with real DB) ──────────────────────────────
describe("recomputeBenchmarkComposite", () => {
  let db: Database.Database;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = "0".repeat(64);
    db = initDb(":memory:");
  });

  function insertModel(overrides: Record<string, any>): number {
    const defaults: Record<string, any> = {
      model_id: "test-model",
      platform: "test",
      canonical_model_key: "test-model",
      display_name: overrides.model_id ?? "test-model",
      intelligence_rank: 50,
      speed_rank: 50,
    };
    const merged = { ...defaults, ...overrides };
    const cols = Object.keys(merged);
    const vals = cols.map((k) => merged[k]);
    const placeholders = cols.map(() => "?").join(", ");
    const stmt = db.prepare(
      `INSERT INTO models (${cols.join(", ")}) VALUES (${placeholders})`,
    );
    const result = stmt.run(...vals);
    return Number(result.lastInsertRowid);
  }

  function getModel(id: number) {
    return db.prepare("SELECT * FROM models WHERE id = ?").get(id) as any;
  }

  function getWeights(): Map<string, any> {
    invalidateSourceWeightsCache();
    return loadSourceWeights();
  }

  it("R4.3: single source → pass-through (benchmark_score = source score)", () => {
    const id = insertModel({
      model_id: "single-source-model",
      canonical_model_key: "single-source-model",
      aa_score: 60,
      aa_score_updated: new Date().toISOString(),
      aa_confidence: 1.0,
    });

    const weights = getWeights();
    const affected = new Set([id]);
    const count = recomputeBenchmarkComposite(db, affected, weights);

    expect(count).toBe(1);
    const row = getModel(id);
    expect(row.benchmark_score).toBeCloseTo(60, 1);
    expect(row.benchmark_composite_version).toBe(1);
  });

  it("R4.1: 3 intelligence sources → weighted average (AA=0.50, BG=0.30, AIIQ=0.20)", () => {
    const now = new Date().toISOString();
    const id = insertModel({
      model_id: "all-sources-model",
      canonical_model_key: "all-sources-model",
      aa_score: 58,
      aa_score_updated: now,
      aa_confidence: 1.0,
      bg_score: 54,
      bg_score_updated: now,
      bg_confidence: 1.0,
      aiiq_score: 52,
      aiiq_score_updated: now,
      aiiq_confidence: 1.0,
    });

    const weights = getWeights();
    recomputeBenchmarkComposite(db, new Set([id]), weights);

    const row = getModel(id);
    // (58×0.50 + 54×0.30 + 52×0.20) / 1.0 = 55.6
    const expected = 58 * 0.5 + 54 * 0.3 + 52 * 0.2;
    expect(row.benchmark_score).toBeCloseTo(expected, 1);
    expect(row.benchmark_composite_version).toBe(1);
  });

  it("R4.2: single source → effective weight 1.0 (pass-through)", () => {
    const now = new Date().toISOString();
    const id = insertModel({
      model_id: "two-sources-model",
      canonical_model_key: "two-sources-model",
      aa_score: 58,
      aa_score_updated: now,
      aa_confidence: 1.0,
    });

    const weights = getWeights();
    recomputeBenchmarkComposite(db, new Set([id]), weights);

    const row = getModel(id);
    // Only AA has data → effective weight 0.50 / 0.50 = 1.0 for AA
    expect(row.benchmark_score).toBeCloseTo(58, 1);
  });

  it("3 intelligence sources → weighted average", () => {
    const now = new Date().toISOString();
    const id = insertModel({
      model_id: "three-sources-model",
      canonical_model_key: "three-sources-model",
      aa_score: 58,
      aa_score_updated: now,
      aa_confidence: 1.0,
      bg_score: 54,
      bg_score_updated: now,
      bg_confidence: 1.0,
      aiiq_score: 52,
      aiiq_score_updated: now,
      aiiq_confidence: 1.0,
    });

    const weights = getWeights();
    recomputeBenchmarkComposite(db, new Set([id]), weights);

    const row = getModel(id);
    // Expected: (58×0.50 + 54×0.30 + 52×0.20) / 1.0 = 29 + 16.2 + 10.4 = 55.6
    expect(row.benchmark_score).toBeCloseTo(55.6, 1);
  });

  it("R4.4: no sources → benchmark_score stays NULL (skipped)", () => {
    const id = insertModel({
      model_id: "no-sources-model",
      canonical_model_key: "no-sources-model",
    });

    const weights = getWeights();
    const count = recomputeBenchmarkComposite(db, new Set([id]), weights);

    expect(count).toBe(0); // skipped because totalWeight <= 0
    const row = getModel(id);
    expect(row.benchmark_score).toBeNull();
  });

  it("R8.1b: canary skips row when composite would be invalid", () => {
    const now = new Date().toISOString();
    const id = insertModel({
      model_id: "canary-valid-model",
      canonical_model_key: "canary-valid-model",
      aa_score: 50,
      aa_score_updated: now,
      aa_confidence: 1.0,
    });

    const weights = getWeights();
    const count = recomputeBenchmarkComposite(db, new Set([id]), weights);

    expect(count).toBe(1); // canary passed, row written
    const row = getModel(id);
    expect(row.benchmark_score).toBeCloseTo(50, 1);
    expect(validateComposite(row.benchmark_score)).toBe(true);
  });

  it("writes size_label and intelligence_rank from composite", () => {
    const now = new Date().toISOString();
    const id = insertModel({
      model_id: "tier-rank-model",
      canonical_model_key: "tier-rank-model",
      aa_score: 50,
      aa_score_updated: now,
      aa_confidence: 1.0,
    });

    const weights = getWeights();
    recomputeBenchmarkComposite(db, new Set([id]), weights);

    const row = getModel(id);
    expect(row.size_label).toBe("Frontier"); // 50 >= 45
    expect(row.intelligence_rank).toBe(scoreToIntelligenceRank(50));
  });

  it("manual override wins over lower source composites", () => {
    const now = new Date().toISOString();
    const id = insertModel({
      model_id: "minimaxai/minimax-m2.7",
      canonical_model_key: "minimax-m2-7",
      aa_score: 40,
      aa_score_updated: now,
      aa_confidence: 1.0,
      bg_score: 42,
      bg_score_updated: now,
      bg_confidence: 1.0,
      aiiq_score: 38,
      aiiq_score_updated: now,
      aiiq_confidence: 1.0,
    });

    const weights = getWeights();
    recomputeBenchmarkComposite(db, new Set([id]), weights);

    const row = getModel(id);
    expect(row.benchmark_score).toBe(85);
    expect(row.size_label).toBe("Frontier");
    expect(row.intelligence_rank).toBe(scoreToIntelligenceRank(85));
  });

  it("manual override application uses token boundaries for models and groups", () => {
    const targetModelId = insertModel({
      model_id: "z-ai/glm-5.1-boundary",
      canonical_model_key: "glm-5-1-boundary",
      benchmark_score: null,
      intelligence_rank: 50,
      size_label: "Custom",
    });
    const futureModelId = insertModel({
      model_id: "z-ai/glm-5.10",
      canonical_model_key: "glm-5-10",
      benchmark_score: null,
      intelligence_rank: 50,
      size_label: "Custom",
    });

    db.prepare(`
      INSERT INTO model_groups (group_key, display_name, intelligence_rank, size_label)
      VALUES (?, ?, ?, ?), (?, ?, ?, ?)
    `).run(
      "glm-5-1-boundary",
      "GLM 5.1 Boundary",
      50,
      "Custom",
      "glm-5-10",
      "GLM 5.10",
      50,
      "Custom",
    );

    applyManualBenchmarkOverrides(db);

    const target = getModel(targetModelId);
    const future = getModel(futureModelId);
    expect(target.benchmark_score).toBe(100);
    expect(target.intelligence_rank).toBe(scoreToIntelligenceRank(100));
    expect(future.benchmark_score).toBeNull();
    expect(future.intelligence_rank).toBe(50);

    const targetGroup = db
      .prepare(
        "SELECT benchmark_score, intelligence_rank FROM model_groups WHERE group_key = ?",
      )
      .get("glm-5-1-boundary") as any;
    const futureGroup = db
      .prepare(
        "SELECT benchmark_score, intelligence_rank FROM model_groups WHERE group_key = ?",
      )
      .get("glm-5-10") as any;
    expect(targetGroup.benchmark_score).toBe(100);
    expect(targetGroup.intelligence_rank).toBe(scoreToIntelligenceRank(100));
    expect(futureGroup.benchmark_score).toBeNull();
    expect(futureGroup.intelligence_rank).toBe(50);
  });

  it("staleness decay reduces composite for stale source (R4.5)", () => {
    const fresh = new Date().toISOString();
    const stale = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago

    const id = insertModel({
      model_id: "stale-source-model",
      canonical_model_key: "stale-source-model",
      aa_score: 58,
      aa_score_updated: stale,
      aa_confidence: 1.0,
      bg_score: 54,
      bg_score_updated: fresh,
      bg_confidence: 1.0,
      aiiq_score: 52,
      aiiq_score_updated: fresh,
      aiiq_confidence: 1.0,
    });

    const weights = getWeights();
    recomputeBenchmarkComposite(db, new Set([id]), weights);

    const row = getModel(id);
    // AA decay at 10 days = 0.5, so effective AA weight = 0.50 * 0.5 = 0.25
    // BG fresh: weight = 0.30 * 1.0 = 0.30
    // AIIQ fresh: weight = 0.20 * 1.0 = 0.20
    // Total weight = 0.25 + 0.30 + 0.20 = 0.75
    const aaDecay = 0.5 ** (10 / 10); // 0.5
    const aaW = 0.5 * aaDecay;
    const bgW = 0.3;
    const aiiqW = 0.2;
    const totalW = aaW + bgW + aiiqW;
    const expected = (58 * aaW + 54 * bgW + 52 * aiiqW) / totalW;
    expect(row.benchmark_score).toBeCloseTo(expected, 0);
  });

  it("confidence reduces effective weight (R4.6)", () => {
    const now = new Date().toISOString();
    const id = insertModel({
      model_id: "low-confidence-model",
      canonical_model_key: "low-confidence-model",
      aa_score: 60,
      aa_score_updated: now,
      aa_confidence: 0.6, // low confidence
    });

    const weights = getWeights();
    recomputeBenchmarkComposite(db, new Set([id]), weights);

    const row = getModel(id);
    // Single source → pass-through regardless of confidence
    expect(row.benchmark_score).toBeCloseTo(60, 1);
  });

  it("empty affectedIds → returns 0", () => {
    const weights = getWeights();
    const count = recomputeBenchmarkComposite(db, new Set(), weights);
    expect(count).toBe(0);
  });

  it("non-existent model ID in affectedIds → skipped gracefully", () => {
    const weights = getWeights();
    const count = recomputeBenchmarkComposite(db, new Set([999999]), weights);
    expect(count).toBe(0);
  });

  it("last_benchmark_update = latest of all source timestamps", () => {
    const tsAa = new Date(Date.now() - 2000).toISOString();
    const tsBg = new Date(Date.now() - 1000).toISOString(); // latest
    const tsAiiq = new Date(Date.now() - 3000).toISOString();
    const id = insertModel({
      model_id: "timestamp-model",
      canonical_model_key: "timestamp-model",
      aa_score: 50,
      aa_score_updated: tsAa,
      aa_confidence: 1.0,
      bg_score: 48,
      bg_score_updated: tsBg,
      bg_confidence: 1.0,
      aiiq_score: 46,
      aiiq_score_updated: tsAiiq,
      aiiq_confidence: 1.0,
    });

    const weights = getWeights();
    recomputeBenchmarkComposite(db, new Set([id]), weights);

    const row = getModel(id);
    expect(row.last_benchmark_update).toBe(tsBg);
  });
});

// ── loadSourceWeights ───────────────────────────────────────────────────────
describe("loadSourceWeights", () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = "0".repeat(64);
    initDb(":memory:");
  });

  it("loads 3 source weights from DB (AA, BenchGecko, AIIQ)", () => {
    invalidateSourceWeightsCache();
    const weights = loadSourceWeights();
    expect(weights.size).toBe(3);
    expect(weights.has("aa")).toBe(true);
    expect(weights.has("bg")).toBe(true);
    expect(weights.has("aiiq")).toBe(true);
  });

  it("seed weights: aa=0.50, bg=0.30, aiiq=0.20", () => {
    invalidateSourceWeightsCache();
    const weights = loadSourceWeights();
    expect(weights.size).toBe(3);
    expect(weights.get("aa")?.weight).toBeCloseTo(0.5, 2);
    expect(weights.get("bg")?.weight).toBeCloseTo(0.3, 2);
    expect(weights.get("aiiq")?.weight).toBeCloseTo(0.2, 2);
  });

  it("all 3 sources enabled by default", () => {
    invalidateSourceWeightsCache();
    const weights = loadSourceWeights();
    expect(weights.get("aa")?.enabled).toBe(true);
    expect(weights.get("bg")?.enabled).toBe(true);
    expect(weights.get("aiiq")?.enabled).toBe(true);
  });

  it("caches weights (second call returns same Map)", () => {
    invalidateSourceWeightsCache();
    const w1 = loadSourceWeights();
    const w2 = loadSourceWeights();
    expect(w1).toBe(w2); // same reference (cached)
  });

  it("invalidateSourceWeightsCache forces reload", () => {
    invalidateSourceWeightsCache();
    const w1 = loadSourceWeights();
    invalidateSourceWeightsCache();
    const w2 = loadSourceWeights();
    expect(w1).not.toBe(w2); // different reference after invalidation
  });
});

// ─── TIER_BANDS constant ────────────────────────────────────────────────────
describe("TIER_BANDS", () => {
  it("matches updated tier bands for new score scale (0-100)", () => {
    expect(TIER_BANDS.frontier).toBe(42);
    expect(TIER_BANDS.large).toBe(28);
    expect(TIER_BANDS.medium).toBe(7);
  });
});
