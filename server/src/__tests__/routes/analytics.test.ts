import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, path: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    headers: isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {},
  });
  const data = await res.json().catch(() => null);
  server.close();

  return { status: res.status, body: data };
}

function insertRequest(createdAt: string) {
  const db = getDb();
  db.prepare(`
    INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error, created_at)
    VALUES ('test', 'test-model', 'success', 1, 2, 3, NULL, ?)
  `).run(createdAt);
}

function insertTokensRequest(
  platform: string,
  modelId: string,
  status: 'success' | 'error',
  inputTokens: number,
  outputTokens: number,
  createdAt: string,
) {
  const db = getDb();
  db.prepare(`
    INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error, created_at)
    VALUES (?, ?, ?, ?, ?, 3, NULL, ?)
  `).run(platform, modelId, status, inputTokens, outputTokens, createdAt);
}

function insertKey(platform: string, enabled = 1) {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', ?, ?, ?, 'healthy', ?)
  `).run(platform, '0'.repeat(64), '0'.repeat(32), '0'.repeat(32), enabled);
}

function insertModel(platform: string, modelId: string, enabled = 1) {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled)
    VALUES (?, ?, ?, 1, 1, ?)
  `).run(platform, modelId, modelId, enabled);
}

function insertFallbackConfig(platform: string, modelId: string, enabled = 1) {
  const db = getDb();
  const model = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get(platform, modelId) as { id: number } | undefined;
  if (!model) return;
  db.prepare(`
    INSERT OR IGNORE INTO fallback_config (model_db_id, priority, enabled)
    VALUES (?, 99, ?)
  `).run(model.id, enabled);
}

function insertErrorRequest(
  platform: string,
  modelId: string,
  error: string,
  createdAt: string,
) {
  const db = getDb();
  db.prepare(`
    INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error, created_at)
    VALUES (?, ?, 'error', 0, 0, 3, ?, ?)
  `).run(platform, modelId, error, createdAt);
}

