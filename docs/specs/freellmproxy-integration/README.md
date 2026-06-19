# FreeLLMProxy Submodule Integration — Kiro-Style Spec

**Status:** Final Draft · **Author:** Architect (jCodeMunch-augmented) · **Date:** 2026-06-20

Integrate the existing Cloudflare Workers proxy layer (`freellmproxy` — currently at `~/freeproxy`, tracking `vadash/llm-proxy` upstream) as a git submodule of `freellmapi` with fully automated zero-setup deployment. The only prerequisite: `wrangler` on `$PATH` and logged in.

## Documents

| File | Purpose |
|------|---------|
| [REQUIREMENTS.md](./REQUIREMENTS.md) | What must be true when we're done (12 requirement groups, R1–R12) |
| [DESIGN.md](./DESIGN.md) | How it works — submodule topology, auto-init, one-command deploy, wiring to the gateway |
| [TASKS.md](./TASKS.md) | Ordered, delegable implementation steps (10 tasks across 3 phases) |

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Git relationship | Git submodule (not copy/fork) | Proxy stays independently versioned, tracks upstream `vadash/llm-proxy`, receives its own PRs |
| Integration entry point | `npm run proxy:deploy` from the monorepo root | Single command — submodule init, install, env bootstrap, wrangler deploy |
| Env management | `.env` in proxy dir, auto-seeded from gateway's `.env` | No manual copy. Gateway already has secrets; proxy reads what it needs or gets sensible defaults |
| Proxy count | Auto-detected from `.env` with sane default (3) | Zero thought required. Power users can override |
| Naming convention | `freellmproxy` as directory name and npm script namespace | Clear ownership, no collision with generic `proxy` naming |
| Post-clone UX | `git clone` → `npm install` → done. Submodule init is automatic. | The promise: nothing ever required apart from having `wrangler` logged in |
