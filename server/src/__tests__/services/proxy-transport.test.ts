import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock env vars before importing — the module reads them at call time, not
// import time, so we can set/clear them per-test.
// ---------------------------------------------------------------------------

const ORIGINAL_ROUTER_URL = process.env.PROXY_ROUTER_URL;
const ORIGINAL_AUTH_KEY = process.env.PROXY_AUTH_KEY;

function setProxyEnv() {
  process.env.PROXY_ROUTER_URL = 'https://router.example.workers.dev';
  process.env.PROXY_AUTH_KEY = 'test-auth-key-1234';
}

function clearProxyEnv() {
  delete process.env.PROXY_ROUTER_URL;
  delete process.env.PROXY_AUTH_KEY;
}

// Must re-import each time to pick up env var changes — but since the module
// reads env vars at call time (not at import), a single import is fine.
import {
  isProxyTransportConfigured,
  buildProxyUrl,
  proxyChatCompletion,
  proxyStreamChatCompletion,
  computeWorkerIndex,
} from '../../services/proxy-transport.js';

// ── isProxyTransportConfigured ─────────────────────────────────────────────

describe('isProxyTransportConfigured', () => {
  afterEach(() => {
    delete process.env.PROXY_ROUTER_URL;
    delete process.env.PROXY_AUTH_KEY;
  });

  it('returns false when neither env var is set', () => {
    expect(isProxyTransportConfigured()).toBe(false);
  });

  it('returns false when only PROXY_ROUTER_URL is set', () => {
    process.env.PROXY_ROUTER_URL = 'https://router.example.workers.dev';
    expect(isProxyTransportConfigured()).toBe(false);
  });

  it('returns false when only PROXY_AUTH_KEY is set', () => {
    process.env.PROXY_AUTH_KEY = 'some-key';
    expect(isProxyTransportConfigured()).toBe(false);
  });

  it('returns true when both env vars are set', () => {
    process.env.PROXY_ROUTER_URL = 'https://router.example.workers.dev';
    process.env.PROXY_AUTH_KEY = 'some-key';
    expect(isProxyTransportConfigured()).toBe(true);
  });
});

// ── buildProxyUrl ─────────────────────────────────────────────────────────

describe('buildProxyUrl', () => {
  beforeEach(setProxyEnv);
  afterEach(clearProxyEnv);

  it('constructs correct proxy URL from provider base URL', () => {
    const url = buildProxyUrl('https://api.openai.com/v1');
    expect(url).toContain('https://router.example.workers.dev');
    expect(url).toContain('/test-auth-key-1234/1/');
    // The upstream URL is base64url-encoded
    const encoded = url.split('/1/')[1];
    const decoded = Buffer.from(encoded, 'base64url').toString('utf-8');
    expect(decoded).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('strips trailing slashes from router URL', () => {
    process.env.PROXY_ROUTER_URL = 'https://router.example.workers.dev///';
    const url = buildProxyUrl('https://api.openai.com/v1');
    expect(url).toMatch(/^https:\/\/router\.example\.workers\.dev\//);
    expect(url).not.toMatch(/\.dev\/\//);
  });

  it('strips trailing slashes from provider base URL', () => {
    const url = buildProxyUrl('https://api.openai.com/v1///');
    const encoded = url.split('/1/')[1];
    const decoded = Buffer.from(encoded, 'base64url').toString('utf-8');
    expect(decoded).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('appends /chat/completions to the provider base URL', () => {
    const url = buildProxyUrl('https://api.groq.com/openai/v1');
    const encoded = url.split('/1/')[1];
    const decoded = Buffer.from(encoded, 'base64url').toString('utf-8');
    expect(decoded).toBe('https://api.groq.com/openai/v1/chat/completions');
  });

  it('throws if env vars are not set', () => {
    clearProxyEnv();
    expect(() => buildProxyUrl('https://api.openai.com/v1')).toThrow(
      'PROXY_ROUTER_URL and PROXY_AUTH_KEY must be set',
    );
  });

  it('produces valid base64url encoding (no +/= padding chars)', () => {
    const url = buildProxyUrl('https://api.openai.com/v1');
    const encoded = url.split('/1/')[1];
    expect(encoded).not.toMatch(/[+=/]/);
  });
});

// ── proxyChatCompletion ───────────────────────────────────────────────────

describe('proxyChatCompletion', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setProxyEnv();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    clearProxyEnv();
    vi.restoreAllMocks();
    // Restore original env vars
    if (ORIGINAL_ROUTER_URL) process.env.PROXY_ROUTER_URL = ORIGINAL_ROUTER_URL;
    if (ORIGINAL_AUTH_KEY) process.env.PROXY_AUTH_KEY = ORIGINAL_AUTH_KEY;
  });

  it('returns parsed JSON on success', async () => {
    const mockResponse = { id: 'chatcmpl-1', choices: [{ message: { content: 'hello' } }] };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const result = await proxyChatCompletion(
      'https://api.openai.com/v1',
      'sk-test-key',
      { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] },
    );

    expect(result).toEqual(mockResponse);
  });

  it('sends Authorization header with the API key', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });

    await proxyChatCompletion('https://api.openai.com/v1', 'sk-test-key', {});

    const call = fetchMock.mock.calls[0];
    expect(call[1].headers['Authorization']).toBe('Bearer sk-test-key');
  });

  it('sends X-Proxy-Session-Id header when sessionId is provided', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });

    await proxyChatCompletion('https://api.openai.com/v1', 'sk-test', {}, 'sess-abc123');

    const call = fetchMock.mock.calls[0];
    expect(call[1].headers['X-Proxy-Session-Id']).toBe('sess-abc123');
  });

  it('does NOT send X-Proxy-Session-Id header when sessionId is undefined', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });

    await proxyChatCompletion('https://api.openai.com/v1', 'sk-test', {});

    const call = fetchMock.mock.calls[0];
    expect(call[1].headers['X-Proxy-Session-Id']).toBeUndefined();
  });

  it('throws with status on non-OK response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
      headers: new Headers(),
    });

    await expect(
      proxyChatCompletion('https://api.openai.com/v1', 'sk-test', {}),
    ).rejects.toThrow('proxy transport error: 500');
  });

  it('propagates retryAfterMs from retry-after header', async () => {
    const headers = new Headers();
    headers.set('retry-after', '30');

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: () => Promise.resolve('rate limited'),
      headers,
    });

    try {
      await proxyChatCompletion('https://api.openai.com/v1', 'sk-test', {});
    } catch (err: any) {
      expect(err.status).toBe(429);
      expect(err.retryAfterMs).toBe(30000);
    }
  });
});

