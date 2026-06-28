import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, getSetting, initDb, setSetting } from "../../db/index.js";
import { getBoost, initDegradation } from "../../services/degradation.js";
import {
  applyAdvice,
  buildAdvisoryMessages,
  buildAdvisoryPayload,
  parseAdviceResponse,
  truncateToTokenBudget,
} from "../../services/heartbeat-advisor.js";
import { isOnCooldown } from "../../services/ratelimit.js";

describe("Heartbeat AI routing advisor", () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = "0".repeat(64);
    initDb(":memory:");
    initDegradation();
  });

  beforeEach(() => {
    const db = getDb();
    db.exec(`
        DELETE FROM fallback_config;
        DELETE FROM api_keys;
        DELETE FROM requests;
        DELETE FROM key_stats_temp;
        DELETE FROM oscillator_results;
        DELETE FROM rate_limit_cooldowns;
        DELETE FROM models;
        DELETE FROM settings
        WHERE key LIKE 'heartbeat_advisor_%'
           OR key LIKE 'oscillator_%'
           OR key IN ('routing_strategy', 'routing_custom_weights');
      `);
    initDegradation();
    setSetting("heartbeat_advisor_max_input_tokens", "400");
  });

  function seedProvider() {
    const db = getDb();
    db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled)
      VALUES ('testprov', 'test-model', 'Test Model', 1, 1, 1)
    `).run();
    const modelDbId = (
      db
        .prepare(
          "SELECT id FROM models WHERE platform = 'testprov' AND model_id = 'test-model'",
        )
        .get() as { id: number }
    ).id;
    db.prepare(
      "INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)",
    ).run(modelDbId);
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('testprov', 'Key 1', 'sk-secret-value', 'iv', 'tag', 'healthy', 1)
    `).run();
    const keyId = (
      db
        .prepare("SELECT id FROM api_keys WHERE platform = 'testprov'")
        .get() as { id: number }
    ).id;
    db.prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, output_tokens, reasoning_tokens, latency_ms, ttfb_ms, request_type, created_at)
      VALUES
        ('testprov', 'test-model', ?, 'success', 100, 10, 1000, 120, 'chat', datetime('now')),
        ('testprov', 'test-model', ?, 'error', 0, 0, 2000, NULL, 'chat', datetime('now'))
    `).run(keyId, keyId);
    db.prepare(`
      INSERT INTO key_stats_temp (
        platform, model_id, key_id, successes, failures, tokPerSec, avgTtfbMs,
        totalRequests, advisorScore, advisorConfidence, advisorUpdatedAt
      )
      VALUES ('testprov', 'test-model', ?, 1, 1, 110, 120, 2, 3, 7, 123456)
    `).run(keyId);
    return { modelDbId, keyId };
  }

  it("parses JSON, compact text, and garbage safely", () => {
    expect(
      parseAdviceResponse(
        '{"confidence":7,"selfScore":-4,"cooldownHint":1,"recheckSooner":true}',
      ),
    ).toMatchObject({
      confidence: 7,
      selfScore: -4,
      cooldownHint: 1,
      recheckSooner: true,
    });

    expect(
      parseAdviceResponse("c:8 self:3 cooldown:2 recheck:true"),
    ).toMatchObject({
      confidence: 8,
      selfScore: 3,
      cooldownHint: 2,
      recheckSooner: true,
    });

    expect(
      parseAdviceResponse(
        '{"confidence":7,"selfScore":2,"cooldownHint":0,"recheckSooner":false',
      ),
    ).toMatchObject({
      confidence: 7,
      selfScore: 2,
      cooldownHint: 0,
      recheckSooner: false,
    });

    expect(
      parseAdviceResponse(
        "confidence: 6 selfScore: -2 cooldownHint: 1 recheckSooner: yes",
      ),
    ).toMatchObject({
      confidence: 6,
      selfScore: -2,
      cooldownHint: 1,
      recheckSooner: true,
    });

    expect(parseAdviceResponse("not advice")).toMatchObject({
      confidence: 0,
      selfScore: 0,
      cooldownHint: 0,
      recheckSooner: false,
    });
  });

  it("parses Iterative Refinement oscillator advice fields from JSON", () => {
    expect(
      parseAdviceResponse(
        '{"confidence":8,"selfScore":1,"cooldownHint":0,"recheckSooner":false,"oscillatorHint":"enable","injectionModel":"other/test-model","injectionBrevity":"shorter"}',
      ),
    ).toMatchObject({
      confidence: 8,
      selfScore: 1,
      cooldownHint: 0,
      recheckSooner: false,
      oscillatorHint: "enable",
      injectionModel: "other/test-model",
      injectionBrevity: "shorter",
    });
  });

  it("parses compact Iterative Refinement oscillator advice aliases", () => {
    expect(
      parseAdviceResponse(
        "c:6 self:0 cooldown:0 recheck:false o:d i:other/test-model b:l",
      ),
    ).toMatchObject({
      confidence: 6,
      selfScore: 0,
      cooldownHint: 0,
      recheckSooner: false,
      oscillatorHint: "disable",
      injectionModel: "other/test-model",
      injectionBrevity: "longer",
    });

    expect(
      parseAdviceResponse("o:\"enabled\" i:'intelligence_rank:2' b:short"),
    ).toMatchObject({
      oscillatorHint: "enable",
      injectionModel: "intelligence_rank:2",
      injectionBrevity: "shorter",
    });

    expect(
      parseAdviceResponse(
        '{"oscillatorHint":"disabled","injectionModel":"\'other/test-model\'","injectionBrevity":"long"}',
      ),
    ).toMatchObject({
      oscillatorHint: "disable",
      injectionModel: "other/test-model",
      injectionBrevity: "longer",
    });
  });

  it("builds sanitized payloads without key material or raw error text", () => {
    const { modelDbId, keyId } = seedProvider();
    const payload = buildAdvisoryPayload({
      platform: "testprov",
      modelDbId,
      modelId: "test-model",
      keyId,
      keyHealth: new Map([
        [
          `${keyId}:test-model`,
          {
            penalty: 2,
            healthy: false,
            lastError: "401 Unauthorized for sk-secret-value",
            lastPingLatencyMs: 321,
          },
        ],
      ]),
    });

    const json = JSON.stringify(payload);
    expect(json).not.toContain("sk-secret-value");
    expect(json).not.toContain("Unauthorized");
    expect(json).toContain("auth_error");
    expect(payload.keys[0].models[0].lastPingLatencyMs).toBe(321);
    expect(payload.keys[0].models[0].stats).toMatchObject({
      tokPerSec: 110,
      avgTtfbMs: 120,
      successes: 1,
      failures: 1,
      totalRequests: 2,
    });
    expect(payload.keys[0].models[0].advisor).toMatchObject({
      score: 3,
      confidence: 7,
      updatedAt: 123456,
    });
    expect(payload.models[0].stats.successRate).toBe(0.5);
  });

  it("includes collected oscillator metrics in advisory payloads", () => {
    const { modelDbId, keyId } = seedProvider();
    const db = getDb();
    db.prepare(`
      INSERT INTO oscillator_results (
        session_key,
        foundation_model_db_id,
        injection_model_db_id,
        total_latency_ms,
        complete,
        status,
        anomaly_detected
      )
      VALUES ('thread-advisor', ?, ?, 1500, 1, 'completed', 0)
    `).run(modelDbId, modelDbId);

    const payload = buildAdvisoryPayload({
      platform: "testprov",
      modelDbId,
      modelId: "test-model",
      keyId,
      keyHealth: new Map(),
    });

    expect(payload.oscillator).toMatchObject({
      attempts: 1,
      successes: 1,
      failures: 0,
      avgLatencyMs: 1500,
      anomalyCount: 0,
    });
  });

  it("truncates the advisory prompt to the approximate token budget", () => {
    const { modelDbId, keyId } = seedProvider();
    const payload = buildAdvisoryPayload({
      platform: "testprov",
      modelDbId,
      modelId: "test-model",
      keyId,
      keyHealth: new Map(),
    });
    payload.models.push(
      ...Array.from({ length: 50 }, (_, i) => ({
        model: `extra-${i}`,
        provider: "other",
        stats: {
          successRate: 1,
          avgLatencyMs: 100,
          p95LatencyMs: 200,
          tokPerSec: 50,
          avgTtfbMs: 20,
        },
      })),
    );

    const truncated = truncateToTokenBudget(payload, 120);
    const { estimatedInputTokens, messages } = buildAdvisoryMessages(
      truncated,
      120,
    );
    const systemPrompt = String(messages[0].content);
    expect(estimatedInputTokens).toBeLessThanOrEqual(120);
    expect(systemPrompt).toContain("oscillatorHint");
    expect(systemPrompt).toContain("i:<provider/model");
    expect(systemPrompt).toContain("b:<s|l|d>");
  });

  it("applies advice with capped boost, cooldown, and recheck scheduling", () => {
    const { modelDbId, keyId } = seedProvider();
    const scheduled: Array<{
      keyId: number;
      modelId: string;
      delayMs: number;
    }> = [];

    const results = applyAdvice({
      advice: {
        confidence: 9,
        selfScore: 9,
        cooldownHint: 2,
        recheckSooner: true,
      },
      modelDbId,
      platform: "testprov",
      modelId: "test-model",
      keyId,
      normalRecheckDelayMs: 100_000,
      scheduleRecheck: (scheduledKeyId, modelId, delayMs) => {
        scheduled.push({ keyId: scheduledKeyId, modelId, delayMs });
      },
    });

    expect(results.map((result) => result.applied)).toEqual([
      "score_boost",
      "key_score_boost",
      "cooldown_reduce",
      "recheck_scheduled",
    ]);
    expect(getBoost(modelDbId)).toBe(2);
    expect(isOnCooldown("testprov", "test-model", keyId)).toBe(true);
    expect(scheduled).toEqual([
      { keyId, modelId: "test-model", delayMs: 50_000 },
    ]);
    const keyStats = getDb()
      .prepare(
        `SELECT advisorScore, advisorConfidence, advisorUpdatedAt
         FROM key_stats_temp
         WHERE platform = 'testprov' AND model_id = 'test-model' AND key_id = ?`,
      )
      .get(keyId) as {
      advisorScore: number;
      advisorConfidence: number;
      advisorUpdatedAt: number | null;
    };
    expect(keyStats.advisorScore).toBe(9);
    expect(keyStats.advisorConfidence).toBe(9);
    expect(keyStats.advisorUpdatedAt).toBeGreaterThan(0);
  });

  it("applies confident Iterative Refinement injection model advice", () => {
    const { modelDbId, keyId } = seedProvider();
    const db = getDb();
    db.prepare(`
        INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled)
        VALUES ('other', 'test-model', 'Other Test Model', 2, 2, 1)
      `).run();
    const injectionModelDbId = (
      db
        .prepare(
          "SELECT id FROM models WHERE platform = 'other' AND model_id = 'test-model'",
        )
        .get() as { id: number }
    ).id;

    const results = applyAdvice({
      advice: {
        confidence: 8,
        selfScore: 0,
        cooldownHint: 0,
        recheckSooner: false,
        oscillatorHint: "enable",
        injectionModel: " other / test-model ",
        injectionBrevity: "shorter",
      },
      modelDbId,
      platform: "testprov",
      modelId: "test-model",
      keyId,
    });

    expect(results.map((result) => result.applied)).toEqual([
      "no_opinion",
      "injection_adjusted",
      "injection_adjusted",
    ]);
    // oscillatorHint 'enable' with high confidence returns no_opinion (strategy selection is the toggle)
    expect(getSetting("oscillator_injection_selection")).toBe(
      String(injectionModelDbId),
    );
    expect(getSetting("oscillator_injection_max_sentences")).toBe("1");

    const rankResults = applyAdvice({
      advice: {
        confidence: 6,
        selfScore: 0,
        cooldownHint: 0,
        recheckSooner: false,
        injectionModel: "intelligence_rank : 2",
      },
      modelDbId,
      platform: "testprov",
      modelId: "test-model",
      keyId,
    });

    expect(rankResults).toContainEqual({
      applied: "injection_adjusted",
      modelDbId: injectionModelDbId,
      magnitude: injectionModelDbId,
    });
    expect(getSetting("oscillator_injection_selection")).toBe(
      String(injectionModelDbId),
    );
  });

  it("ignores oscillator disable advice when Iterative Refinement is strategy-selected", () => {
    const { modelDbId, keyId } = seedProvider();

    // Since oscillator is enabled by strategy selection, disable advice is no_opinion
    expect(
      applyAdvice({
        advice: {
          confidence: 3,
          selfScore: 0,
          cooldownHint: 0,
          recheckSooner: false,
          oscillatorHint: "disable",
        },
        modelDbId,
        platform: "testprov",
        modelId: "test-model",
        keyId,
      }),
    ).toEqual([{ applied: "no_opinion", modelDbId, magnitude: 0 }]);

    // Even with higher confidence, disable is not applied (strategy change required)
    expect(
      applyAdvice({
        advice: {
          confidence: 9,
          selfScore: 0,
          cooldownHint: 0,
          recheckSooner: false,
          oscillatorHint: "disable",
        },
        modelDbId,
        platform: "testprov",
        modelId: "test-model",
        keyId,
      }),
    ).toEqual([{ applied: "no_opinion", modelDbId, magnitude: 0 }]);
  });
});
