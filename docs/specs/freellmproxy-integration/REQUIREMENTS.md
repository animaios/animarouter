# Requirements — FreeLLMProxy Submodule Integration

---

## R1: Git Submodule Structure

**R1.1** The proxy repository (currently at `~/freeproxy`, origin `https://github.com/animaios/freeproxy`) shall be added as a git submodule at the path `freellmproxy/` within the `freellmapi` monorepo root.

**R1.2** The submodule shall point to the `main` branch of `animaios/freeproxy` by default, tracking the latest commit.

**R1.3** The submodule URL shall use the `https://` form (not `git@`) so that anonymous `git clone --recursive` works without SSH keys.

**R1.4** A `.gitmodules` entry shall exist with `branch = main` so `git submodule update --remote` pulls the right branch.

---

## R2: Zero-Setup Post-Clone

**R2.1** After a fresh `git clone --recurse-submodules` (or `git clone` followed by `git submodule update --init --recursive`), the `freellmproxy/` directory shall contain the full proxy source tree — no manual steps required.

**R2.2** Running `npm install` from the monorepo root shall also install dependencies in `freellmproxy/` — no separate `cd freellmproxy && npm install` required by the user.

**R2.3** If a user clones without `--recurse-submodules` and then runs `npm install`, the install script shall detect the missing submodule, auto-initialize it, and proceed. No user intervention needed.

**R2.4** The `wrangler` CLI is the **only** external prerequisite. If `wrangler` is not on `$PATH`, any proxy-related script shall print a clear one-line message: `⚠️  wrangler not found. Install: npm i -g wrangler && wrangler login` and exit non-zero. It shall **not** silently fail or install wrangler globally itself.

---

## R3: One-Command Deploy

**R3.1** `npm run proxy:deploy` from the monorepo root shall:
1. Verify `wrangler` is on `$PATH`
2. Ensure the submodule is initialized and up to date
3. Ensure `freellmproxy/node_modules` exists (install if missing)
4. Ensure `freellmproxy/.env` exists (bootstrap if missing — see R4)
5. Run the proxy's deploy script

**R3.2** The command shall exit 0 on full success, non-zero on any failure, with a clear per-worker summary (matching the existing deploy.ts output format).

**R3.3** If any proxy worker deploy fails, the script shall still attempt the remaining workers and the router. It shall not abort early (matching existing `deploy.ts` behavior with `deployParallel` + retry).

---

## R4: Automatic Environment Bootstrap

**R4.1** If `freellmproxy/.env` does not exist when `npm run proxy:deploy` runs, the script shall generate it automatically:
- `AUTH_KEY` — derived from the gateway's `ENCRYPTION_KEY` (first 16 hex chars), or if that's unavailable, `crypto.randomBytes(16).toString('hex').slice(0, 16)`. Minimum 8 characters.
- `INTERNAL_AUTH_SECRET` — `crypto.randomBytes(32).toString('hex')`. Always freshly generated, 64 hex chars.
- `PROXY_COUNT` — default `3`.
- `ROUTER_DOMAIN` — read from `freellmapi/.env` `PROXY_ROUTER_DOMAIN` if set, otherwise `router.example.com` (placeholder — user must update for production).

**R4.2** If `freellmproxy/.env` already exists, the script shall **never** overwrite it. Any manually-set values (e.g., a real `ROUTER_DOMAIN`) are preserved.

**R4.3** The generated `.env` file shall be listed in `freellmproxy/.gitignore` (it already is — verify this is intact).

**R4.4** On bootstrap, the script shall print: `✅ Generated freellmproxy/.env with defaults. Edit ROUTER_DOMAIN before deploying to production.`

---

## R5: NPM Script Surface

**R5.1** The monorepo root `package.json` shall gain these scripts:
- `proxy:deploy` — full deploy pipeline (R3)
- `proxy:dev` — `wrangler dev` in the proxy submodule (local dev server)
- `proxy:status` — show deployed worker status via `wrangler deployments list`
- `proxy:test` — run proxy vitest suite

**R5.2** Each script shall `cd` into `freellmproxy/` (or use `--prefix`) before executing the proxy's own scripts. No script shall assume the CWD is inside the proxy directory.

