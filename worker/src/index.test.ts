import { afterEach, describe, expect, it, vi } from 'vitest';
import { base64urlDecode, handleRequest, isAllowedHost, type Env } from './index';

const env: Env = {
  PROXY_AUTH_KEY: 'worker-secret',
  ALLOWED_HOSTS: '*',
};

function base64urlEncode(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function proxyUrl(upstream: string, authKey = env.PROXY_AUTH_KEY): string {
  return `https://relay.example.test/${authKey}/1/${base64urlEncode(upstream)}`;
}

function request(upstream: string, init: RequestInit = {}): Request {
  return new Request(proxyUrl(upstream), {
    method: 'POST',
    headers: {
      authorization: 'Bearer provider-key',
      'content-type': 'application/json',
      'x-proxy-session-id': 'session-1',
      'x-internal-debug': 'drop-me',
      ...init.headers,
    },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    ...init,
  });
}

describe('AnimaRouter anonymizing Worker', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns health status without auth', async () => {
    const res = await handleRequest(new Request('https://relay.example.test/healthz'), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('rejects non-POST proxy requests', async () => {
    const res = await handleRequest(new Request(proxyUrl('https://api.example.test/v1/chat/completions')), env);
    expect(res.status).toBe(405);
  });

  it('rejects invalid auth keys', async () => {
    const res = await handleRequest(new Request(proxyUrl('https://api.example.test/v1/chat/completions', 'wrong'), {
      method: 'POST',
      headers: { authorization: 'Bearer provider-key' },
    }), env);
    expect(res.status).toBe(401);
  });

  it('rejects malformed encoded upstream paths without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await handleRequest(new Request(`https://relay.example.test/${env.PROXY_AUTH_KEY}/1/not-base64!`, {
      method: 'POST',
      headers: { authorization: 'Bearer provider-key' },
    }), env);

    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Invalid upstream URL');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows wildcard upstream hosts for custom providers', async () => {
    expect(isAllowedHost('custom-provider.internal', '*')).toBe(true);
    expect(isAllowedHost('anything.example.com', '')).toBe(true);
  });

  it('supports exact and wildcard host restrictions', () => {
    expect(isAllowedHost('api.openai.com', 'api.openai.com,*.example.com')).toBe(true);
    expect(isAllowedHost('tenant.example.com', 'api.openai.com,*.example.com')).toBe(true);
    expect(isAllowedHost('example.com', '*.example.com')).toBe(false);
    expect(isAllowedHost('blocked.test', 'api.openai.com,*.example.com')).toBe(false);
  });

  it('rejects non-HTTPS upstreams', async () => {
    const res = await handleRequest(request('http://api.example.test/v1/chat/completions'), env);
    expect(res.status).toBe(400);
  });

  it('rejects disallowed upstream hosts when an allowlist is configured', async () => {
    const res = await handleRequest(
      request('https://blocked.example.test/v1/chat/completions'),
      { ...env, ALLOWED_HOSTS: 'api.openai.com' },
    );
    expect(res.status).toBe(403);
  });

  it('forwards only provider-safe request headers and preserves body', async () => {
    const upstreamBody = { id: 'chatcmpl-test', choices: [] };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(upstreamBody), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': 'must-not-forward=1',
        'retry-after': '2',
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await handleRequest(request('https://api.example.test/v1/chat/completions'), env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(upstreamBody);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('retry-after')).toBe('2');
    expect(res.headers.get('set-cookie')).toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.test/v1/chat/completions');
    const headers = init.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer provider-key');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-proxy-session-id')).toBeNull();
    expect(headers.get('x-internal-debug')).toBeNull();
    expect(await new Response(init.body).json()).toEqual({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  it('passes streaming response bodies through', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"delta":"hi"}\n\n'));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream, {
      headers: { 'content-type': 'text/event-stream' },
    })));

    const res = await handleRequest(request('https://api.example.test/v1/chat/completions'), env);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toBe('data: {"delta":"hi"}\n\n');
  });
});

describe('base64urlDecode', () => {
  it('decodes unpadded base64url strings', () => {
    const encoded = base64urlEncode('https://api.example.test/v1/chat/completions');
    expect(base64urlDecode(encoded)).toBe('https://api.example.test/v1/chat/completions');
  });
});
