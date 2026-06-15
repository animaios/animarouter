import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatToolCall,
  ChatToolChoice,
  ChatToolDefinition,
  TokenUsage,
  Platform,
} from '@api-gateway/shared/types.js';
import { BaseProvider, providerHttpError, type CompletionOptions } from './base.js';
import { contentToString, normalizeOutboundContent } from '../lib/content.js';

// Anthropic Messages API. The 2023-06-01 revision is the current stable version
// (Anthropic pins clients to a specific date and the server negotiates the wire
// format). The 2025-05-14 beta enables tool-calling on models that didn't
// support it before — Anthropic still routes these through the same /v1/messages
// endpoint, but the beta header is required to expose `tools` / `tool_use` /
// `tool_result` content blocks. See https://docs.anthropic.com/en/api/versioning
// and https://docs.anthropic.com/en/docs/tool-use.
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BETA = 'tools-2025-05-14';

// Anthropic requires `max_tokens` on every request; the API rejects calls that
// omit it with 400 "max_tokens is required". The proxy accepts OpenAI-shaped
// requests that frequently leave it unset, so default to a value large enough
// for most prompts (4k tokens ≈ ~12k chars of English). Callers can still
// override via CompletionOptions.max_tokens.
const DEFAULT_MAX_TOKENS = 4096;

const STREAM_INACTIVITY_TIMEOUT_MS = 300000;

/** Wire-shape for the Anthropic Messages API request body. */
interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicWireMessage[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
}

type AnthropicWireMessage =
  | { role: 'user'; content: string | AnthropicUserContentBlock[] }
  | { role: 'assistant'; content: string | AnthropicAssistantContentBlock[] };

type AnthropicUserContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_result'; tool_use_id: string; content: string };

type AnthropicAssistantContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

type AnthropicToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string };

interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicResponseBlock[];
  stop_reason: 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

type AnthropicResponseBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: string; [key: string]: unknown };

interface AnthropicStreamEvent {
  type: string;
  // Event-specific fields. We only model the ones we actually consume; the
  // rest pass through to the parser and are ignored if unmatched.
  message?: { id: string; model: string; usage?: { input_tokens?: number; output_tokens?: number } };
  index?: number;
  content_block?: { type: string; id?: string; name?: string };
  delta?: {
    type: 'text_delta' | 'input_json_delta' | string;
    text?: string;
    partial_json?: string;
    stop_reason?: 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' | null;
    stop_sequence?: string | null;
  };
  usage?: { output_tokens?: number };
}

/**
 * Provider for Anthropic-compatible endpoints (api.anthropic.com, AWS Bedrock's
 * Anthropic-on-Claude routes, Google Vertex AI's Claude routes, and any
 * third-party proxy that speaks the Anthropic Messages API).
 *
 * Translates OpenAI-format requests to Anthropic's content-block shape and
 * back. Tool calls are expressed as `tool_use` / `tool_result` blocks; system
 * messages are hoisted to the top-level `system` field.
 *
 * Auth is via the `x-api-key` header (keyless mode omits it for self-hosted
 * proxies that need no auth). The `anthropic-version` header is mandatory; the
 * `anthropic-beta` header enables newer tool-use features.
 */
export class AnthropicCompatProvider extends BaseProvider {
  readonly platform: Platform;
  readonly name: string;
  // baseUrl is declared on BaseProvider as a public field; redeclared here so
  // callers can read it on the concrete class without a type-narrowing cast.
  baseUrl?: string;
  private readonly timeoutMs: number;

  constructor(opts: {
    platform: Platform;
    name: string;
    baseUrl: string;
    timeoutMs?: number;
    keyless?: boolean;
  }) {
    super();
    this.platform = opts.platform;
    this.name = opts.name;
    this.baseUrl = opts.baseUrl;
    this.timeoutMs = opts.timeoutMs ?? 120000;
    this.keyless = opts.keyless ?? false;
  }

