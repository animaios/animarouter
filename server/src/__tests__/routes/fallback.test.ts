import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb, setSetting } from '../../db/index.js';
import { evictGhostStates, initDegradation } from '../../services/degradation.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('Fallback API', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    initDegradation();
    app = createApp();
    dashToken = mintDashboardToken();
  });

  it('GET /api/fallback returns fallback chain', async () => {
    const { status, body } = await request(app, 'GET', '/api/fallback');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    // Should be sorted by priority
    for (let i = 1; i < body.length; i++) {
      expect(body[i].priority).toBeGreaterThanOrEqual(body[i - 1].priority);
    }
  });

  it('GET /api/fallback entries have expected fields', async () => {
    const { body } = await request(app, 'GET', '/api/fallback');
    const first = body[0];
    expect(first).toHaveProperty('modelDbId');
    expect(first).toHaveProperty('priority');
    expect(first).toHaveProperty('enabled');
    expect(first).toHaveProperty('platform');
    expect(first).toHaveProperty('displayName');
    expect(first).toHaveProperty('intelligenceRank');
    expect(first).toHaveProperty('boost');
  });

  it('GET /api/fallback excludes archived models from routing views', async () => {
    const db = getDb();
    const target = db.prepare(`
      SELECT m.id
      FROM models m
      JOIN fallback_config fc ON fc.model_db_id = m.id
      WHERE m.enabled = 1 AND fc.enabled = 1
      LIMIT 1
    `).get() as { id: number } | undefined;
    expect(target).toBeDefined();
    if (!target) return;

    db.prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(target.id);
    try {
      const fallback = await request(app, 'GET', '/api/fallback');
      expect(fallback.status).toBe(200);
      expect(fallback.body.some((entry: any) => entry.modelDbId === target.id)).toBe(false);

      const performance = await request(app, 'GET', '/api/fallback/performance');
      expect(performance.status).toBe(200);
      expect(performance.body.some((entry: any) => entry.modelDbId === target.id)).toBe(false);
    } finally {
      db.prepare('UPDATE models SET enabled = 1 WHERE id = ?').run(target.id);
    }
  });

  it('persists model boost and returns it in fallback entries', async () => {
    const { body: original } = await request(app, 'GET', '/api/fallback');
    const modelDbId = original[0].modelDbId;

    const boosted = await request(app, 'PUT', `/api/fallback/boost/${modelDbId}`, { boost: 2 });
    expect(boosted.status).toBe(200);
    expect(boosted.body.boost).toBe(2);

    const { body: afterBoost } = await request(app, 'GET', '/api/fallback');
    const boostedEntry = afterBoost.find((entry: any) => entry.modelDbId === modelDbId);
    expect(boostedEntry.boost).toBe(2);

    const reset = await request(app, 'DELETE', `/api/fallback/boost/${modelDbId}`);
    expect(reset.status).toBe(200);

    const { body: afterReset } = await request(app, 'GET', '/api/fallback');
    const resetEntry = afterReset.find((entry: any) => entry.modelDbId === modelDbId);
    expect(resetEntry.boost).toBe(1);
  });

  it('keeps model boost until it is manually reset', async () => {
    const { body: original } = await request(app, 'GET', '/api/fallback');
    const modelDbId = original[0].modelDbId;

    const demoted = await request(app, 'PUT', `/api/fallback/boost/${modelDbId}`, { boost: 0.5 });
    expect(demoted.status).toBe(200);
    expect(demoted.body.boost).toBe(0.5);

    expect(evictGhostStates()).not.toContain(modelDbId);

    const { body: afterEviction } = await request(app, 'GET', '/api/fallback');
    const demotedEntry = afterEviction.find((entry: any) => entry.modelDbId === modelDbId);
    expect(demotedEntry.boost).toBe(0.5);

    const reset = await request(app, 'DELETE', `/api/fallback/boost/${modelDbId}`);
    expect(reset.status).toBe(200);
  });

  it('PUT /api/fallback/routing accepts Iterative Refinement strategy', async () => {
      try {
        const { status, body } = await request(app, 'PUT', '/api/fallback/routing', { strategy: 'iterative_refinement' });

        expect(status).toBe(200);
        expect(body.strategy).toBe('iterative_refinement');
        expect(body.presets.iterative_refinement).toEqual({
          reliability: 0.30,
          speed: 0.10,
          intelligence: 0.45,
          latency: 0.15,
        });
      } finally {
        await request(app, 'PUT', '/api/fallback/routing', { strategy: 'balanced' });
      }
    });

  it('PUT /api/fallback updates order', async () => {
    const { body: original } = await request(app, 'GET', '/api/fallback');

    // Reverse the order
    const reversed = original.map((e: any, i: number) => ({
      modelDbId: e.modelDbId,
      priority: original.length - i,
      enabled: e.enabled,
    }));

    const { status } = await request(app, 'PUT', '/api/fallback', reversed);
    expect(status).toBe(200);

    // Verify order changed
    const { body: after } = await request(app, 'GET', '/api/fallback');
    expect(after[0].modelDbId).toBe(original[original.length - 1].modelDbId);

    // Restore original order
    const restore = original.map((e: any, i: number) => ({
      modelDbId: e.modelDbId,
      priority: i + 1,
      enabled: e.enabled,
    }));
    await request(app, 'PUT', '/api/fallback', restore);
  });

  it('GET /api/fallback returns one row per model group when grouping is enabled', async () => {
    setSetting('model_grouping_enabled', 'true');
    try {
      const { status, body } = await request(app, 'GET', '/api/fallback');
      expect(status).toBe(200);
      expect(body.length).toBeGreaterThan(0);
      expect(body.every((entry: any) => entry.isGroup === true)).toBe(true);
      expect(body[0]).toHaveProperty('groupId');
      expect(body[0]).toHaveProperty('groupKey');
      expect(body[0]).toHaveProperty('providerCount');
      expect(Array.isArray(body[0].providers)).toBe(true);
    } finally {
      setSetting('model_grouping_enabled', 'false');
    }
  });

  it('PUT /api/fallback updates grouped manual order by groupId', async () => {
    setSetting('model_grouping_enabled', 'true');
    try {
      const { body: original } = await request(app, 'GET', '/api/fallback');
      expect(original.length).toBeGreaterThan(1);

      const reversed = original.map((entry: any, index: number) => ({
        groupId: entry.groupId,
        priority: original.length - index,
      }));
      const { status } = await request(app, 'PUT', '/api/fallback', reversed);
      expect(status).toBe(200);

      const { body: after } = await request(app, 'GET', '/api/fallback');
      expect(after[0].groupId).toBe(original[original.length - 1].groupId);

      const restore = original.map((entry: any, index: number) => ({
        groupId: entry.groupId,
        priority: index + 1,
      }));
      await request(app, 'PUT', '/api/fallback', restore);
    } finally {
      setSetting('model_grouping_enabled', 'false');
    }
  });

  it('persists group boost across all grouped provider rows', async () => {
    setSetting('model_grouping_enabled', 'true');
    let groupId: number | undefined;
    let providerIds: number[] = [];
    try {
      const { body: original } = await request(app, 'GET', '/api/fallback');
      const group = original.find((entry: any) => entry.isGroup && entry.providers?.length > 0);
      expect(group).toBeDefined();
      if (!group) return;

      groupId = group.groupId;
      providerIds = group.providers.map((provider: any) => provider.modelDbId);

      const boosted = await request(app, 'PUT', `/api/fallback/boost/groups/${groupId}`, { boost: 2 });
      expect(boosted.status).toBe(200);
      expect(boosted.body).toMatchObject({ groupId, boost: 2 });
      expect(boosted.body.modelDbIds.sort((a: number, b: number) => a - b)).toEqual([...providerIds].sort((a, b) => a - b));

      const { body: afterBoost } = await request(app, 'GET', '/api/fallback');
      const boostedGroup = afterBoost.find((entry: any) => entry.groupId === groupId);
      expect(boostedGroup.boost).toBe(2);

      const db = getDb();
      for (const providerId of providerIds) {
        const row = db.prepare('SELECT boost FROM model_degradation WHERE model_db_id = ?').get(providerId) as { boost: number } | undefined;
        expect(row?.boost).toBe(2);
      }

      const reset = await request(app, 'DELETE', `/api/fallback/boost/groups/${groupId}`);
      expect(reset.status).toBe(200);

      const { body: afterReset } = await request(app, 'GET', '/api/fallback');
      const resetGroup = afterReset.find((entry: any) => entry.groupId === groupId);
      expect(resetGroup.boost).toBe(1);
    } finally {
      if (groupId !== undefined) {
        await request(app, 'DELETE', `/api/fallback/boost/groups/${groupId}`);
      }
      setSetting('model_grouping_enabled', 'false');
    }
  });

  it('POST /api/fallback/sort/intelligence sorts by cross-provider tier, then rank', async () => {
    const { status } = await request(app, 'POST', '/api/fallback/sort/intelligence');
    expect(status).toBe(200);

    const { body } = await request(app, 'GET', '/api/fallback');

    // intelligence_rank is per-provider, so the sort normalizes on the
    // cross-provider capability tier (size_label) first (issue #135).
    const tier: Record<string, number> = { Frontier: 1, Large: 2, Medium: 3, Small: 4 };
    const tierOf = (label: string) => tier[label] ?? 5;

    for (let i = 1; i < body.length; i++) {
      const prevTier = tierOf(body[i - 1].sizeLabel);
      const curTier = tierOf(body[i].sizeLabel);
      // Capability tier never decreases...
      expect(curTier).toBeGreaterThanOrEqual(prevTier);
      // ...and within the same tier, per-provider rank breaks the tie.
      if (curTier === prevTier) {
        expect(body[i].intelligenceRank).toBeGreaterThanOrEqual(body[i - 1].intelligenceRank);
      }
    }
  });

  it('intelligence sort never places a weaker tier above a Frontier model (#135)', async () => {
    await request(app, 'POST', '/api/fallback/sort/intelligence');
    const { body } = await request(app, 'GET', '/api/fallback');

    // The last Frontier model must come before the first non-Frontier model —
    // i.e. no "Intel #1 from a weaker provider" leaks above the frontier tier.
    const lastFrontier = body.map((m: any) => m.sizeLabel).lastIndexOf('Frontier');
    const firstNonFrontier = body.findIndex((m: any) => m.sizeLabel !== 'Frontier');
    if (lastFrontier !== -1 && firstNonFrontier !== -1) {
      expect(lastFrontier).toBeLessThan(firstNonFrontier);
    }
  });

  it('POST /api/fallback/sort/speed sorts by speed', async () => {
    const { status } = await request(app, 'POST', '/api/fallback/sort/speed');
    expect(status).toBe(200);

    const { body } = await request(app, 'GET', '/api/fallback');
    // Should be sorted ascending by speed rank
    for (let i = 1; i < body.length; i++) {
      expect(body[i].speedRank).toBeGreaterThanOrEqual(body[i - 1].speedRank);
    }
  });

  it('POST /api/fallback/sort/invalid returns 400', async () => {
    const { status } = await request(app, 'POST', '/api/fallback/sort/invalid');
    expect(status).toBe(400);
  });
});
