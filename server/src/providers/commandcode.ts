import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatMessage,
  ChatToolCall,
  ChatToolDefinition,
} from "@animarouter/shared/types.js";
import { contentToString } from "../lib/content.js";
import {
  BaseProvider,
  type CompletionOptions,
  providerHttpError,
} from "./base.js";

const NPM_VERSION_URL = "https://registry.npmjs.org/command-code/latest";
const API_BASE = "https://api.commandcode.ai";
/** Fallback max_tokens when neither the caller nor the catalog specifies one.
 *  Matches the Go reference proxy (proxy.go:92). */
const FALLBACK_MAX_TOKENS = 64000;
/** Default temperature. The Go reference proxy defaults to 0.3, but
 *  the CommandCode API is tuned for 0.7 (matching the Livebench/default
 *  consensus observed across providers). */
const DEFAULT_TEMPERATURE = 0.7;
const STREAM_TIMEOUT_MS = 300000; // 5 min — same as BaseProvider.readSseStream
const VERSION_FALLBACK = "0.18.10"; // upstream's minVersion — safe floor if npm is unreachable
const MIN_SUPPORTED_VERSION = "0.18.10";

let cachedVersion: string | undefined;
let versionPromise: Promise<string> | undefined;

/** Fetch the latest command-code npm version, cached for the process lifetime.
 * Mirrors the Go proxy's behavior of sending an up-to-date x-command-code-version. */
