#!/usr/bin/env node
/**
 * proxy-integrate.mjs — Orchestration script for the freellmproxy submodule.
 *
 * Commands:
 *   init     Auto-init submodule if missing, install proxy deps
 *   env      Bootstrap freellmproxy/.env if missing
 *   deploy   Full pipeline: init → env → wrangler deploy
 *   dev      Run wrangler dev (local dev server)
 *   status   Show deployed worker status
 *   test     Run proxy vitest suite
 *
 * Design principles:
 *   - Idempotent: running twice is a no-op
 *   - Non-fatal: if the submodule is absent, log a warning and exit 0
 *     (except for deploy/status which exit 1 — those are explicit user actions)
 *   - No interactive prompts: everything is automated
 */
import { exec as execCb, spawn as spawnCb } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROXY_DIR = join(ROOT, "freellmproxy");
const PROXY_ENV = join(PROXY_DIR, ".env");
const GIT_MODULES_DIR = join(ROOT, ".git", "modules", "freellmproxy");
const ROOT_ENV = join(ROOT, ".env");

const execAsync = promisify(execCb);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dirExists(p) {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read a single key from a .env file. Returns undefined if not found.
 * Handles KEY=VALUE, KEY="VALUE", KEY='VALUE'.
 */
function readEnvValue(filePath, key) {
  if (!existsSync(filePath)) return undefined;
  const content = readFileSync(filePath, "utf-8");
  const re = new RegExp(`^${key}\\s*=\\s*(.+)$`, "m");
  const m = content.match(re);
  if (!m) return undefined;
  let val = m[1].trim();
  // Strip surrounding quotes
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    val = val.slice(1, -1);
  }
  return val || undefined;
}

/**
 * Read all key-value pairs from a .env file.
 */