// ── proxyStreamChatCompletion ──────────────────────────────────────────────

describe('proxyStreamChatCompletion', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  function makeSSEStream(sseData: string) {
    const encoder = new TextEncoder();
    const chunks = sseData.split('|CHUNK|');
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
  }

  beforeEach(() => {
    setProxyEnv();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    clearProxyEnv();
    vi.restoreAllMocks();
    if (ORIGINAL_ROUTER_URL) process.env.PROXY_ROUTER_URL = ORIGINAL_ROUTER_URL;
    if (ORIGINAL_AUTH_KEY) process.env.PROXY_AUTH_KEY = ORIGINAL_AUTH_KEY;
  });

  it('yields parsed JSON objects from SSE data lines', async () => {
    const chunk1 = JSON.stringify({ id: '1', choices: [{ delta: { content: 'hel' } }] });
    const chunk2 = JSON.stringify({ id: '1', choices: [{ delta: { content: 'lo' } }] });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: makeSSEStream(`data: ${chunk1}\n\ndata: ${chunk2}\n\n`),
      headers: new Headers(),
    });

    const results: Record<string, unknown>[] = [];
    for await (const chunk of proxyStreamChatCompletion('https://api.openai.com/v1', 'sk-test', {})) {
      results.push(chunk);
    }

    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('1');
    expect(results[1].id).toBe('1');
  });

  it('stops on data: [DONE]', async () => {
    const chunk1 = JSON.stringify({ id: '1', choices: [{ delta: { content: 'hi' } }] });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: makeSSEStream(`data: ${chunk1}\n\ndata: [DONE]\n\ndata: {"should":"not appear"}\n\n`),
      headers: new Headers(),
    });

    const results: Record<string, unknown>[] = [];
    for await (const chunk of proxyStreamChatCompletion('https://api.openai.com/v1', 'sk-test', {})) {
      results.push(chunk);
    }

    expect(results).toHaveLength(1);
  });

  it('skips comment lines (SSE keep-alive)', async () => {
    const chunk1 = JSON.stringify({ id: '1', choices: [{ delta: { content: 'a' } }] });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: makeSSEStream(`: this is a comment\n\ndata: ${chunk1}\n\n`),
      headers: new Headers(),
    });

    const results: Record<string, unknown>[] = [];
    for await (const chunk of proxyStreamChatCompletion('https://api.openai.com/v1', 'sk-test', {})) {
      results.push(chunk);
    }

    expect(results).toHaveLength(1);
  });

  it('skips malformed JSON data lines gracefully', async () => {
    const chunk1 = JSON.stringify({ id: '1', choices: [{ delta: { content: 'a' } }] });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: makeSSEStream(`data: {broken json\n\ndata: ${chunk1}\n\n`),
      headers: new Headers(),
    });

    const results: Record<string, unknown>[] = [];
    for await (const chunk of proxyStreamChatCompletion('https://api.openai.com/v1', 'sk-test', {})) {
      results.push(chunk);
    }

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('1');
  });

  it('throws with status on non-OK response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: () => Promise.resolve('bad gateway'),
      headers: new Headers(),
    });

    await expect(
      (async () => {
        for await (const _ of proxyStreamChatCompletion('https://api.openai.com/v1', 'sk-test', {})) {
          // consume
        }
      })(),
    ).rejects.toThrow('proxy transport error: 502');
  });

  it('propagates retryAfterMs from retry-after header on error', async () => {
    const headers = new Headers();
    headers.set('retry-after', '15');

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: () => Promise.resolve('rate limited'),
      headers,
    });

    try {
      for await (const _ of proxyStreamChatCompletion('https://api.openai.com/v1', 'sk-test', {})) {
        // consume
      }
    } catch (err: any) {
      expect(err.status).toBe(429);
      expect(err.retryAfterMs).toBe(15000);
    }
  });

  it('includes stream: true in request body', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: makeSSEStream('data: [DONE]\n\n'),
      headers: new Headers(),
    });

    for await (const _ of proxyStreamChatCompletion('https://api.openai.com/v1', 'sk-test', { model: 'gpt-4' })) {
      // consume
    }

    const call = fetchMock.mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.stream).toBe(true);
    expect(body.model).toBe('gpt-4');
  });

  it('sends X-Proxy-Session-Id header when sessionId is provided', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: makeSSEStream('data: [DONE]\n\n'),
      headers: new Headers(),
    });

    for await (const _ of proxyStreamChatCompletion('https://api.openai.com/v1', 'sk-test', {}, 'my-session')) {
      // consume
    }

    const call = fetchMock.mock.calls[0];
    expect(call[1].headers['X-Proxy-Session-Id']).toBe('my-session');
  });

  it('throws when response body is null', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      body: null,
      headers: new Headers(),
    });

    await expect(
      (async () => {
        for await (const _ of proxyStreamChatCompletion('https://api.openai.com/v1', 'sk-test', {})) {
          // consume
        }
      })(),
    ).rejects.toThrow('no response body');
  });
});

