import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { initDb } from "../../db/index.js";
import { resetAutoOrchestratorCache } from "../../services/auto-orchestrator.js";
import {
  getProviderStrategy,
  listProviderStrategies,
  setProviderStrategy,
} from "../../services/provider-strategy.js";
import {
  getRoutingStrategy,
  resolvePlatformStrategy,
  setRoutingStrategy,
} from "../../services/router.js";
import type { RoutingStrategy } from "../../services/scoring.js";

/**
 * Tests for the provider_strategies migration and the new "auto" literal
 * extending the shared RoutingStrategy union.
 */

describe("provider_strategies migration", () => {
  function freshDb(): Database.Database {
    return initDb(":memory:");
  }

  it("creates the table with the expected column schema", () => {
    const db = freshDb();

    const columns = (
      db.prepare("PRAGMA table_info(provider_strategies)").all() as Array<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }>
    ).map((c) => c.name);

    expect(columns).toEqual(
      expect.arrayContaining(["platform", "strategy", "updated_at"]),
    );
    expect(columns).toHaveLength(3);
  });

  it("has platform as the primary key", () => {
    const db = freshDb();

    const columns = db
      .prepare("PRAGMA table_info(provider_strategies)")
      .all() as Array<{ name: string; pk: number }>;

    const platformCol = columns.find((c) => c.name === "platform");
    expect(platformCol).toBeDefined();
    expect(platformCol?.pk).toBe(1);
  });

  it("CHECK constraint rejects invalid strategy literals", () => {
    const db = freshDb();

    expect(() => {
      db.prepare(
        "INSERT INTO provider_strategies (platform, strategy) VALUES (?, ?)",
      ).run("groq", "bogus");
    }).toThrow(/CHECK constraint failed/);
  });

  it("accepts all 9 valid strategy values", () => {
    const db = freshDb();

    const validStrategies: RoutingStrategy[] = [
      "priority",
      "balanced",
      "smartest",
      "iterative_refinement",
      "fastest",
      "reliable",
      "custom",
      "racing",
      "auto",
    ];

    for (const s of validStrategies) {
      expect(() => {
        db.prepare(
          "INSERT INTO provider_strategies (platform, strategy) VALUES (?, ?)",
        ).run(`platform-${s}`, s);
      }).not.toThrow();
    }
  });
});

describe("RoutingStrategy type union", () => {
  it("accepts the literal 'auto' at compile time", () => {
    // This assignment is a compile-time check — it must type-check.
    const x: RoutingStrategy = "auto";
    expect(x).toBe("auto");
  });

  it("accepts all 8 pre-existing literals unchanged", () => {
    const legacy: RoutingStrategy[] = [
      "priority",
      "balanced",
      "smartest",
      "iterative_refinement",
      "fastest",
      "reliable",
      "custom",
      "racing",
    ];
    expect(legacy).toHaveLength(8);
  });
});

describe("provider strategy persistence", () => {
  beforeEach(() => {
    initDb(":memory:");
    resetAutoOrchestratorCache();
  });

  it("round-trips a strategy for a platform", () => {
    setProviderStrategy("groq", "reliable");
    expect(getProviderStrategy("groq")).toBe("reliable");
  });

  it("upserts — second write wins", () => {
    setProviderStrategy("groq", "reliable");
    setProviderStrategy("groq", "fastest");
    expect(getProviderStrategy("groq")).toBe("fastest");
  });

  it("returns null for platforms with no row", () => {
    expect(getProviderStrategy("unconfigured-platform")).toBeNull();
  });

  it("lists all platforms that have been written", () => {
    setProviderStrategy("groq", "reliable");
    setProviderStrategy("cerebras", "auto");
    const rows = listProviderStrategies();
    expect(rows).toHaveLength(2);
    const byPlatform = Object.fromEntries(
      rows.map((r) => [r.platform, r.strategy]),
    );
    expect(byPlatform).toEqual({ groq: "reliable", cerebras: "auto" });
  });

  it("returned strategy is always one of the 9 canonical literals", () => {
    const allStrategies: RoutingStrategy[] = [
      "priority",
      "balanced",
      "smartest",
      "iterative_refinement",
      "fastest",
      "reliable",
      "custom",
      "racing",
      "auto",
    ];
    for (const s of allStrategies) {
      setProviderStrategy(`pf-${s}`, s);
      const stored = getProviderStrategy(`pf-${s}`);
      expect(allStrategies.includes(stored as RoutingStrategy)).toBe(true);
    }
  });
});

describe("resolvePlatformStrategy", () => {
  beforeEach(() => {
    initDb(":memory:");
    resetAutoOrchestratorCache();
  });

  it("returns per-platform strategy when row exists (manual override)", () => {
    setRoutingStrategy("balanced");
    setProviderStrategy("groq", "reliable");
    expect(resolvePlatformStrategy("groq")).toBe("reliable");
  });

  it("returns global when no row exists", () => {
    setRoutingStrategy("balanced");
    expect(resolvePlatformStrategy("nim")).toBe("balanced");
  });

  it("returns an Auto arm when per-platform strategy === 'auto'", () => {
    setRoutingStrategy("priority");
    setProviderStrategy("groq", "auto");
    const validArms = new Set<RoutingStrategy>([
      "balanced",
      "smartest",
      "fastest",
      "reliable",
      "racing",
    ]);
    for (let i = 0; i < 20; i++) {
      resetAutoOrchestratorCache();
      const arm = resolvePlatformStrategy("groq");
      expect(validArms.has(arm)).toBe(true);
    }
  });

  it("getRoutingStrategy() is isolated from per-platform rows", () => {
    setRoutingStrategy("balanced");
    setProviderStrategy("groq", "reliable");
    expect(getRoutingStrategy()).toBe("balanced");
  });

  it("setRoutingStrategy() only updates the global setting, not per-platform", () => {
    setProviderStrategy("groq", "reliable");
    setRoutingStrategy("fastest");
    expect(getProviderStrategy("groq")).toBe("reliable");
  });
});
