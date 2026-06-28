/**
 * Integration tests for Provider Health Heartbeat (Per-Key Edition).
 *
 * Each test re-imports modules in isolation to avoid cross-test contamination
 * from module-level cached config and state.
 */

import type { Express } from "express";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createApp } from "../../app.js";
import { getDb, initDb, setSetting } from "../../db/index.js";
import { mintDashboardToken } from "../helpers/auth.js";

describe("Provider Health Heartbeat", () => {
  let chatCompletion: ReturnType<typeof vi.fn>;
  let publishedEvents: any[];
  let recordActivity: () => void;
  let startHeartbeat: () => void;
  let stopHeartbeat: () => void;
  let initDb: (path?: string) => any;
  let getDb: () => any;
  let setSetting: (key: string, value: string) => void;
  let getSetting: (key: string) => string | undefined;
  let getPenalty: (modelDbId: number) => number;
  let recordFailure: (modelDbId: number, tier: "minor" | "major") => void;
  let initDegradation: () => void;
  let getKeyHealth: (keyId: number, modelId?: string) => any;
  let isKeyHealthy: (keyId: number, modelId?: string) => boolean;
  let resetHeartbeatConfig: () => void;
  let markKeyUnhealthy: (
    keyId: number,
    modelId: string,
    error?: string,
    transient?: boolean,
    recheckDelayMs?: number,
  ) => void;
  let pokeKey: (keyId: number) => Promise<boolean>;
  let pokeAllKeys: () => Promise<{ poked: number; skipped: boolean }>;
  let getPendingRechecks: () => ReadonlyMap<
    string,
    { keyId: number; modelId: string; attempt: number }
  >;
  let healthKey: (keyId: number, modelId: string) => string;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 6, 1, 12, 0, 0));
    process.env.ENCRYPTION_KEY = "0".repeat(64);

    // Setup provider mock
    chatCompletion = vi.fn();
    const fakeProvider = { name: "fake", chatCompletion } as any;

    vi.doMock("../../providers/index.js", async (importOriginal) => {
      const actual = (await importOriginal()) as any;
      return { ...actual, buildProviderFor: () => fakeProvider };
    });

    publishedEvents = [];
    vi.doMock("../../services/events.js", () => ({
      publish: vi.fn((evt: any) => publishedEvents.push(evt)),
      publishDeduped: vi.fn((evt: any) => publishedEvents.push(evt)),
      resetEventThrottle: vi.fn(),
    }));

    vi.doMock("../../lib/crypto.js", async (importOriginal) => {
      const actual = (await importOriginal()) as any;
      return { ...actual, decrypt: vi.fn(() => "mocked-api-key") };
    });

    // Import fresh modules
    const heartbeatModule = await import("../../services/heartbeat.js");
    const dbModule = await import("../../db/index.js");
    const degradationModule = await import("../../services/degradation.js");

    recordActivity = heartbeatModule.recordActivity;
    startHeartbeat = heartbeatModule.startHeartbeat;
    stopHeartbeat = heartbeatModule.stopHeartbeat;
    getKeyHealth = heartbeatModule.getKeyHealth;
    isKeyHealthy = heartbeatModule.isKeyHealthy;
    resetHeartbeatConfig = heartbeatModule.resetHeartbeatConfig;
    markKeyUnhealthy = heartbeatModule.markKeyUnhealthy;
    pokeKey = heartbeatModule.pokeKey;
    pokeAllKeys = heartbeatModule.pokeAllKeys;
    getPendingRechecks = heartbeatModule.getPendingRechecks;
    healthKey = heartbeatModule.healthKey;
    initDb = dbModule.initDb;
    getDb = dbModule.getDb;
    setSetting = dbModule.setSetting;
    getSetting = dbModule.getSetting;
    getPenalty = degradationModule.getPenalty;
    recordFailure = degradationModule.recordFailure;
    initDegradation = degradationModule.initDegradation;

    initDb(":memory:");
    initDegradation();

    // Enable heartbeat via DB setting
    setSetting("heartbeat_enabled", "true");
    setSetting("heartbeat_interval_min", "10");
    setSetting("heartbeat_activity_window_min", "15");
    setSetting("heartbeat_stagger_ms", "0"); // No stagger in tests to avoid timing issues
    setSetting("heartbeat_exhausted_recheck_sec", "90");
    setSetting("heartbeat_exhausted_max_rechecks", "3");
  });

  afterEach(() => {
    stopHeartbeat();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setupProvider(platform = "testprov", modelId = "test-model") {
    const db = getDb();
    db.prepare("DELETE FROM fallback_config").run();
    db.prepare(
      `INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('${platform}', '${modelId}', 'Test Model', 1, 1, 1)`,
    ).run();
    const id = (
      db
        .prepare(
          `SELECT id FROM models WHERE platform = '${platform}' AND model_id = '${modelId}'`,
        )
        .get() as any
    ).id;
    db.prepare(
      "INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)",
    ).run(id);
    db.prepare(
      `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('${platform}', 'Key 1', 'enc', 'iv', 'tag', 'healthy', 1)`,
    ).run();
    const keyRow = db
      .prepare("SELECT id FROM api_keys WHERE platform = ? AND enabled = 1")
      .get(platform) as any;
    return { modelDbId: id, keyId: keyRow.id, modelId };
  }

  // ── Activity Gating ────────────────────────────────────────────────────

  describe("Activity gating", () => {
    it("cycle is skipped when no activity has ever occurred", async () => {
      startHeartbeat();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

      const skipEvents = publishedEvents.filter(
        (e) => e.type === "heartbeat.cycle_skipped",
      );
      expect(skipEvents.length).toBeGreaterThanOrEqual(1);
      expect(skipEvents[0].reason).toBe("activity_gate");
      expect(skipEvents[0].lastActivityAgeMs).toBe(-1);
    });

    it("cycle is skipped when last activity is older than the activity window", async () => {
      recordActivity();
      // Advance past the activity window (15 min)
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);

      startHeartbeat();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

      const skipEvents = publishedEvents.filter(
        (e) => e.type === "heartbeat.cycle_skipped",
      );
      expect(skipEvents.length).toBeGreaterThanOrEqual(1);
      expect(skipEvents[0].reason).toBe("activity_gate");
      expect(skipEvents[0].lastActivityAgeMs).toBeGreaterThan(15 * 60 * 1000);
    });

    it("cycle proceeds when activity is recent", async () => {
      setupProvider();
      // Use mockResolvedValue (not Once) so both warmup and interval cycles
      // get a successful response.
      chatCompletion.mockResolvedValue({
        choices: [{ message: { role: "assistant", content: "hi" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      recordActivity();
      startHeartbeat();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

      const pingEvents = publishedEvents.filter(
        (e) => e.type === "heartbeat.ping",
      );
      expect(pingEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Ping Classification ─────────────────────────────────────────────────

  describe("Ping success/failure classification", () => {
    it("successful ping records success and reduces degradation penalty", async () => {
      const { modelDbId, keyId } = setupProvider();

      // Add some penalty first
      recordFailure(modelDbId, "major");
      const penaltyBefore = getPenalty(modelDbId);
      expect(penaltyBefore).toBeGreaterThan(0);

      // Use mockResolvedValue (not Once) so both the warmup and interval cycles
      // get a successful response. The warmup fires immediately on startHeartbeat().
      chatCompletion.mockResolvedValue({
        choices: [{ message: { role: "assistant", content: "pong" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      recordActivity();
      startHeartbeat();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

      const pingEvents = publishedEvents.filter(
        (e) => e.type === "heartbeat.ping",
      );
      expect(pingEvents.length).toBeGreaterThanOrEqual(1);
      expect(pingEvents[0].success).toBe(true);
      expect(pingEvents[0].provider).toBe("testprov");
      expect(pingEvents[0].keyId).toBe(keyId);
      expect(pingEvents[0].latencyMs).toBeGreaterThanOrEqual(0);

      // Penalty should have decreased
      expect(getPenalty(modelDbId)).toBeLessThan(penaltyBefore);

      // Per-key+model health should be healthy
      expect(isKeyHealthy(keyId, "test-model")).toBe(true);
    });

    it("failed ping (5xx) records major failure and increases penalty", async () => {
      const { modelDbId, keyId } = setupProvider();

      // Use mockRejectedValue (not Once) so both warmup and interval cycles
      // consistently get a failure response.
      chatCompletion.mockRejectedValue(new Error("503 Service Unavailable"));

      recordActivity();
      startHeartbeat();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

      const pingEvents = publishedEvents.filter(
        (e) => e.type === "heartbeat.ping",
      );
      expect(pingEvents.length).toBeGreaterThanOrEqual(1);
      expect(pingEvents[0].success).toBe(false);
      expect(pingEvents[0].keyId).toBe(keyId);
      expect(pingEvents[0].error).toBeDefined();

      expect(getPenalty(modelDbId)).toBeGreaterThan(0);

      // Per-key+model health should be unhealthy
      expect(isKeyHealthy(keyId, "test-model")).toBe(false);
      const health = getKeyHealth(keyId, "test-model");
      expect(health).toBeDefined();
      expect(health.penalty).toBeGreaterThan(0);
    });

    it("failed ping (429) records minor failure", async () => {
      const { modelDbId, keyId } = setupProvider();

      chatCompletion.mockRejectedValue(new Error("429 Rate limited"));

      recordActivity();
      startHeartbeat();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

      const pingEvents = publishedEvents.filter(
        (e) => e.type === "heartbeat.ping",
      );
      expect(pingEvents.length).toBeGreaterThanOrEqual(1);
      expect(pingEvents[0].success).toBe(false);
      expect(pingEvents[0].keyId).toBe(keyId);

      expect(getPenalty(modelDbId)).toBeGreaterThan(0);
      expect(isKeyHealthy(keyId, "test-model")).toBe(false);
    });

    it("non-retryable error (401) does NOT penalize the model but marks key unhealthy", async () => {
      const { modelDbId, keyId } = setupProvider();

      chatCompletion.mockRejectedValue(new Error("401 Unauthorized"));

      recordActivity();
      startHeartbeat();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

      const pingEvents = publishedEvents.filter(
        (e) => e.type === "heartbeat.ping",
      );
      expect(pingEvents.length).toBeGreaterThanOrEqual(1);
      expect(pingEvents[0].success).toBe(false);

      // Non-retryable errors don't penalize model-level degradation
      expect(getPenalty(modelDbId)).toBe(0);

      // But the key is still marked unhealthy for this model
      expect(isKeyHealthy(keyId, "test-model")).toBe(false);
    });
  });

  // ── Cold Key Handling ──────────────────────────────────────────────────

  describe("Cold key handling", () => {
    it("isKeyHealthy returns false for a cold key when heartbeat is enabled", () => {
      // Heartbeat is enabled in beforeEach — cold keys must be prewarmed
      expect(isKeyHealthy(999)).toBe(false);
    });

    it("isKeyHealthy returns true for a cold key when heartbeat is disabled (backward compat)", () => {
      // Disable heartbeat
      setSetting("heartbeat_enabled", "false");
      resetHeartbeatConfig();

      // When heartbeat is off, cold keys are assumed healthy for backward compat
      expect(isKeyHealthy(999)).toBe(true);
    });

    it("isKeyHealthy returns true after a successful warmup ping", async () => {
      const { modelDbId, keyId } = setupProvider();

      // Key starts cold (not yet pinged)
      expect(isKeyHealthy(keyId)).toBe(false);

      chatCompletion.mockResolvedValue({
        choices: [{ message: { role: "assistant", content: "pong" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      recordActivity();
      startHeartbeat();

      // The warmup cycle fires immediately — wait for it to complete
      // by advancing a microtask tick
      await vi.advanceTimersByTimeAsync(0);

      // After warmup, the key should be healthy for this model
      expect(isKeyHealthy(keyId, "test-model")).toBe(true);
      const health = getKeyHealth(keyId, "test-model");
      expect(health).toBeDefined();
      expect(health.healthy).toBe(true);
    });
  });

  // ── Per-Model Fallback ─────────────────────────────────────────────────

  describe("Per-model fallback", () => {
    it("key is healthy for model-b when marked unhealthy for model-a", async () => {
      const db = getDb();
      db.prepare("DELETE FROM fallback_config").run();

      // Set up one platform with two models sharing the same keys
      db.prepare(
        "INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('fallback-prov', 'model-a', 'Model A', 1, 1, 1)",
      ).run();
      db.prepare(
        "INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('fallback-prov', 'model-b', 'Model B', 2, 2, 1)",
      ).run();
      const idA = (
        db
          .prepare(
            "SELECT id FROM models WHERE model_id = 'model-a' AND platform = 'fallback-prov'",
          )
          .get() as any
      ).id;
      const idB = (
        db
          .prepare(
            "SELECT id FROM models WHERE model_id = 'model-b' AND platform = 'fallback-prov'",
          )
          .get() as any
      ).id;

      db.prepare(
        "INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)",
      ).run(idA);
      db.prepare(
        "INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 2, 1)",
      ).run(idB);

      // One key for the platform
      db.prepare(
        "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('fallback-prov', 'Key 1', 'enc', 'iv', 'tag', 'healthy', 1)",
      ).run();
      const keyRow = db
        .prepare("SELECT id FROM api_keys WHERE platform = ? AND enabled = 1")
        .get("fallback-prov") as any;
      const keyId = keyRow.id;

      // First, make the key healthy for both models via pokeAllKeys
      chatCompletion.mockResolvedValue({
        choices: [{ message: { role: "assistant", content: "pong" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      await pokeAllKeys();

      // Verify key is healthy for both models
      expect(isKeyHealthy(keyId, "model-a")).toBe(true);
      expect(isKeyHealthy(keyId, "model-b")).toBe(true);
      expect(isKeyHealthy(keyId)).toBe(true); // healthy on at least one model

      // Mark key unhealthy for model-a only
      markKeyUnhealthy(keyId, "model-a", "429 rate limit");

      // model-a should be unhealthy
      expect(isKeyHealthy(keyId, "model-a")).toBe(false);

      // model-b should still be healthy (independent per-model tracking)
      expect(isKeyHealthy(keyId, "model-b")).toBe(true);

      // Without modelId, key is healthy because at least one model (model-b) is healthy
      expect(isKeyHealthy(keyId)).toBe(true);
    });
  });

  // ── Per-Key Pinging ────────────────────────────────────────────────────

  describe("Per-key pinging", () => {
    it("pings each key for each model per cycle (warmup cycle)", async () => {
      const db = getDb();
      db.prepare("DELETE FROM fallback_config").run();

      db.prepare(
        "INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('multikey', 'model-a', 'Model A', 1, 1, 1)",
      ).run();
      db.prepare(
        "INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('multikey', 'model-b', 'Model B', 2, 2, 1)",
      ).run();
      const idA = (
        db
          .prepare(
            "SELECT id FROM models WHERE model_id = 'model-a' AND platform = 'multikey'",
          )
          .get() as any
      ).id;
      const idB = (
        db
          .prepare(
            "SELECT id FROM models WHERE model_id = 'model-b' AND platform = 'multikey'",
          )
          .get() as any
      ).id;

      db.prepare(
        "INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)",
      ).run(idA);
      db.prepare(
        "INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 2, 1)",
      ).run(idB);

      // One key for the platform — should be pinged only once
      db.prepare(
        "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('multikey', 'Key 1', 'enc', 'iv', 'tag', 'healthy', 1)",
      ).run();

      chatCompletion.mockResolvedValue({
        choices: [{ message: { role: "assistant", content: "pong" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      recordActivity();
      startHeartbeat();

      // Advance time by 0 to drain microtask queue (warmup cycle completes)
      await vi.advanceTimersByTimeAsync(0);

      const pingEvents = publishedEvents.filter(
        (e) => e.type === "heartbeat.ping",
      );
      // Key should be pinged once per model (2 models = 2 pings)
      // The no-dedup behavior ensures per-model health tracking works correctly.
      expect(pingEvents.length).toBe(2);
    });

    it("pings multiple keys on the same platform (warmup cycle)", async () => {
      const db = getDb();
      db.prepare("DELETE FROM fallback_config").run();

      db.prepare(
        "INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('twokeys', 'model-a', 'Model A', 1, 1, 1)",
      ).run();
      const idA = (
        db
          .prepare(
            "SELECT id FROM models WHERE model_id = 'model-a' AND platform = 'twokeys'",
          )
          .get() as any
      ).id;
      db.prepare(
        "INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)",
      ).run(idA);

      db.prepare(
        "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('twokeys', 'Key 1', 'enc1', 'iv1', 'tag1', 'healthy', 1)",
      ).run();
      db.prepare(
        "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('twokeys', 'Key 2', 'enc2', 'iv2', 'tag2', 'healthy', 1)",
      ).run();

      chatCompletion.mockResolvedValue({
        choices: [{ message: { role: "assistant", content: "pong" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      recordActivity();
      startHeartbeat();

      // Advance time by 0 to drain microtask queue (warmup cycle completes)
      await vi.advanceTimersByTimeAsync(0);

      const pingEvents = publishedEvents.filter(
        (e) => e.type === "heartbeat.ping",
      );
      // Both keys should be pinged
      expect(pingEvents.length).toBe(2);
      expect(pingEvents.every((e) => e.success)).toBe(true);
    });
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────

  describe("Lifecycle (start/stop)", () => {
    it("startHeartbeat is a no-op when disabled", () => {
      setSetting("heartbeat_enabled", "false");
      startHeartbeat();
      vi.advanceTimersByTime(30 * 60 * 1000);
      expect(publishedEvents.length).toBe(0);
    });

    it("stopHeartbeat is safe to call even if never started", () => {
      expect(() => stopHeartbeat()).not.toThrow();
    });

    it("stopHeartbeat clears the timer", () => {
      recordActivity();
      startHeartbeat();
      stopHeartbeat();

      const eventsBefore = publishedEvents.length;
      vi.advanceTimersByTime(10 * 60 * 1000 + 1000);
      expect(publishedEvents.length).toBe(eventsBefore);
    });
  });

  // ── Startup Prewarm ──────────────────────────────────────────────────

  describe("Startup prewarm", () => {
    it("fires immediately on startHeartbeat() without waiting for interval tick", async () => {
      const { modelDbId, keyId } = setupProvider();

      chatCompletion.mockResolvedValue({
        choices: [{ message: { role: "assistant", content: "pong" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      // No recordActivity() call — prewarm fires independently
      startHeartbeat();

      // Advance only microtasks (not the timer interval)
      await vi.advanceTimersByTimeAsync(0);

      // Key should be healthy after prewarm completes — proves the cycle
      // ran immediately without waiting for the 10 min interval
      expect(isKeyHealthy(keyId, "test-model")).toBe(true);
      const health = getKeyHealth(keyId, "test-model");
      expect(health).toBeDefined();
      expect(health!.healthy).toBe(true);
      expect(health!.penalty).toBe(0);
    });

    it("bypasses the activity gate when no prior user request exists", async () => {
      const { modelDbId, keyId } = setupProvider();

      chatCompletion.mockResolvedValue({
        choices: [{ message: { role: "assistant", content: "pong" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      // Explicitly NOT calling recordActivity() — lastActivityAt remains 0.
      // A normal cycle would skip due to the activity gate (see Activity gating
      // tests above), but prewarm (skipGate=true) bypasses the gate entirely.
      startHeartbeat();
      await vi.advanceTimersByTimeAsync(0);

      // Keys should still be pinged because prewarm bypasses the activity gate
      const pingEvents = publishedEvents.filter(
        (e) => e.type === "heartbeat.ping",
      );
      expect(pingEvents.length).toBeGreaterThanOrEqual(1);
      expect(pingEvents[0].success).toBe(true);

      // Key should be healthy in keyHealthMap
      expect(isKeyHealthy(keyId, "test-model")).toBe(true);
    });
  });

  // ── Ping Task Sorting ───────────────────────────────────────────────

  describe("Ping task sorting", () => {
    it("groups ping tasks by provider and processes them concurrently", async () => {
      const db = getDb();
      db.prepare("DELETE FROM fallback_config").run();

      // Create two models on separate platforms with the same priority.
      // Previously this test verified cross-provider ordering by modelDbId,
      // but now provider groups run concurrently so ordering is non-deterministic.
      db.prepare(
        "INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('sort-b', 'model-b', 'Model B', 2, 2, 1)",
      ).run();
      const idB = (
        db
          .prepare(
            "SELECT id FROM models WHERE platform = 'sort-b' AND model_id = 'model-b'",
          )
          .get() as any
      ).id;

      db.prepare(
        "INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('sort-a', 'model-a', 'Model A', 1, 1, 1)",
      ).run();
      const idA = (
        db
          .prepare(
            "SELECT id FROM models WHERE platform = 'sort-a' AND model_id = 'model-a'",
          )
          .get() as any
      ).id;

      db.prepare(
        "INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)",
      ).run(idB);
      db.prepare(
        "INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)",
      ).run(idA);

      // One key per platform — each forms its own provider group
      db.prepare(
        "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('sort-b', 'Key B', 'enc', 'iv', 'tag', 'healthy', 1)",
      ).run();
      db.prepare(
        "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('sort-a', 'Key A', 'enc', 'iv', 'tag', 'healthy', 1)",
      ).run();

      chatCompletion.mockResolvedValue({
        choices: [{ message: { role: "assistant", content: "pong" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      recordActivity();
      startHeartbeat();
      await vi.advanceTimersByTimeAsync(0);

      const pingEvents = publishedEvents.filter(
        (e) => e.type === "heartbeat.ping",
      );
      expect(pingEvents.length).toBe(2);

      // Both providers should be pinged (order non-deterministic since they
      // run concurrently in separate Promise.all branches)
      const providers = new Set(pingEvents.map((e) => e.provider));
      expect(providers.has("sort-b")).toBe(true);
      expect(providers.has("sort-a")).toBe(true);
    });
  });

  // ── resetHeartbeatConfig ─────────────────────────────────────────────

  describe("pokeKey", () => {
    it("returns true when heartbeat is disabled (backward compat)", async () => {
      setSetting("heartbeat_enabled", "false");
      resetHeartbeatConfig();

      const result = await pokeKey(1);
      expect(result).toBe(true);
    });

    it("pings a specific key and returns true when healthy", async () => {
      const { keyId } = setupProvider();

      // Key starts cold
      expect(isKeyHealthy(keyId)).toBe(false);

      chatCompletion.mockResolvedValue({
        choices: [{ message: { role: "assistant", content: "pong" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      const result = await pokeKey(keyId);
      expect(result).toBe(true);

      // Verify the key became healthy in keyHealthMap for its model
      const health = getKeyHealth(keyId, "test-model");
      expect(health).toBeDefined();
      expect(health.healthy).toBe(true);
    });

    it("returns false for a non-existent key", async () => {
      const result = await pokeKey(99999);
      expect(result).toBe(false);
    });
  });

  describe("pokeAllKeys", () => {
    it("triggers a full cycle making all keys healthy", async () => {
      const { keyId } = setupProvider();

      // Key starts cold
      expect(isKeyHealthy(keyId)).toBe(false);

      chatCompletion.mockResolvedValue({
        choices: [{ message: { role: "assistant", content: "pong" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      const result = await pokeAllKeys();

      // After a full cycle, the key should become healthy
      const health = getKeyHealth(keyId, "test-model");
      expect(health).toBeDefined();
      expect(health.healthy).toBe(true);

      // Should return the number of keys poked
      expect(result).toEqual({ poked: 1, skipped: false });
    });

    it("returns { poked: 0, skipped: true } when a cycle is already in progress", async () => {
      const { keyId } = setupProvider();

      // Make chatCompletion hang (never resolves) so the first cycle stays in progress
      chatCompletion.mockReturnValue(new Promise(() => {}));

      // Start the first cycle — this will enter runCycle, set cycleInProgress = true,
      // then hang on the first await inside pingKey.
      const firstPoke = pokeAllKeys();

      // Second call should see cycleInProgress = true and return immediately
      const result = await pokeAllKeys();
      expect(result).toEqual({ poked: 0, skipped: true });
    });
  });

  describe("resetHeartbeatConfig", () => {
    it("clears keyHealthMap when called", () => {
      // Mark a key unhealthy — this populates keyHealthMap
      markKeyUnhealthy(1, "test", "forced test failure");

      // Verify the key is now in the health map and unhealthy (for this model)
      let health = getKeyHealth(1, "test");
      expect(health).toBeDefined();
      expect(health!.healthy).toBe(false);

      // Reset clears the map
      resetHeartbeatConfig();

      // Key should be gone from the map
      health = getKeyHealth(1, "test");
      expect(health).toBeUndefined();
    });
  });

  // ── Concurrency Batching ───────────────────────────────────────────────

  describe("Concurrency batching", () => {
    /** Set up N keys on a single platform/model for concurrency tests. */
    function setupMultiKey(n: number, platform = "conctest") {
      const db = getDb();
      db.prepare("DELETE FROM fallback_config").run();

      db.prepare(
        `INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('${platform}', 'conc-model', 'Conc Model', 1, 1, 1)`,
      ).run();
      const modelDbId = (
        db
          .prepare(
            `SELECT id FROM models WHERE platform = '${platform}' AND model_id = 'conc-model'`,
          )
          .get() as any
      ).id;
      db.prepare(
        "INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)",
      ).run(modelDbId);

      for (let i = 1; i <= n; i++) {
        db.prepare(
          `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('${platform}', 'Key ${i}', 'enc${i}', 'iv${i}', 'tag${i}', 'healthy', 1)`,
        ).run();
      }

      return { modelDbId };
    }

    it("concurrency=1 pings all keys sequentially (no parallel batches)", async () => {
      setupMultiKey(3);
      setSetting("heartbeat_concurrency", "1");
      resetHeartbeatConfig();

      chatCompletion.mockResolvedValue({
        choices: [{ message: { role: "assistant", content: "pong" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      recordActivity();
      const result = await pokeAllKeys();

      // All 3 keys should be pinged
      expect(result.poked).toBe(3);
      const pingEvents = publishedEvents.filter(
        (e) => e.type === "heartbeat.ping",
      );
      expect(pingEvents.length).toBe(3);
      expect(pingEvents.every((e) => e.success)).toBe(true);
    });

    it("concurrency=1 with stagger delays between sequential pings", async () => {
      setupMultiKey(3);
      setSetting("heartbeat_concurrency", "1");
      setSetting("heartbeat_stagger_ms", "50");
      resetHeartbeatConfig();

      chatCompletion.mockResolvedValue({
        choices: [{ message: { role: "assistant", content: "pong" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      recordActivity();
      // pokeAllKeys resolves runCycle(true). With concurrency=1 and stagger=50ms,
      // the cycle awaits sleep(50) after each ping except the last.
      // Since sleep uses setTimeout internally, fake timers control progress.
      const cyclePromise = pokeAllKeys();

      // After first ping resolves but before first sleep resolves,
      // only 1 ping event should have been published.
      await vi.advanceTimersByTimeAsync(0);
      let pingEvents = publishedEvents.filter(
        (e) => e.type === "heartbeat.ping",
      );
      expect(pingEvents.length).toBe(1);

      // Advance past first stagger sleep — second ping fires
      await vi.advanceTimersByTimeAsync(50);
      pingEvents = publishedEvents.filter((e) => e.type === "heartbeat.ping");
      expect(pingEvents.length).toBe(2);

      // Advance past second stagger sleep — third ping fires
      await vi.advanceTimersByTimeAsync(50);
      pingEvents = publishedEvents.filter((e) => e.type === "heartbeat.ping");
      expect(pingEvents.length).toBe(3);

      const result = await cyclePromise;
      expect(result.poked).toBe(3);
    });

    it("concurrency=2 batches keys into groups of 2", async () => {
      setupMultiKey(3);
      setSetting("heartbeat_concurrency", "2");
      resetHeartbeatConfig();

      chatCompletion.mockResolvedValue({
        choices: [{ message: { role: "assistant", content: "pong" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      recordActivity();
      const result = await pokeAllKeys();

      // All 3 keys pinged: batch 1 = 2 keys, batch 2 = 1 key
      expect(result.poked).toBe(3);
      const pingEvents = publishedEvents.filter(
        (e) => e.type === "heartbeat.ping",
      );
      expect(pingEvents.length).toBe(3);
      expect(pingEvents.every((e) => e.success)).toBe(true);
    });

    it("serializes pings for the same key across multiple models when concurrency > 1", async () => {
      const db = getDb();
      db.prepare("DELETE FROM fallback_config").run();

      db.prepare(
        "INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('samekey', 'model-a', 'Model A', 1, 1, 1)",
      ).run();
      db.prepare(
        "INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('samekey', 'model-b', 'Model B', 2, 2, 1)",
      ).run();
      const idA = (
        db
          .prepare(
            "SELECT id FROM models WHERE platform = 'samekey' AND model_id = 'model-a'",
          )
          .get() as any
      ).id;
      const idB = (
        db
          .prepare(
            "SELECT id FROM models WHERE platform = 'samekey' AND model_id = 'model-b'",
          )
          .get() as any
      ).id;
      db.prepare(
        "INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)",
      ).run(idA);
      db.prepare(
        "INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 2, 1)",
      ).run(idB);
      db.prepare(
        "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('samekey', 'Key 1', 'enc', 'iv', 'tag', 'healthy', 1)",
      ).run();

      setSetting("heartbeat_concurrency", "2");
      resetHeartbeatConfig();

      let active = 0;
      let maxActive = 0;
      chatCompletion.mockImplementation(() => {
        active++;
        maxActive = Math.max(maxActive, active);
        return new Promise((resolve) => {
          setTimeout(() => {
            active--;
            resolve({
              choices: [{ message: { role: "assistant", content: "pong" } }],
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            });
          }, 1);
        });
      });

      const cyclePromise = pokeAllKeys();
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(1);
      const result = await cyclePromise;

      expect(result.poked).toBe(2);
      expect(maxActive).toBe(1);
      const pingEvents = publishedEvents.filter(
        (e) => e.type === "heartbeat.ping",
      );
      expect(pingEvents.length).toBe(2);
      expect(pingEvents.every((e) => e.success)).toBe(true);
    });

    it("high concurrency pings all keys in a single batch", async () => {
      setupMultiKey(2);
      setSetting("heartbeat_concurrency", "10");
      resetHeartbeatConfig();

      chatCompletion.mockResolvedValue({
        choices: [{ message: { role: "assistant", content: "pong" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      recordActivity();
      const result = await pokeAllKeys();

      // Both keys pinged concurrently in a single batch
      expect(result.poked).toBe(2);
      const pingEvents = publishedEvents.filter(
        (e) => e.type === "heartbeat.ping",
      );
      expect(pingEvents.length).toBe(2);
      expect(pingEvents.every((e) => e.success)).toBe(true);
    });

    it("no stagger sleep when concurrency > 1", async () => {
      setupMultiKey(3);
      setSetting("heartbeat_concurrency", "2");
      setSetting("heartbeat_stagger_ms", "100");
      resetHeartbeatConfig();

      chatCompletion.mockResolvedValue({
        choices: [{ message: { role: "assistant", content: "pong" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      recordActivity();
      // With concurrency=2, sleep is never invoked even when stagger > 0
      // (sleep only fires when concurrency === 1 && staggerMs > 0)
      const result = await pokeAllKeys();

      expect(result.poked).toBe(3);
      const pingEvents = publishedEvents.filter(
        (e) => e.type === "heartbeat.ping",
      );
      expect(pingEvents.length).toBe(3);
    });
  });
  // ── Recheck Scheduling ──────────────────────────────────────────────────

  describe("Recheck scheduling", () => {
    it("markKeyUnhealthy schedules a recheck timer", () => {
      const { keyId } = setupProvider();
      markKeyUnhealthy(keyId, "test-model", "429 rate limit");
      expect(getPendingRechecks().has(healthKey(keyId, "test-model"))).toBe(
        true,
      );
      expect(
        getPendingRechecks().get(healthKey(keyId, "test-model"))!.attempt,
      ).toBe(1);
    });

    it("no duplicate recheck for same key", () => {
      const { keyId } = setupProvider();
      markKeyUnhealthy(keyId, "test-model", "429 rate limit");
      markKeyUnhealthy(keyId, "test-model", "429 rate limit again");
      expect(getPendingRechecks().size).toBe(1);
      expect(
        getPendingRechecks().get(healthKey(keyId, "test-model"))!.attempt,
      ).toBe(1);
    });

    it("disabled heartbeat → no recheck scheduled", async () => {
      // Need a fresh module with heartbeat disabled
      vi.resetModules();
      vi.doMock("../../providers/index.js", async (importOriginal) => {
        const actual = (await importOriginal()) as any;
        return {
          ...actual,
          buildProviderFor: () => ({ name: "fake", chatCompletion: vi.fn() }),
        };
      });
      vi.doMock("../../services/events.js", () => ({
        publish: vi.fn(),
      }));
      vi.doMock("../../lib/crypto.js", async (importOriginal) => {
        const actual = (await importOriginal()) as any;
        return { ...actual, decrypt: vi.fn(() => "mocked-api-key") };
      });

      process.env.ENCRYPTION_KEY = "0".repeat(64);
      const freshDb = await import("../../db/index.js");
      const freshHb = await import("../../services/heartbeat.js");
      const freshDegr = await import("../../services/degradation.js");

      freshDb.initDb(":memory:");
      freshDegr.initDegradation();
      // heartbeat_enabled defaults to false — no setting needed

      // Setup provider in fresh DB
      const db = freshDb.getDb();
      db.prepare(
        "INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('testprov', 'test-model', 'Test', 1, 1, 1)",
      ).run();
      const id = (
        db
          .prepare("SELECT id FROM models WHERE platform = 'testprov'")
          .get() as any
      ).id;
      db.prepare(
        "INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)",
      ).run(id);
      db.prepare(
        "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('testprov', 'Key 1', 'enc', 'iv', 'tag', 'healthy', 1)",
      ).run();
      const keyRow = db
        .prepare("SELECT id FROM api_keys WHERE platform = ? AND enabled = 1")
        .get("testprov") as any;

      freshHb.markKeyUnhealthy(keyRow.id, "test-model", "429 rate limit");
      expect(freshHb.getPendingRechecks().size).toBe(0);
    });
  });

  // ── Recheck Execution ──────────────────────────────────────────────────

  describe("markKeyUnhealthy transient", () => {
    it("transient 429 keeps key in healthy pool", async () => {
      const { keyId } = setupProvider();
      // First, make the key healthy via a poke
      chatCompletion.mockResolvedValue({
        choices: [{ message: { role: "assistant", content: "hi" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      const result = await pokeKey(keyId);
      expect(result).toBe(true);
      expect(isKeyHealthy(keyId, "test-model")).toBe(true);
      const healthBefore = getKeyHealth(keyId, "test-model");
      expect(healthBefore?.penalty).toBe(0);

      // Clear any published events from pokeKey
      publishedEvents.length = 0;

      // Mark as unhealthy with transient=true for test-model
      markKeyUnhealthy(keyId, "test-model", "429 rate limited", true);

      // Key should remain healthy (transient doesn't evict)
      expect(isKeyHealthy(keyId, "test-model")).toBe(true);

      // Penalty should NOT be incremented
      const health = getKeyHealth(keyId, "test-model");
      expect(health?.penalty).toBe(0);

      // Recheck should be scheduled (transient still triggers recheck)
      expect(getPendingRechecks().has(healthKey(keyId, "test-model"))).toBe(
        true,
      );
    });
  });

  describe("markKeyUnhealthy with custom recheck delay", () => {
    it("uses custom recheckDelayMs for daily exhaustion", async () => {
      const { keyId } = setupProvider();
      // First make the key healthy
      chatCompletion.mockResolvedValue({
        choices: [{ message: { role: "assistant", content: "hi" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      await pokeKey(keyId);
      expect(isKeyHealthy(keyId)).toBe(true);

      // Clear events from pokeKey
      publishedEvents.length = 0;

      // Mark as unhealthy for daily exhaustion (transient=false) with a 10-minute recheck delay
      const customDelayMs = 10 * 60 * 1000; // 10 minutes
      markKeyUnhealthy(
        keyId,
        "test-model",
        "daily quota exhausted",
        false,
        customDelayMs,
      );

      // Key should be evicted from healthy pool
      expect(isKeyHealthy(keyId, "test-model")).toBe(false);

      // Penalty should be incremented
      const health = getKeyHealth(keyId, "test-model");
      expect(health?.penalty).toBe(1);
      expect(health?.healthy).toBe(false);

      // Advance by only 90s — timer should NOT have fired yet (custom delay is 10min)
      await vi.advanceTimersByTimeAsync(90_000);
      const earlyRecheckEvents = publishedEvents.filter(
        (e) => e.type === "heartbeat.recheck",
      );
      expect(earlyRecheckEvents.length).toBe(0);

      // Only advance to 10min + 1ms from markKeyUnhealthy (510s from the 90s point)
      // Avoiding the next scheduled recheck at +90s after first fire
      const err = new Error("429 daily limit");
      (err as any).status = 429;
      chatCompletion.mockRejectedValueOnce(err);
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 90_000 + 100);

      const recheckEvents = publishedEvents.filter(
        (e) => e.type === "heartbeat.recheck",
      );
      expect(recheckEvents.length).toBe(1);
      expect(recheckEvents[0].success).toBe(false);
    });

    it("replaces an existing pending default recheck when a later custom delay is supplied", async () => {
      const { keyId } = setupProvider();
      chatCompletion.mockResolvedValue({
        choices: [{ message: { role: "assistant", content: "hi" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      await pokeKey(keyId);
      publishedEvents.length = 0;

      markKeyUnhealthy(keyId, "test-model", "429 rate limited", true);
      expect(getPendingRechecks().has(healthKey(keyId, "test-model"))).toBe(
        true,
      );

      const customDelayMs = 10 * 60 * 1000;
      markKeyUnhealthy(
        keyId,
        "test-model",
        "daily quota exhausted",
        false,
        customDelayMs,
      );
      expect(isKeyHealthy(keyId, "test-model")).toBe(false);

      await vi.advanceTimersByTimeAsync(90_000 + 100);
      expect(
        publishedEvents.filter((e) => e.type === "heartbeat.recheck"),
      ).toHaveLength(0);

      chatCompletion.mockResolvedValueOnce({
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      await vi.advanceTimersByTimeAsync(customDelayMs - 90_000 + 100);

      const recheckEvents = publishedEvents.filter(
        (e) => e.type === "heartbeat.recheck",
      );
      expect(recheckEvents).toHaveLength(1);
      expect(recheckEvents[0].success).toBe(true);
    });

    it("uses default recheckSec for transient 429", async () => {
      const { keyId } = setupProvider();
      // First make the key healthy
      chatCompletion.mockResolvedValue({
        choices: [{ message: { role: "assistant", content: "hi" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      await pokeKey(keyId);

      // Clear events
      publishedEvents.length = 0;

      // Mark as unhealthy with transient=true (no custom delay)
      markKeyUnhealthy(keyId, "test-model", "429 rate limited", true);

      // Key should remain healthy
      expect(isKeyHealthy(keyId, "test-model")).toBe(true);

      // Advance by recheckSec (default 90s in test) — recheck should fire
      chatCompletion.mockResolvedValueOnce({
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      await vi.advanceTimersByTimeAsync(90_000 + 100);

      const recheckEvents = publishedEvents.filter(
        (e) => e.type === "heartbeat.recheck",
      );
      // The key was healthy, so fireRecheck should no-op (healthy key check at start)
      // This is correct behavior — a transient-marked healthy key doesn't need recheck
      expect(recheckEvents.length).toBe(0);
    });
  });

  describe("Recheck execution", () => {
    it("recheck success clears timer and emits event", async () => {
      const { keyId } = setupProvider();
      chatCompletion.mockResolvedValueOnce({
        choices: [{ message: { content: "ok" } }],
      });

      markKeyUnhealthy(keyId, "test-model", "429 rate limit");
      expect(getPendingRechecks().has(healthKey(keyId, "test-model"))).toBe(
        true,
      );

      // Advance past the recheck delay (90s default)
      await vi.advanceTimersByTimeAsync(90_000 + 100);

      // Timer should be cleared
      expect(getPendingRechecks().has(healthKey(keyId, "test-model"))).toBe(
        false,
      );
      // Key should be healthy again for this model
      expect(isKeyHealthy(keyId, "test-model")).toBe(true);
      // Should emit heartbeat.recheck event with success
      const recheckEvents = publishedEvents.filter(
        (e) => e.type === "heartbeat.recheck",
      );
      expect(recheckEvents.length).toBe(1);
      expect(recheckEvents[0].success).toBe(true);
      expect(recheckEvents[0].attempt).toBe(1);
      expect(recheckEvents[0].keyId).toBe(keyId);
    });

    it("recheck failure schedules next attempt", async () => {
      const { keyId } = setupProvider();
      // Fail the ping — simulate a rate limit error
      const err = new Error("429 rate limited");
      (err as any).status = 429;
      chatCompletion.mockRejectedValueOnce(err);

      markKeyUnhealthy(keyId, "test-model", "429 rate limit");
      await vi.advanceTimersByTimeAsync(90_000 + 100);

      // Should have emitted a failure recheck event
      const recheckEvents = publishedEvents.filter(
        (e) => e.type === "heartbeat.recheck",
      );
      expect(recheckEvents.length).toBe(1);
      expect(recheckEvents[0].success).toBe(false);
      expect(recheckEvents[0].attempt).toBe(1);
      // Should schedule next attempt
      expect(getPendingRechecks().has(healthKey(keyId, "test-model"))).toBe(
        true,
      );
      expect(
        getPendingRechecks().get(healthKey(keyId, "test-model"))!.attempt,
      ).toBe(2);
    });

    it("max rechecks stops retrying", async () => {
      const { keyId } = setupProvider();
      // Set max rechecks to 1 for this test
      setSetting("heartbeat_exhausted_max_rechecks", "1");
      resetHeartbeatConfig();

      const err = new Error("429 rate limited");
      (err as any).status = 429;
      chatCompletion.mockRejectedValue(err);

      markKeyUnhealthy(keyId, "test-model", "429 rate limit");
      await vi.advanceTimersByTimeAsync(90_000 + 100);

      // After max rechecks (1), no more timers
      expect(getPendingRechecks().has(healthKey(keyId, "test-model"))).toBe(
        false,
      );

      // Reset setting for other tests
      setSetting("heartbeat_exhausted_max_rechecks", "3");
      resetHeartbeatConfig();
    });

    it("key already healthy → recheck no-ops", async () => {
      const { keyId } = setupProvider();
      markKeyUnhealthy(keyId, "test-model", "429 rate limit");

      // Manually mark key healthy before timer fires (via pokeKey)
      chatCompletion.mockResolvedValueOnce({
        choices: [{ message: { content: "ok" } }],
      });
      await pokeKey(keyId);
      expect(isKeyHealthy(keyId, "test-model")).toBe(true);

      // Clear any published events from pokeKey
      publishedEvents.length = 0;

      // Now advance past the recheck timer
      await vi.advanceTimersByTimeAsync(90_000 + 100);

      // No recheck event should be emitted — key is already healthy
      const recheckEvents = publishedEvents.filter(
        (e) => e.type === "heartbeat.recheck",
      );
      expect(recheckEvents.length).toBe(0);
    });

    it("key disabled → recheck no-ops", async () => {
      const { keyId } = setupProvider();
      markKeyUnhealthy(keyId, "test-model", "429 rate limit");

      // Disable the key in DB before timer fires
      const db = getDb();
      db.prepare("UPDATE api_keys SET enabled = 0 WHERE id = ?").run(keyId);

      await vi.advanceTimersByTimeAsync(90_000 + 100);

      // No recheck event — key is disabled
      const recheckEvents = publishedEvents.filter(
        (e) => e.type === "heartbeat.recheck",
      );
      expect(recheckEvents.length).toBe(0);
      // Timer should be cleaned up
      expect(getPendingRechecks().has(healthKey(keyId, "test-model"))).toBe(
        false,
      );
    });
    it("race: markKeyUnhealthy during in-flight recheck does not leak duplicate timer", async () => {
      const { keyId } = setupProvider();

      // Start a recheck cycle
      markKeyUnhealthy(keyId, "test-model", "429 rate limit");
      expect(getPendingRechecks().has(healthKey(keyId, "test-model"))).toBe(
        true,
      );

      // Advance to fire the recheck timer
      // Make pingKey hang (never resolves) so we can inject a race
      let resolvePing: () => void;
      const pingPromise = new Promise<void>((r) => {
        resolvePing = r;
      });
      chatCompletion.mockReturnValueOnce(pingPromise);

      await vi.advanceTimersByTimeAsync(90_000 + 100);

      // At this point, fireRecheck is in-flight (awaiting pingKey)
      // The entry is still in recheckTimers with inFlight=true
      expect(getPendingRechecks().has(healthKey(keyId, "test-model"))).toBe(
        true,
      );

      // Now simulate the key being marked unhealthy again during the async gap
      markKeyUnhealthy(keyId, "test-model", "429 again");

      // scheduleRecheck should have seen the in-flight entry and updated it
      // (bumped generation, set attempt back to 1, scheduled new timer)
      // There should still be exactly one entry - not two
      expect(getPendingRechecks().size).toBe(1);

      // Now resolve the hanging ping
      chatCompletion.mockResolvedValueOnce({
        choices: [{ message: { content: "ok" } }],
      });
      resolvePing!();

      // Let the microtask queue drain
      await vi.advanceTimersByTimeAsync(0);

      // The stale fireRecheck should detect the generation mismatch
      // and exit without scheduling a duplicate next attempt
      // Only one entry should exist
      expect(getPendingRechecks().size).toBeLessThanOrEqual(1);
    });
  });

  // ── Recheck Cleanup ─────────────────────────────────────────────────────

  describe("Recheck cleanup", () => {
    it("stopHeartbeat clears all rechecks", () => {
      const { keyId: keyId1 } = setupProvider("testprov", "test-model");
      // Add a second key on a different platform
      const db = getDb();
      db.prepare(
        "INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('prov2', 'model2', 'Model 2', 2, 2, 1)",
      ).run();
      const id2 = (
        db
          .prepare(
            "SELECT id FROM models WHERE platform = 'prov2' AND model_id = 'model2'",
          )
          .get() as any
      ).id;
      db.prepare(
        "INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 2, 1)",
      ).run(id2);
      db.prepare(
        "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('prov2', 'Key 2', 'enc2', 'iv2', 'tag2', 'healthy', 1)",
      ).run();
      const keyRow2 = db
        .prepare("SELECT id FROM api_keys WHERE platform = ? AND enabled = 1")
        .get("prov2") as any;

      markKeyUnhealthy(keyId1, "test-model", "429");
      markKeyUnhealthy(keyRow2.id, "model2", "429");
      expect(getPendingRechecks().size).toBe(2);

      stopHeartbeat();
      expect(getPendingRechecks().size).toBe(0);
    });

    it("resetHeartbeatConfig clears rechecks", () => {
      const { keyId } = setupProvider();
      markKeyUnhealthy(keyId, "test-model", "429");
      expect(getPendingRechecks().has(healthKey(keyId, "test-model"))).toBe(
        true,
      );

      resetHeartbeatConfig();
      expect(getPendingRechecks().size).toBe(0);
    });
  });

  // ── Recheck Event Shape ─────────────────────────────────────────────────

  describe("Recheck event shape", () => {
    it("success event has correct fields", async () => {
      const { keyId } = setupProvider();
      chatCompletion.mockResolvedValueOnce({
        choices: [{ message: { content: "ok" } }],
      });

      markKeyUnhealthy(keyId, "test-model", "429 rate limit");
      await vi.advanceTimersByTimeAsync(90_000 + 100);

      const recheckEvents = publishedEvents.filter(
        (e) => e.type === "heartbeat.recheck",
      );
      expect(recheckEvents.length).toBe(1);
      const evt = recheckEvents[0];
      expect(evt).toMatchObject({
        type: "heartbeat.recheck",
        keyId,
        provider: "testprov",
        model: "test-model",
        success: true,
        attempt: 1,
      });
      expect(evt.latencyMs).toBeGreaterThanOrEqual(0);
      expect(typeof evt.at).toBe("number");
      // No error field on success
      expect(evt.error).toBeUndefined();
    });

    it("failure event has error field", async () => {
      const { keyId } = setupProvider();
      const err = new Error("429 Too Many Requests");
      (err as any).status = 429;
      chatCompletion.mockRejectedValueOnce(err);

      markKeyUnhealthy(keyId, "test-model", "429 rate limit");
      await vi.advanceTimersByTimeAsync(90_000 + 100);

      const recheckEvents = publishedEvents.filter(
        (e) => e.type === "heartbeat.recheck",
      );
      expect(recheckEvents.length).toBe(1);
      const evt = recheckEvents[0];
      expect(evt.success).toBe(false);
      expect(evt.error).toBeTruthy();
      expect(typeof evt.attempt).toBe("number");
    });
  });

  // ── AI Routing Advisor ─────────────────────────────────────────────────

  describe("AI routing advisor", () => {
    it("uses advisory messages and emits advisor events when enabled", async () => {
      setupProvider();
      setSetting("heartbeat_advisor_enabled", "true");
      setSetting("heartbeat_advisor_max_output_tokens", "8");
      chatCompletion.mockResolvedValue({
        choices: [
          {
            message: {
              role: "assistant",
              content:
                '{"confidence":7,"selfScore":2,"cooldownHint":0,"recheckSooner":false}',
            },
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
      });

      await pokeAllKeys();

      const firstCall = chatCompletion.mock.calls[0];
      expect(firstCall[1][0].role).toBe("system");
      expect(firstCall[1][1].content).toContain('"self"');
      expect(firstCall[3].max_tokens).toBe(8);

      const parsedEvents = publishedEvents.filter(
        (e) => e.type === "heartbeat.advisor_parsed",
      );
      expect(parsedEvents).toHaveLength(1);
      expect(parsedEvents[0]).toMatchObject({
        provider: "testprov",
        model: "test-model",
        confidence: 7,
        selfScore: 2,
      });

      const appliedEvents = publishedEvents.filter(
        (e) => e.type === "heartbeat.advisor_applied",
      );
      expect(appliedEvents.some((e) => e.applied === "score_boost")).toBe(true);
    });

    it("honors recheckSooner advice for a healthy key", async () => {
      setupProvider();
      setSetting("heartbeat_advisor_enabled", "true");
      setSetting("heartbeat_advisor_max_output_tokens", "8");
      chatCompletion
        .mockResolvedValueOnce({
          choices: [
            {
              message: {
                role: "assistant",
                content:
                  '{"confidence":7,"selfScore":0,"cooldownHint":0,"recheckSooner":true}',
              },
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
        })
        .mockResolvedValueOnce({
          choices: [
            {
              message: {
                role: "assistant",
                content:
                  '{"confidence":7,"selfScore":0,"cooldownHint":0,"recheckSooner":false}',
              },
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
        });

      await pokeAllKeys();
      expect(chatCompletion).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(45_000 + 100);

      expect(chatCompletion).toHaveBeenCalledTimes(2);
      const recheckEvents = publishedEvents.filter(
        (e) => e.type === "heartbeat.recheck",
      );
      expect(recheckEvents).toHaveLength(1);
      expect(recheckEvents[0]).toMatchObject({
        provider: "testprov",
        model: "test-model",
        success: true,
        attempt: 1,
      });
    });

    it("applies Rabbit oscillator advice and preserves it on the next cycle", async () => {
      setupProvider();
      const db = getDb();
      db.prepare(`
        INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled)
        VALUES ('other', 'injection-model', 'Injection Model', 2, 2, 1)
      `).run();
      const injectionModelDbId = (
        db
          .prepare(
            "SELECT id FROM models WHERE platform = 'other' AND model_id = 'injection-model'",
          )
          .get() as { id: number }
      ).id;
      setSetting("heartbeat_advisor_enabled", "true");
      setSetting("heartbeat_advisor_max_output_tokens", "8");
      setSetting("rabbit_enabled", "false");
      chatCompletion
        .mockResolvedValueOnce({
          choices: [
            {
              message: {
                role: "assistant",
                content:
                  '{"confidence":8,"selfScore":0,"cooldownHint":0,"recheckSooner":false,"oscillatorHint":"enable","injectionModel":"other/injection-model","injectionBrevity":"shorter"}',
              },
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
        })
        .mockResolvedValueOnce({
          choices: [
            {
              message: {
                role: "assistant",
                content:
                  '{"confidence":0,"selfScore":0,"cooldownHint":0,"recheckSooner":false,"oscillatorHint":"no_opinion"}',
              },
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
        });

      await pokeAllKeys();

      expect(getSetting("rabbit_enabled")).toBe("true");
      expect(getSetting("oscillator_injection_selection")).toBe(
        String(injectionModelDbId),
      );
      expect(getSetting("oscillator_injection_max_sentences")).toBe("1");
      expect(
        publishedEvents.some(
          (e) =>
            e.type === "heartbeat.advisor_applied" &&
            e.applied === "oscillator_toggled" &&
            e.magnitude === 1,
        ),
      ).toBe(true);
      expect(
        publishedEvents.some(
          (e) =>
            e.type === "heartbeat.advisor_applied" &&
            e.applied === "injection_adjusted" &&
            e.magnitude === injectionModelDbId,
        ),
      ).toBe(true);

      await pokeAllKeys();

      expect(chatCompletion).toHaveBeenCalledTimes(2);
      expect(getSetting("rabbit_enabled")).toBe("true");
      expect(getSetting("oscillator_injection_selection")).toBe(
        String(injectionModelDbId),
      );
      expect(getSetting("oscillator_injection_max_sentences")).toBe("1");
    });

    it("keeps the legacy hi ping and emits no advisor events when disabled", async () => {
      setupProvider();
      setSetting("heartbeat_advisor_enabled", "false");
      chatCompletion.mockResolvedValue({
        choices: [{ message: { role: "assistant", content: "hi" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      await pokeAllKeys();

      const firstCall = chatCompletion.mock.calls[0];
      expect(firstCall[1]).toEqual([{ role: "user", content: "hi" }]);
      expect(firstCall[3].max_tokens).toBe(5);
      expect(
        publishedEvents.some((e) => e.type.startsWith("heartbeat.advisor_")),
      ).toBe(false);
    });
  });
});

// ── Route-level: POST /heartbeat/poke ─────────────────────────────────────

describe("Heartbeat Poke API", () => {
  let app: Express;
  let dashToken: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = "0".repeat(64);
    initDb(":memory:");

    // Enable heartbeat and add a model+key BEFORE createApp() so readConfig()
    // caches the correct values during app startup.
    setSetting("heartbeat_enabled", "true");
    setSetting("heartbeat_interval_min", "10");
    setSetting("heartbeat_activity_window_min", "15");
    setSetting("heartbeat_stagger_ms", "0");

    app = createApp();
    dashToken = mintDashboardToken();

    // Add model+key for single-key poke tests
    const db = getDb();
    db.prepare(
      "INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('route-test', 'route-model', 'Route Test', 1, 1, 1)",
    ).run();
    const modelId = (
      db
        .prepare(
          "SELECT id FROM models WHERE platform = 'route-test' AND model_id = 'route-model'",
        )
        .get() as any
    ).id;
    db.prepare(
      "INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)",
    ).run(modelId);
    db.prepare(
      "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('route-test', 'Key 1', 'enc', 'iv', 'tag', 'healthy', 1)",
    ).run();
  });

  async function postPoke(body: Record<string, unknown>) {
    const server = app.listen(0);
    const addr = server.address() as any;
    const url = `http://127.0.0.1:${addr.port}/api/settings/heartbeat/poke`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${dashToken}`,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    server.close();
    return { status: res.status, body: data };
  }

  it("returns { poked, skipped } for empty body (poke all keys)", async () => {
    const { status, body } = await postPoke({});
    expect(status).toBe(200);
    expect(body).toMatchObject({ poked: 1, skipped: false });
  });

  it("returns key_ok or key_unhealthy_or_missing for a valid keyId", async () => {
    const keyRow = getDb()
      .prepare("SELECT id FROM api_keys WHERE platform = 'route-test'")
      .get() as any;

    const { status, body } = await postPoke({ keyId: keyRow.id });
    expect(status).toBe(200);
    expect(["key_ok", "key_unhealthy_or_missing"]).toContain(body.success);
  });

  it("returns 400 for an invalid keyId", async () => {
    const { status, body } = await postPoke({ keyId: "not-a-number" });
    expect(status).toBe(400);
    expect(body.error.message).toBe("keyId must be a number");
  });
});