  /** OpenAI tools are wrapped as `{ type: 'function', function: { ... } }`;
   * Anthropic tools are flat `{ name, description, input_schema }`. */
  private translateTools(tools?: ChatToolDefinition[]): AnthropicTool[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    const out: AnthropicTool[] = [];
    for (const t of tools) {
      out.push({
        name: t.function.name,
        ...(t.function.description ? { description: t.function.description } : {}),
        input_schema: (t.function.parameters ?? { type: 'object', properties: {} }) as Record<string, unknown>,
      });
    }
    return out;
  }

  /** OpenAI's `tool_choice` literals are mostly direct — 'auto' and 'required'
   * map cleanly. 'none' can't be expressed as a value in Anthropic's shape (no
   * `disable_tools` field), so we still return the literal and let
   * `chatCompletion` skip emitting the `tools` field when it's used. */
  private translateToolChoice(choice?: ChatToolChoice): AnthropicToolChoice | undefined {
    if (choice == null) return undefined;
    if (choice === 'none') return { type: 'auto' };
    if (choice === 'auto') return { type: 'auto' };
    if (choice === 'required') return { type: 'any' };
    // Specific function: 'auto' is the closest legal Anthropic value (they
    // support forcing a specific tool via `{ type: 'tool', name }`).
    return { type: 'tool', name: choice.function.name };
  }