**R5.3** `npm run proxy:test` shall be included in the top-level `npm test` (added to the `test` script chain). Proxy test failures shall fail the overall test run.

---

## R6: Monorepo Install Integration

**R6.1** The root `package.json` `scripts.postinstall` (or a `prepare` script) shall handle submodule auto-init (R2.3) and proxy dependency installation (R2.2).

**R6.2** The postinstall script shall be idempotent — running it multiple times shall have no side effects if the submodule is already initialized and dependencies are installed.

**R6.3** The postinstall script shall not block or fail the main gateway `npm install` if the submodule directory is missing for non-interactive reasons (e.g., CI with `--no-optional`). It shall log a warning and continue.

---

## R7: .gitignore Hygiene

**R7.1** `freellmproxy/.gitignore` shall continue to cover: `node_modules/`, `.wrangler/`, `dist/`, `.env`. No changes needed if the existing file covers these (verify).

**R7.2** The monorepo root `.gitignore` shall **not** add `freellmproxy/` to its ignore list — the submodule must be tracked by git, not ignored.

**R7.3** `freellmproxy/dist/` (generated TOML configs) and `freellmproxy/.wrangler/` (local dev cache) shall never be committed to the monorepo.

---

## R8: Preserved Proxy Independence

**R8.1** The proxy shall remain fully functional as a standalone project (`cd freellmproxy && npm run deploy`) without any dependency on the monorepo. The submodule integration is additive, not replacing.

**R8.2** The proxy's own `package.json`, `wrangler.toml`, `tsconfig.json`, `.env.example`, etc. shall remain unchanged. All integration logic lives in the monorepo's scripts and `package.json`.

**R8.3** Upstream tracking (`vadash/llm-proxy`) shall continue to work: `cd freellmproxy && git fetch upstream && git merge upstream/main` shall produce a clean merge with no monorepo-specific conflicts.

---

## R9: Gateway ↔ Proxy Awareness

**R9.1** The gateway shall be able to route requests **through** the cloud proxy via the custom provider mechanism (already built — `server/src/routes/custom.ts`). No new code path is needed in the gateway; this is a documentation and configuration task.

**R9.2** The spec shall document how to register the deployed proxy as a custom provider in the gateway:
1. Encode the target upstream URL in base64url
2. Construct the proxy URL: `https://{ROUTER_DOMAIN}/{AUTH_KEY}/{PROXY_NUM}/{BASE64_URL}`
3. Add it as a custom provider with base URL = that proxy URL

**R9.3** No gateway code changes are required for the base integration. Future enhancements (auto-register proxy as a provider, proxy-aware routing) are explicitly out of scope for this spec.

---

## R10: CI Integration

**R10.1** The monorepo CI (`github/workflows/ci.yml`) shall, on push/PR:
1. Check out with submodules: `submodules: recursive`
2. Install dependencies (root + proxy via postinstall)
3. Run proxy type-check: `npm run proxy:test`

**R10.2** CI shall **not** deploy the proxy. Deployment is a manual/operator action.

**R10.3** If the submodule is missing or broken, CI shall fail fast with a clear error: `❌ freellmproxy submodule not initialized. Ensure submodules: recursive in checkout.`

---

## R11: Documentation

**R11.1** The monorepo `README.md` shall gain a "Cloud Proxy" section after "Docker" explaining:
- What the proxy does (IP rotation, header stripping, deterministic fake IPs)
- The one-command deploy (`npm run proxy:deploy`)
- The prerequisites (wrangler on PATH, logged in)
- How to set `ROUTER_DOMAIN` in `freellmproxy/.env`

**R11.2** The spec shall include a README update plan with the exact section content to add (delegable as a single task).

---

## R12: Rollback Safety

**R12.1** Removing the submodule shall be a clean, documented operation: `git submodule deinit -f freellmproxy && git rm -f freellmproxy && rm -rf .git/modules/freellmproxy`. The monorepo shall work identically before and after.

**R12.2** The proxy's `.env` and `.wrangler/` state are local-only. Removing the submodule does not affect deployed Cloudflare Workers. Redeploying after re-adding the submodule restores all functionality.

**R12.3** All npm scripts in the monorepo root that reference `freellmproxy/` shall gracefully handle the directory's absence (log warning, exit 0 for optional scripts, exit 1 for `proxy:deploy`).
