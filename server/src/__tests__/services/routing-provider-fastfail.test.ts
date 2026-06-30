import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, initDb } from "../../db/index.js";
import * as crypto from "../../lib/crypto.js";
import { classifyError } from "../../services/degradation.js";
import { routeRequest, setRoutingStrategy } from "../../services/router.js";

// Mock crypto to avoid IV errors
vi.mock("../../lib/crypto.js", async () => {
  const actual = await vi.importActual("../../lib/crypto.js");
  return {
    ...actual,
    decrypt: vi.fn(() => "mocked-api-key"),
  };
});

vi.mock("../../services/events.js", () => ({
  publish: vi.fn(),
  publishDeduped: vi.fn(),
  resetEventThrottle: vi.fn(),
}));

const ORIGINAL_DEV_MODE = process.env.DEV_MODE;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function restoreEnv() {
  if (ORIGINAL_DEV_MODE === undefined) delete process.env.DEV_MODE;
  else process.env.DEV_MODE = ORIGINAL_DEV_MODE;
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
}

// ── classifyError integration contract ──────────────────────────────────────

describe("classifyError — fast-fail contract", () => {
  it("503 is major (counts toward fast-fail threshold)", () => {
    expect(
      classifyError({ status: 503, message: "503 service unavailable" }),
    ).toBe("major");
  });

  it("500 is major", () => {
    expect(
      classifyError({ status: 500, message: "internal server error" }),
    ).toBe("major");
  });

  it("429 is minor (does NOT count toward fast-fail)", () => {
    expect(classifyError({ status: 429, message: "rate limit" })).toBe("minor");
  });

  it("402 is minor (does NOT count toward fast-fail)", () => {
    expect(classifyError({ status: 402, message: "payment required" })).toBe(
      "minor",
    );
  });

  it("404 is null (does NOT count toward fast-fail)", () => {
    expect(classifyError({ status: 404, message: "not found" })).toBeNull();
  });

  it("timeout is major (counts toward fast-fail)", () => {
    expect(classifyError(new Error("ETIMEDOUT"))).toBe("major");
    expect(classifyError(new Error("connection timeout"))).toBe("major");
  });
});

// ── Fast-fail skipModels via routeRequest ───────────────────────────────────

