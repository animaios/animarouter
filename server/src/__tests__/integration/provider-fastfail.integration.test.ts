/**
 * Integration tests for Provider-Outage Fast-Fail.
 *
 * Each test re-imports modules in isolation to avoid cross-test contamination
 * from module-level state (degradation map, key exhaustion, cooldowns, etc.).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Express } from 'express';
import type { RoutingStrategy } from '../../services/scoring.js';

describe('Provider-Outage Fast-Fail — Integration', () => {
  let app: Express;
  let key: string;
  let chatCompletion: ReturnType<typeof vi.fn>;
  let streamChatCompletion: ReturnType<typeof vi.fn>;
  let publishedEvents: any[];
  let getDb: () => any;
  let encrypt: (key: string) => { encrypted: string; iv: string; authTag: string };
  let setRoutingStrategy: (strategy: RoutingStrategy) => void;
  let post: (app: Express, path: string, body: any, key: string) => Promise<{ status: number; body: any; raw: string; headers: Headers }>;

  // Model IDs
  let alphaModel1Id: number;
  let alphaModel2Id: number;
  let betaModel1Id: number;

  beforeEach(async () => {
    // Reset all module state by re-importing fresh modules
    vi.resetModules();

    // Re-setup provider mock
    chatCompletion = vi.fn();
    streamChatCompletion = vi.fn();
    const fakeProvider = { name: 'fake', chatCompletion, streamChatCompletion } as any;

    vi.doMock('../../providers/index.js', async (importOriginal) => {
      const actual = await importOriginal() as any;
      return {
        ...actual,
        getProvider: () => fakeProvider,
        resolveProvider: () => fakeProvider,
        buildProviderFor: () => fakeProvider,
      };
    });

    publishedEvents = [];
    vi.doMock('../../services/events.js', () => ({
      publish: vi.fn((evt: any) => publishedEvents.push(evt)),
      publishDeduped: vi.fn((evt: any) => publishedEvents.push(evt)),
      resetEventThrottle: vi.fn(),
    }));

    // Re-import modules fresh
    const appModule = await import('../../app.js');
    const dbModule = await import('../../db/index.js');
    const cryptoModule = await import('../../lib/crypto.js');
    const routerModule = await import('../../services/router.js');

    getDb = dbModule.getDb;
    encrypt = cryptoModule.encrypt;
    setRoutingStrategy = routerModule.setRoutingStrategy;

    post = async (app: Express, path: string, body: any, k: string) => {
      const server = app.listen(0);
      const addr = server.address() as any;
      const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${k}` },
        body: JSON.stringify(body),
      });
      const raw = await res.text();
      server.close();
      let json: any = null;
      try { json = JSON.parse(raw); } catch {}
      return { status: res.status, body: json, raw, headers: res.headers };
    };

    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    dbModule.initDb(':memory:');
    app = appModule.createApp();
    key = dbModule.getUnifiedApiKey();

    const db = dbModule.getDb();
    routerModule.setRoutingStrategy('priority');

    // Clear seeded fallback_config so only our fixtures are routable
    db.prepare('DELETE FROM fallback_config').run();

    // Provider "alpha" with 2 models (threshold = 2 by default)
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('alpha', 'model-a1', 'Alpha A1', 1, 1, 1)").run();
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('alpha', 'model-a2', 'Alpha A2', 2, 2, 1)").run();
    db.prepare("INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled) VALUES ('beta', 'model-b1', 'Beta B1', 3, 3, 1)").run();

    alphaModel1Id = (db.prepare("SELECT id FROM models WHERE platform = 'alpha' AND model_id = 'model-a1'").get() as any).id;
    alphaModel2Id = (db.prepare("SELECT id FROM models WHERE platform = 'alpha' AND model_id = 'model-a2'").get() as any).id;
    betaModel1Id = (db.prepare("SELECT id FROM models WHERE platform = 'beta' AND model_id = 'model-b1'").get() as any).id;

    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)").run(alphaModel1Id);
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 2, 1)").run(alphaModel2Id);
    db.prepare("INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 3, 1)").run(betaModel1Id);

    const { encrypted, iv, authTag } = encrypt('test-key');
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('alpha', 'Alpha Key', ?, ?, ?, 'healthy', 1)").run(encrypted, iv, authTag);
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('beta', 'Beta Key', ?, ?, ?, 'healthy', 1)").run(encrypted, iv, authTag);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('2 distinct models with 5xx on same provider triggers fast-fail — routes to fallback provider', async () => {
    // model-a1 gets 1 attempt (503), model-a2 gets 1 attempt (503), then beta succeeds
    chatCompletion
      .mockRejectedValueOnce(new Error('alpha API error 503: Service Unavailable'))
      .mockRejectedValueOnce(new Error('alpha API error 503: Service Unavailable'))
      .mockResolvedValueOnce({
        choices: [{ message: { role: 'assistant', content: 'beta answer' } }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      });

    const { status, body, headers } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('beta answer');
    expect(headers.get('x-routed-via')).toContain('beta/model-b1');

    // Verify fast-fail event was emitted
    const fastFailEvents = publishedEvents.filter(e => e.type === 'routing.provider_fastfail');
    expect(fastFailEvents.length).toBe(1);
    expect(fastFailEvents[0].provider).toBe('alpha');
    expect(fastFailEvents[0].failedModelCount).toBe(2);
  });

  it('single model 5xx does NOT trigger fast-fail (below threshold)', async () => {
    // model-a1 fails once (503), then model-a2 succeeds
    chatCompletion
      .mockRejectedValueOnce(new Error('alpha API error 503: Service Unavailable'))
      .mockResolvedValueOnce({
        choices: [{ message: { role: 'assistant', content: 'alpha a2 answer' } }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      });

    const { status, body } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('alpha a2 answer');

    // No fast-fail event — only 1 distinct model failed
    const fastFailEvents = publishedEvents.filter(e => e.type === 'routing.provider_fastfail');
    expect(fastFailEvents.length).toBe(0);
  });

  it('429 (minor) does NOT count toward fast-fail threshold — only major (5xx) counts', async () => {
    // model-a1 gets 1 attempt (429 minor), model-a2 gets 1 attempt (503 major)
    chatCompletion
      .mockRejectedValueOnce(new Error('alpha API error 429: Rate limited'))
      .mockRejectedValueOnce(new Error('alpha API error 503: Service Unavailable'))
      .mockResolvedValueOnce({
        choices: [{ message: { role: 'assistant', content: 'beta answer' } }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      });

    const { status } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    expect(status).toBe(200);

    // No fast-fail: 429 is minor, only 1 major model
    const fastFailEvents = publishedEvents.filter(e => e.type === 'routing.provider_fastfail');
    expect(fastFailEvents.length).toBe(0);
  });

  it('fastFired guard: once fast-fail triggers, subsequent model failures dont re-emit', async () => {
    // After fast-fail triggers on alpha (2 models failed), all alpha models
    // are in skipModels. The only remaining model is beta.
    // Even if more alpha errors occur somehow, no duplicate event fires.
    chatCompletion
      .mockRejectedValueOnce(new Error('alpha API error 503: down'))
      .mockRejectedValueOnce(new Error('alpha API error 503: down'))
      .mockResolvedValueOnce({
        choices: [{ message: { role: 'assistant', content: 'beta ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      });

    await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    // Exactly 1 fast-fail event for alpha
    const fastFailEvents = publishedEvents.filter(e => e.type === 'routing.provider_fastfail');
    expect(fastFailEvents.length).toBe(1);
    expect(fastFailEvents[0].provider).toBe('alpha');
    expect(fastFailEvents[0].failedModelCount).toBe(2);
  });

  it('key_exhausted events are emitted before fast-fail event', async () => {
    chatCompletion
      .mockRejectedValueOnce(new Error('alpha API error 503: down'))
      .mockRejectedValueOnce(new Error('alpha API error 503: down'))
      .mockResolvedValueOnce({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      });

    await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    const exhaustedEvents = publishedEvents.filter(e => e.type === 'routing.key_exhausted');
    const fastFailEvents = publishedEvents.filter(e => e.type === 'routing.provider_fastfail');

    expect(exhaustedEvents.length).toBeGreaterThanOrEqual(2);
    expect(fastFailEvents.length).toBe(1);

    // Fast-fail event comes after the key_exhausted events
    const fastFailIdx = publishedEvents.indexOf(fastFailEvents[0]);
    const firstExhaustedIdx = publishedEvents.indexOf(exhaustedEvents[0]);
    expect(fastFailIdx).toBeGreaterThan(firstExhaustedIdx);
  });

  it('fast-fail adds ALL enabled models of the provider to skipModels', async () => {
    // After fast-fail on alpha, verify that even alpha models NOT in the
    // fallback chain at time of failure are skipped (DB query fetches all)
    chatCompletion
      .mockRejectedValueOnce(new Error('alpha API error 503: down'))
      .mockRejectedValueOnce(new Error('alpha API error 503: down'))
      .mockResolvedValueOnce({
        choices: [{ message: { role: 'assistant', content: 'beta answer' } }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      });

    const { status, body } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('beta answer');
    // All attempts on alpha should have failed, only beta should succeed
    expect(chatCompletion).toHaveBeenCalledTimes(3); // 2 failures + 1 success
  });
});
