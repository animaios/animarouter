# Tasks — FreeLLMProxy Submodule Integration (v2 — Todd Howard Edition)

---

## Phase 0: Proxy-Side Fix (Prerequisite)

### Task 0.1 — Make `ROUTER_DOMAIN` Optional in `deploy.ts`

**Dependencies:** None (do this first — it unblocks everything)
**Files:** `freellmproxy/scripts/deploy.ts` (modify proxy code)
**What it does:** Enables workers.dev mode when ROUTER_DOMAIN is absent

**Work:**
1. Change `requireEnv("ROUTER_DOMAIN", 1)` to `process.env.ROUTER_DOMAIN || undefined` (line ~306 in deploy.ts)
2. Modify `generateRouterToml` signature: `routerDomain` param becomes optional (`string?`)
3. Inside `generateRouterToml`: only add `routes` key if `routerDomain` is truthy:
   ```typescript
   if (routerDomain) {
     config.routes = [{ pattern: routerDomain, custom_domain: true }];
   }
   ```
4. When `routerDomain` is provided, also set `ROUTER_DOMAIN` in `[vars]` (for the encoder page URL generation)
5. When `routerDomain` is undefined, set `ROUTER_DOMAIN = ""` in `[vars]` (empty string — the router code still reads it but it's harmless)
6. Verify: `ROUTER_DOMAIN` present in `.env` → TOML has `routes` section (backward compat). `ROUTER_DOMAIN` absent → TOML has no `routes` section → workers.dev.

**Context symbols:**
- `scripts/deploy.ts` — `generateRouterToml`, `requireEnv`, `runWranglerDeploy`
- `src/router.ts` — reads `env.ROUTER_DOMAIN` for encoder page. Empty string is fine (it falls back to `url.hostname`)

**Validation:** 
- Set `ROUTER_DOMAIN=custom.example.com` in `.env` → `npm run deploy` → generated `dist/router.toml` contains `routes = [{ pattern = "custom.example.com", custom_domain = true }]`
- Remove `ROUTER_DOMAIN` from `.env` → `npm run deploy` → generated `dist/router.toml` has **no** `routes` section
- Existing tests still pass

---

## Phase 1: Submodule + Orchestrator

### Task 1.1 — Add Git Submodule

**Dependencies:** Task 0.1 (proxy must support workers.dev first)
**Files:** `.gitmodules` (new), `freellmproxy/` (gitlink)
**What it does:** Registers the proxy as a submodule with the new commit from Task 0.1

**Work:**
1. From the monorepo root:
   ```bash
   git submodule add -b main https://github.com/animaios/freeproxy.git freellmproxy
   git submodule update --init --recursive
   ```
2. Verify `.gitmodules`:
   ```ini
   [submodule "freellmproxy"]
       path = freellmproxy
       url = https://github.com/animaios/freeproxy.git
       branch = main
   ```
3. Verify `freellmproxy/src/worker.ts` exists
4. Verify root `.gitignore` does **not** list `freellmproxy/`
5. Stage `.gitmodules` and the `freellmproxy` gitlink

**Validation:** `git submodule status` shows `freellmproxy` with a commit hash.

---

### Task 1.2 — Create `scripts/proxy-up.mjs` (init + env + test commands)

**Dependencies:** Task 1.1
**Files:** `scripts/proxy-up.mjs` (new)
**What it does:** The orchestration script — init, env, and test subcommands. Deploy comes in Task 2.1.

**Work:**
1. Create `scripts/proxy-up.mjs` as an ESM Node script
2. Implement command dispatch: `init`, `env`, `test`
3. **`init` command:**
   - Check if `freellmproxy/` directory exists
   - If NO: check if `.git/modules/freellmproxy` exists
     - If YES: run `git submodule update --init --recursive` from monorepo root
     - If NO: print `⚠️ freellmproxy submodule not available. Skipping.` and exit 0
   - If YES: check if `freellmproxy/node_modules/` exists
     - If NO: run `npm install --prefix freellmproxy`
     - If YES: skip (idempotent)
4. **`env` command:**
   - Check if `freellmproxy/.env` exists → if YES, skip
   - If NO, generate:
     - `AUTH_KEY=crypto.randomBytes(16).toString('hex').slice(0, 16)`
     - `INTERNAL_AUTH_SECRET=crypto.randomBytes(32).toString('hex')`
     - `PROXY_COUNT=3`
     - **No `ROUTER_DOMAIN`** — workers.dev default
   - Write to `freellmproxy/.env`
   - Print: `✅ Generated freellmproxy/.env`
5. **`test` command:**
   - If `freellmproxy/` doesn't exist → log warning, exit 0
   - Run `npm test --prefix freellmproxy`
   - Forward exit code
6. Helper functions:
   - `ROOT` — `dirname(dirname(fileURLToPath(import.meta.url)))` (same pattern as `cli.mjs`)
   - `PROXY_DIR` — `path.join(ROOT, "freellmproxy")`
   - `readEnv(filePath)` — parse `.env` → `Map<string, string>`
   - `writeEnv(filePath, entries)` — append key=value lines, skip existing keys
   - `execAsync(cmd, opts)` — promisified `child_process.exec`
   - `spawnAsync(cmd, args, opts)` — promisified `child_process.spawn` with stdio control
   - `randomHex(n)` — `crypto.randomBytes(n).toString('hex')`

**Context:** Follow `scripts/cli.mjs` for ROOT calculation pattern, ESM imports, spawn style.

**Validation:**
- `node scripts/proxy-up.mjs init` installs proxy deps
- `node scripts/proxy-up.mjs env` generates `.env` (no ROUTER_DOMAIN)
- `node scripts/proxy-up.mjs test` runs proxy vitest
- Running `env` twice → second run is no-op (idempotent)

---

### Task 1.3 — Wire NPM Scripts and Postinstall

**Dependencies:** Task 1.2
**Files:** `package.json` (modify root)
**Symbols to modify:** `scripts` field

**Work:**
1. Add to root `package.json` scripts:
   ```json
   "postinstall": "node scripts/proxy-up.mjs init",
   "proxy:dev": "node scripts/proxy-up.mjs dev",
   "proxy:test": "node scripts/proxy-up.mjs test"
   ```
2. Append proxy test to `test` script:
   ```json
   "test": "npm run test -w server && npm run typecheck -w client && npm run proxy:test"
   ```
3. Do NOT add `proxy:up` yet (comes in Task 2.1)
4. Verify `npm install` triggers postinstall and installs proxy deps
5. Verify `npm test` includes proxy tests

**Validation:** `npm test` runs both server tests and proxy tests. `npm install` logs the init output.

---

## Phase 2: The `up` Command

### Task 2.1 — Implement `up` and `status` Commands in `proxy-up.mjs`

**Dependencies:** Task 1.2
**Files:** `scripts/proxy-up.mjs` (extend)
**What it adds:** `up`, `dev`, `status` subcommands

**Work:**
1. **`up` command** — the full pipeline:
   - **Wrangler check**: Run `wrangler whoami --json`. Parse JSON. If exit code != 0 or `loggedIn` is false:
     - Print `⚠️ wrangler not logged in. Run: wrangler login` → exit 1
   - **Submodule + deps**: Reuse `init` logic
   - **Env**: Reuse `env` logic
   - **Deploy**: Spawn `npx tsx scripts/deploy.ts` with `cwd: PROXY_DIR`, `stdio: ['ignore', 'pipe', 'pipe']`
     - Capture stdout and stderr into buffers
     - Also stream stdout to process.stdout (so user sees deploy progress)
     - On exit: if code != 0, print stderr, exit with that code
   - **Extract URL**: Parse captured stdout for `/https:\/\/[^\s]+\.workers\.dev/`
     - If found: that's the router URL
     - If not found: run `wrangler whoami --json` fallback → construct URL from account name slug → print warning
   - **Persist URL**: If `DETECTED_ROUTER_URL` not in `.env`, append it
   - **Print ready block**:
     ```
     🚀 READY
     
     Router URL:  <detected_url>
     Auth key:    <AUTH_KEY from .env>
     
     Example request:
     POST <detected_url>/<AUTH_KEY>/1/<BASE64_URL>
     ```
2. **`dev` command:**
   - Check `freellmproxy/` exists → if NO, log warning and exit 1
   - `cd freellmproxy && npx wrangler dev` with `stdio: 'inherit'`
3. **`status` command:**
   - Check wrangler available
   - `cd freellmproxy && npx wrangler deployments list` with `stdio: 'inherit'`
4. Add `proxy:up` and `proxy:deploy` to root `package.json`:
   ```json
   "proxy:up": "node scripts/proxy-up.mjs up",
   "proxy:deploy": "node scripts/proxy-up.mjs up"
   ```

**Validation:**
- `npm run proxy:up` (with wrangler logged in, fresh `.env`):
  - Boots env, deploys, prints working endpoint URL
  - URL matches what wrangler reports
- Running again: env is no-op, deploy is a no-op (or re-deploys same config)
- Without wrangler: prints error, exits 1

---

## Phase 3: CI + Documentation

### Task 3.1 — Update CI Workflow

**Dependencies:** Task 1.3
**Files:** `.github/workflows/ci.yml` (modify)

**Work:**
1. Add `submodules: recursive` to checkout step
2. Verify `npm test` includes proxy tests via the chain
3. No deploy step in CI

**Validation:** CI includes proxy tests.

---

### Task 3.2 — Verify `.gitignore` Hygiene

**Dependencies:** Task 1.1
**Files:** `freellmproxy/.gitignore` (verify), root `.gitignore` (verify)

**Work:**
1. Verify `freellmproxy/.gitignore` covers: `node_modules/`, `.wrangler/`, `dist/`, `.env`
2. Verify root `.gitignore` does not ignore `freellmproxy/`
3. Verify `freellmproxy/dist/` and `freellmproxy/.wrangler/` are not tracked

**Validation:** Clean `git status` after running `proxy:dev`.

---

### Task 3.3 — Add "Cloud Proxy" Section to README

**Dependencies:** Task 2.1
**Files:** `README.md` (modify — add section after "Docker")

**Work:**
1. Insert "## Cloud Proxy" section after the Docker section
2. Content:

   > ## Cloud Proxy
   >
   > AnimaRouter ships a Cloudflare Workers proxy layer for IP rotation and header stripping. Deploy it to route requests through geographically-distributed exit IPs so upstream providers see consistent, non-identifying IP addresses instead of your real one.
   >
   > **Prerequisites:** [wrangler](https://developers.cloudflare.com/workers/wrangler/) installed and logged in (`npm i -g wrangler && wrangler login`).
   >
   > ```bash
   > npm run proxy:up
   > ```
   >
   > That's it. The first run automatically:
   > 1. Initializes the `freellmproxy` git submodule
   > 2. Installs proxy dependencies
   > 3. Generates secure secrets
   > 4. Deploys proxy workers + router to Cloudflare
   > 5. Detects and prints your working endpoint URL
   >
   > After deployment, register the proxy as a custom provider in the dashboard:
   > 1. Base64url-encode your target URL: `node -e "console.log(Buffer.from('https://api.example.com/v1').toString('base64url'))"`
   > 2. Construct: `https://{ROUTER_URL}/{AUTH_KEY}/{PROXY_NUM}/{BASE64_URL}`
   > 3. Add as a custom provider with that URL as the base URL
   >
   > **Custom domain (optional):** Add `ROUTER_DOMAIN=your.domain.com` to `freellmproxy/.env` before deploying. This replaces the `workers.dev` subdomain with your own domain. The domain must be a Cloudflare-proxied zone.
   >
   > | Command | Purpose |
   > |---------|---------|
   > | `npm run proxy:up` | Deploy everything to Cloudflare |
   > | `npm run proxy:dev` | Local dev server via wrangler |
   > | `npm run proxy:status` | Show deployment status |
   > | `npm run proxy:test` | Run proxy test suite |
   >
   > Adjust `PROXY_COUNT` in `freellmproxy/.env`. See [the proxy's README](freellmproxy/README.md) for the full architecture.

3. Add "Cloud Proxy" to the Table of Contents

**Validation:** README renders correctly. The "just run it" message is clear. Custom domain is clearly optional.

---

## Implementation Order (Dependency Graph)

```
Phase 0 (proxy-side fix):
  Task 0.1 (optional ROUTER_DOMAIN) ──→ unblocks Phase 1

Phase 1:
  Task 1.1 (submodule) ──→ Task 1.2 (script) ──→ Task 1.3 (npm wiring)

Phase 2:
  Task 2.1 (up command) ──→ depends on Task 1.2

Phase 3 (parallel with Phase 2 after dep met):
  Task 3.1 (CI) ──→ depends on Task 1.3
  Task 3.2 (gitignore) ──→ depends on Task 1.1
  Task 3.3 (README) ──→ depends on Task 2.1
```

## Not In Scope (Explicitly Deferred)

- Auto-register proxy as a gateway custom provider
- Proxy-aware routing in the gateway's bandit
- Dashboard UI for proxy management
- Multiple proxy deployments (staging vs production)
- Proxy metrics ingested into gateway analytics
- Wrangler login automation (interactive — user must do it)
