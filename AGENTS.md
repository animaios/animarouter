# AnimaRouter

Multi-provider LLM proxy with an Express backend, React dashboard, and SQLite storage. Users add API keys for providers (OpenAI, Google, Anthropic, Cerebras, Cohere, Cloudflare), the server routes requests across keys with automatic failover, rate-limit awareness, and weighted scoring.

## Structure

```
server/          Express 5 API — providers, routing, rate-limiting, auth, SSE events
client/          React 19 + Vite dashboard — key management, analytics, playground
shared/          Shared TypeScript types (ChatMessage, Provider interfaces)
scripts/         CLI entry point (cli.mjs)
docker/          Docker setup docs
docs/specs/      Design specs for features in progress (benchmark-unification, dynamic-degradation, freellmproxy-integration)
```

Key server modules: `server/src/providers/` (per-provider adapters extending `BaseProvider`), `server/src/services/router.ts` (request routing + scoring), `server/src/routes/proxy.ts` (the /v1/chat/completions endpoint), `server/src/services/ratelimit.ts`.

## Commands

- `npm run dev` — start both server and client
- `npm run build` — build server then client
- `npm run test` — server vitest + client typecheck
- `npm run test -w server` — server tests only

## Rules

- Prefer delegating code changes via `spawn_agent` when that tool is available. If `spawn_agent` or jcodemunch MCP tools are unavailable, Codex may edit directly in this workspace after stating that fallback.
- **Never commit secrets** — API keys, tokens, encryption keys go through the import script pattern (see `RULES.md §12`).
- **Never touch git branches** — do not switch, reset, push, pull, merge, rebase, stash, or create branches unless the user explicitly instructs you to.
- **Never use `git stash`** — other agents are working on this repo; stashing can lose or conflict with their in-flight changes.
- Run a subagent code review after every spec implementation when `spawn_agent` is available. If it is unavailable, do a direct review pass before finalization and call out the missing subagent review in the final response.
- Use `npm` (not yarn/pnpm) — this is an npm workspaces monorepo.
- After delegated or direct edits, verify with jcodemunch when available. If unavailable, use local search, tests, and targeted code review.

## Delegation

`spawn_agent` is stateless — pass 100% of needed context every call. Include the repo identifier (`api-llm-local`), specific symbol_ids, and the jcodemunch usage mandate. Prefer `get_context_bundle` / `get_ranked_context` over copying source into prompts.

## Further Reference

Read these only when relevant to your current task:

- **`RULES.md §0`** — the full SOP for planning, delegation, and code review (analyze → delegate → verify loop)
- `RULES.md §1–§13` — fork management, branching, sync, conflict resolution, testing, credential import
- `docs/specs/` — design specs for in-progress features

## jcodemunch

Repo is indexed as `api-llm-local`. Prefer structured retrieval over reading full files:

- `plan_turn` → `search_symbols` → `get_symbol_source` / `get_context_bundle`
- `get_file_outline` before pulling source
- `get_blast_radius` / `find_references` before approving changes
- `register_edit` after edits land

Symbol ID format: `{file_path}::{qualified_name}#{kind}`
