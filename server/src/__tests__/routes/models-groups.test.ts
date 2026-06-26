import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
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

describe('Model group alias routes', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().exec('DELETE FROM fallback_config; DELETE FROM models; DELETE FROM model_groups; DELETE FROM model_group_aliases;');
  });

  it('reconciles model group assignments when aliases are added and removed', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO model_groups (group_key, display_name, intelligence_rank, size_label)
      VALUES ('old-group', 'Old Group', 5, 'Medium')
    `).run();
    db.prepare(`
      INSERT INTO model_groups (group_key, display_name, intelligence_rank, size_label)
      VALUES ('target-group', 'Target Group', 1, 'Large')
    `).run();
    const oldGroup = db.prepare('SELECT id FROM model_groups WHERE group_key = ?').get('old-group') as { id: number };
    const targetGroup = db.prepare('SELECT id FROM model_groups WHERE group_key = ?').get('target-group') as { id: number };
    db.prepare(`
      INSERT INTO models (platform, model_id, display_name, benchmark_score, intelligence_rank, speed_rank, size_label, group_id, enabled)
      VALUES ('route-test', 'alias-model', 'Alias Model', 75, 2, 1, 'Large', ?, 1)
    `).run(oldGroup.id);

    const created = await request(app, 'POST', '/api/models/groups/aliases', {
      alias: 'alias-model',
      groupKey: 'target-group',
    });
    expect(created.status).toBe(201);

    const afterCreate = db.prepare('SELECT group_id FROM models WHERE model_id = ?')
      .get('alias-model') as { group_id: number };
    expect(afterCreate.group_id).toBe(targetGroup.id);

    const deleted = await request(app, 'DELETE', '/api/models/groups/aliases/alias-model');
    expect(deleted.status).toBe(200);

    const afterDelete = db.prepare(`
      SELECT mg.group_key, m.group_id
      FROM models m
      JOIN model_groups mg ON mg.id = m.group_id
      WHERE m.model_id = ?
    `).get('alias-model') as { group_key: string; group_id: number };
    expect(afterDelete.group_id).not.toBe(targetGroup.id);
    expect(afterDelete.group_key).toBe('alias-model');
  });

  it('updates existing alias targets and syncs fallback group assignments', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO model_groups (group_key, display_name, intelligence_rank, size_label)
      VALUES ('old-group', 'Old Group', 5, 'Medium')
    `).run();
    db.prepare(`
      INSERT INTO model_groups (group_key, display_name, intelligence_rank, size_label)
      VALUES ('target-group', 'Target Group', 1, 'Large')
    `).run();
    db.prepare(`
      INSERT INTO model_groups (group_key, display_name, intelligence_rank, size_label)
      VALUES ('next-group', 'Next Group', 2, 'Large')
    `).run();

    const oldGroup = db.prepare('SELECT id FROM model_groups WHERE group_key = ?').get('old-group') as { id: number };
    const targetGroup = db.prepare('SELECT id FROM model_groups WHERE group_key = ?').get('target-group') as { id: number };
    const nextGroup = db.prepare('SELECT id FROM model_groups WHERE group_key = ?').get('next-group') as { id: number };
    const modelInfo = db.prepare(`
      INSERT INTO models (platform, model_id, display_name, benchmark_score, intelligence_rank, speed_rank, size_label, group_id, enabled)
      VALUES ('route-test', 'alias-model', 'Alias Model', 75, 2, 1, 'Large', ?, 1)
    `).run(oldGroup.id);
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, group_id, enabled) VALUES (?, 1, ?, 1)')
      .run(modelInfo.lastInsertRowid, oldGroup.id);

    const created = await request(app, 'POST', '/api/models/groups/aliases', {
      alias: 'alias-model',
      groupKey: 'target-group',
    });
    expect(created.status).toBe(201);

    let row = db.prepare(`
      SELECT m.group_id AS model_group_id, fc.group_id AS fallback_group_id
      FROM models m
      JOIN fallback_config fc ON fc.model_db_id = m.id
      WHERE m.model_id = ?
    `).get('alias-model') as { model_group_id: number; fallback_group_id: number };
    expect(row.model_group_id).toBe(targetGroup.id);
    expect(row.fallback_group_id).toBe(targetGroup.id);

    const updated = await request(app, 'POST', '/api/models/groups/aliases', {
      alias: 'alias-model',
      groupKey: 'next-group',
    });
    expect(updated.status).toBe(201);

    row = db.prepare(`
      SELECT m.group_id AS model_group_id, fc.group_id AS fallback_group_id
      FROM models m
      JOIN fallback_config fc ON fc.model_db_id = m.id
      WHERE m.model_id = ?
    `).get('alias-model') as { model_group_id: number; fallback_group_id: number };
    expect(row.model_group_id).toBe(nextGroup.id);
    expect(row.fallback_group_id).toBe(nextGroup.id);
  });
});