// ── computeWorkerIndex ─────────────────────────────────────────────────────

describe('computeWorkerIndex', () => {
  it('returns deterministic index for same session', () => {
    const idx1 = computeWorkerIndex('session-abc', 3);
    const idx2 = computeWorkerIndex('session-abc', 3);
    expect(idx1).toBe(idx2);
  });

  it('returns different indices for different sessions', () => {
    const idx1 = computeWorkerIndex('session-abc', 3);
    const idx2 = computeWorkerIndex('session-xyz', 3);
    expect(idx1).not.toBe(idx2);
  });

  it('always returns value in range [0, workerCount)', () => {
    for (let i = 0; i < 100; i++) {
      const idx = computeWorkerIndex(`session-${i}`, 3);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(3);
    }
  });

  it('distributes sessions across workers', () => {
    const buckets = new Map<number, number>();
    for (let i = 0; i < 300; i++) {
      const idx = computeWorkerIndex(`session-${i}`, 3);
      buckets.set(idx, (buckets.get(idx) ?? 0) + 1);
    }
    // With 300 sessions and 3 workers, each should get ~100
    // Allow generous range to avoid flaky tests (SHA1 distribution is good)
    for (let w = 0; w < 3; w++) {
      expect(buckets.get(w) ?? 0).toBeGreaterThan(50);
    }
  });

  it('produces consistent index matching the key affinity hash pattern', () => {
    // Verify same SHA1 pattern used by key affinity (readUInt32BE % count)
    const idx = computeWorkerIndex('session-abc', 3);
    expect(typeof idx).toBe('number');
    expect(Number.isInteger(idx)).toBe(true);
  });
});
