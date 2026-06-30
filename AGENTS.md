# Repository Guidelines

## Project Structure & Module Organization

AnimaRouter is a TypeScript monorepo (npm workspaces) for a smart LLM API router.

```
.
├── server/      # Express API (routing, proxying, analytics) — Node + better-sqlite3 + drizzle-orm
├── client/      # React dashboard (Vite + Tailwind v4 + TanStack Query)
├── worker/      # Cloudflare Worker edge proxy (Wrangler)
├── shared/      # Shared TypeScript types consumed by server/worker
├── scripts/      # CLI entrypoint (bin: api) and deploy helpers
└── docs/        # Specs and design notes
```

Source lives in `src/` within each workspace; build output goes to `dist/`.

## Build, Test, and Development Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start server (tsx watch) and client (vite) concurrently |
| `npm run dev:lan` | Same, but exposes the client on LAN (`--host`) |
| `npm run build` | Type-check + build server, type-check client, type-check worker |
| `npm run build:server` | `tsc` compile server to `dist/` |
| `npm run build:worker` | `tsc --noEmit` type-check worker |
| `npm run deploy:worker` | Interactive deploy wizard for the Cloudflare Worker |
| `npm run test` | Run server + worker vitest suites and client type-check |
| `npm run lint` | `biome check .` (format + lint + import sort) |
| `npm run lint:fix` | Auto-fix biome issues |
| `npm run test -w server` | Server tests: `vitest run --pool=forks --fileParallelism=false` |
| `npm run test -w worker` | Worker tests: `vitest run` |
| `npm run typecheck -w client` | `tsc --noEmit` for the client |

Per-workspace scripts are invoked with `npm run <script> -w <workspace>`.

## Coding Style & Naming Conventions

- **Formatter/linter:** Biome (config in `biome.json`). 2-space indent, double quotes, organize-imports on save.
- **TypeScript:** strict mode across all workspaces. Server and worker are ESM (`"type": "module"`).
- **Naming:** `camelCase` for functions/variables, `PascalCase` for types/classes, `kebab-case` for filenames (e.g., `router-bandit.test.ts`).
- **Imports:** use workspace aliases (`@animarouter/shared`) for cross-package imports.
- **Client:** Tailwind v4 utility classes; components in `src/pages/` and `src/components/`.

Run `npm run lint:fix` before committing to catch style issues.

## Testing Guidelines

- **Framework:** Vitest (v3) with `@vitest/coverage-v8` for coverage.
- **Server tests** live in `server/src/__tests__/` split by area (`services/`, `routes/`, `providers/`, `lib/`, `db/`, `integration/`). Run with `--pool=forks --fileParallelism=false` because tests share a SQLite database.
- **Worker tests** live in `worker/src/` (e.g., `index.test.ts`).
- **Client tests** live alongside source in `client/src/` (e.g., `*.test.ts`).
- **Naming:** `<module>.test.ts` colocated or under `__tests__/`.
- Coverage is tracked via DeepSource; aim to keep or improve coverage on changes.

## Commit & Pull Request Guidelines

- **Commit style:** conventional `type: description` (e.g., `feat:`, `docs:`, `fix:`). Keep the subject line under 72 characters. Recent history uses short, lowercase subjects.
- **Pre-commit:** Husky runs lint checks via `.husky/pre-commit`.
- **Pull requests:** link related issues in the description, include screenshots for UI changes, and ensure `npm run test` and `npm run lint` pass before requesting review.

## Agent-Specific Instructions

- The server depends on a SQLite database; tests that touch it must not run with full parallelism (the `--fileParallelism=false` flag is intentional).
- Environment variables are documented in `.env.example` — copy to `.env` before running the server locally.
- The worker deploys via Wrangler; `wrangler.toml` and `scripts/deploy-worker-wizard.mjs` handle configuration.
