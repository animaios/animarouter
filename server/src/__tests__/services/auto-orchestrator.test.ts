import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDb } from "../../db/index.js";
import {
  recordAutoOutcome,
  resetAutoOrchestratorCache,
  selectAutoStrategy,
} from "../../services/auto-orchestrator.js";
import type { RoutingStrategy } from "../../services/scoring.js";

/**
 * Tests for the Thompson-sampled Auto meta-bandit orchestrator.
 *
 * The orchestrator selects one of 5 eligible arms (balanced, smartest,
 * fastest, reliable, racing). Rewards are derived from `model_stats_temp`
 * telemetry via composite scoring. Sparse telemetry falls back to a uniform
 * Beta(1,1) prior. There is no separate reward table — pseudo-counts are
 * recomputed from `model_stats_temp` on every call.
 */

function freshDb(): Database.Database {
  return initDb(":memory:");
}

async function seedStats(
  db: Database.Database,
  platform: string,
  rows: Array<{
    model_id: string;
    successes: number;
    failures: number;
    tokPerSec: number;
    avgTtfbMs: number;
  }>,
): Promise<void> {
  // ensure at least one model row exists so FK-dependent insert works
  const modelCount = db
    .prepare("SELECT COUNT(*) as cnt FROM models WHERE platform = ?")
    .get(platform) as { cnt: number };
  if (modelCount.cnt === 0) {
    db.prepare(
      `INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label)
       VALUES (?, ?, ?, 1, 1, 'Medium')`,
    ).run(platform, `${platform}-seed`, `${platform}-seed`);
  }
  // Pre-populate model_stats_temp directly
  for (const r of rows) {
    db.prepare(
      `INSERT OR REPLACE INTO model_stats_temp (platform, model_id, successes, failures, tokPerSec, avgTtfbMs)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      platform,
      r.model_id,
      r.successes,
      r.failures,
      r.tokPerSec,
      r.avgTtfbMs,
    );
  }
}

describe("auto-orchestrator", () => {
  beforeEach(() => {
    freshDb();
    resetAutoOrchestratorCache();
  });

  afterEach(() => {
    resetAutoOrchestratorCache();
  });

  it("selectAutoStrategy returns one of the 5 valid arms only", () => {
    const validArms = new Set<RoutingStrategy>([
      "balanced",
      "smartest",
      "fastest",
      "reliable",
      "racing",
    ]);
    for (let i = 0; i < 200; i++) {
      const arm = selectAutoStrategy("groq");
      expect(validArms.has(arm)).toBe(true);
    }
  });

  it("never returns 'iterative_refinement', 'priority', 'custom', or 'auto'", () => {
    const disallowed = new Set([
      "priority",
      "custom",
      "iterative_refinement",
      "auto",
    ]);
    for (let i = 0; i < 100; i++) {
      const arm = selectAutoStrategy("groq");
      expect(disallowed.has(arm)).toBe(false);
    }
  });

  it("sparse telemetry (<10 obs) yields approximately uniform arm distribution", () => {
    // No model_stats_temp rows → Beta(1,1) prior per arm.
    // Reset cache between calls so each invocation re-samples.
    const counts = new Map<RoutingStrategy, number>();
    const N = 200;
    for (let i = 0; i < N; i++) {
      resetAutoOrchestratorCache();
      const arm = selectAutoStrategy("groq");
      counts.set(arm, (counts.get(arm) ?? 0) + 1);
    }
    // All 5 arms must appear at least once
    expect(counts.size).toBe(5);
    // No arm should dominate
    for (const [, c] of counts) {
      expect(c).toBeLessThan(N * 0.6);
    }
  });

  it("biased telemetry tilts arm selection toward the high-reward arm", async () => {
    const db = initDb(":memory:");
    // Seed strong telemetry for platform 'groq' — high reliability, fast, low TTFB
    await seedStats(db, "groq", [
      {
        model_id: "groq-model-1",
        successes: 100,
        failures: 5,
        tokPerSec: 200,
        avgTtfbMs: 150,
      },
    ]);
    // CombineScore with reliable weights (reliability=0.6) yields higher scores
    // than balanced (reliability=0.4) when reliability signal is strong.
    // Over 200 samples with the cache reset between each call, 'reliable' should
    // win more than 'balanced'.
    const counts = new Map<RoutingStrategy, number>();
    const N = 200;
    for (let i = 0; i < N; i++) {
      resetAutoOrchestratorCache();
      const arm = selectAutoStrategy("groq");
      counts.set(arm, (counts.get(arm) ?? 0) + 1);
    }
    const reliableCount = counts.get("reliable") ?? 0;
    const balancedCount = counts.get("balanced") ?? 0;
    expect(reliableCount).toBeGreaterThan(balancedCount);
  });

  it("clearing model_stats_temp resets arm selection to uniform", async () => {
    const db = initDb(":memory:");
    // Seed strong telemetry to bias
    await seedStats(db, "groq", [
      {
        model_id: "groq-model-1",
        successes: 100,
        failures: 5,
        tokPerSec: 200,
        avgTtfbMs: 150,
      },
    ]);

    // Clear telemetry
    db.prepare("DELETE FROM model_stats_temp WHERE platform = 'groq'").run();

    // After clearing, distribution should return to approximately uniform
    // (reset cache between calls so each invocation re-samples)
    const uniformCounts = new Map<RoutingStrategy, number>();
    for (let i = 0; i < 200; i++) {
      resetAutoOrchestratorCache();
      uniformCounts.set(
        selectAutoStrategy("groq"),
        (uniformCounts.get(selectAutoStrategy("groq")) ?? 0) + 1,
      );
    }
    expect(uniformCounts.size).toBeGreaterThanOrEqual(4);
    const maxUniform = Math.max(...uniformCounts.values());
    expect(maxUniform).toBeLessThan(200 * 0.6); // no arm dominant
  });

  it("selectAutoStrategy is side-effect free (no writes)", () => {
    const db = initDb(":memory:");
    const before = db
      .prepare("SELECT COUNT(*) as cnt FROM provider_strategies")
      .get() as { cnt: number };
    selectAutoStrategy("fresh-platform");
    const after = db
      .prepare("SELECT COUNT(*) as cnt FROM provider_strategies")
      .get() as { cnt: number };
    expect(after.cnt).toBe(before.cnt);
  });

  it("recordAutoOutcome tolerates unknown platform/arm without throwing", () => {
    expect(() => {
      recordAutoOutcome("totally-bogus-platform", "bogus-arm", 0.5);
    }).not.toThrow();
  });

  it("burst re-sample window returns the same arm within a tight loop", () => {
    const arms = Array.from({ length: 10 }, () => selectAutoStrategy("groq"));
    const allSame = arms.every((a) => a === arms[0]);
    expect(allSame).toBe(true);
  });

  it("different platforms may select different arms", () => {
    const groqArm = selectAutoStrategy("groq");
    resetAutoOrchestratorCache();
    const cerebrasArm = selectAutoStrategy("cerebras");
    // Both must be valid arms even if they differ
    const validArms = new Set<RoutingStrategy>([
      "balanced",
      "smartest",
      "fastest",
      "reliable",
      "racing",
    ]);
    expect(validArms.has(groqArm)).toBe(true);
    expect(validArms.has(cerebrasArm)).toBe(true);
  });
});
