# Tasks — FreeLLMProxy Submodule Integration

---

## Phase 1: Submodule + Script Foundation

### Task 1.1 — Add Git Submodule

**Dependencies:** None
**Files:** `.gitmodules` (new), `freellmproxy/` (gitlink), `.gitignore` (verify)
**What it does:** Registers the proxy as a submodule

**Work:**
1. From the monorepo root:
   ```bash
   git submodule add -b main https://github.com/animaios/freeproxy.git freellmproxy
   ```
2. Verify `.gitmodules` contains:
   ```ini
   [submodule "freellmproxy"]
       path = freellmproxy
       url = https://github.com/animaios/freeproxy.git
       branch = main
   ```
3. Verify `freellmproxy/` contains the full proxy source tree
4. Verify the monorepo root `.gitignore` does **not** list `freellmproxy/` as an ignored path
5. Stage `.gitmodules` and the `freellmproxy` gitlink

**Validation:** `git submodule status` shows `freellmproxy` with a commit hash. `ls freellmproxy/src/worker.ts` exists.

---

### Task 1.2 — Create `scripts/proxy-integrate.mjs` (init + env + test commands)

**Dependencies:** Task 1.1
**Files:** `scripts/proxy-integrate.mjs` (new)
**What it does:** The orchestration script — init, env, and test subcommands only (deploy comes in Task 2.1)

**Work:**
1. Create `scripts/proxy-integrate.mjs` as an ESM Node script
2. Implement command dispatch: `init`, `env`, `test`
3. **`init` command:**
   - Check if `freellmproxy/` directory exists
   - If NO: check if `.git/modules/freellmproxy` exists
     - If YES: run `git submodule update --init --recursive` from monorepo root
     - If NO: print `⚠️  freellmproxy submodule not available. Skipping auto-init.` and exit 0
   - If YES: check if `freellmproxy/node_modules/` exists
     - If NO: run `npm install --prefix freellmproxy`
     - If YES: skip
   - All operations must be idempotent (R6.2)
4. **`env` command:**
   - Check if `freellmproxy/.env` exists → if YES, skip (R4.2)
   - If NO, generate:
     - `AUTH_KEY`: read `ENCRYPTION_KEY` from monorepo `.env`, take first 16 hex chars. Fallback: `crypto.randomBytes(16).toString('hex').slice(0, 16)`
     - `INTERNAL_AUTH_SECRET`: `crypto.randomBytes(32).toString('hex')`
     - `PROXY_COUNT=3`
     - `ROUTER_DOMAIN`: read `PROXY_ROUTER_DOMAIN` from monorepo `.env` if set, otherwise `router.example.com`
   - Write to `freellmproxy/.env`
   - Print: `✅ Generated freellmproxy/.env with defaults. Edit ROUTER_DOMAIN before deploying to production.`
5. **`test` command:**
   - Check if `freellmproxy/` exists → if NO, print warning and exit 0 (R12.3)
   - Run `npm test --prefix freellmproxy`
   - Forward exit code
6. Helper: `ensureDir(path)` — check if a directory exists (fs.existsSync + stat.isDirectory)
7. Helper: `readEnvValue(filePath, key)` — parse a `.env` file for a specific key value
8. Helper: `execAsync(cmd, options)` — promisified `child_process.exec` with cwd option

**Context symbols:**
- `scripts/cli.mjs` — reference for the existing CLI pattern (spawn, ROOT path calc)
- Follows the same ESM import style and ROOT calculation pattern

**Validation:** `node scripts/proxy-integrate.mjs init` installs proxy deps. `node scripts/proxy-integrate.mjs env` generates the `.env`. `node scripts/proxy-integrate.mjs test` runs proxy vitest.

---

### Task 1.3 — Wire NPM Scripts and Postinstall

**Dependencies:** Task 1.2
**Files:** `package.json` (modify root)
**Symbols to modify:** `scripts` field in root `package.json`

**Work:**
1. Add to root `package.json` scripts:
   ```json
   "postinstall": "node scripts/proxy-integrate.mjs init",
   "proxy:dev": "cd freellmproxy && npx wrangler dev",
   "proxy:test": "node scripts/proxy-integrate.mjs test"
   ```
2. Append `&& npm run proxy:test` to the existing `test` script:
   ```json
   "test": "npm run test -w server && npm run typecheck -w client && npm run proxy:test"
   ```
3. Do NOT add `proxy:deploy` or `proxy:status` yet (those come in Task 2.1)
4. Verify `npm install` from root triggers postinstall and installs proxy deps
5. Verify `npm test` includes proxy tests in the chain

**Validation:** `npm test` runs both server tests and proxy tests. `npm install` logs the proxy init output (or a skip warning if submodule absent).

---

## Phase 2: Deploy Pipeline

### Task 2.1 — Implement Deploy Command in `proxy-integrate.mjs`

**Dependencies:** Task 1.2
**Files:** `scripts/proxy-integrate.mjs` (extend)
**What it adds:** `deploy` and `status` subcommands

**Work:**
1. **`deploy` command:**
   - Check `wrangler` is on `$PATH` (use `which wrangler` or `execAsync('wrangler --version')`)
     - If NOT found: print `⚠️  wrangler not found. Install: npm i -g wrangler && wrangler login` and exit 1
   - Run the `init` logic (submodule + deps check) — reuse the same function
   - Run the `env` logic (bootstrap if missing) — reuse the same function
   - Load `freellmproxy/.env` values into `process.env` (same parsing as `readEnvValue` but for all keys)
   - Spawn: `node --import tsx scripts/deploy.ts` with `cwd: 'freellmproxy'` and `stdio: 'inherit'`
   - Forward the child process exit code