describe('Analytics API', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM requests').run();
    getDb().prepare('DELETE FROM api_keys').run();
    getDb().prepare('DELETE FROM fallback_config').run();
    // Seed keys and models so the active-provider filter includes these platforms' data.
    // Models use INSERT OR IGNORE to avoid UNIQUE conflicts with initDb-seeded rows.
    insertKey('test', 1);
    insertKey('groq', 1);
    insertKey('custom', 1);
    insertModel('test', 'test-model');
    insertModel('test', 'model-a');
    insertModel('test', 'model-b');
    insertModel('groq', 'llama-3.3-70b-versatile');
    insertModel('custom', 'mystery-model');
    insertFallbackConfig('test', 'test-model', 1);
    insertFallbackConfig('test', 'model-a', 1);
    insertFallbackConfig('test', 'model-b', 1);
    insertFallbackConfig('groq', 'llama-3.3-70b-versatile', 1);
    insertFallbackConfig('custom', 'mystery-model', 1);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-29T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a rolling 24-hour window for summary analytics', async () => {
    insertRequest('2026-05-28 11:59:59');
    insertRequest('2026-05-28 12:00:00');
    insertRequest('2026-05-29 11:59:59');

    const { status, body } = await request(app, '/api/analytics/summary?range=24h');

    expect(status).toBe(200);
    expect(body.totalRequests).toBe(2);
    expect(body.totalInputTokens).toBe(2);
    expect(body.totalOutputTokens).toBe(4);
  });

  it.each([
    ['7d', '2026-05-22 11:59:59', '2026-05-22 12:00:00'],
    ['30d', '2026-04-29 11:59:59', '2026-04-29 12:00:00'],
  ])('uses a rolling %s window for summary analytics', async (range, outside, boundary) => {
    insertRequest(outside);
    insertRequest(boundary);
    insertRequest('2026-05-29 11:59:59');

    const { status, body } = await request(app, `/api/analytics/summary?range=${range}`);

    expect(status).toBe(200);
    expect(body.totalRequests).toBe(2);
  });

  describe('pinned vs auto tracking', () => {
    function insertPinnedRequest(modelId: string, requestedModel: string | null, createdAt: string) {
      getDb().prepare(`
        INSERT INTO requests (platform, model_id, requested_model, status, input_tokens, output_tokens, latency_ms, error, created_at)
        VALUES ('test', ?, ?, 'success', 1, 2, 3, NULL, ?)
      `).run(modelId, requestedModel, createdAt);
    }

    it('summary splits pinned, honored, and auto requests', async () => {
      insertPinnedRequest('model-a', 'model-a', '2026-05-29 11:00:00'); // pin honored
      insertPinnedRequest('model-b', 'model-a', '2026-05-29 11:01:00'); // pin overridden by failover
      insertPinnedRequest('model-b', null, '2026-05-29 11:02:00');      // auto-routed

      const { status, body } = await request(app, '/api/analytics/summary?range=24h');

      expect(status).toBe(200);
      expect(body.totalRequests).toBe(3);
      expect(body.pinnedRequests).toBe(2);
      expect(body.pinHonoredRequests).toBe(1);
    });

    it('by-model counts only requests the model served because it was pinned', async () => {
      insertPinnedRequest('model-a', 'model-a', '2026-05-29 11:00:00'); // pinned + served
      insertPinnedRequest('model-a', null, '2026-05-29 11:01:00');      // auto, same model
      insertPinnedRequest('model-a', 'model-x', '2026-05-29 11:02:00'); // failover landed here

      const { status, body } = await request(app, '/api/analytics/by-model?range=24h');

      expect(status).toBe(200);
      const row = body.find((r: any) => r.modelId === 'model-a');
      expect(row.requests).toBe(3);
      expect(row.pinnedRequests).toBe(1);
    });
  });

  describe('active provider filtering', () => {
    beforeEach(() => {
      // api_keys and requests already cleared by parent beforeEach.
      // Use unique platform names across filter tests so INSERT OR IGNORE doesn't
      // carry stale enabled=1 state between tests.
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-29T12:00:00.000Z'));
    });

    it('excludes requests from providers with no keys (summary)', async () => {
      insertKey('haskey', 1);
      insertModel('haskey', 'm1');
      insertFallbackConfig('haskey', 'm1', 1);
      insertTokensRequest('haskey', 'm1', 'success', 100, 100, '2026-05-29 11:00:00');
      insertTokensRequest('nokey', 'm1', 'success', 100, 100, '2026-05-29 11:00:00');

      const { body } = await request(app, '/api/analytics/summary?range=24h');

      expect(body.totalRequests).toBe(1);
    });

    it('excludes requests from providers with only disabled keys (summary)', async () => {
      insertKey('disabled', 0);
      insertModel('disabled', 'm1');
      insertFallbackConfig('disabled', 'm1', 1);
      insertTokensRequest('disabled', 'm1', 'success', 100, 100, '2026-05-29 11:00:00');

      const { body } = await request(app, '/api/analytics/summary?range=24h');

      expect(body.totalRequests).toBe(0);
      expect(body.successRate).toBe(0);
    });

    it('excludes requests from providers with keys but no enabled models (summary)', async () => {
      insertKey('nomodels', 1);
      // No enabled models for 'nomodels' — intentionally omit insertModel()
      insertTokensRequest('nomodels', 'm1', 'success', 100, 100, '2026-05-29 11:00:00');

      const { body } = await request(app, '/api/analytics/summary?range=24h');

      expect(body.totalRequests).toBe(0);
    });

    it('includes requests once a key is enabled', async () => {
      insertKey('late', 0);
      insertModel('late', 'm1');
      insertFallbackConfig('late', 'm1', 1);
      insertTokensRequest('late', 'm1', 'success', 100, 100, '2026-05-29 11:00:00');

      const before = await request(app, '/api/analytics/summary?range=24h');
      expect(before.body.totalRequests).toBe(0);

      getDb().prepare('UPDATE api_keys SET enabled = 1 WHERE platform = ?').run('late');

      const after = await request(app, '/api/analytics/summary?range=24h');
      expect(after.body.totalRequests).toBe(1);
    });

    it('filters by-platform endpoint', async () => {
      insertKey('active', 1);
      insertModel('active', 'm1');
      insertFallbackConfig('active', 'm1', 1);
      insertTokensRequest('active', 'm1', 'success', 100, 100, '2026-05-29 11:00:00');
      insertTokensRequest('inactive', 'm1', 'success', 100, 100, '2026-05-29 11:00:00');

      const { body } = await request(app, '/api/analytics/by-platform?range=24h');

      expect(body).toHaveLength(1);
      expect(body[0].platform).toBe('active');
    });

    it('filters by-model endpoint', async () => {
      insertKey('active', 1);
      insertModel('active', 'm1');
      insertModel('active', 'm2');
      insertFallbackConfig('active', 'm1', 1);
      insertFallbackConfig('active', 'm2', 1);
      insertTokensRequest('active', 'm1', 'success', 100, 100, '2026-05-29 11:00:00');
      insertTokensRequest('active', 'm2', 'success', 100, 100, '2026-05-29 11:00:00');
      insertTokensRequest('inactive', 'm1', 'success', 100, 100, '2026-05-29 11:00:00');

      const { body } = await request(app, '/api/analytics/by-model?range=24h');

      expect(body).toHaveLength(2);
      expect(body.every((r: any) => r.platform === 'active')).toBe(true);
    });

    it('filters error-distribution endpoint', async () => {
      insertKey('active', 1);
      insertModel('active', 'm1');
      insertFallbackConfig('active', 'm1', 1);
      insertErrorRequest('active', 'm1', '429 rate limit', '2026-05-29 11:00:00');
      insertErrorRequest('inactive', 'm1', '500 internal server', '2026-05-29 11:00:00');

      const { body } = await request(app, '/api/analytics/error-distribution?range=24h');

      expect(body.byPlatform).toHaveLength(1);
      expect(body.byPlatform[0].platform).toBe('active');
    });

    it('filters timeline endpoint', async () => {
      insertKey('tlactive', 1);
      insertModel('tlactive', 'm1');
      insertFallbackConfig('tlactive', 'm1', 1);
      insertTokensRequest('tlactive', 'm1', 'success', 100, 100, '2026-05-29 11:00:00');
      insertTokensRequest('tlinactive', 'm1', 'success', 100, 100, '2026-05-29 11:00:00');

      const { body } = await request(app, '/api/analytics/timeline?range=24h');

      expect(body.length).toBeGreaterThan(0);
      // Only the active provider's request is counted — non-zero buckets should have exactly 1 request
      const nonZeroBuckets = body.filter((pt: any) => pt.requests > 0);
      expect(nonZeroBuckets.length).toBeGreaterThan(0);
      expect(nonZeroBuckets.every((pt: any) => pt.requests === 1)).toBe(true);
    });

    it('filters model-timeline endpoint', async () => {
      insertKey('mtactive', 1);
      insertModel('mtactive', 'm1');
      insertFallbackConfig('mtactive', 'm1', 1);
      insertTokensRequest('mtactive', 'm1', 'success', 100, 100, '2026-05-29 11:00:00');
      insertTokensRequest('mtinactive', 'm1', 'success', 100, 100, '2026-05-29 11:00:00');

      const { body } = await request(app, '/api/analytics/model-timeline?range=24h');

      expect(body.series).toHaveLength(1);
      expect(body.series[0].platform).toBe('mtactive');
      const nonZeroBuckets = body.points.filter((pt: any) => pt.totalRequests > 0);
      expect(nonZeroBuckets.length).toBeGreaterThan(0);
      expect(nonZeroBuckets.every((pt: any) => pt.totalRequests === 1)).toBe(true);
    });

    it('filters errors endpoint', async () => {
      insertKey('erractive', 1);
      insertModel('erractive', 'm1');
      insertFallbackConfig('erractive', 'm1', 1);
      insertErrorRequest('erractive', 'm1', '429 rate limit', '2026-05-29 11:00:00');
      insertErrorRequest('errinactive', 'm1', '500 internal server', '2026-05-29 11:00:00');

      const { body } = await request(app, '/api/analytics/errors?range=24h');

      expect(body).toHaveLength(1);
      expect(body[0].platform).toBe('erractive');
    });
  });

  describe('disabled model filtering in by-model', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-29T12:00:00.000Z'));
    });

    it('includes all models in by-model breakdown regardless of enabled status', async () => {
      insertKey('dm', 1);
      insertModel('dm', 'active-m', 1);
      insertFallbackConfig('dm', 'active-m', 1);
      insertModel('dm', 'disabled-m', 1);
      insertFallbackConfig('dm', 'disabled-m', 0);
      insertTokensRequest('dm', 'active-m', 'success', 100, 100, '2026-05-29 11:00:00');
      insertTokensRequest('dm', 'disabled-m', 'success', 100, 100, '2026-05-29 11:00:00');

      const { body } = await request(app, '/api/analytics/by-model?range=24h');

      const dmRows = body.filter((r: any) => r.platform === 'dm');
      expect(dmRows).toHaveLength(2);
    });

    it('includes untracked model (no models row) in by-model breakdown', async () => {
      insertKey('untracked', 1);
      insertModel('untracked', 'known-m', 1);
      insertFallbackConfig('untracked', 'known-m', 1);
      insertTokensRequest('untracked', 'known-m', 'success', 100, 100, '2026-05-29 11:00:00');
      insertTokensRequest('untracked', 'ghost-m', 'success', 100, 100, '2026-05-29 11:00:00');

      const { body } = await request(app, '/api/analytics/by-model?range=24h');

      const utRows = body.filter((r: any) => r.platform === 'untracked');
      expect(utRows).toHaveLength(2);
      expect(utRows.map((r: any) => r.modelId).sort()).toEqual(['ghost-m', 'known-m']);
    });

    it('includes all models regardless of fallback_config enabled status', async () => {
      insertKey('retoggle', 1);
      insertModel('retoggle', 'm1', 1);
      insertFallbackConfig('retoggle', 'm1', 0);
      insertTokensRequest('retoggle', 'm1', 'success', 100, 100, '2026-05-29 11:00:00');

      const { body } = await request(app, '/api/analytics/by-model?range=24h');
      const rtRows = body.filter((r: any) => r.platform === 'retoggle');
      expect(rtRows).toHaveLength(1);
      expect(rtRows[0].modelId).toBe('m1');
      expect(rtRows[0].requests).toBe(1);
    });

    it('by-platform includes traffic from all models regardless of fallback enabled status', async () => {
      insertKey('dm2', 1);
      insertModel('dm2', 'active-m2', 1);
      insertFallbackConfig('dm2', 'active-m2', 1);
      insertModel('dm2', 'disabled-m2', 1);
      insertFallbackConfig('dm2', 'disabled-m2', 0);
      insertTokensRequest('dm2', 'active-m2', 'success', 100, 100, '2026-05-29 11:00:00');
      insertTokensRequest('dm2', 'disabled-m2', 'success', 100, 100, '2026-05-29 11:00:00');

      const { body } = await request(app, '/api/analytics/by-platform?range=24h');

      const dm2Row = body.find((r: any) => r.platform === 'dm2');
      expect(dm2Row).toBeDefined();
      // Both models counted regardless of fallback_config enabled status
      expect(dm2Row.requests).toBe(2);
    });

    it('by-model request counts match summary total', async () => {
      insertKey('cons', 1);
      insertModel('cons', 'fc-on', 1);
      insertFallbackConfig('cons', 'fc-on', 1);
      insertModel('cons', 'fc-off', 1);
      insertFallbackConfig('cons', 'fc-off', 0);
      // 10 requests for fallback-enabled model, 5 for disabled
      for (let i = 0; i < 10; i++) {
        insertTokensRequest('cons', 'fc-on', 'success', 10, 20, '2026-05-29 11:00:00');
      }
      for (let i = 0; i < 5; i++) {
        insertTokensRequest('cons', 'fc-off', 'success', 10, 20, '2026-05-29 11:00:00');
      }

      const byModel = await request(app, '/api/analytics/by-model?range=24h');
      const summary = await request(app, '/api/analytics/summary?range=24h');
      const byPlatform = await request(app, '/api/analytics/by-platform?range=24h');

      // by-model should only show fc-on with 10 requests
      const consRows = byModel.body.filter((r: any) => r.platform === 'cons');
      expect(consRows).toHaveLength(2);
      expect(consRows.reduce((sum: number, r: any) => sum + r.requests, 0)).toBe(15);

      // summary total should include all models
      expect(summary.body.totalRequests).toBe(15);

      // by-platform should show cons with 15 requests
      const consPlatform = byPlatform.body.find((r: any) => r.platform === 'cons');
      expect(consPlatform).toBeDefined();
      expect(consPlatform.requests).toBe(15);
    });

    it('includes model disabled in fallback but enabled in models table', async () => {
      insertKey('fb', 1);
      insertModel('fb', 'fallback-off-m', 1);
      insertFallbackConfig('fb', 'fallback-off-m', 0);
      insertTokensRequest('fb', 'fallback-off-m', 'success', 100, 100, '2026-05-29 11:00:00');

      const { body } = await request(app, '/api/analytics/by-model?range=24h');

      const fbRows = body.filter((r: any) => r.platform === 'fb');
      expect(fbRows).toHaveLength(1);
    });
  });

  describe('timeline interval limits', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-29T12:00:00.000Z'));
    });

    it('coerces minute buckets to daily buckets for 30d timelines', async () => {
      const { status, body } = await request(app, '/api/analytics/timeline?range=30d&interval=minute');

      expect(status).toBe(200);
      expect(body).toHaveLength(31);
      expect(body.every((pt: any) => pt.timestamp.endsWith('T00:00:00Z'))).toBe(true);
    });

    it('coerces 5-minute buckets to daily buckets for 7d model timelines', async () => {
      const { status, body } = await request(app, '/api/analytics/model-timeline?range=7d&interval=5min');

      expect(status).toBe(200);
      expect(body.points).toHaveLength(8);
      expect(body.points.every((pt: any) => pt.timestamp.endsWith('T00:00:00Z'))).toBe(true);
    });

    it('still allows hourly buckets for 30d timelines', async () => {
      const { status, body } = await request(app, '/api/analytics/timeline?range=30d&interval=hour');

      expect(status).toBe(200);
      expect(body).toHaveLength(721);
      expect(body[0].timestamp).toBe('2026-04-29T12:00:00Z');
      expect(body.at(-1).timestamp).toBe('2026-05-29T12:00:00Z');
    });
  });
  describe('hourly productivity buckets', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-29T12:00:00.000Z'));
    });

    it('returns 24 zero-filled buckets when no traffic exists', async () => {
      insertKey('h0empty', 1);
      insertModel('h0empty', 'm1');
      insertFallbackConfig('h0empty', 'm1', 1);

      const { status, body } = await request(app, '/api/analytics/hourly?range=24h');

      expect(status).toBe(200);
      expect(body).toHaveLength(24);
      expect(body[0]).toEqual({
        hour: 0, requests: 0, avgLatencyMs: 0, avgTokPerSec: 0, errorRate: 0, successRate: 0,
      });
    });

    it('groups requests by UTC hour', async () => {
      insertKey('h0utc', 1);
      insertModel('h0utc', 'm1');
      insertFallbackConfig('h0utc', 'm1', 1);
      // 2026-05-29 03:30:00 UTC => hour 3
      insertTokensRequest('h0utc', 'm1', 'success', 100, 100, '2026-05-29 03:30:00');
      // 2026-05-29 22:15:00 UTC => hour 22
      insertTokensRequest('h0utc', 'm1', 'success', 100, 100, '2026-05-29 22:15:00');

      const { body } = await request(app, '/api/analytics/hourly?range=24h');

      expect(body[3].requests).toBe(1);
      expect(body[22].requests).toBe(1);
      expect(body[0].requests).toBe(0);
      expect(body).toHaveLength(24);
    });

    it('counts error rate and computes avg tok_per_sec', async () => {
      insertKey('h0err', 1);
      insertModel('h0err', 'm1');
      insertFallbackConfig('h0err', 'm1', 1);
      // 1 success + 1 error within the same hour => 50% error rate
      insertTokensRequest('h0err', 'm1', 'success', 0, 100, '2026-05-29 11:10:00');
      insertErrorRequest('h0err', 'm1', '500 internal server', '2026-05-29 11:20:00');

      const { body } = await request(app, '/api/analytics/hourly?range=24h');

      const h11 = body[11];
      expect(h11.requests).toBe(2);
      expect(h11.errorRate).toBe(50);
      expect(h11.successRate).toBe(50);
    });

    it('zero-fills all 24 hours for the 30d range when the window is too coarse', async () => {
      insertKey('h30', 1);
      insertModel('h30', 'm1');
      insertFallbackConfig('h30', 'm1', 1);
      insertTokensRequest('h30', 'm1', 'success', 10, 10, '2026-05-29 01:00:00');

      const { status, body } = await request(app, '/api/analytics/hourly?range=30d');

      expect(status).toBe(200);
      expect(body).toHaveLength(24);
      expect(body[1].requests).toBe(1);
    });
  });

  describe('pings-hourly collapsed baseline', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-29T12:00:00.000Z'));
    });

    it('returns 24 zero-filled buckets when no pings', async () => {
      insertKey('pempty', 1);
      insertModel('pempty', 'm1');
      insertFallbackConfig('pempty', 'm1', 1);

      const { status, body } = await request(app, '/api/analytics/pings-hourly?range=24h');

      expect(status).toBe(200);
      expect(body).toHaveLength(24);
      expect(body[0]).toEqual({ hour: 0, requests: 0, avgLatencyMs: 0, errorRate: 0, successRate: 0 });
    });

    it('groups pings by UTC hour', async () => {
      insertKey('pghour', 1);
      insertModel('pghour', 'm1');
      insertFallbackConfig('pghour', 'm1', 1);
      const db = getDb();
      db.prepare(
        "INSERT OR IGNORE INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES (100, 'pghour', 'k', ?, ?, ?, 'healthy', 1)",
      ).run('0'.repeat(64), '0'.repeat(32), '0'.repeat(32));
      db.prepare(
        "INSERT INTO ping_history (platform, model_id, key_id, success, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run('pghour', 'm1', 100, 1, 50, '2026-05-29 03:30:00');
      db.prepare(
        "INSERT INTO ping_history (platform, model_id, key_id, success, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run('pghour', 'm1', 100, 1, 70, '2026-05-29 22:15:00');

      const { status, body } = await request(app, '/api/analytics/pings-hourly?range=24h');

      expect(status).toBe(200);
      expect(body).toHaveLength(24);
      expect(body[3].requests).toBe(1);
      expect(body[3].avgLatencyMs).toBe(50);
      expect(body[22].requests).toBe(1);
      expect(body[22].avgLatencyMs).toBe(70);
      expect(body[0].requests).toBe(0);
    });

    it('computes error rate from failed pings', async () => {
      insertKey('pgerr', 1);
      insertModel('pgerr', 'm1');
      insertFallbackConfig('pgerr', 'm1', 1);
      const db = getDb();
      db.prepare(
        "INSERT OR IGNORE INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES (200, 'pgerr', 'k', ?, ?, ?, 'healthy', 1)",
      ).run('0'.repeat(64), '0'.repeat(32), '0'.repeat(32));
      db.prepare(
        "INSERT INTO ping_history (platform, model_id, key_id, success, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run('pgerr', 'm1', 200, 1, 50, '2026-05-29 11:00:00');
      db.prepare(
        "INSERT INTO ping_history (platform, model_id, key_id, success, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run('pgerr', 'm1', 200, 0, 200, '2026-05-29 11:30:00');

      const { status, body } = await request(app, '/api/analytics/pings-hourly?range=24h');

      expect(status).toBe(200);
      expect(body).toHaveLength(24);
      // 1 success + 1 failure → 50% error rate
      expect(body[11].requests).toBe(2);
      expect(body[11].errorRate).toBe(50);
      expect(body[11].avgLatencyMs).toBe(125);
    });

    it('respects the active-platform filter', async () => {
      // pghost: has a ping, but no enabled key → should be filtered
      const db = getDb();
      db.prepare(
        "INSERT OR IGNORE INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES (300, 'pghost', 'k', ?, ?, ?, 'healthy', 0)",
      ).run('0'.repeat(64), '0'.repeat(32), '0'.repeat(32));
      db.prepare(
        "INSERT INTO ping_history (platform, model_id, key_id, success, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run('pghost', 'm1', 300, 1, 50, '2026-05-29 04:00:00');

      const { status, body } = await request(app, '/api/analytics/pings-hourly?range=24h');

      expect(status).toBe(200);
      expect(body).toHaveLength(24);
      expect(body[4].requests).toBe(0);
    });
  });

  describe('model-timeline stacked series', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-29T12:00:00.000Z'));
    });

    it('returns top models plus Other with zero-filled timeline points', async () => {
      insertKey('stacked', 1);
      insertModel('stacked', 'm1');
      insertModel('stacked', 'm2');
      insertModel('stacked', 'm3');
      insertFallbackConfig('stacked', 'm1', 1);
      insertFallbackConfig('stacked', 'm2', 1);
      insertFallbackConfig('stacked', 'm3', 1);

      for (let i = 0; i < 3; i++) {
        insertTokensRequest('stacked', 'm1', 'success', 100, 100, '2026-05-29 11:00:00');
      }
      for (let i = 0; i < 2; i++) {
        insertTokensRequest('stacked', 'm2', 'success', 100, 100, '2026-05-29 11:00:00');
      }
      insertTokensRequest('stacked', 'm3', 'success', 100, 100, '2026-05-29 11:00:00');

      const { status, body } = await request(app, '/api/analytics/model-timeline?range=24h&limit=2');

      expect(status).toBe(200);
      expect(body.series.map((s: any) => s.key)).toEqual(['model_0', 'model_1', 'other']);
      expect(body.series.map((s: any) => s.modelId)).toEqual(['m1', 'm2', '__other__']);
      expect(body.points.length).toBeGreaterThan(1);

      const nonZeroBuckets = body.points.filter((pt: any) => pt.totalRequests > 0);
      expect(nonZeroBuckets).toHaveLength(1);
      expect(nonZeroBuckets[0].totalRequests).toBe(6);
      expect(nonZeroBuckets[0].model_0).toBe(3);
      expect(nonZeroBuckets[0].model_1).toBe(2);
      expect(nonZeroBuckets[0].other).toBe(1);
    });
  });

  describe('tok/s computation in by-model', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-29T12:00:00.000Z'));
    });

    function insertTokRequest(
      platform: string,
      modelId: string,
      outputTokens: number,
      reasoningTokens: number,
      latencyMs: number,
      createdAt: string,
      inputTokens = 0,
    ) {
      getDb().prepare(`
        INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, reasoning_tokens, latency_ms, error, created_at)
        VALUES (?, ?, 'success', ?, ?, ?, ?, NULL, ?)
      `).run(platform, modelId, inputTokens, outputTokens, reasoningTokens, latencyMs, createdAt);
    }

    it('includes reasoning_tokens in tok_per_sec computation', async () => {
      // 90 output + 10 reasoning = 100 total tokens; 1000 ms → 100 tok/s
      insertTokRequest('test', 'test-model', 90, 10, 1_000, '2026-05-29 11:00:00');

      const { status, body } = await request(app, '/api/analytics/by-model?range=24h');

      expect(status).toBe(200);
      const row = body.find((r: any) => r.modelId === 'test-model');
      expect(row).toBeDefined();
      expect(row.tokPerSec).toBe(100);
      // Without reasoning_tokens the formula would yield 90; confirm they're included
      expect(row.totalOutputTokens).toBe(90);
      expect(row.totalReasoningTokens).toBe(10);
    });

    it('returns empty array when there are no requests', async () => {
      // Parent beforeEach clears requests — no inserts means zero data
      const { status, body } = await request(app, '/api/analytics/by-model?range=24h');

      expect(status).toBe(200);
      expect(body).toEqual([]);
    });

    it('handles zero latency gracefully', async () => {
      insertTokRequest('test', 'test-model', 100, 50, 0, '2026-05-29 11:00:00');

      const { status, body } = await request(app, '/api/analytics/by-model?range=24h');

      expect(status).toBe(200);
      const row = body.find((r: any) => r.modelId === 'test-model');
      expect(row).toBeDefined();
      expect(row.tokPerSec).toBe(0);
    });
  });
});
