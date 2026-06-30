#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import Database from "better-sqlite3";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dirname, "..");
const DB_PATH = path.join(ROOT, "server/data/api-gateway.db");
const WORKER_SOURCE = path.join(ROOT, "worker/src/index.ts");
const DEFAULT_WORKER_NAME = "animarouter-anon-transport";
const DEFAULT_ALLOWED_HOSTS = "*";
const DEFAULT_PLACEMENT_REGION = "azure:swedencentral";
const CF_API = "https://api.cloudflare.com/client/v4";
const KEY_BYTES = 32;
const KEY_HEX_LEN = KEY_BYTES * 2;
const PLACEHOLDER_KEY = "your-64-char-hex-key-here";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function randomSecret() {
  return `arw_${crypto.randomBytes(24).toString("base64url")}`;
}

async function ask(rl, prompt, fallback) {
  const suffix = fallback ? ` (${fallback})` : "";
  const answer = (await rl.question(`${prompt}${suffix}: `)).trim();
  return answer || fallback || "";
}

function parseHexKey(value, source) {
  if (value.length !== KEY_HEX_LEN || !/^[0-9a-fA-F]+$/.test(value)) {
    throw new Error(
      `Invalid ENCRYPTION_KEY (${source}): expected ${KEY_HEX_LEN} hex chars.`,
    );
  }
  return Buffer.from(value, "hex");
}

function ensureDbAndEncryptionKey(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outbound_transports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transport_id TEXT NOT NULL DEFAULT 'cloudflare-worker',
      name TEXT NOT NULL,
      endpoint_url TEXT NOT NULL,
      encrypted_auth_key TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      allowed_hosts TEXT NOT NULL DEFAULT '*',
      placement_region TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_deployed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(transport_id, endpoint_url)
    );
  `);

  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey && envKey !== PLACEHOLDER_KEY) return parseHexKey(envKey, "env");

  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'encryption_key'")
    .get();
  if (row?.value) return parseHexKey(row.value, "db");

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "ENCRYPTION_KEY is required in production before storing Worker relay secrets.",
    );
  }

  const generated = crypto.randomBytes(KEY_BYTES);
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('encryption_key', ?)",
  ).run(generated.toString("hex"));
  return generated;
}

function encryptSecret(secret, key) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(secret, "utf8", "hex");
  encrypted += cipher.final("hex");
  return {
    encrypted,
    iv: iv.toString("hex"),
    authTag: cipher.getAuthTag().toString("hex"),
  };
}

function upsertTransport(db, key, record) {
  const encrypted = encryptSecret(record.authKey, key);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO outbound_transports (
      transport_id, name, endpoint_url, encrypted_auth_key, iv, auth_tag,
      allowed_hosts, placement_region, enabled, last_deployed_at, updated_at
    )
    VALUES ('cloudflare-worker', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(transport_id, endpoint_url) DO UPDATE SET
      name = excluded.name,
      encrypted_auth_key = excluded.encrypted_auth_key,
      iv = excluded.iv,
      auth_tag = excluded.auth_tag,
      allowed_hosts = excluded.allowed_hosts,
      placement_region = excluded.placement_region,
      enabled = 1,
      last_deployed_at = excluded.last_deployed_at,
      updated_at = excluded.updated_at
  `).run(
    record.name,
    record.endpointUrl.replace(/\/+$/, ""),
    encrypted.encrypted,
    encrypted.iv,
    encrypted.authTag,
    record.allowedHosts,
    record.placementRegion,
    now,
    now,
  );
}

function buildWorkerJavaScript() {
  const source = fs.readFileSync(WORKER_SOURCE, "utf8");
  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      sourceMap: false,
      inlineSources: false,
      removeComments: false,
    },
    fileName: "index.ts",
  });
  return result.outputText;
}

