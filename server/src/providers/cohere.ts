import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from '@animarouter/shared/types.js';
import { BaseProvider, providerHttpError, type CompletionOptions } from './base.js';
import { flattenMessageContent } from '../lib/content.js';
import { extractErrorMessage } from '../lib/error-body.js';
const API_BASE = 'https://api.cohere.ai/compatibility/v1';

export class CohereProvider extends BaseProvider {
  readonly platform = 'cohere' as const;
  readonly name = 'Cohere';
  baseUrl = API_BASE;

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const body: Record<string, unknown> = {
      model: modelId,
      messages: flattenMessageContent(messages),
      temperature: options?.temperature,
      max_tokens: options?.max_tokens,
      top_p: options?.top_p,
      tools: options?.tools,
      tool_choice: options?.tool_choice,
    };
    // Cohere's Chat API ignores unknown fields, so we forward both the
    // `reasoning_effort` shorthand and the rich `thinking` object verbatim
    // — a future model/route that understands them decides; the rest is
    // silently dropped at the wrapper. (#290)
    if (options?.reasoning_effort) body.reasoning_effort = options.reasoning_effort;
    if (options?.thinking) body.thinking = options.thinking;

    const res = await this.fetchWithTimeout(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw providerHttpError(res, `Cohere API error ${res.status}: ${extractErrorMessage(err) ?? res.statusText}`);
    }
    const data = await res.json() as ChatCompletionResponse;
    data._routed_via = { platform: this.platform, model: modelId };
    return data;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const body: Record<string, unknown> = {
      model: modelId,
      messages: flattenMessageContent(messages),
      temperature: options?.temperature,
      max_tokens: options?.max_tokens,
      top_p: options?.top_p,
      tools: options?.tools,
      tool_choice: options?.tool_choice,
      stream: true,
    };
    // Same thinking-knob pass-through as the non-streaming path. The
    // wrapper decides what to do with these; unknown fields are dropped
    // upstream. (#290)
    if (options?.reasoning_effort) body.reasoning_effort = options.reasoning_effort;
    if (options?.thinking) body.thinking = options.thinking;

    const res = await this.fetchWithTimeout(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw providerHttpError(res, `Cohere API error ${res.status}: ${extractErrorMessage(err) ?? res.statusText}`);
    }

    yield* this.readSseStream(res);
  }

  async validateKey(apiKey: string): Promise<boolean> {
    // Transport errors propagate — health.ts marks status='error' without
    // marking the key invalid. Only confirmed 401/403 returns false.
    const res = await this.fetchWithTimeout(`${API_BASE}/models`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    }, 10000);
    return res.status !== 401 && res.status !== 403;
  }
}
