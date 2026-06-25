import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(isGatedApiPath(path) && !('Authorization' in headers) ? { Authorization: `Bearer ${dashToken}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.text();
  server.close();

  let json: any = null;
  try { json = JSON.parse(data); } catch {}

  return { status: res.status, body: json };
}

function authHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

// requested_model logging: a pinned request records the model id the client
// named; an auto request records NULL. This is what lets analytics split
// pinned vs auto traffic and surface failover overrides.
describe('requested_model analytics logging', () => {
  let app: Express;
  let groqModelId: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
    // Any enabled groq model from the seeded catalog will do as the pin target.
    groqModelId = (getDb().prepare(`
      SELECT m.model_id FROM models m
      JOIN fallback_config fc ON fc.model_db_id = m.id
      WHERE m.platform = 'groq' AND m.enabled = 1
      ORDER BY fc.priority LIMIT 1
    `).get() as { model_id: string }).model_id;
  });

  beforeEach(async () => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();

    const addKey = await request(app, 'POST', '/api/keys', {
      platform: 'groq',
      key: 'gsk_pinned_model_test',
      label: 'pinned-model',
    });
    expect(addKey.status).toBe(201);

    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.includes('api.groq.com')) {
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-pin', object: 'chat.completion', created: 1, model: groqModelId,
            choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          }),
        } as any;
      }
      return origFetch(url, init);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs the pinned model id when the client names a model', async () => {
    const { status } = await request(app, 'POST', '/v1/chat/completions', {
      model: groqModelId,
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());
    expect(status).toBe(200);

    const row = getDb().prepare('SELECT model_id, requested_model FROM requests ORDER BY id DESC LIMIT 1').get() as any;
    expect(row.requested_model).toBe(groqModelId);
    expect(row.model_id).toBe(groqModelId); // pin honored
  });

  it.each([['auto'], [undefined]])('logs NULL requested_model for auto routing (model: %s)', async (model) => {
    const { status } = await request(app, 'POST', '/v1/chat/completions', {
      ...(model ? { model } : {}),
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());
    expect(status).toBe(200);

    const row = getDb().prepare('SELECT requested_model FROM requests ORDER BY id DESC LIMIT 1').get() as any;
    expect(row.requested_model).toBeNull();
  });
});

// Strict pinning: when the client names a model (model: "platform/model_id")
// the proxy must use ONLY that model. A transient error on the pinned model
// must NOT silently fall through to a different model in the chain — that
// would serve a response from a model the user did not pick, which is the
// exact behaviour strict pinning is supposed to prevent. The proxy already
// supports this contract (pinMode: true in routeRequest, PINNED_MODEL_EXHAUSTED
// when all keys burn out); these tests cover the proxy-level integration.
describe('strict pinning (no silent fallback on pinned-model errors)', () => {
  let app: Express;
  let pinnedModelId: number;
  let pinnedDisplayName: string;
  let pinnedModelName: string;
  let fallbackModelId: number;
  let fallbackDisplayName: string;
  let fallbackModelName: string;
  let fallbackPlatform: string;
  let pinnedPlatform: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();

    // Pick two enabled models on different platforms with different provider
    // fetches so the test can verify the pinned model is hit and the fallback
    // model is NOT hit.
    const db = getDb();
    const enabled = db.prepare(`
      SELECT m.id, m.platform, m.model_id, m.display_name, fc.priority
      FROM models m JOIN fallback_config fc ON fc.model_db_id = m.id
      WHERE m.enabled = 1 AND fc.enabled = 1
      ORDER BY fc.priority ASC
    `).all() as Array<{ id: number; platform: string; model_id: string; display_name: string; priority: number }>;

    // Pick a high-priority row and a low-priority row on different platforms
    // so the test can assert the proxy tries the pinned one first and stops
    // there.
    pinnedModelId = enabled[0].id;
    pinnedPlatform = enabled[0].platform;
    pinnedModelName = enabled[0].model_id;
    pinnedDisplayName = enabled[0].display_name;

    const otherPlatform = enabled.find(r => r.platform !== pinnedPlatform);
    if (!otherPlatform) throw new Error('Need at least two platforms in the seed catalog');
    fallbackModelId = otherPlatform.id;
    fallbackPlatform = otherPlatform.platform;
    fallbackModelName = otherPlatform.model_id;
    fallbackDisplayName = otherPlatform.display_name;
  });

  beforeEach(async () => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM requests').run();

    // Add a key for the pinned platform only — the fallback platform has NO
    // key, so the only way it could "succeed" is if the proxy fell through.
    const addKey = await request(app, 'POST', '/api/keys', {
      platform: pinnedPlatform,
      key: 'pinned-strict-test-key',
      label: 'pinned-strict',
    });
    expect(addKey.status).toBe(201);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does NOT fall through to a different model when the pinned model returns an in-band error', async () => {
    // Mock fetch: the pinned platform returns an in-band error frame inside a
    // 200 SSE stream (the dead-turn class the proxy normally treats as "skip
    // this model and try the next one in the chain"). With strict pinning,
    // the proxy must NOT fall through — it should report a 502 with the
    // pinned model's name in the error, and no requests should hit the
    // fallback platform.
    const origFetch = global.fetch;
    const calls: string[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      calls.push(urlStr);
      if (urlStr.includes(fallbackPlatform)) {
        // If the proxy falls through, this branch is hit. The mock returns
        // a normal success so a fallthrough would visibly succeed and
        // contaminate the test. We track via calls[] to assert it never ran.
        return {
          ok: true,
          json: () => Promise.resolve({
            id: 'chatcmpl-fb', object: 'chat.completion', created: 1,
            model: fallbackModelName,
            choices: [{ index: 0, message: { role: 'assistant', content: 'fallback' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          }),
        } as any;
      }
      if (urlStr.includes(pinnedPlatform)) {
        // Pinned platform: simulate an in-band error frame inside the SSE
        // stream. The provider returns 200 + a stream whose first frame is
        // an error chunk, which the proxy classifies as a retryable
        // "in-band provider error" — and the bug was that this triggered a
        // skipModels.add(pinned) + fall through. We assert the fix.
        return {
          ok: true,
          body: makeInBandErrorStream(pinnedDisplayName),
        } as any;
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: `${pinnedPlatform}/${pinnedModelName}`,
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    }, authHeaders());

    // Strict pinning must surface the in-band error to the user, not fall
    // through to a different model. With per-key retry removed, the key is
    // exhausted and the outer loop returns 429 (all models exhausted).
    expect(status).toBe(429);
    expect(body?.error?.message).toMatch(/exhausted/i);

    // The fallback platform's fetch URL must NOT appear in the call log.
    const fbHits = calls.filter(u => u.includes(fallbackPlatform));
    expect(fbHits).toEqual([]);
  });

  it('returns 404 to the user when the pinned model is dead upstream, instead of silent fallback', async () => {
    const origFetch = global.fetch;
    const calls: string[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      calls.push(urlStr);
      if (urlStr.includes(fallbackPlatform)) {
        return { ok: true, json: () => Promise.resolve({ id: 'x', choices: [{ message: { role: 'assistant', content: 'fb' }, finish_reason: 'stop' }] }) } as any;
      }
      if (urlStr.includes(pinnedPlatform)) {
        // Provider returns a 404-style error message. The proxy classifies
        // this as isModelNotFoundError, which previously added the pinned
        // model to skipModels and fell through. With strict pinning, it
        // must surface 404 instead.
        return { ok: false, status: 404, statusText: 'Not Found', text: () => Promise.resolve('not found'), json: () => Promise.resolve({ error: { message: 'No such model' } }) } as any;
      }
      return origFetch(url, init);
    });

    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      model: `${pinnedPlatform}/${pinnedModelName}`,
      messages: [{ role: 'user', content: 'hi' }],
    }, authHeaders());

    expect(status).toBe(404);
    expect(body?.error?.code).toBe('model_not_found');
    expect(body?.error?.message).toMatch(/Pinned model/);
    expect(body?.error?.message).toMatch(new RegExp(`${pinnedPlatform}/${pinnedModelName}`.replace(/\//g, '\\/')));

    const fbHits = calls.filter(u => u.includes(fallbackPlatform));
    expect(fbHits).toEqual([]);
  });
});

;

// Build a minimal ReadableStream that yields an in-band error frame, then
// closes. Matches the upstream provider format the proxy's stream reader
// expects (data: {"error":{...}}\n\n followed by a clean close).
function makeInBandErrorStream(displayName: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const frame = `data: ${JSON.stringify({ error: { message: `Internal server error from ${displayName}` } })}\n\n`;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(frame));
      controller.close();
    },
  });
}
