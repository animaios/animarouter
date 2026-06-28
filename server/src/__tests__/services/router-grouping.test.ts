import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, initDb, setSetting } from "../../db/index.js";
import * as crypto from "../../lib/crypto.js";
import { initDegradation, recordFailure } from "../../services/degradation.js";
import {
  getRoutingScores,
  getRoutingStrategy,
  refreshStatsCache,
  routeRequest,
  setRoutingStrategy,
} from "../../services/router.js";

vi.mock("../../lib/crypto.js", async () => {
  const actual = await vi.importActual("../../lib/crypto.js");
  return { ...actual, decrypt: vi.fn(() => "mocked-api-key") };
});

const ORIGINAL_DEV_MODE = process.env.DEV_MODE;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

// Helpers — model + key + fallback_config setup
function addModel(opts: {
  platform: string;
  modelId: string;
  name: string;
  intelligenceRank: number;
  speedRank?: number;
  sizeLabel: string;
  budget: string;
  priority: number;
}): number {
  const db = getDb();
  db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, monthly_token_budget, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    opts.platform,
    opts.modelId,
    opts.name,
    opts.intelligenceRank,
    opts.speedRank ?? 1,
    opts.sizeLabel,
    opts.budget,
  );
  const id = (
    db
      .prepare("SELECT id FROM models WHERE platform = ? AND model_id = ?")
      .get(opts.platform, opts.modelId) as { id: number }
  ).id;
  db.prepare(
    "INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)",
  ).run(id, opts.priority);
  db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'k', 'enc', 'iv', 'tag', 'healthy', 1)
  `).run(opts.platform);
  return id;
}

function addHistory(
  platform: string,
  modelId: string,
  opts: {
    successes: number;
    failures: number;
    outTokens?: number;
    latencyMs?: number;
    ttfbMs?: number | null;
  },
) {
  const db = getDb();
  const ins = db.prepare(`
    INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, ttfb_ms)
    VALUES (?, ?, 1, ?, 0, ?, ?, ?, ?)
  `);
  for (let i = 0; i < opts.successes; i++) {
    ins.run(
      platform,
      modelId,
      "success",
      opts.outTokens ?? 100,
      opts.latencyMs ?? 1000,
      null,
      opts.ttfbMs ?? null,
    );
  }
  for (let i = 0; i < opts.failures; i++) {
    ins.run(
      platform,
      modelId,
      "error",
      0,
      opts.latencyMs ?? 1000,
      "boom",
      opts.ttfbMs ?? null,
    );
  }
}

// Create a model_groups row + bind models and fallback_config to it.
function addGroup(opts: {
  groupKey: string;
  displayName: string;
  intelligenceRank: number;
  sizeLabel: string;
  benchmarkScore?: number | null;
  contextWindow?: number | null;
  supportsVision?: boolean;
  supportsTools?: boolean;
  maxOutputTokens?: number | null;
  priority: number;
  // Provider entries: each has platform, model_id, display_name, speed_rank
  providers: Array<{
    platform: string;
    modelId: string;
    name: string;
    speedRank: number;
    intelligenceRank?: number;
    sizeLabel?: string;
    useProxy?: boolean;
  }>;
}): number {
  const db = getDb();

  // Create the group
  db.prepare(`
    INSERT INTO model_groups (group_key, display_name, intelligence_rank, size_label, benchmark_score,
      context_window, max_output_tokens, supports_vision, supports_tools, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    opts.groupKey,
    opts.displayName,
    opts.intelligenceRank,
    opts.sizeLabel,
    opts.benchmarkScore ?? null,
    opts.contextWindow ?? null,
    opts.maxOutputTokens ?? null,
    opts.supportsVision ? 1 : 0,
    opts.supportsTools ? 1 : 0,
  );
  const groupId = (
    db
      .prepare("SELECT id FROM model_groups WHERE group_key = ?")
      .get(opts.groupKey) as { id: number }
  ).id;

  // Create provider models + bind them to the group
  const modelIds: number[] = [];
  for (const p of opts.providers) {
    db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
        monthly_token_budget, enabled, group_id)
      VALUES (?, ?, ?, ?, ?, ?, '', 1, ?)
    `).run(
      p.platform,
      p.modelId,
      p.name,
      p.intelligenceRank ?? opts.intelligenceRank,
      p.speedRank,
      p.sizeLabel ?? opts.sizeLabel,
      groupId,
    );
    const mId = (
      db
        .prepare("SELECT id FROM models WHERE platform = ? AND model_id = ?")
        .get(p.platform, p.modelId) as { id: number }
    ).id;
    modelIds.push(mId);

    // Ensure key for the platform
    const hasKey = db
      .prepare(
        "SELECT id FROM api_keys WHERE platform = ? AND enabled = 1 LIMIT 1",
      )
      .get(p.platform) as { id: number } | undefined;
    if (!hasKey) {
      db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, use_proxy)
        VALUES (?, 'k', 'enc', 'iv', 'tag', 'healthy', 1, ?)
      `).run(p.platform, p.useProxy ? 1 : 0);
    } else if (p.useProxy !== undefined) {
      db.prepare("UPDATE api_keys SET use_proxy = ? WHERE id = ?").run(
        p.useProxy ? 1 : 0,
        hasKey.id,
      );
    }

    // Ensure custom_providers entry for this platform slug
    const hasProvider = db
      .prepare("SELECT id FROM custom_providers WHERE slug = ?")
      .get(p.platform);
    if (!hasProvider) {
      db.prepare(`
        INSERT INTO custom_providers (slug, display_name, base_url)
        VALUES (?, ?, ?)
      `).run(p.platform, p.name, `https://${p.platform}.example.com/v1`);
    }
  }

  // Create fallback_config entry for the group — uses the first provider’s model_db_id
  // (required NOT NULL column) and sets group_id. Only ONE entry per group.
  db.prepare(
    "INSERT INTO fallback_config (model_db_id, priority, group_id, enabled) VALUES (?, ?, ?, 1)",
  ).run(modelIds[0], opts.priority, groupId);

  // Disable any old per-model fallback entries for these models
  // (they came from initDb seed); clean up so only group entries remain.
  for (const mId of modelIds) {
    db.prepare(
      "UPDATE fallback_config SET enabled = 0 WHERE model_db_id = ? AND group_id IS NULL",
    ).run(mId);
  }

  return groupId;
}