async function getCommandCodeVersion(): Promise<string> {
  if (cachedVersion) return cachedVersion;
  if (versionPromise) return versionPromise;

  versionPromise = (async () => {
    try {
      const res = await fetch(NPM_VERSION_URL, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return VERSION_FALLBACK;
      const pkg = (await res.json()) as { version?: string };
      const v =
        typeof pkg.version === "string" ? pkg.version : VERSION_FALLBACK;
      // Always send at least the known-minimum so the upstream doesn't 426 us
      cachedVersion =
        compareVersions(v, MIN_SUPPORTED_VERSION) < 0
          ? MIN_SUPPORTED_VERSION
          : v;
      return cachedVersion;
    } catch {
      cachedVersion = VERSION_FALLBACK;
      return cachedVersion;
    } finally {
      versionPromise = undefined;
    }
  })();
  return versionPromise;
}

/** Loose semver-ish compare: returns <0 if a<b, 0 if equal, >0 if a>b. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((p) => parseInt(p, 10) || 0);
  const pb = b.split(".").map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

// ── CommandCode wire types ───────────────────────────────────────────────

interface CCContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  toolCallId?: string;
  toolName?: string;
  tool_use_id?: string;
  content?: unknown;
  output?: { type: string; value: string };
}

interface CCStreamEvent {
  type: string;
  text?: string;
  id?: string;
  delta?: string;
  input?: Record<string, unknown>;
  toolCallId?: string;
  toolName?: string;
  finishReason?: string;
  totalUsage?: { inputTokens: number; outputTokens: number };
  // Optional reasoning fields. CommandCode's wrapper surfaces model-side
  // reasoning traces under varying keys depending on the underlying model;
  // we capture any of these so OpenAI-format clients can preserve the trace
  // for multi-turn replay. (#290)
  reasoning?: string;
  reasoningContent?: string;
  reasoning_content?: string;
  thinking?: string | { text?: string; thinking?: string };
  redacted_thinking?: string;
  error?: { message: string; statusCode?: number };
}

/** Normalize the variable-shape reasoning field on CCStreamEvent to a string.
 * CommandCode's wrapper surfaces reasoning traces under varying keys
 * depending on the underlying model (`reasoning`, `text`, `thinking`
 * as object/string, …). This helper flattens any of them. (#290) */
function extractReasoningFromEvent(event: CCStreamEvent): string {
  if (typeof event.reasoning_content === "string")
    return event.reasoning_content;
  if (typeof event.reasoningContent === "string") return event.reasoningContent;
  if (typeof event.reasoning === "string") return event.reasoning;
  if (typeof event.redacted_thinking === "string")
    return event.redacted_thinking;
  if (typeof event.thinking === "string") return event.thinking;
  if (event.thinking && typeof event.thinking === "object") {
    const inner = event.thinking.text ?? event.thinking.thinking;
    if (typeof inner === "string") return inner;
  }
  if (
    typeof event.text === "string" &&
    event.type?.toLowerCase().includes("reason")
  ) {
    return event.text;
  }
  return "";
}

interface StreamingToolDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

interface StreamingDelta {
  role?: "assistant";
  content?: string;
  tool_calls?: StreamingToolDelta[];
  reasoning_content?: string;
}

// ── Provider ─────────────────────────────────────────────────────────────

export class CommandCodeProvider extends BaseProvider {
  readonly platform = "commandcode" as const;
  readonly name = "CommandCode";
  // baseUrl left undefined — CommandCode has no /v1/models endpoint, so
  // auto-discovery skips this provider.

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    const body = this.buildRequestBody(messages, modelId, options);
    const headers = await this.requestHeaders(apiKey);
    const res = await this.fetchWithTimeout(
      `${API_BASE}/alpha/generate`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: options?.signal,
      },
      options?.timeoutMs ?? 120000,
    );

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw providerHttpError(
        res,
        `CommandCode API error ${res.status}: ${err}`,
      );
    }

    return this.collectNonStreamResponse(res, modelId);
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    const body = this.buildRequestBody(messages, modelId, options);
    const headers = await this.requestHeaders(apiKey);
    const res = await this.fetchWithTimeout(
      `${API_BASE}/alpha/generate`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: options?.signal,
      },
      options?.timeoutMs ?? 120000,
    );
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw providerHttpError(
        res,
        `CommandCode API error ${res.status}: ${err}`,
      );
    }

    yield* this.streamNdjsonResponse(res, modelId);
  }

  async validateKey(apiKey: string): Promise<boolean> {
    try {
      const headers = await this.requestHeaders(apiKey);
      const res = await this.fetchWithTimeout(
        `${API_BASE}/alpha/generate`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            config: this.defaultConfig(),
            memory: "",
            taste: "",
            skills: "",
            params: {
              model: "deepseek/deepseek-v4-flash",
              messages: [
                { role: "user", content: [{ type: "text", text: "hi" }] },
              ],
              system: "",
              max_tokens: 1,
              temperature: 0.7,
              stream: true,
              tools: [],
            },
            threadId: crypto.randomUUID(),
          }),
        },
        15000,
      );
      return res.ok || res.status >= 500;
    } catch {
      return true;
    }
  }

  // ── Request building ───────────────────────────────────────────────────

  private buildRequestBody(
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Record<string, unknown> {
    const system = this.buildSystemText(messages);
    const ccMessages = this.convertMessages(messages);
    const tools = this.convertTools(options?.tools);
    const temperature = options?.temperature ?? DEFAULT_TEMPERATURE;
    const maxTokens = options?.max_tokens ?? FALLBACK_MAX_TOKENS;

    return {
      config: this.defaultConfig(),
      memory: "",
      taste: "",
      skills: "",
      params: {
        model: modelId,
        messages: ccMessages,
        tools,
        system,
        max_tokens: maxTokens,
        temperature,
        stream: true,
        // Pass thinking signals through to the underlying provider. The
        // CommandCode wrapper reaches model-specific APIs that
        // recognize `reasoning_effort`; the richer `thinking` object is
        // forwarded verbatim too so the wrapper can pick what it
        // understands. (#290)
        ...(options?.reasoning_effort
          ? { reasoning_effort: options.reasoning_effort }
          : {}),
        ...(options?.thinking ? { thinking: options.thinking } : {}),
      },
      threadId: crypto.randomUUID(),
    };
  }

  private defaultConfig(): Record<string, unknown> {
    return {
      workingDir: ".",
      date: new Date().toISOString().slice(0, 10),
      environment: "cli",
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "main",
      gitStatus: "",
      recentCommits: [],
    };
  }

  private async requestHeaders(
    apiKey: string,
  ): Promise<Record<string, string>> {
    const version = await getCommandCodeVersion();
    return {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "x-command-code-version": version,
      "x-cli-environment": "production",
      Accept: "text/event-stream",
    };
  }

  // ── Message translation ────────────────────────────────────────────────

  private buildSystemText(messages: ChatMessage[]): string {
    let system = "";
    for (const m of messages) {
      if (m.role === "system") {
        if (system.length > 0) system += "\n";
        system += this.blockText(m.content);
      }
    }
    return system;
  }

  private convertMessages(
    messages: ChatMessage[],
  ): Array<{ role: string; content: CCContentBlock[] }> {
    const toolNames = new Map<string, string>();
    for (const m of messages) {
      if (m.role === "assistant" && "tool_calls" in m) {
        const calls = (m as { tool_calls?: ChatToolCall[] }).tool_calls;
        if (calls) {
          for (const tc of calls) {
            if (tc.id && tc.function?.name)
              toolNames.set(tc.id, tc.function.name);
          }
        }
      }
    }

    const out: Array<{ role: string; content: CCContentBlock[] }> = [];
    for (const m of messages) {
      if (m.role === "system") continue;

      if (m.role === "tool") {
        const toolMsg = m as ChatMessage & { tool_call_id: string };
        const name =
          (m as { name?: string }).name ||
          toolNames.get(toolMsg.tool_call_id) ||
          "unknown";
        const val = this.blockText(m.content);
        out.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: toolMsg.tool_call_id,
              toolName: name,
              output: {
                type: val.startsWith("Error:") ? "error-text" : "text",
                value: val,
              },
            },
          ],
        });
        continue;
      }

      if (m.role === "assistant" && "tool_calls" in m) {
        const a = m as ChatMessage & { tool_calls?: ChatToolCall[] };
        const blocks: CCContentBlock[] = this.contentToBlocks(m.content);
        const added = new Set(
          blocks
            .filter((b) => b.type === "tool-call" && b.toolCallId)
            .map((b) => b.toolCallId!),
        );

        for (const tc of a.tool_calls ?? []) {
          if (added.has(tc.id)) continue;
          blocks.push({
            type: "tool-call",
            toolCallId: tc.id,
            toolName: tc.function?.name,
            input: this.safeParseJson(tc.function?.arguments),
          });
          added.add(tc.id);
        }
        out.push({ role: "assistant", content: blocks });
        continue;
      }

      out.push({ role: m.role, content: this.contentToBlocks(m.content) });
    }
    return out;
  }
  /** Extract the text value from an individual content block object, mirroring
   *  the Go proxy's `contentPartToString()` in convert.go. Key difference from
   *  lib/content.ts's `contentToString`: that function operates on a whole
   *  message (string | null | array), NOT on single block objects — a bare
   *  `{type:'text',text:'Hello'}` returns '' from it, silently dropping user
   *  content. This helper handles single blocks directly. */
  private blockText(block: unknown): string {
    if (block === null || block === undefined) return "";
    if (typeof block === "string") return block;
    if (Array.isArray(block)) {
      return block.map((b) => this.blockText(b)).join("");
    }
    if (typeof block === "object") {
      const b = block as Record<string, unknown>;
      // Common text-carrying keys — same order as Go reference
      for (const key of [
        "text",
        "content",
        "output_text",
        "input_text",
        "refusal",
        "thinking",
        "redacted_thinking",
      ]) {
        if (typeof b[key] === "string") return b[key] as string;
      }
      // Image blocks → descriptive string
      const iu = b["image_url"];
      if (
        iu &&
        typeof iu === "object" &&
        typeof (iu as Record<string, unknown>)["url"] === "string"
      ) {
        return `[Image URL: ${(iu as Record<string, unknown>)["url"]}]`;
      }
      if (typeof iu === "string") return `[Image URL: ${iu}]`;
      // Fallback: stringify the block
      try {
        return JSON.stringify(b);
      } catch {
        return String(b);
      }
    }
    return String(block);
  }

  /** Convert an OpenAI content value to CommandCode content blocks.
   *  Matches the Go reference proxy's `parseContent()` in convert.go — every
   *  block type the Go proxy preserves is preserved here so conversation
   *  history is never silently truncated. */
  private contentToBlocks(
    content: unknown,
    _toolNames?: Map<string, string>,
  ): CCContentBlock[] {
    if (content === null || content === undefined) return [];
    if (typeof content === "string") {
      return content.length > 0 ? [{ type: "text", text: content }] : [];
    }
    if (Array.isArray(content)) {
      return content
        .map((c): CCContentBlock | null => {
          if (typeof c === "string") return { type: "text", text: c };
          const b = c as Record<string, unknown>;
          const typ = typeof b.type === "string" ? b.type : "";

          // ── text-like blocks (Go: text, input_text, output_text, refusal,
          //     thinking, redacted_thinking, reasoning, document, search_result) ──
          if (
            typ === "text" ||
            typ === "input_text" ||
            typ === "output_text" ||
            typ === "refusal" ||
            typ === "thinking" ||
            typ === "redacted_thinking" ||
            typ === "reasoning" ||
            typ === "document" ||
            typ === "search_result"
          ) {
            return { type: "text", text: this.blockText(b) };
          }

          // ── image-like blocks (Go: image_url, input_image, image → stringified text) ──
          if (typ === "image_url" || typ === "input_image" || typ === "image") {
            return { type: "text", text: this.blockText(b) };
          }

          // ── tool-call blocks (Go: tool_use, tool-call) ──
          if (typ === "tool_use" || typ === "tool-call" || b.tool_use_id) {
            const id =
              (typeof b.id === "string" ? b.id : "") ||
              (typeof b.toolCallId === "string" ? b.toolCallId : "") ||
              (typeof b.tool_use_id === "string" ? b.tool_use_id : "");
            const name =
              (typeof b.name === "string" ? b.name : "") ||
              (typeof b.toolName === "string" ? b.toolName : "");
            const input = b.input ?? b.arguments;
            const block: CCContentBlock = { type: "tool-call", input };
            if (id) block.toolCallId = id;
            if (name) block.toolName = name;
            return block;
          }

          // ── tool-result blocks (Go: tool_result, tool-result) ──
          if (typ === "tool_result" || typ === "tool-result") {
            const toolUseId =
              (typeof b.tool_use_id === "string" ? b.tool_use_id : "") ||
              (typeof b.toolCallId === "string" ? b.toolCallId : "");
            const toolName = typeof b.toolName === "string" ? b.toolName : "";
            const contentVal = this.blockText(b.content ?? b.output);
            const outputType = contentVal.startsWith("Error:")
              ? "error-text"
              : "text";
            const block: CCContentBlock = {
              type: "tool-result",
              output: { type: outputType, value: contentVal },
            };
            if (toolUseId) block.toolCallId = toolUseId;
            if (toolName) block.toolName = toolName;
            return block;
          }

          // ── fallthrough: unknown types become text ──
          return { type: "text", text: this.blockText(b) };
        })
        .filter((b): b is CCContentBlock => b !== null);
    }
    return [];
  }

  private convertTools(
    tools?: ChatToolDefinition[],
  ): Record<string, unknown>[] {
    if (!tools || tools.length === 0) return [];
    return tools
      .filter((t) => t.type === "function" && t.function?.name)
      .map((t) => {
        const out: Record<string, unknown> = {
          name: t.function.name,
          input_schema: t.function.parameters ?? {
            type: "object",
            properties: {},
          },
        };
        if (t.function.description) out.description = t.function.description;
        return out;
      });
  }

  private async collectNonStreamResponse(
    res: Response,
    modelId: string,
  ): Promise<ChatCompletionResponse> {
    const events = await this.readNdjsonEvents(res);
    let content = "";
    let reasoning = "";
    const toolCalls: ChatToolCall[] = [];
    const toolCallBySlot: Record<string, number> = {};
    let inputTokens = 0;
    let outputTokens = 0;

    for (const event of events) {
      switch (event.type) {
        case "text-delta":
          content += event.text ?? "";
          break;
        case "reasoning-delta":
        case "reasoning-deltas":
        case "reasoning": {
          const r = extractReasoningFromEvent(event);
          if (r) reasoning = reasoning ? `${reasoning}\n${r}` : r;
          break;
        }
        case "tool-use":
          toolCallBySlot[event.toolCallId!] = toolCalls.length;
          toolCalls.push({
            id: event.toolCallId!,
            type: "function",
            function: { name: event.toolName ?? "", arguments: "" },
          });
          break;
        case "tool-delta":
          if (toolCalls.length > 0)
            toolCalls[toolCalls.length - 1].function.arguments +=
              event.text ?? "";
          break;
        case "tool-input-start":
          toolCallBySlot[event.id!] = toolCalls.length;
          toolCalls.push({
            id: event.id!,
            type: "function",
            function: { name: event.toolName ?? "", arguments: "" },
          });
          break;
        case "tool-input-delta":
          if (event.id && toolCallBySlot[event.id] !== undefined) {
            toolCalls[toolCallBySlot[event.id]].function.arguments +=
              event.delta ?? "";
          }
          break;
        case "tool-call": {
          const args = event.input ? JSON.stringify(event.input) : "";
          const idx = event.toolCallId
            ? toolCallBySlot[event.toolCallId]
            : undefined;
          if (idx !== undefined) {
            if (event.toolName) toolCalls[idx].function.name = event.toolName;
            if (args) toolCalls[idx].function.arguments = args;
          } else {
            toolCalls.push({
              id: event.toolCallId!,
              type: "function",
              function: { name: event.toolName ?? "", arguments: args },
            });
          }
          break;
        }
        case "finish":
          if (event.totalUsage) {
            inputTokens = event.totalUsage.inputTokens;
            outputTokens = event.totalUsage.outputTokens;
          }
          break;
      }
    }

    const hasToolCalls = toolCalls.length > 0;
    const finishReason = hasToolCalls ? "tool_calls" : "stop";
    const msg: {
      role: string;
      content: string | null;
      tool_calls?: ChatToolCall[];
      reasoning_content?: string;
    } = {
      role: "assistant",
      content: hasToolCalls ? null : content,
    };
    if (hasToolCalls) msg.tool_calls = toolCalls;
    if (reasoning.length > 0) msg.reasoning_content = reasoning;

    return {
      id: this.makeId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [
        {
          index: 0,
          message: msg as ChatCompletionResponse["choices"][0]["message"],
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    };
  }

  // ── Streaming ──────────────────────────────────────────────────────────

  private async *streamNdjsonResponse(
    res: Response,
    modelId: string,
  ): AsyncGenerator<ChatCompletionChunk> {
    const id = this.makeId();
    const created = Math.floor(Date.now() / 1000);
    let sentRole = false;
    let toolCallIndex = 0;
    const toolCallSlot: Record<string, number> = {};
    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");
    const decoder = new TextDecoder();
    let buf = "";

    try {
      while (true) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("CommandCode stream stalled")),
              STREAM_TIMEOUT_MS,
            );
          }),
        ]).finally(() => clearTimeout(timer));

        const { done, value } = result;
        if (done) {
          buf += decoder.decode();
          yield* this.flushStreamBuffer(
            buf,
            id,
            created,
            modelId,
            () => sentRole,
            (v) => {
              sentRole = v;
            },
            toolCallSlot,
            () => toolCallIndex,
            (v) => {
              toolCallIndex = v;
            },
          );
          break;
        }

        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          const chunk = this.processStreamLine(
            line,
            id,
            created,
            modelId,
            () => sentRole,
            (v) => {
              sentRole = v;
            },
            toolCallSlot,
            () => toolCallIndex,
            (v) => {
              toolCallIndex = v;
            },
          );
          if (chunk) yield chunk;
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  private *flushStreamBuffer(
    buf: string,
    id: string,
    created: number,
    modelId: string,
    getRole: () => boolean,
    setRole: (v: boolean) => void,
    toolCallSlot: Record<string, number>,
    getIdx: () => number,
    setIdx: (v: number) => void,
  ): Generator<ChatCompletionChunk> {
    for (const line of buf.split("\n")) {
      const chunk = this.processStreamLine(
        line,
        id,
        created,
        modelId,
        getRole,
        setRole,
        toolCallSlot,
        getIdx,
        setIdx,
      );
      if (chunk) yield chunk;
    }
  }

  private processStreamLine(
    line: string,
    id: string,
    created: number,
    modelId: string,
    getRole: () => boolean,
    setRole: (v: boolean) => void,
    toolCallSlot: Record<string, number>,
    getIdx: () => number,
    setIdx: (v: number) => void,
  ): ChatCompletionChunk | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    const event = this.safeParseJson(trimmed) as CCStreamEvent | null;
    if (!event || !event.type) return null;
    switch (event.type) {
      case "text-delta": {
        const delta: StreamingDelta = { content: event.text };
        if (!getRole()) {
          delta.role = "assistant";
          setRole(true);
        }
        return this.buildChunk(id, created, modelId, delta, null);
      }
      case "reasoning-delta":
      case "reasoning-deltas":
      case "reasoning":
      case "thinking-delta": {
        const text = extractReasoningFromEvent(event);
        if (text.length === 0) return null;
        const delta: StreamingDelta = { reasoning_content: text };
        if (!getRole()) {
          delta.role = "assistant";
          setRole(true);
        }
        return this.buildChunk(id, created, modelId, delta, null);
      }
      case "tool-use": {
        const idx = getIdx();
        toolCallSlot[event.toolCallId!] = idx;
        const tc: StreamingToolDelta = {
          index: idx,
          id: event.toolCallId!,
          type: "function",
          function: { name: event.toolName },
        };
        const delta: StreamingDelta = { tool_calls: [tc] };
        if (!getRole()) {
          delta.role = "assistant";
          setRole(true);
        }
        return this.buildChunk(id, created, modelId, delta, null);
      }
      case "tool-delta": {
        const prevIdx = getIdx() - 1;
        const delta: StreamingDelta = {
          tool_calls: [{ index: prevIdx, function: { arguments: event.text } }],
        };
        return this.buildChunk(id, created, modelId, delta, null);
      }
      case "tool-input-start": {
        if (toolCallSlot[event.id!] === undefined) {
          const idx = getIdx();
          toolCallSlot[event.id!] = idx;
          setIdx(idx + 1);
        }
        const idx = toolCallSlot[event.id!];
        const tc: StreamingToolDelta = {
          index: idx,
          id: event.id!,
          type: "function",
          function: { name: event.toolName },
        };
        const delta: StreamingDelta = { tool_calls: [tc] };
        if (!getRole()) {
          delta.role = "assistant";
          setRole(true);
        }
        return this.buildChunk(id, created, modelId, delta, null);
      }
      case "tool-input-delta": {
        const idx = toolCallSlot[event.id!] ?? getIdx();
        const delta: StreamingDelta = {
          tool_calls: [{ index: idx, function: { arguments: event.delta } }],
        };
        return this.buildChunk(id, created, modelId, delta, null);
      }
      case "tool-call": {
        if (!event.toolCallId) return null;
        if (toolCallSlot[event.toolCallId] !== undefined) return null;
        const idx = getIdx();
        toolCallSlot[event.toolCallId] = idx;
        setIdx(idx + 1);
        const args = event.input ? JSON.stringify(event.input) : "";
        const tc: StreamingToolDelta = {
          index: idx,
          id: event.toolCallId,
          type: "function",
          function: { name: event.toolName, arguments: args },
        };
        const delta: StreamingDelta = { tool_calls: [tc] };
        if (!getRole()) {
          delta.role = "assistant";
          setRole(true);
        }
        return this.buildChunk(id, created, modelId, delta, null);
      }
      case "finish": {
        const reason = this.mapFinishReason(event.finishReason);
        return {
          id,
          object: "chat.completion.chunk",
          created,
          model: modelId,
          choices: [{ index: 0, delta: {}, finish_reason: reason }],
          usage: event.totalUsage
            ? {
                prompt_tokens: event.totalUsage.inputTokens,
                completion_tokens: event.totalUsage.outputTokens,
                total_tokens:
                  event.totalUsage.inputTokens + event.totalUsage.outputTokens,
              }
            : undefined,
        };
      }
      default:
        return null;
    }
  }

  private buildChunk(
    id: string,
    created: number,
    modelId: string,
    delta: StreamingDelta,
    finishReason: string | null,
  ): ChatCompletionChunk {
    return {
      id,
      object: "chat.completion.chunk",
      created,
      model: modelId,
      choices: [
        {
          index: 0,
          delta: delta as unknown as ChatCompletionChunk["choices"][0]["delta"],
          finish_reason: finishReason,
        },
      ],
    } satisfies ChatCompletionChunk;
  }

  private mapFinishReason(reason?: string): string {
    if (reason === "tool_calls" || reason === "tool-calls") return "tool_calls";
    if (reason === "length" || reason === "max_tokens") return "length";
    if (reason === "content_filter" || reason === "content-filter")
      return "content_filter";
    return "stop";
  }

  private async readNdjsonEvents(res: Response): Promise<CCStreamEvent[]> {
    const text = await res.text();
    const events: CCStreamEvent[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = this.safeParseJson(trimmed);
      if (parsed && typeof parsed === "object" && "type" in parsed) {
        events.push(parsed as CCStreamEvent);
      }
    }
    return events;
  }

  private safeParseJson(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}
