import type { Express } from "express";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { getDb, initDb } from "../../db/index.js";
import { encrypt } from "../../lib/crypto.js";
import { buildProviderFor } from "../../providers/index.js";
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

describe("Custom providers (#230)", () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = "0".repeat(64);
    initDb(":memory:");
    app = createApp();
    dashToken = mintDashboardToken();
  });

  // ── Provider CRUD ──────────────────────────────────────────────────

  it("POST /api/custom-providers creates a provider row", async () => {
    const { status, body } = await request(
      app,
      "POST",
      "/api/custom-providers",
      {
        slug: "my-ollama",
        displayName: "My Ollama box",
        baseUrl: "http://192.168.1.10:11434/v1",
      },
    );
    expect(status).toBe(201);
    expect(body.slug).toBe("my-ollama");
    expect(body.displayName).toBe("My Ollama box");
    expect(body.baseUrl).toBe("http://192.168.1.10:11434/v1");
    expect(body.id).toBeGreaterThan(0);

    const db = getDb();
    const row = db
      .prepare("SELECT * FROM custom_providers WHERE slug = ?")
      .get("my-ollama") as any;
    expect(row).toBeDefined();
    expect(row.display_name).toBe("My Ollama box");
  });

  it("trims a trailing slash from baseUrl", async () => {
    const { status, body } = await request(
      app,
      "POST",
      "/api/custom-providers",
      {
        slug: "lm-studio",
        displayName: "LM Studio",
        baseUrl: "http://localhost:1234/v1/",
      },
    );
    expect(status).toBe(201);
    expect(body.baseUrl).toBe("http://localhost:1234/v1");
  });

  it("rejects an invalid slug (uppercase, leading dash, too short)", async () => {
    for (const slug of [
      "BadSlug",
      "-leading",
      "a",
      "with space",
      "a".repeat(40),
    ]) {
      const { status, body } = await request(
        app,
        "POST",
        "/api/custom-providers",
        {
          slug,
          displayName: "x",
          baseUrl: "http://example.com/v1",
        },
      );
      expect(status).toBe(400);
      expect(body.error.message).toMatch(/slug/);
    }
  });

  // Every Platform from shared/types.ts is reserved — a custom provider using
  // one of those slugs would shadow the built-in's routing table (#230).
  it("rejects every built-in platform slug", async () => {
    const builtins = [
      "google",
      "groq",
      "cerebras",
      "nvidia",
      "mistral",
      "openrouter",
      "github",
      "cohere",
      "cloudflare",
      "zhipu",
      "ollama",
      "kilo",
      "pollinations",
      "llm7",
      "huggingface",
      "opencode",
      "ovh",
      "commandcode",
    ];
    for (const slug of builtins) {
      const { status, body } = await request(
        app,
        "POST",
        "/api/custom-providers",
        {
          slug,
          displayName: `My ${slug}`,
          baseUrl: "http://example.com/v1",
        },
      );
      expect(status, `slug '${slug}' should be rejected`).toBe(400);
      expect(body.error.message).toMatch(/reserved/);
    }
  });

  it("rejects a duplicate slug with 409", async () => {
    await request(app, "POST", "/api/custom-providers", {
      slug: "dup",
      displayName: "A",
      baseUrl: "http://a.example.com/v1",
    });
    const { status } = await request(app, "POST", "/api/custom-providers", {
      slug: "dup",
      displayName: "B",
      baseUrl: "http://b.example.com/v1",
    });
    expect(status).toBe(409);
  });

  it("GET /api/custom-providers returns all providers with model/key counts", async () => {
    await request(app, "POST", "/api/custom-providers", {
      slug: "counted",
      displayName: "Counted",
      baseUrl: "http://c.example.com/v1",
    });
    await request(app, "POST", "/api/custom-providers/counted/models", {
      modelId: "m1",
      displayName: "M1",
    });
    const { status, body } = await request(app, "GET", "/api/custom-providers");
    expect(status).toBe(200);
    const counted = body.find((p: any) => p.slug === "counted");
    expect(counted.modelCount).toBe(1);
    expect(counted.keyCount).toBe(0);
  });

  it("PATCH /api/custom-providers/:slug updates displayName and baseUrl, syncing api_keys.base_url", async () => {
    await request(app, "POST", "/api/custom-providers", {
      slug: "edited",
      displayName: "Old",
      baseUrl: "http://old.example.com/v1",
    });
    const { encrypted, iv, authTag } = encrypt("test-key");
    getDb()
      .prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
      VALUES ('edited', 'k', ?, ?, ?, 'unknown', 1, 'http://old.example.com/v1')
    `)
      .run(encrypted, iv, authTag);

    const { status } = await request(
      app,
      "PATCH",
      "/api/custom-providers/edited",
      {
        displayName: "New",
        baseUrl: "http://new.example.com/v1/",
      },
    );
    expect(status).toBe(200);

    const row = getDb()
      .prepare(
        "SELECT display_name, base_url FROM custom_providers WHERE slug = ?",
      )
      .get("edited") as any;
    expect(row.display_name).toBe("New");
    expect(row.base_url).toBe("http://new.example.com/v1");

    const keyRow = getDb()
      .prepare("SELECT base_url FROM api_keys WHERE platform = ?")
      .get("edited") as any;
    expect(keyRow.base_url).toBe("http://new.example.com/v1");
  });

  it("DELETE /api/custom-providers/:slug cascades models + keys + fallback entries", async () => {
    await request(app, "POST", "/api/custom-providers", {
      slug: "doomed",
      displayName: "Doomed",
      baseUrl: "http://d.example.com/v1",
    });
    const { body: created } = await request(
      app,
      "POST",
      "/api/custom-providers/doomed/models",
      {
        modelId: "d1",
        displayName: "D1",
      },
    );
    const { encrypted, iv, authTag } = encrypt("k");
    getDb()
      .prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
      VALUES ('doomed', 'k', ?, ?, ?, 'unknown', 1, 'http://d.example.com/v1')
    `)
      .run(encrypted, iv, authTag);

    const { status, body } = await request(
      app,
      "DELETE",
      "/api/custom-providers/doomed",
    );

    expect(status).toBe(200);
    expect(body.archived).toBe(true);

    const db = getDb();
    // Provider is archived, not deleted.
    const prov = db
      .prepare("SELECT archived FROM custom_providers WHERE slug = ?")
      .get("doomed") as { archived: number };
    expect(prov.archived).toBe(1);
    // Models are disabled, not deleted.
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM models WHERE platform = ? AND enabled = 1",
          )
          .get("doomed") as any
      ).n,
    ).toBe(0);
    // Keys are disabled, not deleted.
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM api_keys WHERE platform = ? AND enabled = 1",
          )
          .get("doomed") as any
      ).n,
    ).toBe(0);
    // Fallback rows are cleaned up.
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM fallback_config WHERE model_db_id = ?",
          )
          .get(created.id) as any
      ).n,
    ).toBe(0);
  });

  // ── Model CRUD ─────────────────────────────────────────────────────

  it("POST /api/custom-providers/:slug/models creates a model and appends to fallback chain", async () => {
    await request(app, "POST", "/api/custom-providers", {
      slug: "with-model",
      displayName: "WM",
      baseUrl: "http://wm.example.com/v1",
    });
    const { status, body } = await request(
      app,
      "POST",
      "/api/custom-providers/with-model/models",
      {
        modelId: "qwen3:4b",
        displayName: "Qwen3 4B",
        contextWindow: 128000,
      },
    );
    expect(status).toBe(201);
    expect(body.modelId).toBe("qwen3:4b");
    expect(body.platform).toBe("with-model");

    const db = getDb();
    const model = db
      .prepare(
        "SELECT * FROM models WHERE platform = 'with-model' AND model_id = 'qwen3:4b'",
      )
      .get() as any;
    expect(model.display_name).toBe("Qwen3 4B");
    expect(model.context_window).toBe(128000);
    expect(model.size_label).toBe("Custom");
    expect(model.supports_tools).toBe(1); // default true
    expect(model.supports_vision).toBe(0); // default false

    const fc = db
      .prepare("SELECT * FROM fallback_config WHERE model_db_id = ?")
      .get(model.id) as any;
    expect(fc).toBeDefined();
    expect(fc.enabled).toBe(1);
  });

  it("rejects a duplicate model id on the same provider with 409", async () => {
    await request(app, "POST", "/api/custom-providers", {
      slug: "dup-models",
      displayName: "DM",
      baseUrl: "http://dm.example.com/v1",
    });
    await request(app, "POST", "/api/custom-providers/dup-models/models", {
      modelId: "m",
      displayName: "M",
    });
    const { status } = await request(
      app,
      "POST",
      "/api/custom-providers/dup-models/models",
      {
        modelId: "m",
        displayName: "M2",
      },
    );
    expect(status).toBe(409);
  });

  it("returns 404 when adding a model to an unknown provider", async () => {
    const { status } = await request(
      app,
      "POST",
      "/api/custom-providers/no-such-thing/models",
      {
        modelId: "m",
        displayName: "M",
      },
    );
    expect(status).toBe(404);
  });

  it("GET /api/custom-providers/:slug/models returns the models for that provider", async () => {
    await request(app, "POST", "/api/custom-providers", {
      slug: "listable",
      displayName: "L",
      baseUrl: "http://l.example.com/v1",
    });
    await request(app, "POST", "/api/custom-providers/listable/models", {
      modelId: "a",
      displayName: "A",
    });
    await request(app, "POST", "/api/custom-providers/listable/models", {
      modelId: "b",
      displayName: "B",
    });
    const { status, body } = await request(
      app,
      "GET",
      "/api/custom-providers/listable/models",
    );
    expect(status).toBe(200);
    const ids = body.map((m: any) => m.modelId).sort();
    expect(ids).toEqual(["a", "b"]);
  });

  it("PATCH /api/custom-models/:id updates editable fields", async () => {
    await request(app, "POST", "/api/custom-providers", {
      slug: "patchable",
      displayName: "P",
      baseUrl: "http://p.example.com/v1",
    });
    const { body: created } = await request(
      app,
      "POST",
      "/api/custom-providers/patchable/models",
      {
        modelId: "x",
        displayName: "X",
      },
    );
    const { status } = await request(
      app,
      "PATCH",
      `/api/custom-models/${created.id}`,
      {
        displayName: "X (edited)",
        contextWindow: 65536,
        supportsTools: false,
      },
    );
    expect(status).toBe(200);
    const model = getDb()
      .prepare("SELECT * FROM models WHERE id = ?")
      .get(created.id) as any;
    expect(model.display_name).toBe("X (edited)");
    expect(model.context_window).toBe(65536);
    expect(model.supports_tools).toBe(0);
  });

  it("DELETE /api/custom-models/:id archives the model and removes its fallback entry", async () => {
    await request(app, "POST", "/api/custom-providers", {
      slug: "removable",
      displayName: "R",
      baseUrl: "http://r.example.com/v1",
    });
    const { body: created } = await request(
      app,
      "POST",
      "/api/custom-providers/removable/models",
      {
        modelId: "gone",
        displayName: "Gone",
      },
    );
    const { status } = await request(
      app,
      "DELETE",
      `/api/custom-models/${created.id}`,
    );
    expect(status).toBe(200);
    // Model is archived, not deleted.
    const model = getDb()
      .prepare("SELECT enabled FROM models WHERE id = ?")
      .get(created.id) as { enabled: number };
    expect(model.enabled).toBe(0);
    expect(
      (
        getDb()
          .prepare(
            "SELECT COUNT(*) AS n FROM fallback_config WHERE model_db_id = ?",
          )
          .get(created.id) as any
      ).n,
    ).toBe(0);
  });

  it("PATCH /api/custom-models/:id unarchives the model and restores its fallback entry", async () => {
    await request(app, "POST", "/api/custom-providers", {
      slug: "restorable",
      displayName: "Restore",
      baseUrl: "http://restore.example.com/v1",
    });
    const { body: created } = await request(
      app,
      "POST",
      "/api/custom-providers/restorable/models",
      {
        modelId: "back",
        displayName: "Back",
      },
    );

    expect(
      (
        getDb()
          .prepare(
            "SELECT COUNT(*) AS n FROM fallback_config WHERE model_db_id = ?",
          )
          .get(created.id) as any
      ).n,
    ).toBe(1);

    const archived = await request(
      app,
      "DELETE",
      `/api/custom-models/${created.id}`,
    );
    expect(archived.status).toBe(200);
    expect(
      (
        getDb()
          .prepare(
            "SELECT COUNT(*) AS n FROM fallback_config WHERE model_db_id = ?",
          )
          .get(created.id) as any
      ).n,
    ).toBe(0);

    const restored = await request(
      app,
      "PATCH",
      `/api/custom-models/${created.id}`,
      { enabled: true },
    );
    expect(restored.status).toBe(200);

    const model = getDb()
      .prepare("SELECT enabled FROM models WHERE id = ?")
      .get(created.id) as { enabled: number };
    expect(model.enabled).toBe(1);
    const fallback = getDb()
      .prepare(
        "SELECT enabled, priority FROM fallback_config WHERE model_db_id = ?",
      )
      .get(created.id) as { enabled: number; priority: number };
    expect(fallback.enabled).toBe(1);
    expect(fallback.priority).toBeGreaterThan(0);
  });

  // ── Built-in provider model operations ──────────────────────────────

  it("POST /api/custom-providers/:slug/models accepts a built-in provider slug", async () => {
    // cloudflare is a built-in provider — adding a model to it should succeed
    const { status, body } = await request(
      app,
      "POST",
      "/api/custom-providers/cloudflare/models",
      {
        modelId: "custom-cloudflare-model",
        displayName: "Custom CF Model",
      },
    );
    expect(status).toBe(201);
    expect(body.platform).toBe("cloudflare");
    expect(body.modelId).toBe("custom-cloudflare-model");

    const db = getDb();
    const model = db
      .prepare(
        "SELECT * FROM models WHERE platform = 'cloudflare' AND model_id = 'custom-cloudflare-model'",
      )
      .get() as any;
    expect(model).toBeDefined();
    expect(model.supports_tools).toBe(1);
  });

  it("GET /api/custom-providers/:slug/models works for built-in providers", async () => {
    // cloudflare already has a model from the test above, plus built-in catalog rows
    const { status, body } = await request(
      app,
      "GET",
      "/api/custom-providers/cloudflare/models",
    );
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    const cfModel = body.find(
      (m: any) => m.modelId === "custom-cloudflare-model",
    );
    expect(cfModel).toBeDefined();
  });

  it("DELETE /api/custom-models/:id archives models on built-in providers", async () => {
    // Find the custom model we added to cloudflare
    const db = getDb();
    const model = db
      .prepare(
        "SELECT id FROM models WHERE platform = 'cloudflare' AND model_id = 'custom-cloudflare-model'",
      )
      .get() as any;
    expect(model).toBeDefined();
    const { status } = await request(
      app,
      "DELETE",
      `/api/custom-models/${model.id}`,
    );
    expect(status).toBe(200);
    // Archived, not deleted.
    const archived = db
      .prepare("SELECT enabled FROM models WHERE id = ?")
      .get(model.id) as { enabled: number };
    expect(archived.enabled).toBe(0);
  });

  // ── Wiring: buildProviderFor + the proxy see a custom provider ───

  it("buildProviderFor returns an OpenAI-compat provider for a custom slug after the row exists", async () => {
    await request(app, "POST", "/api/custom-providers", {
      slug: "routed",
      displayName: "Routed",
      baseUrl: "http://rt.example.com/v1",
    });
    const provider = buildProviderFor("routed");
    expect(provider).toBeDefined();
    expect((provider as any).baseUrl).toBe("http://rt.example.com/v1");
    expect(provider!.platform).toBe("routed");
  });

  it("buildProviderFor returns undefined for a slug that has no row", () => {
    expect(buildProviderFor("nonexistent-slug")).toBeUndefined();
  });
});