describe("Provider-Outage Fast-Fail — skipModels integration", () => {
  let bluesmindsKimiId: number;
  let bluesmindsGlmId: number;
  let cloudflareKimiId: number;

  beforeEach(() => {
    process.env.DEV_MODE = "true";
    process.env.NODE_ENV = "test";
    initDb(":memory:");
    // Wipe seeded catalog so each test controls its own models/keys
    // (same pattern as router-bandit.test.ts).
    getDb().exec(
      "DELETE FROM fallback_config; DELETE FROM api_keys; DELETE FROM models; DELETE FROM requests;",
    );
    setRoutingStrategy("priority");
    const db = getDb();

    // Clear seeded fallback_config entries so only test fixtures are routable
    db.prepare("DELETE FROM fallback_config").run();

    // Provider "bluesminds" with 2 models
    db.prepare(
      "INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('bluesminds', 'kimi-k2.6', 'Kimi K2.6', 1, 1, 1)",
    ).run();
    db.prepare(
      "INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('bluesminds', 'glm-5.1', 'GLM 5.1', 2, 2, 1)",
    ).run();
    // Provider "cloudflare" with 1 model (same kimi-k2.6 model)
    db.prepare(
      "INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('cloudflare', 'kimi-k2.6', 'Kimi K2.6', 1, 1, 1)",
    ).run();

    bluesmindsKimiId = (
      db
        .prepare(
          "SELECT id FROM models WHERE platform = 'bluesminds' AND model_id = 'kimi-k2.6'",
        )
        .get() as any
    ).id;
    bluesmindsGlmId = (
      db
        .prepare(
          "SELECT id FROM models WHERE platform = 'bluesminds' AND model_id = 'glm-5.1'",
        )
        .get() as any
    ).id;
    cloudflareKimiId = (
      db
        .prepare(
          "SELECT id FROM models WHERE platform = 'cloudflare' AND model_id = 'kimi-k2.6'",
        )
        .get() as any
    ).id;

    db.prepare(
      "INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)",
    ).run(bluesmindsKimiId);
    db.prepare(
      "INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 2, 1)",
    ).run(bluesmindsGlmId);
    db.prepare(
      "INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 3, 1)",
    ).run(cloudflareKimiId);

    // Keys for both providers
    db.prepare(
      "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('bluesminds', 'BS Key 1', 'enc', 'iv', 'tag', 'healthy', 1)",
    ).run();
    db.prepare(
      "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('bluesminds', 'BS Key 2', 'enc', 'iv', 'tag', 'healthy', 1)",
    ).run();
    db.prepare(
      "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('cloudflare', 'CF Key 1', 'enc', 'iv', 'tag', 'healthy', 1)",
    ).run();

    vi.clearAllMocks();
    (crypto.decrypt as any).mockReturnValue("mocked-api-key");
  });

  afterEach(() => {
    restoreEnv();
  });

  it("single-model provider in skipModels does NOT trigger fast-fail (threshold not met)", () => {
    // Only cloudflare's kimi is skipped (simulating one 503 on a single-model provider).
    // Bluesminds models should still be available.
    const result = routeRequest(
      100,
      undefined,
      undefined,
      false,
      false,
      new Set([cloudflareKimiId]),
    );
    expect(result.platform).toBe("bluesminds");
  });

  it("all bluesminds models in skipModels routes to cloudflare", () => {
    // Simulating fast-fail: both bluesminds models added to skipModels.
    const skipModels = new Set([bluesmindsKimiId, bluesmindsGlmId]);
    const result = routeRequest(
      100,
      undefined,
      undefined,
      false,
      false,
      skipModels,
    );
    expect(result.platform).toBe("cloudflare");
    expect(result.modelDbId).toBe(cloudflareKimiId);
  });

  it("all models from all providers in skipModels throws", () => {
    const allModels = new Set([
      bluesmindsKimiId,
      bluesmindsGlmId,
      cloudflareKimiId,
    ]);
    expect(() =>
      routeRequest(100, undefined, undefined, false, false, allModels),
    ).toThrow();
  });

  it("skipModels is idempotent — adding already-skipped model is a no-op", () => {
    // Simulating: skipModels already has bluesmindsKimiId from 404, fast-fail adds both.
    const skipModels = new Set<number>([bluesmindsKimiId]);
    skipModels.add(bluesmindsKimiId); // idempotent
    skipModels.add(bluesmindsGlmId);
    const result = routeRequest(
      100,
      undefined,
      undefined,
      false,
      false,
      skipModels,
    );
    expect(result.platform).toBe("cloudflare");
  });

  it("providerFailures map tracks distinct models per platform correctly", () => {
    // Simulating the tracking logic used in proxy.ts fast-fail block
    const providerFailures = new Map<string, Set<number>>();
    const THRESHOLD = 2;

    // First 5xx on bluesminds/kimi
    const failed1 = providerFailures.get("bluesminds") ?? new Set<number>();
    failed1.add(bluesmindsKimiId);
    providerFailures.set("bluesminds", failed1);
    expect(failed1.size).toBe(1);
    expect(failed1.size >= THRESHOLD).toBe(false);

    // Second 5xx on bluesminds/glm — threshold crossed
    const failed2 = providerFailures.get("bluesminds") ?? new Set<number>();
    failed2.add(bluesmindsGlmId);
    providerFailures.set("bluesminds", failed2);
    expect(failed2.size).toBe(2);
    expect(failed2.size >= THRESHOLD).toBe(true);
  });

  it("429 on model A + 503 on model B = only 1 count (only major counts)", () => {
    const providerFailures = new Map<string, Set<number>>();
    const THRESHOLD = 2;

    // 429 on kimi — classifyError returns 'minor', does NOT count
    const tier429 = classifyError({ status: 429, message: "rate limited" });
    expect(tier429).toBe("minor");
    // Minor errors are NOT added to providerFailures

    // 503 on glm — classifyError returns 'major', counts
    const tier503 = classifyError({ status: 503, message: "unavailable" });
    expect(tier503).toBe("major");
    const failed = providerFailures.get("bluesminds") ?? new Set<number>();
    failed.add(bluesmindsGlmId);
    providerFailures.set("bluesminds", failed);

    expect(failed.size).toBe(1);
    expect(failed.size >= THRESHOLD).toBe(false); // Threshold NOT met
  });

  it("fastFired set prevents duplicate events per provider", () => {
    const fastFired = new Set<string>();

    // First trigger
    expect(fastFired.has("bluesminds")).toBe(false);
    fastFired.add("bluesminds");
    expect(fastFired.has("bluesminds")).toBe(true);

    // Second trigger — guarded by fastFired
    expect(fastFired.has("bluesminds")).toBe(true); // Already fired, skip
  });

  it("multiple providers tracked independently", () => {
    const providerFailures = new Map<string, Set<number>>();
    const fastFired = new Set<string>();
    const THRESHOLD = 2;

    // Bluesminds: 1 failure
    const bsFailures = providerFailures.get("bluesminds") ?? new Set<number>();
    bsFailures.add(bluesmindsKimiId);
    providerFailures.set("bluesminds", bsFailures);

    // Cloudflare: 1 failure (but only 1 model, so can never reach threshold=2)
    const cfFailures = providerFailures.get("cloudflare") ?? new Set<number>();
    cfFailures.add(cloudflareKimiId);
    providerFailures.set("cloudflare", cfFailures);

    // Neither has crossed threshold
    expect(bsFailures.size >= THRESHOLD).toBe(false);
    expect(cfFailures.size >= THRESHOLD).toBe(false);

    // Bluesminds crosses threshold
    bsFailures.add(bluesmindsGlmId);
    expect(bsFailures.size >= THRESHOLD).toBe(true);
    fastFired.add("bluesminds");

    // Cloudflare still hasn't (single model, can never reach 2)
    expect(cfFailures.size >= THRESHOLD).toBe(false);
    expect(fastFired.has("cloudflare")).toBe(false);
  });

  it("query for all enabled models on a platform returns correct set", () => {
    const db = getDb();
    const platformModels = db
      .prepare("SELECT id FROM models WHERE platform = ? AND enabled = 1")
      .all("bluesminds") as Array<{ id: number }>;

    const ids = platformModels.map((m) => m.id);
    expect(ids).toContain(bluesmindsKimiId);
    expect(ids).toContain(bluesmindsGlmId);
    expect(ids).not.toContain(cloudflareKimiId);
    expect(ids.length).toBeGreaterThanOrEqual(2);
  });

  it("threshold=0 disables fast-fail (guard short-circuits)", () => {
    const THRESHOLD = 0;
    const providerFailures = new Map<string, Set<number>>();

    // Simulate the guard: if (THRESHOLD > 0 && ...)
    if (THRESHOLD > 0) {
      // This block should never execute when threshold is 0
      const failed = providerFailures.get("bluesminds") ?? new Set<number>();
      failed.add(bluesmindsKimiId);
      providerFailures.set("bluesminds", failed);
    }

    expect(providerFailures.size).toBe(0); // No tracking happened
  });
});