2. **`status` command:**
   - Check `wrangler` is on `$PATH` — same guard as deploy
   - Run: `wrangler deployments list` with `cwd: 'freellmproxy'` and `stdio: 'inherit'`
   - Forward exit code
3. Add `proxy:deploy` and `proxy:status` to root `package.json`:
   ```json
   "proxy:deploy": "node scripts/proxy-integrate.mjs deploy",
   "proxy:status": "node scripts/proxy-integrate.mjs status"
   ```

**Important:** The proxy's `scripts/deploy.ts` uses `tsx` (its own devDependency). We spawn it via `node --import tsx scripts/deploy.ts` to ensure TypeScript execution works from the proxy directory. Do NOT attempt to compile the deploy script — it's designed to run with tsx.

**Validation:** `npm run proxy:deploy` (with wrangler logged in) deploys all proxy workers + router. `npm run proxy:status` shows deployment status. Without wrangler, both print the error message and exit 1.

---

## Phase 3: CI + Documentation

### Task 3.1 — Update CI Workflow

**Dependencies:** Task 1.3
**Files:** `.github/workflows/ci.yml` (modify)

**Work:**
1. Add `submodules: recursive` to the checkout step:
   ```yaml
   - uses: actions/checkout@v4
     with:
       submodules: recursive
   ```
2. Verify `npm test` in CI now includes proxy tests
3. Do NOT add any wrangler deploy step to CI (R10.2)

**Validation:** CI run includes proxy tests. If submodule checkout is missing, CI fails with a clear error.

---

### Task 3.2 — Verify `.gitignore` Hygiene

**Dependencies:** Task 1.1
**Files:** `freellmproxy/.gitignore` (verify only), root `.gitignore` (verify only)

**Work:**
1. Verify `freellmproxy/.gitignore` contains: `node_modules/`, `.wrangler/`, `dist/`, `.env`
2. Verify root `.gitignore` does NOT contain `freellmproxy/` or any path that would ignore the submodule
3. Verify `freellmproxy/dist/` and `freellmproxy/.wrangler/` are not tracked by git

**Validation:** `git status` after `npm run proxy:dev` (which creates `.wrangler/`) does not show those directories as untracked.

---

### Task 3.3 — Add "Cloud Proxy" Section to README

**Dependencies:** Task 1.3, Task 2.1
**Files:** `README.md` (modify — add section after "Docker")

**Work:**
1. Insert a new section after the "Docker" heading (line ~205) titled "## Cloud Proxy"
2. Content:
   ```markdown
   ## Cloud Proxy

   API-Gateway ships an optional Cloudflare Workers proxy layer for IP rotation and header stripping. Deploy it to route requests through geographically-distributed exit IPs so upstream providers see consistent, non-identifying IP addresses instead of your real one.

   **Prerequisites:** [wrangler](https://developers.cloudflare.com/workers/wrangler/) installed and logged in (`npm i -g wrangler && wrangler login`).

   ```bash
   npm run proxy:deploy
   ```

   On first run this automatically:
   1. Initializes the `freellmproxy` git submodule
   2. Installs proxy dependencies
   3. Generates `freellmproxy/.env` with secure defaults (edit `ROUTER_DOMAIN` before production!)
   4. Deploys N proxy workers + a router worker to Cloudflare

   After deployment, register the proxy as a custom provider in the dashboard:
   1. Base64url-encode your target URL: `node -e "console.log(Buffer.from('https://api.example.com/v1').toString('base64url'))"`
   2. Construct: `https://{ROUTER_DOMAIN}/{AUTH_KEY}/{PROXY_NUM}/{BASE64_URL}`
   3. Add as a custom provider with that URL as the base URL

   Other commands:

   | Command | Purpose |
   |---------|---------|
   | `npm run proxy:dev` | Local dev server via wrangler |
   | `npm run proxy:deploy` | Deploy all workers to Cloudflare |
   | `npm run proxy:status` | Show deployment status |
   | `npm run proxy:test` | Run proxy test suite |

   Adjust `PROXY_COUNT` and `ROUTER_DOMAIN` in `freellmproxy/.env`. See [the proxy's README](freellmproxy/README.md) for the full architecture.
   ```

**Validation:** README renders correctly with the new section. Links resolve.

---

## Implementation Order (Dependency Graph)

```
Phase 1:
  Task 1.1 (submodule) ──→ Task 1.2 (script) ──→ Task 1.3 (npm wiring)

Phase 2 (parallel with Phase 3):
  Task 2.1 (deploy command) ──→ depends on Task 1.2

Phase 3 (parallel with Phase 2):
  Task 3.1 (CI) ──→ depends on Task 1.3
  Task 3.2 (gitignore verify) ──→ depends on Task 1.1
  Task 3.3 (README) ──→ depends on Task 1.3 + Task 2.1
```

## Not In Scope (Explicitly Deferred)

These are **not** part of this spec. Do not implement:
- Auto-register the deployed proxy as a custom provider in the gateway (requires DB + UI code)
- Proxy-aware routing in the gateway's bandit (requires router changes)
- Dashboard UI elements for proxy management
- Multiple proxy deployments (staging vs production) — use separate `ROUTER_DOMAIN` values in separate `.env` files
- Proxy metrics ingested into the gateway's analytics
