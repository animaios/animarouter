import crypto from "node:crypto";
import type { ChatCompletionResponse } from "@animarouter/shared/types.js";
import { getEnabledCloudflareWorkerTransport } from "./outbound-transports.js";

// ---------------------------------------------------------------------------
// Outbound relay transports
//
// `direct` remains implemented by the provider adapters themselves. Relay
// transports wrap an already-selected provider/model/API key and decide how
// that request leaves AnimaRouter.
// ---------------------------------------------------------------------------

export type TransportId =
  | "direct"
  | "cloudflare-worker"
  | "netlify-function"
  | "custom-http-relay";

export interface RelayTransportRequest {
  providerBaseUrl: string;
  apiKey: string;
  body: Record<string, unknown>;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface OutboundRelayTransport {
  id: Exclude<TransportId, "direct">;
  label: string;
  supportsStreaming: boolean;
  isConfigured(): boolean;
  chatCompletion(
    request: RelayTransportRequest,
  ): Promise<ChatCompletionResponse>;
  streamChatCompletion(
    request: RelayTransportRequest,
  ): AsyncGenerator<Record<string, unknown>>;
}

export function transportIdFromUseProxy(useProxy: boolean): TransportId {
  return useProxy ? "cloudflare-worker" : "direct";
}

// ---------------------------------------------------------------------------
// FreeLLMProxy / Cloudflare Worker transport
// URL scheme: POST https://{ROUTER_URL}/{AUTH_KEY}/1/{BASE64URL}
// where BASE64URL is the upstream provider URL in base64url encoding (no padding).
// ---------------------------------------------------------------------------

function base64urlEncode(str: string): string {
  return Buffer.from(str).toString("base64url");
}

export function isProxyTransportConfigured(): boolean {
  if (process.env.PROXY_ROUTER_URL && process.env.PROXY_AUTH_KEY) return true;
  try {
    return !!getEnabledCloudflareWorkerTransport();
  } catch {
    return false;
  }
}

export function buildProxyUrl(providerBaseUrl: string): string {
  const dbTransport =
    process.env.PROXY_ROUTER_URL && process.env.PROXY_AUTH_KEY
      ? undefined
      : (() => {
          try {
            return getEnabledCloudflareWorkerTransport();
          } catch {
            return undefined;
          }
        })();
  const routerUrl = (
    process.env.PROXY_ROUTER_URL ?? dbTransport?.endpointUrl
  )?.replace(/\/+$/, "");
  const authKey = process.env.PROXY_AUTH_KEY ?? dbTransport?.authKey;
  if (!routerUrl || !authKey) {
    throw new Error(
      "PROXY_ROUTER_URL and PROXY_AUTH_KEY must be set for proxy transport",
    );
  }
  // The proxy expects the full upstream URL including the /chat/completions path
  const upstreamUrl = `${providerBaseUrl.replace(/\/+$/, "")}/chat/completions`;
  const encoded = base64urlEncode(upstreamUrl);
  return `${routerUrl}/${authKey}/1/${encoded}`;
}

class CloudflareWorkerRelayTransport implements OutboundRelayTransport {
  readonly id = "cloudflare-worker" as const;
  readonly label = "Cloudflare Worker";
  readonly supportsStreaming = true;

  isConfigured(): boolean {
    return isProxyTransportConfigured();
  }

  async chatCompletion(
    request: RelayTransportRequest,
  ): Promise<ChatCompletionResponse> {
    const url = buildProxyUrl(request.providerBaseUrl);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${request.apiKey}`,
    };
    if (request.sessionId) {
      headers["X-Proxy-Session-Id"] = request.sessionId;
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(request.body),
      signal: request.signal
        ? AbortSignal.any([request.signal, AbortSignal.timeout(120000)])
        : AbortSignal.timeout(120000), // 2 min timeout matching provider default
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err: any = new Error(
        `proxy transport error: ${res.status} ${text.slice(0, 500)}`,
      );
      err.status = res.status;
      // Propagate retry-after header if present
      const retryAfter = res.headers.get("retry-after");
      if (retryAfter) err.retryAfterMs = Number(retryAfter) * 1000;
      throw err;
    }

    return res.json() as Promise<ChatCompletionResponse>;
  }

  async *streamChatCompletion(
    request: RelayTransportRequest,
  ): AsyncGenerator<Record<string, unknown>> {
    const url = buildProxyUrl(request.providerBaseUrl);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${request.apiKey}`,
    };
    if (request.sessionId) {
      headers["X-Proxy-Session-Id"] = request.sessionId;
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...request.body, stream: true }),
      signal: request.signal
        ? AbortSignal.any([request.signal, AbortSignal.timeout(120000)])
        : AbortSignal.timeout(120000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err: any = new Error(
        `proxy transport error: ${res.status} ${text.slice(0, 500)}`,
      );
      err.status = res.status;
      const retryAfter = res.headers.get("retry-after");
      if (retryAfter) err.retryAfterMs = Number(retryAfter) * 1000;
      throw err;
    }

    if (!res.body)
      throw new Error(
        "proxy transport: no response body for streaming request",
      );

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let completed = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          completed = true;
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // keep incomplete line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":")) continue; // skip empty/comment lines
          if (trimmed === "data: [DONE]") {
            completed = true;
            return;
          }
          if (trimmed.startsWith("data: ")) {
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
      if (!completed) {
        await reader.cancel().catch(() => undefined);
      }
      reader.releaseLock();
    }
  }
}

const relayTransports = new Map<
  OutboundRelayTransport["id"],
  OutboundRelayTransport
>([["cloudflare-worker", new CloudflareWorkerRelayTransport()]]);

export function getRelayTransport(
  id: TransportId,
): OutboundRelayTransport | undefined {
  if (id === "direct") return undefined;
  return relayTransports.get(id);
}

export function isRelayTransportConfigured(id: TransportId): boolean {
  if (id === "direct") return true;
  return getRelayTransport(id)?.isConfigured() ?? false;
}

// Backward-compatible wrappers for the existing Cloudflare-only call sites.
export async function proxyChatCompletion(
  providerBaseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  sessionId?: string,
): Promise<ChatCompletionResponse> {
  return getRelayTransport("cloudflare-worker")!.chatCompletion({
    providerBaseUrl,
    apiKey,
    body,
    sessionId,
  });
}

export async function* proxyStreamChatCompletion(
  providerBaseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  sessionId?: string,
): AsyncGenerator<Record<string, unknown>> {
  yield* getRelayTransport("cloudflare-worker")!.streamChatCompletion({
    providerBaseUrl,
    apiKey,
    body,
    sessionId,
  });
}

export function computeWorkerIndex(
  sessionId: string,
  workerCount: number,
): number {
  const hash = crypto.createHash("sha1").update(sessionId).digest();
  const hashInt = hash.readUInt32BE(0);
  return hashInt % workerCount;
}
