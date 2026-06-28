import type { AddressInfo } from "node:net";
import type { ChatMessage } from "@animarouter/shared/types.js";
import type { Express } from "express";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const chatCompletion = vi.fn();
const streamChatCompletion = vi.fn();
const fakeProvider = { name: "fake", chatCompletion, streamChatCompletion };

vi.mock("../../providers/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../providers/index.js")>();
  return {
    ...actual,
    getProvider: () => fakeProvider,
    resolveProvider: () => fakeProvider,
    buildProviderFor: () => fakeProvider,
  };
});

const { createApp } = await import("../../app.js");
const { initDb, getDb, getUnifiedApiKey, setSetting } = await import(
  "../../db/index.js"
);
const { encrypt } = await import("../../lib/crypto.js");
const { setRoutingStrategy } = await import("../../services/router.js");

async function post(
  app: Express,
  path: string,
  body: Record<string, unknown>,
  key: string,
) {
  const server = app.listen(0);
  const addr = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(raw);
    } catch {}
    return { status: res.status, body: json, headers: res.headers };
  } finally {
    server.close();
  }
}

function messageText(messages: ChatMessage[]): string {
  return messages.map((message) => String(message.content)).join("\n");
}

function addModel(opts: {
  platform: string;
  modelId: string;
  name: string;
  intelligenceRank: number;
  speedRank: number;
  sizeLabel: string;
  priority: number;
}) {
  const db = getDb();
  db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(
    opts.platform,
    opts.modelId,
    opts.name,
    opts.intelligenceRank,
    opts.speedRank,
    opts.sizeLabel,
  );
  const modelDbId = (
    db
      .prepare("SELECT id FROM models WHERE platform = ? AND model_id = ?")
      .get(opts.platform, opts.modelId) as { id: number }
  ).id;
  db.prepare(
    "INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)",
  ).run(modelDbId, opts.priority);
  return modelDbId;
}

function addKey(platform: string) {
  const { encrypted, iv, authTag } = encrypt(`${platform}-key`);
  getDb()
    .prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', ?, ?, ?, 'healthy', 1)
  `)
    .run(platform, encrypted, iv, authTag);
}

describe("Rabbit proxy integration", () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = "0".repeat(64);
    initDb(":memory:");
    app = createApp();
    key = getUnifiedApiKey();
  });

  beforeEach(() => {
    const db = getDb();
    db.exec(`
      DELETE FROM fallback_config;
      DELETE FROM api_keys;
      DELETE FROM models;
      DELETE FROM requests;
      DELETE FROM settings
      WHERE key LIKE 'rabbit_%'
         OR key LIKE 'oscillator_%'
         OR key IN ('routing_strategy', 'model_grouping_enabled');
    `);
    setSetting("model_grouping_enabled", "false");
    setRoutingStrategy("rabbit");
    setSetting("rabbit_enabled", "true");
    setSetting("oscillator_foundation_selection", "auto");
    setSetting("oscillator_injection_selection", "divergent");
    setSetting("oscillator_min_intelligence_gap", "0");
    setSetting("oscillator_injection_max_sentences", "2");
    setSetting("oscillator_load_shed_threshold", "21");
    setSetting("oscillator_step_timeout_ms", "1000");

    addModel({
      platform: "alpha",
      modelId: "foundation",
      name: "Foundation",
      intelligenceRank: 1,
      speedRank: 3,
      sizeLabel: "Frontier",
      priority: 1,
    });
    addModel({
      platform: "beta",
      modelId: "injection",
      name: "Injection",
      intelligenceRank: 2,
      speedRank: 4,
      sizeLabel: "Large",
      priority: 2,
    });
    addKey("alpha");
    addKey("beta");
    chatCompletion.mockReset();
    streamChatCompletion.mockReset();
  });

  it("routes eligible non-streaming Rabbit requests through Foundation, Injection, and Anchor steps", async () => {
    chatCompletion.mockImplementation(
      async (_apiKey: string, messages: ChatMessage[], modelId: string) => {
        if (
          modelId === "foundation" &&
          chatCompletion.mock.calls.length === 1
        ) {
          return {
            choices: [
              { message: { role: "assistant", content: "Foundation base." } },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          };
        }
        if (modelId === "injection") {
          expect(messageText(messages)).toContain(
            "[Thought Context: Foundation base.]",
          );
          return {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Alternative angle. Concise.",
                },
              },
            ],
            usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
          };
        }
        expect(modelId).toBe("foundation");
        expect(messageText(messages)).toContain(
          "[Thought Context: Alternative angle. Concise.]",
        );
        return {
          choices: [
            { message: { role: "assistant", content: "Final Rabbit answer." } },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        };
      },
    );

    const { status, body, headers } = await post(
      app,
      "/v1/chat/completions",
      {
        model: "auto",
        messages: [
          {
            role: "user",
            content: "Analyze this architecture and explain the tradeoffs.",
          },
        ],
      },
      key,
    );

    expect(status).toBe(200);
    expect(
      (body as { choices: Array<{ message: { content: string } }> }).choices[0]
        .message.content,
    ).toBe("Final Rabbit answer.");
    expect(headers.get("x-rabbit-status")).toBe("completed");
    expect(chatCompletion.mock.calls.map((call) => call[2])).toEqual([
      "foundation",
      "injection",
      "foundation",
    ]);
  });
});
