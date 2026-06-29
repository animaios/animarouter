import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatMessage,
} from "@animarouter/shared/types.js";
import { contentToString } from "../lib/content.js";
import { extractErrorMessage } from "../lib/error-body.js";
import {
  BaseProvider,
  type CompletionOptions,
  providerHttpError,
} from "./base.js";
/**
 * Cloudflare Workers AI provider.
 * API key format expected: "account_id:api_token"
 * The account_id is extracted from the key to build the URL.
 */
export class CloudflareProvider extends BaseProvider {
  readonly platform = "cloudflare" as const;
  readonly name = "Cloudflare Workers AI";

  private parseKey(apiKey: string): { accountId: string; token: string } {
    const sep = apiKey.indexOf(":");
    if (sep === -1)
      throw new Error(
        'Cloudflare key must be in format "account_id:api_token"',
      );
    return { accountId: apiKey.slice(0, sep), token: apiKey.slice(sep + 1) };
  }

  // Cloudflare's OpenAI-compat endpoint:
  //   - rejects `content: null` on assistant messages that carry tool_calls,
  //     even though the OpenAI spec allows it (collapse to '');
  //   - doesn't accept the array content envelope, so flatten to string.
  private normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((m) => ({ ...m, content: contentToString(m.content) }));
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const { accountId, token } = this.parseKey(apiKey);
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;

    const res = await this.fetchWithTimeout(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        messages: this.normalizeMessages(messages),
        temperature: options?.temperature,
        max_tokens: options?.max_tokens,
        top_p: options?.top_p,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
        // Forward thinking knobs verbatim — Cloudflare silently drops fields
        // it doesn't recognize for now, but newer reasoning models (DeepSeek
        // R1 distill etc.) read `reasoning_effort` and pick the right depth.
        // (#290)
        ...(options?.reasoning_effort
          ? { reasoning_effort: options.reasoning_effort }
          : {}),
        ...(options?.thinking ? { thinking: options.thinking } : {}),
      }),
      signal: options?.signal,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw providerHttpError(
        res,
        `Cloudflare API error ${res.status}: ${extractErrorMessage(err) ?? res.statusText}`,
      );
    }

    const data = (await res.json()) as ChatCompletionResponse;
    data._routed_via = { platform: "cloudflare", model: modelId };
    return data;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const { accountId, token } = this.parseKey(apiKey);
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;

    const res = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        messages: this.normalizeMessages(messages),
        temperature: options?.temperature,
        max_tokens: options?.max_tokens,
        top_p: options?.top_p,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        parallel_tool_calls: options?.parallel_tool_calls,
        stream: true,
        // Thinking knobs — same rationale as the non-streaming path. (#290)
        ...(options?.reasoning_effort
          ? { reasoning_effort: options.reasoning_effort }
          : {}),
        ...(options?.thinking ? { thinking: options.thinking } : {}),
      }),
      signal: options?.signal,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw providerHttpError(
        res,
        `Cloudflare API error ${res.status}: ${extractErrorMessage(err) ?? res.statusText}`,
      );
    }

    yield* this.readSseStream(res);
  }

  async validateKey(apiKey: string): Promise<boolean> {
    // Transport errors propagate — health.ts marks status='error' without
    // marking the key invalid. Only confirmed bad/inactive tokens return false.
    const { token } = this.parseKey(apiKey);
    const res = await this.fetchWithTimeout(
      "https://api.cloudflare.com/client/v4/user/tokens/verify",
      { method: "GET", headers: { Authorization: `Bearer ${token}` } },
      10000,
    );
    if (res.status === 401 || res.status === 403) return false;
    if (!res.ok) return true; // unexpected non-2xx that isn't auth — don't disable
    // Cloudflare's token-verify response is a narrow shape; we only check
    // `success` and `result.status` per the documented contract. Anything
    // else we treat as "key not verified by this transport" rather than
    // disabling it. Use `unknown` instead of `any` so the API stays typed:
    // the cast through `unknown` is a one-way boundary at the JSON-parse
    // gateway, which is the only safe place to lose tracking. (#290)
    const data = (await res.json().catch(() => null)) as unknown as {
      success?: unknown;
      result?: { status?: unknown };
    } | null;
    return data?.success === true && data.result?.status === "active";
  }
}
