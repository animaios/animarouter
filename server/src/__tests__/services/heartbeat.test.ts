/**
 * Integration tests for Provider Health Heartbeat (Per-Key Edition).
 *
 * Each test re-imports modules in isolation to avoid cross-test contamination
 * from module-level cached config and state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('Provider Health Heartbeat', () => {
  let chatCompletion: ReturnType<typeof vi.fn>;
  let publishedEvents: any[];
  let recordActivity: () => void;
  let startHeartbeat: () => void;
  let stopHeartbeat: () => void;
  let initDb: (path?: string) => any;
  let getDb: () => any;
  let setSetting: (key: string, value: string) => void;
  let getPenalty: (modelDbId: number) => number;
  let recordFailure: (modelDbId: number, tier: 'minor' | 'major') => void;
  let initDegradation: () => void;
  let getKeyHealth: (keyId: number) => any;
  let isKeyHealthy: (keyId: number) => boolean;
  let resetHeartbeatConfig: () => void;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 6, 1, 12, 0, 0));
    process.env.ENCRYPTION_KEY = '0'.repeat(64);

    // Setup provider mock
    chatCompletion = vi.fn();
    const fakeProvider = { name: 'fake', chatCompletion } as any;

    vi.doMock('../../providers/index.js', async (importOriginal) => {
      const actual = await importOriginal() as any;
      return { ...actual, buildProviderFor: () => fakeProvider };
    });

    publishedEvents = [];
    vi.doMock('../../services/events.js', () => ({
      publish: vi.fn((evt: any) => publishedEvents.push(evt)),
    }));

    vi.doMock('../../lib/crypto.js', async (importOriginal) => {
      const actual = await importOriginal() as any;
      return { ...actual, decrypt: vi.fn(() => 'mocked-api-key') };
    });

    // Import fresh modules
    const heartbeatModule = await import('../../services/heartbeat.js');
    const dbModule = await import('../../db/index.js');
    const degradationModule = await import('../../services/degradation.js');

    recordActivity = heartbeatModule.recordActivity;
    startHeartbeat = heartbeatModule.startHeartbeat;
    stopHeartbeat = heartbeatModule.stopHeartbeat;
    getKeyHealth = heartbeatModule.getKeyHealth;
    isKeyHealthy = heartbeatModule.isKeyHealthy;
    resetHeartbeatConfig = heartbeatModule.resetHeartbeatConfig;
    initDb = dbModule.initDb;
    getDb = dbModule.getDb;
    setSetting = dbModule.setSetting;
    getPenalty = degradationModule.getPenalty;
    recordFailure = degradationModule.recordFailure;
    initDegradation = degradationModule.initDegradation;

    initDb(':memory:');
    initDegradation();

    // Enable heartbeat via DB setting
    setSetting('heartbeat_enabled', 'true');
    setSetting('heartbeat_interval_min', '10');
    setSetting('heartbeat_activity_window_min', '15');
    setSetting('heartbeat_stagger_ms', '0'); // No stagger in tests to avoid timing issues
  });

  afterEach(() => {
    stopHeartbeat();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setupProvider(platform = 'testprov', modelId = 'test-model') {
    const db = getDb();
    db.prepare('DELETE FROM fallback_config').run();
    db.prepare(`INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('${platform}', '${modelId}', 'Test Model', 1, 1, 1)`).run();
    const id = (db.prepare(`SELECT id FROM models WHERE platform = '${platform}' AND model_id = '${modelId}'`).get() as any).id;
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(id);
    db.prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('${platform}', 'Key 1', 'enc', 'iv', 'tag', 'healthy', 1)`).run();
    const keyRow = db.prepare("SELECT id FROM api_keys WHERE platform = ? AND enabled = 1").get(platform) as any;
    return { modelDbId: id, keyId: keyRow.id };
  }

  // ── Activity Gating ────────────────────────────────────────────────────

  describe('Activity gating', () => {
    it('cycle is skipped when no activity has ever occurred', async () => {
      startHeartbeat();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

      const skipEvents = publishedEvents.filter(e => e.type === 'heartbeat.cycle_skipped');
      expect(skipEvents.length).toBeGreaterThanOrEqual(1);
      expect(skipEvents[0].reason).toBe('activity_gate');
      expect(skipEvents[0].lastActivityAgeMs).toBe(-1);
    });

    it('cycle is skipped when last activity is older than the activity window', async () => {
      recordActivity();
      // Advance past the activity window (15 min)
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);

      startHeartbeat();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

      const skipEvents = publishedEvents.filter(e => e.type === 'heartbeat.cycle_skipped');
      expect(skipEvents.length).toBeGreaterThanOrEqual(1);
      expect(skipEvents[0].reason).toBe('activity_gate');
      expect(skipEvents[0].lastActivityAgeMs).toBeGreaterThan(15 * 60 * 1000);
    });

    it('cycle proceeds when activity is recent', async () => {
      setupProvider();
      // Use mockResolvedValue (not Once) so both warmup and interval cycles
      // get a successful response.
      chatCompletion.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'hi' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      recordActivity();
      startHeartbeat();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

      const pingEvents = publishedEvents.filter(e => e.type === 'heartbeat.ping');
      expect(pingEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── Ping Classification ─────────────────────────────────────────────────

  describe('Ping success/failure classification', () => {
    it('successful ping records success and reduces degradation penalty', async () => {
      const { modelDbId, keyId } = setupProvider();

      // Add some penalty first
      recordFailure(modelDbId, 'major');
      const penaltyBefore = getPenalty(modelDbId);
      expect(penaltyBefore).toBeGreaterThan(0);

      // Use mockResolvedValue (not Once) so both the warmup and interval cycles
      // get a successful response. The warmup fires immediately on startHeartbeat().
      chatCompletion.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'pong' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      recordActivity();
      startHeartbeat();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

      const pingEvents = publishedEvents.filter(e => e.type === 'heartbeat.ping');
      expect(pingEvents.length).toBeGreaterThanOrEqual(1);
      expect(pingEvents[0].success).toBe(true);
      expect(pingEvents[0].provider).toBe('testprov');
      expect(pingEvents[0].keyId).toBe(keyId);
      expect(pingEvents[0].latencyMs).toBeGreaterThanOrEqual(0);

      // Penalty should have decreased
      expect(getPenalty(modelDbId)).toBeLessThan(penaltyBefore);

      // Per-key health should be healthy
      expect(isKeyHealthy(keyId)).toBe(true);
    });

    it('failed ping (5xx) records major failure and increases penalty', async () => {
      const { modelDbId, keyId } = setupProvider();

      // Use mockRejectedValue (not Once) so both warmup and interval cycles
      // consistently get a failure response.
      chatCompletion.mockRejectedValue(new Error('503 Service Unavailable'));

      recordActivity();
      startHeartbeat();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

      const pingEvents = publishedEvents.filter(e => e.type === 'heartbeat.ping');
      expect(pingEvents.length).toBeGreaterThanOrEqual(1);
      expect(pingEvents[0].success).toBe(false);
      expect(pingEvents[0].keyId).toBe(keyId);
      expect(pingEvents[0].error).toBeDefined();

      expect(getPenalty(modelDbId)).toBeGreaterThan(0);

      // Per-key health should be unhealthy
      expect(isKeyHealthy(keyId)).toBe(false);
      const health = getKeyHealth(keyId);
      expect(health).toBeDefined();
      expect(health.penalty).toBeGreaterThan(0);
    });

    it('failed ping (429) records minor failure', async () => {
      const { modelDbId, keyId } = setupProvider();

      chatCompletion.mockRejectedValue(new Error('429 Rate limited'));

      recordActivity();
      startHeartbeat();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

      const pingEvents = publishedEvents.filter(e => e.type === 'heartbeat.ping');
      expect(pingEvents.length).toBeGreaterThanOrEqual(1);
      expect(pingEvents[0].success).toBe(false);
      expect(pingEvents[0].keyId).toBe(keyId);

      expect(getPenalty(modelDbId)).toBeGreaterThan(0);
      expect(isKeyHealthy(keyId)).toBe(false);
    });

    it('non-retryable error (401) does NOT penalize the model but marks key unhealthy', async () => {
      const { modelDbId, keyId } = setupProvider();

      chatCompletion.mockRejectedValue(new Error('401 Unauthorized'));

      recordActivity();
      startHeartbeat();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);

      const pingEvents = publishedEvents.filter(e => e.type === 'heartbeat.ping');
      expect(pingEvents.length).toBeGreaterThanOrEqual(1);
      expect(pingEvents[0].success).toBe(false);

      // Non-retryable errors don't penalize model-level degradation
      expect(getPenalty(modelDbId)).toBe(0);

      // But the key is still marked unhealthy per-key
      expect(isKeyHealthy(keyId)).toBe(false);
    });
  });

  // ── Cold Key Handling ──────────────────────────────────────────────────

  describe('Cold key handling', () => {
    it('isKeyHealthy returns false for a cold key when heartbeat is enabled', () => {
      // Heartbeat is enabled in beforeEach — cold keys must be prewarmed
      expect(isKeyHealthy(999)).toBe(false);
    });

    it('isKeyHealthy returns true for a cold key when heartbeat is disabled (backward compat)', () => {
      // Disable heartbeat
      setSetting('heartbeat_enabled', 'false');
      resetHeartbeatConfig();

      // When heartbeat is off, cold keys are assumed healthy for backward compat
      expect(isKeyHealthy(999)).toBe(true);
    });

    it('isKeyHealthy returns true after a successful warmup ping', async () => {
      const { modelDbId, keyId } = setupProvider();

      // Key starts cold (not yet pinged)
      expect(isKeyHealthy(keyId)).toBe(false);

      chatCompletion.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'pong' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      recordActivity();
      startHeartbeat();

      // The warmup cycle fires immediately — wait for it to complete
      // by advancing a microtask tick
      await vi.advanceTimersByTimeAsync(0);

      // After warmup, the key should be healthy
      expect(isKeyHealthy(keyId)).toBe(true);
      const health = getKeyHealth(keyId);
      expect(health).toBeDefined();
      expect(health.healthy).toBe(true);
    });
  });

  // ── Per-Key Pinging ────────────────────────────────────────────────────

  describe('Per-key pinging', () => {
    it('pings each key once per cycle even across multiple models (warmup cycle)', async () => {
      const db = getDb();
      db.prepare('DELETE FROM fallback_config').run();

      db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('multikey', 'model-a', 'Model A', 1, 1, 1)").run();
      db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('multikey', 'model-b', 'Model B', 2, 2, 1)").run();
      const idA = (db.prepare("SELECT id FROM models WHERE model_id = 'model-a' AND platform = 'multikey'").get() as any).id;
      const idB = (db.prepare("SELECT id FROM models WHERE model_id = 'model-b' AND platform = 'multikey'").get() as any).id;

      db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)").run(idA);
      db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 2, 1)").run(idB);

      // One key for the platform — should be pinged only once
      db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('multikey', 'Key 1', 'enc', 'iv', 'tag', 'healthy', 1)").run();

      chatCompletion.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'pong' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      recordActivity();
      startHeartbeat();

      // Advance time by 0 to drain microtask queue (warmup cycle completes)
      await vi.advanceTimersByTimeAsync(0);

      const pingEvents = publishedEvents.filter(e => e.type === 'heartbeat.ping');
      // Key should be pinged exactly once (deduped across models)
      expect(pingEvents.length).toBe(1);
    });

    it('pings multiple keys on the same platform (warmup cycle)', async () => {
      const db = getDb();
      db.prepare('DELETE FROM fallback_config').run();

      db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('twokeys', 'model-a', 'Model A', 1, 1, 1)").run();
      const idA = (db.prepare("SELECT id FROM models WHERE model_id = 'model-a' AND platform = 'twokeys'").get() as any).id;
      db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)").run(idA);

      db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('twokeys', 'Key 1', 'enc1', 'iv1', 'tag1', 'healthy', 1)").run();
      db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('twokeys', 'Key 2', 'enc2', 'iv2', 'tag2', 'healthy', 1)").run();

      chatCompletion.mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'pong' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });

      recordActivity();
      startHeartbeat();

      // Advance time by 0 to drain microtask queue (warmup cycle completes)
      await vi.advanceTimersByTimeAsync(0);

      const pingEvents = publishedEvents.filter(e => e.type === 'heartbeat.ping');
      // Both keys should be pinged
      expect(pingEvents.length).toBe(2);
      expect(pingEvents.every(e => e.success)).toBe(true);
    });
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────

  describe('Lifecycle (start/stop)', () => {
    it('startHeartbeat is a no-op when disabled', () => {
      setSetting('heartbeat_enabled', 'false');
      startHeartbeat();
      vi.advanceTimersByTime(30 * 60 * 1000);
      expect(publishedEvents.length).toBe(0);
    });

    it('stopHeartbeat is safe to call even if never started', () => {
      expect(() => stopHeartbeat()).not.toThrow();
    });

    it('stopHeartbeat clears the timer', () => {
      recordActivity();
      startHeartbeat();
      stopHeartbeat();

      const eventsBefore = publishedEvents.length;
      vi.advanceTimersByTime(10 * 60 * 1000 + 1000);
      expect(publishedEvents.length).toBe(eventsBefore);
    });
  });
});