function readAllEnv(filePath) {
  if (!existsSync(filePath)) return {};
  const result = {};
  const content = readFileSync(filePath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

/**
 * Spawn a command with inherited stdio. Returns the exit code.
 */
function spawnInherit(cmd, opts = {}) {
  return new Promise((resolve) => {
    const proc = spawnCb(cmd, { shell: true, stdio: "inherit", ...opts });
    proc.on("close", (code) => resolve(code ?? 1));
    proc.on("error", () => resolve(1));
  });
}

/**
 * Check if wrangler is available — tries global first, then npx from proxy dir.
 * Returns { available: boolean, method: 'global' | 'npx' | null }
 */
async function checkWrangler() {
  // Try global
  try {
    await execAsync("wrangler --version");
    return { available: true, method: "global" };
  } catch {}
  // Try npx from proxy dir (wrangler is a devDep)
  if (dirExists(join(PROXY_DIR, "node_modules"))) {
    try {
      await execAsync("npx wrangler --version", { cwd: PROXY_DIR });
      return { available: true, method: "npx" };
    } catch {}
  }
  return { available: false, method: null };
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/**
 * init — Ensure the freellmproxy submodule is populated and deps installed.
 * Idempotent and non-fatal on missing submodule.
 */
async function cmdInit() {
  if (dirExists(PROXY_DIR)) {
    // Submodule directory exists — ensure deps are installed
    if (!dirExists(join(PROXY_DIR, "node_modules"))) {
      console.log("📦 Installing proxy dependencies...");
      const code = await spawnInherit("npm install --include=dev", {
        cwd: PROXY_DIR,
      });
      if (code !== 0) {
        console.error("❌ Failed to install proxy dependencies.");
        process.exit(code);
      }
      console.log("✅ Proxy dependencies installed.");
    }
    // else: deps already installed, nothing to do
    return;
  }

  // Submodule directory doesn't exist — try to init from git modules
  if (dirExists(GIT_MODULES_DIR)) {
    console.log("🔧 Initializing freellmproxy submodule...");
    const code = await spawnInherit("git submodule update --init --recursive", {
      cwd: ROOT,
    });
    if (code !== 0) {
      console.error("❌ Failed to initialize submodule.");
      process.exit(code);
    }
    // Now install deps
    if (dirExists(PROXY_DIR) && !dirExists(join(PROXY_DIR, "node_modules"))) {
      console.log("📦 Installing proxy dependencies...");
      const installCode = await spawnInherit("npm install --include=dev", {
        cwd: PROXY_DIR,
      });
      if (installCode !== 0) {
        console.error("❌ Failed to install proxy dependencies.");
        process.exit(installCode);
      }
      console.log("✅ Proxy dependencies installed.");
    }
    return;
  }

  // Neither submodule dir nor git modules exist — non-fatal
  console.log("⚠️  freellmproxy submodule not available. Skipping proxy init.");
  console.log(
    "   To enable: git clone --recurse-submodules (or git submodule update --init --recursive)",
  );
}

/**
 * env — Bootstrap freellmproxy/.env if it doesn't exist.
 * Never overwrites an existing .env.
 */
function cmdEnv() {
  if (existsSync(PROXY_ENV)) {
    // Already exists — never overwrite (R4.2)
    return;
  }

  if (!dirExists(PROXY_DIR)) {
    console.log("⚠️  freellmproxy/ not found. Skipping env bootstrap.");
    return;
  }

  // Generate AUTH_KEY
  const gatewayEncryptionKey = readEnvValue(ROOT_ENV, "ENCRYPTION_KEY");
  let authKey;
  if (gatewayEncryptionKey && gatewayEncryptionKey.length >= 16) {
    authKey = gatewayEncryptionKey.slice(0, 16);
  } else {
    authKey = randomBytes(16).toString("hex").slice(0, 16);
  }

  // Generate INTERNAL_AUTH_SECRET — always fresh
  const internalAuthSecret = randomBytes(32).toString("hex");

  // PROXY_COUNT — sensible default
  const proxyCount = "3";

  // ROUTER_DOMAIN — from gateway .env or placeholder
  let routerDomain = readEnvValue(ROOT_ENV, "PROXY_ROUTER_DOMAIN");
  if (!routerDomain) {
    routerDomain = "router.example.com";
  }

  const envContent = [
    "# Auto-generated by scripts/proxy-integrate.mjs",
    "# Generated on: " + new Date().toISOString(),
    "",
    `AUTH_KEY=${authKey}`,
    `INTERNAL_AUTH_SECRET=${internalAuthSecret}`,
    `PROXY_COUNT=${proxyCount}`,
    `ROUTER_DOMAIN=${routerDomain}`,
    "",
  ].join("\n");

  writeFileSync(PROXY_ENV, envContent, "utf-8");
  console.log(
    "✅ Generated freellmproxy/.env with defaults. Edit ROUTER_DOMAIN before deploying to production.",
  );
  console.log(
    "   Note: custom domain must also be configured in the Cloudflare dashboard.",
  );
}

/**
 * deploy — Full pipeline: check wrangler → init → env → deploy.
 */
async function cmdDeploy() {
  const wrangler = await checkWrangler();
  if (!wrangler.available) {
    console.error(
      "⚠️  wrangler not found. Install: npm i -g wrangler && wrangler login",
    );
    process.exit(1);
  }

  // Run init (submodule + deps)
  await cmdInit();

  // Run env (bootstrap if missing)
  cmdEnv();

  if (!dirExists(PROXY_DIR)) {
    console.error("❌ freellmproxy/ not available after init. Cannot deploy.");
    process.exit(1);
  }

  // Deploy via the proxy's own deploy.ts (it reads .env itself)
  console.log("\n🚀 Deploying proxy workers...");
  const deployCmd =
    wrangler.method === "npx"
      ? "npx tsx scripts/deploy.ts"
      : "npx tsx scripts/deploy.ts";
  const code = await spawnInherit(deployCmd, { cwd: PROXY_DIR });
  process.exit(code);
}

/**
 * dev — Run wrangler dev in the proxy directory.
 */
async function cmdDev() {
  if (!dirExists(PROXY_DIR)) {
    console.error(
      "❌ freellmproxy/ not found. Clone with --recurse-submodules first.",
    );
    process.exit(1);
  }

  const wrangler = await checkWrangler();
  if (!wrangler.available) {
    console.error(
      "⚠️  wrangler not found. Install: npm i -g wrangler && wrangler login",
    );
    process.exit(1);
  }

  const cmd =
    wrangler.method === "global" ? "wrangler dev" : "npx wrangler dev";
  const code = await spawnInherit(cmd, { cwd: PROXY_DIR });
  process.exit(code);
}

/**
 * status — Show deployed worker status.
 */
async function cmdStatus() {
  if (!dirExists(PROXY_DIR)) {
    console.error(
      "❌ freellmproxy/ not found. Clone with --recurse-submodules first.",
    );
    process.exit(1);
  }

  const wrangler = await checkWrangler();
  if (!wrangler.available) {
    console.error(
      "⚠️  wrangler not found. Install: npm i -g wrangler && wrangler login",
    );
    process.exit(1);
  }

  const cmd =
    wrangler.method === "global"
      ? "wrangler deployments list"
      : "npx wrangler deployments list";
  const code = await spawnInherit(cmd, { cwd: PROXY_DIR });
  process.exit(code);
}

/**
 * test — Run the proxy's vitest suite.
 * Gracefully exits 0 if the submodule is absent (R12.3).
 */
async function cmdTest() {
  if (!dirExists(PROXY_DIR)) {
    console.log("⚠️  freellmproxy/ not found. Skipping proxy tests.");
    process.exit(0);
  }

  // Ensure deps are installed
  if (!dirExists(join(PROXY_DIR, "node_modules"))) {
    console.log("📦 Installing proxy dependencies for tests...");
    const installCode = await spawnInherit("npm install --include=dev", {
      cwd: PROXY_DIR,
    });
    if (installCode !== 0) {
      console.error("❌ Failed to install proxy dependencies.");
      process.exit(installCode);
    }
  }

  const code = await spawnInherit("npm test", { cwd: PROXY_DIR });
  process.exit(code);
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

const command = process.argv[2];

const commands = {
  init: cmdInit,
  env: cmdEnv,
  deploy: cmdDeploy,
  dev: cmdDev,
  status: cmdStatus,
  test: cmdTest,
};

if (!command || !commands[command]) {
  console.log(`
proxy-integrate.mjs <command>

Commands:
  init        Auto-init submodule if missing, install deps
  env         Bootstrap freellmproxy/.env if missing
  deploy      Full pipeline: init → env → wrangler deploy
  dev         Run wrangler dev (local dev server)
  status      Show deployed worker status
  test        Run proxy vitest suite
`);
  process.exit(command ? 1 : 0);
}

// Handle sync commands (env) and async commands
const result = commands[command]();
if (result && typeof result.then === "function") {
  result.catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
