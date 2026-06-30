import type { Database } from "better-sqlite3";
import crypto from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, initDb, setSetting } from "../../db/index.js";
import { encrypt } from "../../lib/crypto.js";
import { clearExhausted } from "../../services/key-exhaustion.js";
import { type RouteOptions, routeRequest } from "../../services/router.js";

// Mock heartbeat module to simplify testing
vi.mock("../../services/heartbeat.js", () => ({
  isKeyHealthy: vi.fn(() => true), // All keys healthy by default
  isHeartbeatEnabled: vi.fn(() => false), // Heartbeat disabled by default
  markKeyUnhealthy: vi.fn(),
  recordActivity: vi.fn(),
  getAllKeyHealth: vi.fn(() => new Map()),
  getKeyHealth: vi.fn(),
}));

describe("Key Affinity Per Thread", () => {
  let db: Database;

  beforeEach(() => {
    // Set encryption key
    process.env.ENCRYPTION_KEY = "0".repeat(64);

    // Initialize fresh in-memory database
    db = initDb(":memory:");

    // Clear exhaustion state
    clearExhausted();

    // Enable key affinity by default (matching new default)
    setSetting("key_affinity_enabled", "true");

    // Set up a test provider with multiple keys
    db.prepare(`
      INSERT INTO custom_providers (slug, display_name, base_url, sticky_sessions_enabled)
      VALUES ('test-provider', 'Test Provider', 'https://api.test.com', 0)
    `).run();

    // Create 3 API keys for testing
    const keys = ["key-one", "key-two", "key-three"];
    for (const key of keys) {
      const { encrypted, iv, authTag } = encrypt(key);
      db.prepare(`
        INSERT INTO api_keys (platform, encrypted_key, iv, auth_tag, status, enabled)
        VALUES ('test-provider', ?, ?, ?, 'healthy', 1)
      `).run(encrypted, iv, authTag);
    }

    // Add a test model
    db.prepare(`
      INSERT INTO models (
        platform, model_id, display_name, intelligence_rank, speed_rank,
        size_label, supports_vision, supports_tools, enabled
      ) VALUES (
        'test-provider', 'test-model', 'Test Model', 1, 1,
        'Large', 0, 0, 1
      )
    `).run();

    const modelId = db
      .prepare("SELECT id FROM models WHERE model_id = ?")
      .get("test-model") as { id: number };

    // Add to fallback config
    db.prepare(`
      INSERT INTO fallback_config (model_db_id, priority, enabled)
      VALUES (?, 1, 1)
    `).run(modelId.id);
  });

  afterEach(() => {
    db?.close();
  });

  describe("Happy Path: Same Session → Same Key", () => {
    it("should select the same key for requests with the same session key", () => {
      const sessionKey = "session-abc-123";
      const options: RouteOptions = { stickySessionKey: sessionKey };

      const route1 = routeRequest(
        1000,
        undefined,
        undefined,
        false,
        false,
        undefined,
        options,
      );
      const keyId1 = route1.keyId;
      route1.release();

      const route2 = routeRequest(
        1000,
        undefined,
        undefined,
        false,
        false,
        undefined,
        options,
      );
      const keyId2 = route2.keyId;
      route2.release();

      const route3 = routeRequest(
        1000,
        undefined,
        undefined,
        false,
        false,
        undefined,
        options,
      );
      const keyId3 = route3.keyId;
      route3.release();

      expect(keyId1).toBe(keyId2);
      expect(keyId2).toBe(keyId3);
    });

    it("should compute deterministic key selection based on hash", () => {
      // Create multiple sessions and verify they map consistently
      const sessions = ["session-a", "session-b", "session-c"];
      const keyMapping = new Map<string, number>();

      for (const sessionKey of sessions) {
        const options: RouteOptions = { stickySessionKey: sessionKey };
        const route = routeRequest(
          1000,
          undefined,
          undefined,
          false,
          false,
          undefined,
          options,
        );
        keyMapping.set(sessionKey, route.keyId);
        route.release();
      }

      // Verify same sessions map to same keys again
      for (const sessionKey of sessions) {
        const options: RouteOptions = { stickySessionKey: sessionKey };
        const route = routeRequest(
          1000,
          undefined,
          undefined,
          false,
          false,
          undefined,
          options,
        );
        expect(route.keyId).toBe(keyMapping.get(sessionKey));
        route.release();
      }
    });
  });

  describe("Happy Path: Different Sessions → Different Keys", () => {
    it("should select keys deterministically for different sessions", () => {
      const sessionKey1 = "session-thread-1";
      const sessionKey2 = "session-thread-2";

      const route1 = routeRequest(
        1000,
        undefined,
        undefined,
        false,
        false,
        undefined,
        { stickySessionKey: sessionKey1 },
      );
      const keyId1 = route1.keyId;
      route1.release();

      const route2 = routeRequest(
        1000,
        undefined,
        undefined,
        false,
        false,
        undefined,
        { stickySessionKey: sessionKey2 },
      );
      const keyId2 = route2.keyId;
      route2.release();

      // Verify the selection is deterministic
      const route1Again = routeRequest(
        1000,
        undefined,
        undefined,
        false,
        false,
        undefined,
        { stickySessionKey: sessionKey1 },
      );
      const route2Again = routeRequest(
        1000,
        undefined,
        undefined,
        false,
        false,
        undefined,
        { stickySessionKey: sessionKey2 },
      );

      expect(route1Again.keyId).toBe(keyId1);
      expect(route2Again.keyId).toBe(keyId2);

      route1Again.release();
      route2Again.release();
    });

    it("should distribute sessions across available keys", () => {
      // Generate many sessions and verify they use different keys
      const keyUsage = new Set<number>();
      const numSessions = 20;

      for (let i = 0; i < numSessions; i++) {
        const sessionKey = `session-${i}`;
        const route = routeRequest(
          1000,
          undefined,
          undefined,
          false,
          false,
          undefined,
          { stickySessionKey: sessionKey },
        );
        keyUsage.add(route.keyId);
        route.release();
      }

      // With 3 keys and 20 sessions, we should hit at least 2 different keys
      expect(keyUsage.size).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Happy Path: Disabled Mode → Round-Robin", () => {
    it("should use round-robin when key affinity is disabled", () => {
      setSetting("key_affinity_enabled", "false");

      const sessionKey = "same-session";
      const options: RouteOptions = { stickySessionKey: sessionKey };

      const keyIds: number[] = [];

      // Make multiple requests with the same session key
      for (let i = 0; i < 6; i++) {
        const route = routeRequest(
          1000,
          undefined,
          undefined,
          false,
          false,
          undefined,
          options,
        );
        keyIds.push(route.keyId);
        route.release();
      }

      // With round-robin, we should see rotation through different keys
      const uniqueKeys = new Set(keyIds);
      expect(uniqueKeys.size).toBeGreaterThan(1);
    });

    it("should ignore stickySessionKey when affinity is disabled", () => {
      setSetting("key_affinity_enabled", "false");

      const route1 = routeRequest(
        1000,
        undefined,
        undefined,
        false,
        false,
        undefined,
        { stickySessionKey: "session-1" },
      );
      const keyId1 = route1.keyId;
      route1.release();

      const route2 = routeRequest(
        1000,
        undefined,
        undefined,
        false,
        false,
        undefined,
        { stickySessionKey: "session-2" },
      );
      const keyId2 = route2.keyId;
      route2.release();

      const route3 = routeRequest(
        1000,
        undefined,
        undefined,
        false,
        false,
        undefined,
        { stickySessionKey: "session-3" },
      );
      const keyId3 = route3.keyId;
      route3.release();

      // Round-robin should cycle through keys regardless of session
      const keyIds = [keyId1, keyId2, keyId3];
      const uniqueKeys = new Set(keyIds);
      expect(uniqueKeys.size).toBeGreaterThan(1);
    });
  });

  describe("Edge Case: Exhausted Key Fallback", () => {
    it("should fall back to another key when the affinity key is exhausted", () => {
      const sessionKey = crypto
        .createHash("sha1")
        .update("test-session")
        .digest("hex");
      const options: RouteOptions = { stickySessionKey: sessionKey };

      // First request to establish which key is selected
      const route1 = routeRequest(
        1000,
        undefined,
        undefined,
        false,
        false,
        undefined,
        options,
      );
      const originalKeyId = route1.keyId;
      route1.release();

      // Mark the affinity key as exhausted
      const exhausted = new Set<string>([
        `test-provider:test-model:${originalKeyId}`,
      ]);

      // Next request should fall back to a different key
      const route2 = routeRequest(
        1000,
        exhausted,
        undefined,
        false,
        false,
        undefined,
        options,
      );
      expect(route2.keyId).not.toBe(originalKeyId);
      route2.release();
    });

    it("should try all keys before giving up", () => {
      const sessionKey = crypto
        .createHash("sha1")
        .update("test-session")
        .digest("hex");
      const options: RouteOptions = { stickySessionKey: sessionKey };

      // Get all key IDs
      const allKeyIds = (
        db.prepare("SELECT id FROM api_keys").all() as Array<{ id: number }>
      ).map((k) => k.id);

      // Mark all but one key as exhausted
      const exhausted = new Set<string>();
      for (const keyId of allKeyIds.slice(0, -1)) {
        exhausted.add(`test-provider:test-model:${keyId}`);
      }

      // Should still succeed with the last key
      const route = routeRequest(
        1000,
        exhausted,
        undefined,
        false,
        false,
        undefined,
        options,
      );
      expect(route.keyId).toBe(allKeyIds[allKeyIds.length - 1]);
      route.release();
    });

    it("should throw when all keys are exhausted", () => {
      const sessionKey = crypto
        .createHash("sha1")
        .update("test-session")
        .digest("hex");
      const options: RouteOptions = { stickySessionKey: sessionKey };

      // Get all key IDs and mark them all as exhausted
      const allKeyIds = (
        db.prepare("SELECT id FROM api_keys").all() as Array<{ id: number }>
      ).map((k) => k.id);
      const exhausted = new Set<string>();
      for (const keyId of allKeyIds) {
        exhausted.add(`test-provider:test-model:${keyId}`);
      }

      // Should throw an error when all keys are exhausted
      expect(() => {
        routeRequest(
          1000,
          exhausted,
          undefined,
          false,
          false,
          undefined,
          options,
        );
      }).toThrow();
    });
  });

  describe("Edge Case: Empty Session Key", () => {
    it("should fall back to round-robin when session key is empty", () => {
      const keyIds: number[] = [];

      for (let i = 0; i < 6; i++) {
        const route = routeRequest(
          1000,
          undefined,
          undefined,
          false,
          false,
          undefined,
          { stickySessionKey: "" },
        );
        keyIds.push(route.keyId);
        route.release();
      }

      // With empty session key, should use round-robin
      const uniqueKeys = new Set(keyIds);
      expect(uniqueKeys.size).toBeGreaterThan(1);
    });

    it("should fall back to round-robin when stickySessionKey is undefined", () => {
      const keyIds: number[] = [];

      for (let i = 0; i < 6; i++) {
        const route = routeRequest(
          1000,
          undefined,
          undefined,
          false,
          false,
          undefined,
          { stickySessionKey: undefined },
        );
        keyIds.push(route.keyId);
        route.release();
      }

      // With undefined session key, should use round-robin
      const uniqueKeys = new Set(keyIds);
      expect(uniqueKeys.size).toBeGreaterThan(1);
    });
  });

  describe("Edge Case: Single Key Available", () => {
    it("should always return the same key when only one key exists", () => {
      // Disable all but one key
      db.prepare("UPDATE api_keys SET enabled = 0 WHERE id > 1").run();

      const sessionKey1 = "session-a";
      const sessionKey2 = "session-b";

      const route1 = routeRequest(
        1000,
        undefined,
        undefined,
        false,
        false,
        undefined,
        { stickySessionKey: sessionKey1 },
      );
      const route2 = routeRequest(
        1000,
        undefined,
        undefined,
        false,
        false,
        undefined,
        { stickySessionKey: sessionKey2 },
      );

      expect(route1.keyId).toBe(route2.keyId);

      route1.release();
      route2.release();
    });
  });

  describe("Edge Case: Pin Mode with Affinity", () => {
    it("should respect pin mode and still use affinity for key selection", () => {
      const modelId = (
        db
          .prepare("SELECT id FROM models WHERE model_id = ?")
          .get("test-model") as { id: number }
      ).id;
      const sessionKey = "pinned-session";

      const route1 = routeRequest(
        1000,
        undefined,
        modelId,
        false,
        false,
        undefined,
        { pinMode: true, stickySessionKey: sessionKey },
      );
      const keyId1 = route1.keyId;
      route1.release();

      const route2 = routeRequest(
        1000,
        undefined,
        modelId,
        false,
        false,
        undefined,
        { pinMode: true, stickySessionKey: sessionKey },
      );
      const keyId2 = route2.keyId;
      route2.release();

      expect(keyId1).toBe(keyId2);
    });
  });

  describe("Edge Case: Hash Distribution", () => {
    it("should distribute hashes evenly across keys", () => {
      const numSessions = 300;
      const keyUsage = new Map<number, number>();

      for (let i = 0; i < numSessions; i++) {
        const sessionKey = crypto
          .createHash("sha1")
          .update(`unique-session-${i}`)
          .digest("hex");
        const route = routeRequest(
          1000,
          undefined,
          undefined,
          false,
          false,
          undefined,
          { stickySessionKey: sessionKey },
        );
        keyUsage.set(route.keyId, (keyUsage.get(route.keyId) || 0) + 1);
        route.release();
      }

      // With 3 keys and 300 sessions, each key should get roughly 100 requests (±50%)
      // This tests that the hash distribution is reasonably uniform
      const counts = Array.from(keyUsage.values());
      expect(counts.length).toBe(3); // All 3 keys should be used

      const avg = numSessions / 3;
      for (const count of counts) {
        expect(count).toBeGreaterThan(avg * 0.5);
        expect(count).toBeLessThan(avg * 1.5);
      }
    });
  });

  describe("Edge Case: Backward Compatibility with Provider Sticky Sessions", () => {
    it("should use provider-level sticky_sessions_enabled when global affinity is off", () => {
      // Disable global affinity
      setSetting("key_affinity_enabled", "false");

      // Enable provider-level stickiness
      db.prepare(
        "UPDATE custom_providers SET sticky_sessions_enabled = 1 WHERE slug = ?",
      ).run("test-provider");

      const sessionKey = "provider-sticky-session";
      const options: RouteOptions = { stickySessionKey: sessionKey };

      const route1 = routeRequest(
        1000,
        undefined,
        undefined,
        false,
        false,
        undefined,
        options,
      );
      const keyId1 = route1.keyId;
      route1.release();

      const route2 = routeRequest(
        1000,
        undefined,
        undefined,
        false,
        false,
        undefined,
        options,
      );
      const keyId2 = route2.keyId;
      route2.release();

      // With provider sticky enabled, should use same key
      expect(keyId1).toBe(keyId2);
    });

    it("should prioritize global affinity over provider-level setting", () => {
      // Enable global affinity (default now)
      setSetting("key_affinity_enabled", "true");

      // Disable provider-level stickiness
      db.prepare(
        "UPDATE custom_providers SET sticky_sessions_enabled = 0 WHERE slug = ?",
      ).run("test-provider");

      const sessionKey = "global-affinity-session";
      const options: RouteOptions = { stickySessionKey: sessionKey };

      const route1 = routeRequest(
        1000,
        undefined,
        undefined,
        false,
        false,
        undefined,
        options,
      );
      const keyId1 = route1.keyId;
      route1.release();

      const route2 = routeRequest(
        1000,
        undefined,
        undefined,
        false,
        false,
        undefined,
        options,
      );
      const keyId2 = route2.keyId;
      route2.release();

      // Global affinity should work even with provider setting off
      expect(keyId1).toBe(keyId2);
    });
  });

  describe("Edge Case: Session Key Consistency", () => {
    it("should maintain affinity across model switches in fallback chain", () => {
      // Add a second model
      db.prepare(`
        INSERT INTO models (
          platform, model_id, display_name, intelligence_rank, speed_rank,
          size_label, supports_vision, supports_tools, enabled
        ) VALUES (
          'test-provider', 'test-model-2', 'Test Model 2', 2, 2,
          'Large', 0, 0, 1
        )
      `).run();

      const model2Id = (
        db
          .prepare("SELECT id FROM models WHERE model_id = ?")
          .get("test-model-2") as { id: number }
      ).id;

      db.prepare(`
        INSERT INTO fallback_config (model_db_id, priority, enabled)
        VALUES (?, 2, 1)
      `).run(model2Id);

      const sessionKey = "multi-model-session";

      // Route to first model
      const route1 = routeRequest(
        1000,
        undefined,
        undefined,
        false,
        false,
        undefined,
        { stickySessionKey: sessionKey },
      );
      const keyId1 = route1.keyId;
      route1.release();

      // Skip the first model, forcing fallback to second model
      const modelId1 = (
        db
          .prepare("SELECT id FROM models WHERE model_id = ?")
          .get("test-model") as { id: number }
      ).id;
      const skipModels = new Set([modelId1]);

      const route2 = routeRequest(
        1000,
        undefined,
        undefined,
        false,
        false,
        skipModels,
        { stickySessionKey: sessionKey },
      );
      const keyId2 = route2.keyId;
      route2.release();

      // Same session key should select the same key even on different model
      expect(keyId1).toBe(keyId2);
    });
  });
});