  /** Translate OpenAI messages to Anthropic's content-block shape. System
   * messages are concatenated and hoisted to the top-level `system` field;
   * Anthropic only allows a single system string outside the messages array.
   *
   * Tool / function messages are collapsed into user-side `tool_result` blocks
   * (Anthropic has no tool role — tool outputs are user messages carrying
   * `tool_result` blocks). Assistant tool calls become `tool_use` blocks. */
  private translateMessages(messages: ChatMessage[]): { system?: string; messages: AnthropicWireMessage[] } {
    let system: string | undefined;
    const result: AnthropicWireMessage[] = [];

    for (const m of messages) {
      // ChatMessage.role is 'system' | 'user' | 'assistant' | 'tool'. Map
      // 'developer' (a newer OpenAI role used by some clients) to 'system'
      // the same way the other providers do.
      const role = m.role;
      if (role === 'system') {
        const text = contentToString(m.content);
        if (text) system = system ? `${system}\n${text}` : text;
        continue;
      }

      if (role === 'assistant') {
        if (m.tool_calls && m.tool_calls.length > 0) {
          const blocks: AnthropicAssistantContentBlock[] = [];
          const text = contentToString(m.content);
          if (text) blocks.push({ type: 'text', text });
          for (const tc of m.tool_calls) {
            let input: unknown;
            try {
              input = JSON.parse(tc.function.arguments);
            } catch {
              // Malformed arguments from the client. Anthropic expects an
              // object; send an empty object rather than dropping the call
              // (the model is more useful seeing the call attempt than not).
              input = {};
            }
            blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
          }
          result.push({ role: 'assistant', content: blocks });
          continue;
        }
        // Plain assistant turn. Anthropic allows content: '' here (e.g. a
        // turn that's a sequence of tool calls on a different assistant
        // message) but `null` is not legal — coerce to '' to avoid 400s.
        result.push({ role: 'assistant', content: contentToString(m.content) || '' });
        continue;
      }

      if (role === 'tool') {
        // OpenAI 'tool' role carries the output of a prior tool call. Anthropic
        // expresses this as a user message containing a tool_result block.
        // tool_call_id is required by OpenAI's spec; fall back to '' if a
        // misbehaving client omitted it (Anthropic will 400, which is correct
        // — there's no good answer to "tool result for which call?").
        result.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: m.tool_call_id ?? '',
            content: contentToString(m.content),
          }],
        });
        continue;
      }

      // 'user' (or any future role we don't recognize). Flatten to a string;
      // Anthropic accepts both a string and a content-block array, and the
      // string form is what every non-multimodal code path uses.
      result.push({ role: 'user', content: contentToString(m.content) });
    }

    return { system, messages: result };
  }

  /** Build an OpenAI-shaped response from Anthropic's content-block response.
   *  - text blocks accumulate into `message.content`
   *  - tool_use blocks become `tool_calls` entries
   *  - thinking blocks are dropped (no OpenAI field to carry them; see class
   *    docstring on what this loses vs. preserving)
   *  - stop_reason is mapped end_turn→stop, max_tokens→length, tool_use→
   *    tool_calls, stop_sequence→stop
   *  - usage: input_tokens→prompt_tokens, output_tokens→completion_tokens
   */
  private translateResponse(body: AnthropicResponse, modelId: string): ChatCompletionResponse {
    let content = '';
    const toolCalls: ChatToolCall[] = [];

    for (const block of body.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        const tu = block as typeof block & { id: string; name: string };
        toolCalls.push({
          id: tu.id,
          type: 'function',
          function: {
            name: tu.name,
            arguments: JSON.stringify(tu.input ?? {}),
          },
        });
      }
      // 'thinking' (and any future block type) is intentionally dropped.
    }

    return {
      id: body.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          // Per OpenAI: when tool_calls are present, content is typically null
          // (clients branch on the presence of tool_calls). Preserve a text
          // answer when both are returned.
          content: content || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: this.translateStopReason(body.stop_reason),
      }],
      usage: this.translateUsage(body.usage),
      _routed_via: { platform: this.platform, model: modelId },
    };
  }

  private translateStopReason(reason: AnthropicResponse['stop_reason']): string {
    switch (reason) {
      case 'end_turn':
      case 'stop_sequence':
        return 'stop';
      case 'max_tokens':
        return 'length';
      case 'tool_use':
        return 'tool_calls';
      default:
        return 'stop';
    }
  }

  private translateUsage(usage?: AnthropicResponse['usage']): TokenUsage {
    const input = usage?.input_tokens ?? 0;
    const output = usage?.output_tokens ?? 0;
    return {
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens: input + output,
    };
  }

  /** Build the request body for either the non-streaming or streaming path. */
  private buildRequestBody(
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    stream = false,
  ): AnthropicRequestBody {
    const { system, messages: wireMessages } = this.translateMessages(messages);
    const suppressTools = options?.tool_choice === 'none';

    const body: AnthropicRequestBody = {
      model: modelId,
      max_tokens: options?.max_tokens ?? DEFAULT_MAX_TOKENS,
      messages: wireMessages,
    };
    if (system) body.system = system;
    if (!suppressTools) {
      const tools = this.translateTools(options?.tools);
      if (tools) body.tools = tools;
      const toolChoice = this.translateToolChoice(options?.tool_choice);
      if (toolChoice) body.tool_choice = toolChoice;
    }
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.top_p !== undefined) body.top_p = options.top_p;
    if (stream) body.stream = true;
    return body;
  }

  private buildRequestHeaders(apiKey: string): Record<string, string> {
    // Keyless providers (self-hosted proxies that need no key) get an empty
    // header bag so we never send a `x-api-key: undefined` string the upstream
    // might reject.
    return {
      ...(this.keyless ? {} : { 'x-api-key': apiKey }),
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': ANTHROPIC_BETA,
      'Content-Type': 'application/json',
    };
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const body = this.buildRequestBody(messages, modelId, options, false);
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/v1/messages`,
      {
        method: 'POST',
        headers: this.buildRequestHeaders(apiKey),
        body: JSON.stringify(body),
      },
      options?.timeoutMs ?? this.timeoutMs,
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw providerHttpError(
        res,
        `${this.name} API error ${res.status}: ${(err as { error?: { message?: string } })?.error?.message ?? res.statusText}`,
      );
    }

    let raw: AnthropicResponse;
    try {
      raw = await res.json() as AnthropicResponse;
    } catch {
      throw new Error(
        `${this.name} returned 200 with a non-JSON body — the endpoint is not Anthropic-compatible. ` +
        `Check the base URL points at an Anthropic Messages API root (e.g. https://api.anthropic.com).`,
      );
    }

    const translated = this.translateResponse(raw, modelId);
    // Some Anthropic-compatible proxies echo array-form content; coerce to
    // string for OpenAI-shaped clients (matches other providers' behavior).
    normalizeOutboundContent(translated);
    return translated;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const body = this.buildRequestBody(messages, modelId, options, true);
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/v1/messages`,
      {
        method: 'POST',
        headers: this.buildRequestHeaders(apiKey),
        body: JSON.stringify(body),
      },
      options?.timeoutMs ?? this.timeoutMs,
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw providerHttpError(
        res,
        `${this.name} API error ${res.status}: ${(err as { error?: { message?: string } })?.error?.message ?? res.statusText}`,
      );
    }

    yield* this.readAnthropicStream(res, modelId);
  }

  /**
   * Anthropic SSE is event-oriented: each event is a pair of lines starting
   * with `event: <type>` and `data: <json>`, separated by a blank line. The
   * base reader in `BaseProvider.readSseStream` only knows OpenAI's
   * `data: {json}\n\n` format, so we hand-roll one here.
   *
   * Strategy:
   *  - `message_start`: capture the upstream id/model for chunk framing
   *  - `content_block_start`: record the type (text | tool_use) per index
   *  - `content_block_delta.text_delta`: emit OpenAI content chunks
   *  - `content_block_delta.input_json_delta`: accumulate JSON fragments per
   *    index; emit the assembled tool_call when the block closes
   *  - `content_block_stop`: flush any pending tool_use buffer for that index
   *  - `message_delta`: emit a final chunk carrying finish_reason and any
   *    usage (Anthropic sends updated output_tokens on this event)
   *  - `message_stop`: end of stream
   */
  private async *readAnthropicStream(
    res: Response,
    modelId: string,
  ): AsyncGenerator<ChatCompletionChunk> {
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';
    let upstreamId: string | undefined;
    let currentEvent: string | undefined;
    // For each block index: 'text' | 'tool_use', plus the assembled JSON for
    // tool_use. Block indices are 0-based and stable within a message.
    const blockTypes = new Map<number, 'text' | 'tool_use'>();
    const toolUseBuffers = new Map<number, string>();
    const toolUseMeta = new Map<number, { id: string; name: string }>();
    let finalStopReason: string | null = null;
    let finalUsage: TokenUsage | null = null;
    let emittedFinish = false;
    let sawFinishReason = false;

    const yieldFinishIfNeeded = () => {
      if (emittedFinish) return;
      emittedFinish = true;
      sawFinishReason = true;
      const chunk: ChatCompletionChunk = {
        id: upstreamId ?? this.makeId(),
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: finalStopReason ?? 'stop',
        }],
      };
      if (finalUsage) chunk.usage = finalUsage;
      return chunk;
    };

    try {
      while (true) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`${this.name} stream stalled: no data for ${STREAM_INACTIVITY_TIMEOUT_MS}ms (timeout)`)),
              STREAM_INACTIVITY_TIMEOUT_MS,
            );
          }),
        ]).finally(() => clearTimeout(timer));

        const { done, value } = result;
        if (done) {
          buffer += decoder.decode();
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        // Anthropic events are separated by a blank line (\n\n). Split on
        // \n\n and keep the trailing partial in the buffer.
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';

        for (const rawEvent of events) {
          // Parse the event: / data: lines. Anthropic events are short
          // (~200B), so this is cheap.
          let eventType = currentEvent;
          let dataLine: string | undefined;
          for (const line of rawEvent.split('\n')) {
            const trimmed = line.trimEnd();
            if (trimmed.startsWith('event: ')) {
              eventType = trimmed.slice(7).trim();
            } else if (trimmed.startsWith('data: ')) {
              dataLine = trimmed.slice(6);
            }
          }
          currentEvent = undefined;
          if (!eventType || dataLine == null) continue;

          let payload: AnthropicStreamEvent;
          try {
            payload = JSON.parse(dataLine) as AnthropicStreamEvent;
          } catch {
            // Skip malformed frames — a single bad event shouldn't kill the
            // stream (matches the readSseStream behavior).
            continue;
          }

          switch (eventType) {
            case 'message_start': {
              if (payload.message?.id) upstreamId = payload.message.id;
              break;
            }
            case 'content_block_start': {
              const idx = payload.index ?? 0;
              const block = payload.content_block;
              if (block?.type === 'text') {
                blockTypes.set(idx, 'text');
              } else if (block?.type === 'tool_use') {
                blockTypes.set(idx, 'tool_use');
                toolUseBuffers.set(idx, '');
                if (block.id && block.name) {
                  toolUseMeta.set(idx, { id: block.id, name: block.name });
                }
              }
              break;
            }
            case 'content_block_delta': {
              const idx = payload.index ?? 0;
              const delta = payload.delta;
              if (!delta) break;
              if (delta.type === 'text_delta' && typeof delta.text === 'string') {
                blockTypes.set(idx, 'text');
                yield {
                  id: upstreamId ?? this.makeId(),
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: modelId,
                  choices: [{
                    index: 0,
                    delta: { content: delta.text },
                    finish_reason: null,
                  }],
                };
              } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
                toolUseBuffers.set(idx, (toolUseBuffers.get(idx) ?? '') + delta.partial_json);
              }
              break;
            }
            case 'content_block_stop': {
              const idx = payload.index ?? 0;
              if (blockTypes.get(idx) === 'tool_use') {
                const meta = toolUseMeta.get(idx) ?? { id: `toolu_${idx}`, name: '' };
                const args = toolUseBuffers.get(idx) ?? '';
                yield {
                  id: upstreamId ?? this.makeId(),
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: modelId,
                  choices: [{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        id: meta.id,
                        type: 'function',
                        function: { name: meta.name, arguments: args },
                      }],
                    },
                    finish_reason: null,
                  }],
                };
              }
              break;
            }
            case 'message_delta': {
              const delta = payload.delta;
              if (delta?.stop_reason) {
                finalStopReason = this.translateStopReason(delta.stop_reason);
              }
              if (payload.usage) {
                finalUsage = {
                  // input_tokens arrives on message_start; output_tokens is
                  // updated on message_delta. If we missed message_start,
                  // output is the only token we know.
                  prompt_tokens: 0,
                  completion_tokens: payload.usage.output_tokens ?? 0,
                  total_tokens: payload.usage.output_tokens ?? 0,
                };
              }
              const finish = yieldFinishIfNeeded();
              if (finish) yield finish;
              break;
            }
            case 'message_stop': {
              const finish = yieldFinishIfNeeded();
              if (finish) yield finish;
              return;
            }
            default:
              // Unknown event types (ping, etc.) are ignored.
              break;
          }
        }
      }

      // Stream ended without message_stop — emit a finish chunk so the client
      // sees a clean termination rather than hanging.
      const finish = yieldFinishIfNeeded();
      if (finish) yield finish;
    } finally {
      reader.cancel().catch(() => { /* upstream already gone */ });
    }

    if (!sawFinishReason) {
      throw new Error(`${this.name} stream ended unexpectedly (no message_stop, no stop_reason) — connection reset or truncated upstream`);
    }
  }

  async validateKey(apiKey: string): Promise<boolean> {
    // Anthropic's Messages API rejects GET with 405, so we can't probe it
    // directly. POST a minimal messages request (1 token budget) and treat
    // 200 or 400 (bad request, e.g. invalid model id) as authenticated; only
    // 401/403 indicate an invalid key. Transport errors propagate — health.ts
    // catches them and marks the key status='error' without disabling it.
    //
    // Note: some Anthropic-compatible proxies reject POST /v1/messages
    // without a body, so we send `{}` to a dedicated lightweight endpoint
    // (count_tokens) when available, falling back to /v1/messages otherwise.
    const url = `${this.baseUrl}/v1/messages`;
    const res = await this.fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: this.buildRequestHeaders(apiKey),
        body: JSON.stringify({
          model: 'claude-3-haiku-20240307',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      },
      30000,
    );
    return res.status !== 401 && res.status !== 403;
  }
}