function pickCounts(runs: number): Record<string, number> {
  const counts: Record<string, number> = {};
  for (let i = 0; i < runs; i++) {
    const r = routeRequest(100);
    counts[r.modelId] = (counts[r.modelId] ?? 0) + 1;
  }
  return counts;
}

describe("group-aware routing", () => {
  beforeEach(() => {
    process.env.DEV_MODE = "true";
    process.env.NODE_ENV = "test";
    initDb(":memory:");
    // Wipe seeded data so each test owns its models/keys/fallback chain
    getDb().exec(
      "DELETE FROM fallback_config; DELETE FROM api_keys; DELETE FROM models; DELETE FROM requests; DELETE FROM model_groups; DELETE FROM custom_providers;",
    );
    vi.clearAllMocks();
    (crypto.decrypt as any).mockReturnValue("mocked-api-key");
    initDegradation();
    // Feature flag OFF by default — grouping tests explicitly enable it
    setSetting("model_grouping_enabled", "false");
  });

  afterEach(() => {
    if (ORIGINAL_DEV_MODE === undefined) delete process.env.DEV_MODE;
    else process.env.DEV_MODE = ORIGINAL_DEV_MODE;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  // ── Feature-flag guard ──────────────────────────────────────────────────

  it("when grouping is off, router uses the classic model_db_id chain", () => {
    addModel({
      platform: "google",
      modelId: "gemini",
      name: "Gemini",
      intelligenceRank: 1,
      sizeLabel: "Frontier",
      budget: "~10M",
      priority: 1,
    });
    setRoutingStrategy("priority");
    refreshStatsCache(getDb(), true);
    const r = routeRequest(100);
    expect(r.modelId).toBe("gemini");
    expect(r.platform).toBe("google");
  });

  it('when grouping is on but no groups configured, throws "all models exhausted"', () => {
    // Add a model in the classic way (no group attached)
    addModel({
      platform: "google",
      modelId: "gemini",
      name: "Gemini",
      intelligenceRank: 1,
      sizeLabel: "Frontier",
      budget: "~10M",
      priority: 1,
    });
    setSetting("model_grouping_enabled", "true");
    setRoutingStrategy("priority");
    refreshStatsCache(getDb(), true);
    // The grouped path only queries fallback_config JOIN model_groups,
    // so a model with no group will be invisible → exhaustion
    expect(() => routeRequest(100)).toThrow(/exhausted/i);
  });

  // ── Single-group routing ───────────────────────────────────────────────

  it("routes to a provider within a single group (priority mode)", () => {
    addGroup({
      groupKey: "gpt-4o",
      displayName: "GPT-4o",
      intelligenceRank: 1,
      sizeLabel: "Frontier",
      priority: 1,
      providers: [
        {
          platform: "nim",
          modelId: "nim/gpt-4o",
          name: "GPT-4o (NIM)",
          speedRank: 5,
        },
        {
          platform: "zen",
          modelId: "zen/gpt-4o",
          name: "GPT-4o (Zen)",
          speedRank: 10,
        },
      ],
    });
    setSetting("model_grouping_enabled", "true");
    setRoutingStrategy("priority");
    refreshStatsCache(getDb(), true);
    // Should successfully route — provider is picked, keys exist
    const r = routeRequest(100);
    expect(r.modelId).toMatch(/gpt-4o/);
  });

  it("routes to a provider within a single group (balanced mode)", () => {
    addGroup({
      groupKey: "deepseek-v4-flash",
      displayName: "DeepSeek V4 Flash",
      intelligenceRank: 3,
      sizeLabel: "Large",
      priority: 1,
      providers: [
        {
          platform: "nim",
          modelId: "nim/dsv4f",
          name: "DSV4F (NIM)",
          speedRank: 3,
        },
        {
          platform: "zen",
          modelId: "zen/dsv4f",
          name: "DSV4F (Zen)",
          speedRank: 8,
        },
      ],
    });
    setSetting("model_grouping_enabled", "true");
    setRoutingStrategy("balanced");
    refreshStatsCache(getDb(), true);
    const r = routeRequest(100);
    expect(r.modelId).toMatch(/dsv4f/);
  });

  it("propagates per-key proxy transport from grouped routing", () => {
    addGroup({
      groupKey: "proxied-group",
      displayName: "Proxied Group",
      intelligenceRank: 2,
      sizeLabel: "Large",
      priority: 1,
      providers: [
        {
          platform: "proxied-provider",
          modelId: "proxied/model",
          name: "Proxied",
          speedRank: 1,
          useProxy: true,
        },
      ],
    });
    setSetting("model_grouping_enabled", "true");
    setRoutingStrategy("priority");
    refreshStatsCache(getDb(), true);

    const r = routeRequest(100);
    expect(r.useProxy).toBe(true);
    expect(r.transportId).toBe("cloudflare-worker");
  });

  // ── Multi-group fallback ────────────────────────────────────────────────

  it("falls through to the next group when all providers in first group are exhausted", () => {
    const db = getDb();
    // Group 1: smart model with no keys
    addGroup({
      groupKey: "smart-model",
      displayName: "Smart Model",
      intelligenceRank: 1,
      sizeLabel: "Frontier",
      priority: 1,
      providers: [
        {
          platform: "smart-provider",
          modelId: "smart/m1",
          name: "M1",
          speedRank: 1,
        },
      ],
    });
    // Remove keys for smart-provider
    db.prepare("DELETE FROM api_keys WHERE platform = ?").run("smart-provider");

    // Group 2: backup model with keys
    addGroup({
      groupKey: "backup-model",
      displayName: "Backup Model",
      intelligenceRank: 5,
      sizeLabel: "Medium",
      priority: 2,
      providers: [
        {
          platform: "backup-provider",
          modelId: "backup/m2",
          name: "M2",
          speedRank: 5,
        },
      ],
    });

    setSetting("model_grouping_enabled", "true");
    setRoutingStrategy("priority");
    refreshStatsCache(getDb(), true);
    const r = routeRequest(100);
    expect(r.modelId).toBe("backup/m2");
    expect(r.platform).toBe("backup-provider");
  });

  it("preferredGroupId + pinMode falls through from an unavailable provider to a healthy provider in the pinned group", () => {
    const db = getDb();
    const groupId = addGroup({
      groupKey: "pinned-group",
      displayName: "Pinned Group",
      intelligenceRank: 1,
      sizeLabel: "Frontier",
      priority: 1,
      providers: [
        {
          platform: "pinned-provider-a",
          modelId: "a/pinned",
          name: "Pinned A",
          speedRank: 1,
        },
        {
          platform: "pinned-provider-b",
          modelId: "b/pinned",
          name: "Pinned B",
          speedRank: 10,
        },
      ],
    });
    db.prepare("DELETE FROM api_keys WHERE platform = ?").run(
      "pinned-provider-a",
    );

    addGroup({
      groupKey: "backup-group",
      displayName: "Backup Group",
      intelligenceRank: 5,
      sizeLabel: "Medium",
      priority: 2,
      providers: [
        {
          platform: "backup-provider",
          modelId: "backup/pinned",
          name: "Backup",
          speedRank: 1,
        },
      ],
    });

    setSetting("model_grouping_enabled", "true");
    setRoutingStrategy("priority");
    refreshStatsCache(getDb(), true);
    const r = routeRequest(100, undefined, undefined, false, false, undefined, {
      pinMode: true,
      preferredGroupId: groupId,
    });
    expect(r.platform).toBe("pinned-provider-b");
    expect(r.modelId).toBe("b/pinned");
    expect(r.groupId).toBe(groupId);
  });

  it("preferredGroupId + pinMode throws when every provider in the pinned group is unavailable", () => {
    const db = getDb();
    const groupId = addGroup({
      groupKey: "dead-pinned-group",
      displayName: "Dead Pinned Group",
      intelligenceRank: 1,
      sizeLabel: "Frontier",
      priority: 1,
      providers: [
        {
          platform: "dead-provider-a",
          modelId: "a/dead",
          name: "Dead A",
          speedRank: 1,
        },
        {
          platform: "dead-provider-b",
          modelId: "b/dead",
          name: "Dead B",
          speedRank: 10,
        },
      ],
    });
    db.prepare(
      "DELETE FROM api_keys WHERE platform IN ('dead-provider-a', 'dead-provider-b')",
    ).run();

    addGroup({
      groupKey: "healthy-backup-group",
      displayName: "Healthy Backup Group",
      intelligenceRank: 5,
      sizeLabel: "Medium",
      priority: 2,
      providers: [
        {
          platform: "healthy-backup-provider",
          modelId: "backup/healthy",
          name: "Healthy Backup",
          speedRank: 1,
        },
      ],
    });

    setSetting("model_grouping_enabled", "true");
    setRoutingStrategy("priority");
    refreshStatsCache(getDb(), true);
    expect(() =>
      routeRequest(100, undefined, undefined, false, false, undefined, {
        pinMode: true,
        preferredGroupId: groupId,
      }),
    ).toThrow(/Pinned model exhausted|exhausted/i);
  });

  it("preferredGroupId + pinMode does not fall through when the pinned group fails request filters", () => {
    const groupId = addGroup({
      groupKey: "pinned-no-tools",
      displayName: "Pinned No Tools",
      intelligenceRank: 1,
      sizeLabel: "Frontier",
      priority: 1,
      supportsTools: false,
      providers: [
        {
          platform: "pinned-no-tools-provider",
          modelId: "pinned/no-tools",
          name: "No Tools",
          speedRank: 1,
        },
      ],
    });

    addGroup({
      groupKey: "backup-tools",
      displayName: "Backup Tools",
      intelligenceRank: 5,
      sizeLabel: "Medium",
      priority: 2,
      supportsTools: true,
      providers: [
        {
          platform: "backup-tools-provider",
          modelId: "backup/tools",
          name: "Tools",
          speedRank: 1,
        },
      ],
    });

    setSetting("model_grouping_enabled", "true");
    setRoutingStrategy("priority");
    refreshStatsCache(getDb(), true);

    expect(() =>
      routeRequest(100, undefined, undefined, false, true, undefined, {
        pinMode: true,
        preferredGroupId: groupId,
      }),
    ).toThrow(/Pinned model exhausted|exhausted/i);
  });

  it("applies degradation when ranking providers within a group", () => {
    const db = getDb();
    addGroup({
      groupKey: "degraded-provider-group",
      displayName: "Degraded Provider Group",
      intelligenceRank: 1,
      sizeLabel: "Large",
      priority: 1,
      providers: [
        {
          platform: "degraded-fast-provider",
          modelId: "provider/fast",
          name: "Fast Degraded",
          speedRank: 1,
        },
        {
          platform: "healthy-slow-provider",
          modelId: "provider/slow",
          name: "Slow Healthy",
          speedRank: 100,
        },
      ],
    });

    const degradedModel = db
      .prepare(`
      SELECT id FROM models WHERE platform = ? AND model_id = ?
    `)
      .get("degraded-fast-provider", "provider/fast") as { id: number };

    setSetting("model_grouping_enabled", "true");
    setRoutingStrategy("fastest");
    getRoutingStrategy(); // Ensure the router-owned degradation engine is initialized before recording failures.
    for (let i = 0; i < 5; i++) recordFailure(degradedModel.id, "major");
    refreshStatsCache(getDb(), true);

    const r = routeRequest(100);
    expect(r.platform).toBe("healthy-slow-provider");
    expect(r.modelId).toBe("provider/slow");
  });

  // ── Vision / tools / context filters respect group-level properties ─────

  it("skips a non-vision group when requireVision is set", () => {
    const db = getDb();
    addGroup({
      groupKey: "text-only",
      displayName: "Text Only",
      intelligenceRank: 1,
      sizeLabel: "Frontier",
      priority: 1,
      supportsVision: false,
      providers: [
        { platform: "prov-a", modelId: "a/text", name: "Text", speedRank: 1 },
      ],
    });
    addGroup({
      groupKey: "vision-model",
      displayName: "Vision Model",
      intelligenceRank: 3,
      sizeLabel: "Large",
      priority: 2,
      supportsVision: true,
      providers: [
        {
          platform: "prov-b",
          modelId: "b/vision",
          name: "Vision",
          speedRank: 5,
        },
      ],
    });
    setSetting("model_grouping_enabled", "true");
    setRoutingStrategy("priority");
    refreshStatsCache(getDb(), true);
    const r = routeRequest(100, undefined, undefined, true); // requireVision=true
    expect(r.modelId).toBe("b/vision");
  });

  it("skips a non-tools group when requireTools is set", () => {
    addGroup({
      groupKey: "no-tools",
      displayName: "No Tools",
      intelligenceRank: 1,
      sizeLabel: "Frontier",
      priority: 1,
      supportsTools: false,
      providers: [
        {
          platform: "prov-a",
          modelId: "a/notools",
          name: "NoTools",
          speedRank: 1,
        },
      ],
    });
    addGroup({
      groupKey: "tools-model",
      displayName: "Tools Model",
      intelligenceRank: 3,
      sizeLabel: "Large",
      priority: 2,
      supportsTools: true,
      providers: [
        { platform: "prov-b", modelId: "b/tools", name: "Tools", speedRank: 5 },
      ],
    });
    setSetting("model_grouping_enabled", "true");
    setRoutingStrategy("priority");
    refreshStatsCache(getDb(), true);
    const r = routeRequest(100, undefined, undefined, false, true); // requireTools=true
    expect(r.modelId).toBe("b/tools");
  });

  it("skips a group whose context_window is too small", () => {
    addGroup({
      groupKey: "small-ctx",
      displayName: "Small Context",
      intelligenceRank: 1,
      sizeLabel: "Frontier",
      priority: 1,
      contextWindow: 1000,
      providers: [
        { platform: "prov-a", modelId: "a/small", name: "Small", speedRank: 1 },
      ],
    });
    addGroup({
      groupKey: "big-ctx",
      displayName: "Big Context",
      intelligenceRank: 3,
      sizeLabel: "Large",
      priority: 2,
      contextWindow: 100000,
      providers: [
        { platform: "prov-b", modelId: "b/big", name: "Big", speedRank: 5 },
      ],
    });
    setSetting("model_grouping_enabled", "true");
    setRoutingStrategy("priority");
    refreshStatsCache(getDb(), true);
    const r = routeRequest(5000); // 5000 tokens > 1000 context
    expect(r.modelId).toBe("b/big");
  });

  // ── getRoutingScores with grouping ──────────────────────────────────────

  it("getRoutingScores returns groupedScores when grouping is on", () => {
    addGroup({
      groupKey: "deepseek-v4-flash",
      displayName: "DeepSeek V4 Flash",
      intelligenceRank: 3,
      sizeLabel: "Large",
      priority: 1,
      providers: [
        {
          platform: "nim",
          modelId: "nim/dsv4f",
          name: "DSV4F (NIM)",
          speedRank: 3,
        },
        {
          platform: "zen",
          modelId: "zen/dsv4f",
          name: "DSV4F (Zen)",
          speedRank: 8,
        },
      ],
    });
    setSetting("model_grouping_enabled", "true");
    setRoutingStrategy("balanced");
    refreshStatsCache(getDb(), true);

    const result = getRoutingScores();
    expect(result.groupedScores).toBeDefined();
    expect(result.groupedScores!.length).toBeGreaterThan(0);

    const g = result.groupedScores![0];
    expect(g.groupKey).toBe("deepseek-v4-flash");
    expect(g.groupId).toBeGreaterThan(0);
    expect(g.groupScore).toBeGreaterThanOrEqual(0);
    expect(g.providers.length).toBe(2);
    // Providers should be sorted by sub-score (descending)
    if (g.providers.length >= 2) {
      expect(g.providers[0].subScore).toBeGreaterThanOrEqual(
        g.providers[1].subScore,
      );
    }
  });

  it("getRoutingScores omits groupedScores when grouping is off", () => {
    addModel({
      platform: "google",
      modelId: "m1",
      name: "M1",
      intelligenceRank: 3,
      sizeLabel: "Large",
      budget: "~50M",
      priority: 1,
    });
    setRoutingStrategy("balanced");
    refreshStatsCache(getDb(), true);
    const result = getRoutingScores();
    // groupedScores should be undefined (not set) when grouping is off
    expect(result.groupedScores).toBeUndefined();
  });

  // ── Disabled groups are skipped ─────────────────────────────────────────

  it("disabled groups are skipped in the fallback chain", () => {
    const db = getDb();
    addGroup({
      groupKey: "disabled-group",
      displayName: "Disabled",
      intelligenceRank: 1,
      sizeLabel: "Frontier",
      priority: 1,
      providers: [
        { platform: "prov-a", modelId: "a/dis", name: "Dis", speedRank: 1 },
      ],
    });
    // Disable the group
    db.prepare("UPDATE model_groups SET enabled = 0 WHERE group_key = ?").run(
      "disabled-group",
    );

    addGroup({
      groupKey: "active-group",
      displayName: "Active",
      intelligenceRank: 5,
      sizeLabel: "Medium",
      priority: 2,
      providers: [
        { platform: "prov-b", modelId: "b/act", name: "Act", speedRank: 5 },
      ],
    });
    setSetting("model_grouping_enabled", "true");
    setRoutingStrategy("priority");
    refreshStatsCache(getDb(), true);
    const r = routeRequest(100);
    expect(r.modelId).toBe("b/act");
  });

  // ── Disabled providers within a group are skipped ───────────────────────

  it("disabled providers within a group are skipped", () => {
    const db = getDb();
    addGroup({
      groupKey: "test-group",
      displayName: "Test",
      intelligenceRank: 1,
      sizeLabel: "Frontier",
      priority: 1,
      providers: [
        { platform: "prov-a", modelId: "a/m", name: "AM", speedRank: 1 },
        { platform: "prov-b", modelId: "b/m", name: "BM", speedRank: 5 },
      ],
    });
    // Disable provider A
    db.prepare(
      "UPDATE models SET enabled = 0 WHERE platform = 'prov-a' AND model_id = 'a/m'",
    ).run();

    setSetting("model_grouping_enabled", "true");
    setRoutingStrategy("priority");
    refreshStatsCache(getDb(), true);
    const r = routeRequest(100);
    expect(r.platform).toBe("prov-b");
  });

  // ── Bandit strategy sorts groups by representative score ────────────────

  it("smartest strategy sorts groups by representative score when provider sub-scores are equal", () => {
    // Frontier group (smarter) should beat Medium group even if Medium has priority=1
    addGroup({
      groupKey: "medium-group",
      displayName: "Medium",
      intelligenceRank: 8,
      sizeLabel: "Medium",
      priority: 1,
      providers: [
        { platform: "prov-a", modelId: "a/med", name: "Med", speedRank: 10 },
      ],
    });
    addGroup({
      groupKey: "frontier-group",
      displayName: "Frontier",
      intelligenceRank: 1,
      sizeLabel: "Frontier",
      priority: 2,
      providers: [
        {
          platform: "prov-b",
          modelId: "b/front",
          name: "Front",
          speedRank: 10,
        },
      ],
    });
    setSetting("model_grouping_enabled", "true");
    setRoutingStrategy("smartest"); // Heavy intelligence weight
    refreshStatsCache(getDb(), true);
    const r = routeRequest(100);
    expect(r.modelId).toBe("b/front");
  });

  it("weighted scores rank each model group as one slot using provider sub-scores", () => {
    addGroup({
      groupKey: "slow-group",
      displayName: "Slow Group",
      intelligenceRank: 5,
      sizeLabel: "Large",
      priority: 1,
      providers: [
        {
          platform: "slow-provider",
          modelId: "slow/model",
          name: "Slow Model",
          speedRank: 90,
        },
      ],
    });
    addGroup({
      groupKey: "fast-group",
      displayName: "Fast Group",
      intelligenceRank: 5,
      sizeLabel: "Large",
      priority: 2,
      providers: [
        {
          platform: "fast-provider",
          modelId: "fast/model",
          name: "Fast Model",
          speedRank: 1,
        },
      ],
    });

    setSetting("model_grouping_enabled", "true");
    setRoutingStrategy("fastest");
    refreshStatsCache(getDb(), true);

    const scores = getRoutingScores().groupedScores ?? [];
    expect(scores.map((score) => score.groupKey)).toEqual([
      "fast-group",
      "slow-group",
    ]);
    expect(scores[0].providers).toHaveLength(1);
    expect(scores[1].providers).toHaveLength(1);
  });
});
