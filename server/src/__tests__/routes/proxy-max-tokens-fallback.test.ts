import type { Express } from "express";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the provider so we can inspect the forwarded max_tokens.
const chatCompletion = vi.fn();
const streamChatCompletion = vi.fn();
const fakeProvider = {
  name: "fake",
  chatCompletion,
  streamChatCompletion,
} as any;

vi.mock("../../providers/index.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    getProvider: () => fakeProvider,
    resolveProvider: () => fakeProvider,
    buildProviderFor: () => fakeProvider,
  };
});

const { createApp } = await import("../../app.js");
const { initDb, getDb, getUnifiedApiKey } = await import("../../db/index.js");
const { encrypt } = await import("../../lib/crypto.js");
const { setRoutingStrategy } = await import("../../services/router.js");

async function post(app: Express, path: string, body: any, key: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  server.close();
  let json: any = null;
  try {
    json = JSON.parse(raw);
  } catch {}
  return { status: res.status, body: json, raw, headers: res.headers };
}

const GOOD_RESULT = {
  id: "chatcmpl-test",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "hi" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
};

describe("max_output_tokens catalog fallback", () => {
  let app: Express;
  let key: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = "0".repeat(64);
    initDb(":memory:");
    app = createApp();
    key = getUnifiedApiKey();

    const db = getDb();
    setRoutingStrategy("priority");

    // Set max_output_tokens on one already-seeded NVIDIA model so the
    // fallback logic has something to surface when the caller omits max_tokens.
    db.prepare(`
      UPDATE models SET max_output_tokens = 8192
      WHERE platform = 'nvidia' AND model_id = 'meta/llama-3.1-70b-instruct'
    `).run();

    // Insert an NVIDIA key so the model routes.
    const { encrypted, iv, authTag } = encrypt("sk-nvidia-test");
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('nvidia', 'test', ?, ?, ?, 'healthy', 1)
    `).run(encrypted, iv, authTag);
  });

  beforeEach(() => {
    chatCompletion.mockReset();
    streamChatCompletion.mockReset();
    chatCompletion.mockResolvedValue(GOOD_RESULT);
    getDb().prepare("DELETE FROM rate_limit_cooldowns").run();
  });

  it("uses catalog max_output_tokens when caller omits max_tokens", async () => {
    const res = await post(
      app,
      "/v1/chat/completions",
      {
        messages: [{ role: "user", content: "hi" }],
      },
      key,
    );
    expect(res.status).toBe(200);
    const call = chatCompletion.mock.calls[0];
    expect(call[3].max_tokens).toBe(8192);
  });

  it("forwards caller-supplied max_tokens unchanged", async () => {
    const res = await post(
      app,
      "/v1/chat/completions",
      {
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 77,
      },
      key,
    );
    expect(res.status).toBe(200);
    const call = chatCompletion.mock.calls[0];
    expect(call[3].max_tokens).toBe(77);
  });

  it("treats max_tokens:0 as absent and falls through to catalog default", async () => {
    const res = await post(
      app,
      "/v1/chat/completions",
      {
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 0,
      },
      key,
    );
    expect(res.status).toBe(200);
    const call = chatCompletion.mock.calls[0];
    expect(call[3].max_tokens).toBe(8192);
  });
});