async function cfFetch(pathname, token, init = {}) {
  const res = await fetch(`${CF_API}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok || data.success === false) {
    const message =
      data.errors?.map((e) => e.message).join("; ") || res.statusText;
    throw new Error(`Cloudflare API ${res.status}: ${message}`);
  }
  return data.result;
}

async function deployWorker({
  accountId,
  apiToken,
  workerName,
  authKey,
  allowedHosts,
  placementRegion,
}) {
  const workerJs = buildWorkerJavaScript();
  const metadata = {
    main_module: "index.js",
    bindings: [
      { name: "PROXY_AUTH_KEY", type: "secret_text", text: authKey },
      { name: "ALLOWED_HOSTS", type: "plain_text", text: allowedHosts },
    ],
    compatibility_date: new Date().toISOString().slice(0, 10),
    compatibility_flags: [],
    observability: { enabled: false },
    placement: { region: placementRegion },
    tags: [],
    tail_consumers: [],
    logpush: false,
    usage_model: "standard",
  };

  const form = new FormData();
  form.append(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" }),
    "metadata.json",
  );
  form.append(
    "index.js",
    new Blob([workerJs], { type: "application/javascript+module" }),
    "index.js",
  );

  await cfFetch(
    `/accounts/${accountId}/workers/scripts/${workerName}`,
    apiToken,
    {
      method: "PUT",
      body: form,
    },
  );
}

async function enableWorkersDev(accountId, apiToken, workerName) {
  try {
    await cfFetch(
      `/accounts/${accountId}/workers/scripts/${workerName}/subdomain`,
      apiToken,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      },
    );
  } catch {
    await cfFetch(
      `/accounts/${accountId}/workers/scripts/${workerName}/subdomain`,
      apiToken,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      },
    );
  }
}

async function getWorkersDevEndpoint(accountId, apiToken, workerName) {
  const result = await cfFetch(
    `/accounts/${accountId}/workers/subdomain`,
    apiToken,
  );
  const subdomain = result?.subdomain;
  if (!subdomain) return "";
  return `https://${workerName}.${subdomain}.workers.dev`;
}

async function verifyWorker(endpointUrl, authKey) {
  const res = await fetch(`${endpointUrl.replace(/\/+$/, "")}/healthz`);
  if (!res.ok)
    throw new Error(`Worker health check failed: HTTP ${res.status}`);

  const badAuth = await fetch(
    `${endpointUrl.replace(/\/+$/, "")}/wrong/1/aHR0cHM6Ly9leGFtcGxlLmNvbQ`,
    { method: "POST" },
  );
  if (badAuth.status !== 401) {
    throw new Error(
      `Worker auth check failed: expected 401, got HTTP ${badAuth.status}`,
    );
  }

  void authKey;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rl = readline.createInterface({ input, output });

  try {
    console.log("\nAnimaRouter Cloudflare Worker deployment wizard\n");
    const accountId = args.account || (await ask(rl, "Cloudflare account ID"));
    const apiToken =
      args.token ||
      (await ask(rl, "Cloudflare API token with Workers edit permission"));
    const workerName =
      args.name || (await ask(rl, "Worker name", DEFAULT_WORKER_NAME));
    const placementRegion =
      args.region ||
      (await ask(rl, "Placement region", DEFAULT_PLACEMENT_REGION));
    const allowedHosts =
      args.hosts ||
      (await ask(rl, "Allowed upstream hosts", DEFAULT_ALLOWED_HOSTS));
    const authKey = args.authKey || randomSecret();

    if (!accountId || !apiToken || !workerName) {
      throw new Error(
        "Cloudflare account ID, API token, and Worker name are required.",
      );
    }

    console.log("\nDeploying Worker...");
    await deployWorker({
      accountId,
      apiToken,
      workerName,
      authKey,
      allowedHosts,
      placementRegion,
    });

    console.log("Enabling workers.dev route...");
    await enableWorkersDev(accountId, apiToken, workerName);

    let endpointUrl =
      args.endpoint ||
      (await getWorkersDevEndpoint(accountId, apiToken, workerName));
    if (!endpointUrl) {
      endpointUrl = await ask(
        rl,
        "Could not auto-detect endpoint URL. Enter Worker URL",
      );
    }
    endpointUrl = endpointUrl.replace(/\/+$/, "");

    console.log("Verifying Worker...");
    await verifyWorker(endpointUrl, authKey);

    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const db = new Database(args.db || DB_PATH);
    try {
      const encryptionKey = ensureDbAndEncryptionKey(db);
      upsertTransport(db, encryptionKey, {
        name: workerName,
        endpointUrl,
        authKey,
        allowedHosts,
        placementRegion,
      });
    } finally {
      db.close();
    }

    console.log("\nDeployment complete.");
    console.log(`Worker URL: ${endpointUrl}`);
    console.log("Saved encrypted relay config to server/data/api-gateway.db.");
    console.log(
      "Restart AnimaRouter and the relay will appear in the Keys page.",
    );
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(
    `\nWorker deployment failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
