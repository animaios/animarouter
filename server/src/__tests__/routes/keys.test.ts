import type { Express } from "express";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { getDb, initDb } from "../../db/index.js";
import { isGatedApiPath, mintDashboardToken } from "../helpers/auth.js";

let dashToken = "";

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe("Keys API", () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = "0".repeat(64);
    initDb(":memory:");
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare("DELETE FROM api_keys").run();
  });

  it("GET /api/keys returns empty array initially", async () => {
    const { status, body } = await request(app, "GET", "/api/keys");
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it("POST /api/keys creates a new key", async () => {
    const { status, body } = await request(app, "POST", "/api/keys", {
      platform: "groq",
      key: "gsk_test123456789",
      label: "My Groq Key",
    });

    expect(status).toBe(201);
    expect(body.platform).toBe("groq");
    expect(body.label).toBe("My Groq Key");
    expect(body.maskedKey).toContain("...");
  });

  it("GET /api/keys returns the created key", async () => {
    // First create a key
    await request(app, "POST", "/api/keys", {
      platform: "groq",
      key: "gsk_test123456789",
    });

    const { status, body } = await request(app, "GET", "/api/keys");
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].platform).toBe("groq");
  });

  it("POST /api/keys rejects invalid platform", async () => {
    const { status } = await request(app, "POST", "/api/keys", {
      platform: "invalid_platform",
      key: "test",
    });
    expect(status).toBe(400);
  });

  it("POST /api/keys rejects missing key", async () => {
    const { status } = await request(app, "POST", "/api/keys", {
      platform: "groq",
    });
    expect(status).toBe(400);
  });

  it("POST /api/keys persists label when re-enabling an existing keyless provider row", async () => {
    const db = getDb();
    const slug = "keyless-label-test";
    db.prepare(`
      INSERT OR REPLACE INTO custom_providers (slug, display_name, base_url, keyless, api_format)
      VALUES (?, ?, ?, 1, 'openai')
    `).run(slug, "Keyless Label Test", "https://keyless-label.example.com/v1");
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, use_proxy)
      VALUES (?, 'Old Label', 'enc', 'iv', 'tag', 'error', 0, 0)
    `).run(slug);
    const existing = db
      .prepare("SELECT id FROM api_keys WHERE platform = ?")
      .get(slug) as { id: number };

    const { status, body } = await request(app, "POST", "/api/keys", {
      platform: slug,
      label: "Fresh Label",
      useProxy: true,
    });

    expect(status).toBe(200);
    expect(body.id).toBe(existing.id);
    expect(body.label).toBe("Fresh Label");

    const row = db
      .prepare(
        "SELECT label, status, enabled, use_proxy FROM api_keys WHERE id = ?",
      )
      .get(existing.id) as {
      label: string;
      status: string;
      enabled: number;
      use_proxy: number;
    };
    expect(row.label).toBe("Fresh Label");
    expect(row.status).toBe("unknown");
    expect(row.enabled).toBe(1);
    expect(row.use_proxy).toBe(1);
  });

  it("DELETE /api/keys/:id removes a key", async () => {
    const { body: created } = await request(app, "POST", "/api/keys", {
      platform: "groq",
      key: "gsk_test123456789",
    });

    const { status } = await request(app, "DELETE", `/api/keys/${created.id}`);
    expect(status).toBe(200);

    const { body: after } = await request(app, "GET", "/api/keys");
    expect(after).toHaveLength(0);
  });

  it("DELETE /api/keys/:id returns 404 for nonexistent key", async () => {
    const { status } = await request(app, "DELETE", "/api/keys/99999");
    expect(status).toBe(404);
  });

  it("PATCH /api/keys/:id updates label", async () => {
    const { body: created } = await request(app, "POST", "/api/keys", {
      platform: "groq",
      key: "gsk_test123456789",
    });

    const { status, body } = await request(
      app,
      "PATCH",
      `/api/keys/${created.id}`,
      {
        label: "Production key",
      },
    );

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.label).toBe("Production key");

    const { body: keys } = await request(app, "GET", "/api/keys");
    expect(keys[0].label).toBe("Production key");
  });

  it("PATCH /api/keys/:id updates both enabled and label", async () => {
    const { body: created } = await request(app, "POST", "/api/keys", {
      platform: "groq",
      key: "gsk_test123456789",
    });

    const { status, body } = await request(
      app,
      "PATCH",
      `/api/keys/${created.id}`,
      {
        enabled: false,
        label: "Disabled key",
      },
    );

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.enabled).toBe(false);
    expect(body.label).toBe("Disabled key");

    const { body: keys } = await request(app, "GET", "/api/keys");
    expect(keys[0].enabled).toBe(false);
    expect(keys[0].label).toBe("Disabled key");
  });

  it("PATCH /api/keys/:id clears label", async () => {
    const { body: created } = await request(app, "POST", "/api/keys", {
      platform: "groq",
      key: "gsk_test123456789",
      label: "Temporary label",
    });

    const { status, body } = await request(
      app,
      "PATCH",
      `/api/keys/${created.id}`,
      {
        label: "",
      },
    );

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.label).toBe("");

    const { body: keys } = await request(app, "GET", "/api/keys");
    expect(keys[0].label).toBe("");
  });

  it("PATCH /api/keys/:id returns 400 when no fields provided", async () => {
    const { body: created } = await request(app, "POST", "/api/keys", {
      platform: "groq",
      key: "gsk_test123456789",
    });

    const { status } = await request(
      app,
      "PATCH",
      `/api/keys/${created.id}`,
      {},
    );
    expect(status).toBe(400);
  });

  it("PATCH /api/keys/:id returns 404 for nonexistent key", async () => {
    const { status } = await request(app, "PATCH", "/api/keys/99999", {
      label: "test",
    });
    expect(status).toBe(404);
  });
});
