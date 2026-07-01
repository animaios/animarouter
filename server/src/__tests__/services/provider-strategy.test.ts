import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { initDb } from "../../db/index.js";
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
