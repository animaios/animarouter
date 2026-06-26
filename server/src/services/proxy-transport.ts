import crypto from 'node:crypto';
import type { ChatCompletionResponse } from '@animarouter/shared/types.js';

// ---------------------------------------------------------------------------
// FreeLLMProxy Cloudflare Worker transport
// URL scheme: POST https://{ROUTER_URL}/{AUTH_KEY}/1/{BASE64URL}
// where BASE64URL is the upstream provider URL in base64url encoding (no padding).
// ---------------------------------------------------------------------------

function base64urlEncode(str: string): string {
  return Buffer.from(str).toString('base64url');
}

export function isProxyTransportConfigured(): boolean {
  return !!(process.env.PROXY_ROUTER_URL && process.env.PROXY_AUTH_KEY);
}

export function buildProxyUrl(providerBaseUrl: string): string {
  const routerUrl = process.env.PROXY_ROUTER_URL?.replace(/\/+$/, '');
  const authKey = process.env.PROXY_AUTH_KEY;
  if (!routerUrl || !authKey) {
    throw new Error('PROXY_ROUTER_URL and PROXY_AUTH_KEY must be set for proxy transport');
  }
  // The proxy expects the full upstream URL including the /chat/completions path
  const upstreamUrl = `${providerBaseUrl.replace(/\/+$/, '')}/chat/completions`;
  const encoded = base64urlEncode(upstreamUrl);
  return `${routerUrl}/${authKey}/1/${encoded}`;
}

export async function proxyChatCompletion(
  providerBaseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  sessionId?: string,
): Promise<ChatCompletionResponse> {
  const url = buildProxyUrl(providerBaseUrl);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };
  if (sessionId) {
    headers['X-Proxy-Session-Id'] = sessionId;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000), // 2 min timeout matching provider default
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err: any = new Error(`proxy transport error: ${res.status} ${text.slice(0, 500)}`);
    err.status = res.status;
    // Propagate retry-after header if present
    const retryAfter = res.headers.get('retry-after');
    if (retryAfter) err.retryAfterMs = Number(retryAfter) * 1000;
    throw err;
  }

  return res.json() as Promise<ChatCompletionResponse>;
}

export async function* proxyStreamChatCompletion(
  providerBaseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  sessionId?: string,
): AsyncGenerator<Record<string, unknown>> {
  const url = buildProxyUrl(providerBaseUrl);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };
  if (sessionId) {
    headers['X-Proxy-Session-Id'] = sessionId;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, stream: true }),
    signal: AbortSignal.timeout(120000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err: any = new Error(`proxy transport error: ${res.status} ${text.slice(0, 500)}`);
    err.status = res.status;
    const retryAfter = res.headers.get('retry-after');
    if (retryAfter) err.retryAfterMs = Number(retryAfter) * 1000;
    throw err;
  }

  if (!res.body) throw new Error('proxy transport: no response body for streaming request');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue; // skip empty/comment lines
        if (trimmed === 'data: [DONE]') return;
        if (trimmed.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(trimmed.slice(6));
            yield parsed;
          } catch {
            // Malformed chunk — skip gracefully
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function computeWorkerIndex(sessionId: string, workerCount: number): number {
  const hash = crypto.createHash('sha1').update(sessionId).digest();
  const hashInt = hash.readUInt32BE(0);
  return hashInt % workerCount;
}
