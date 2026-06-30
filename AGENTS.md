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

## jcodemunch

Repo: `animamesh/backend` (indexed). Symbol ID: `{file_path}::{qualified_name}#{kind}`

### Session start
- `resolve_repo(path=".")` — **always first call** — confirm repo is indexed. If not: `index_folder(path=".")`

### Core lookup
- `assemble_task_context(repo="animamesh/backend", task="...")` — opening move; auto-classifies intent (explore/debug/refactor/extend/audit/review), surfaces symbols + ranked context
- `get_file_outline` → `get_symbol_source` / `get_context_bundle(symbol_ids=[...])` — targeted retrieval, never full files
- `search_symbols(repo="animamesh/backend", query="...")` — find by name, signature, summary
  - `mode="context"` — query-less ranked context assembly
  - `mode="winnow"` — multi-axis constraint filter (kind, language, complexity, churn, etc.)
  - `semantic=true` — embedding-based search (requires embed provider)
  - `detail_level="compact"` — 15 tokens/row (broad discovery); `"standard"` (default); `"full"` (inline source)
  - `fusion=true` — Weighted Reciprocal Rank across lexical/structural/similarity/identity channels; best for vague queries
- `search_text(repo="animamesh/backend", query="...")` — full-text search across file contents (string literals, comments, configs)
- `search_ast(repo="animamesh/backend", pattern="..." | category="...")` — structural anti-pattern scan (empty_catch, god_function, hardcoded_secret, etc.)

### Impact & safety
- `get_blast_radius(symbol="...", include_source=true)` — check impact before changes. Key params: `call_depth` (0–3, find callers), `include_decisions=true` (surfaces commit intent), `source_budget`
- `find_references(mode="refs"|"importers"|"related", quick=true|false)` — trace who uses a symbol. `quick=true` returns lightweight `{is_referenced, import_count}` for dead-code checks
- `get_call_hierarchy(symbol_id="...", direction="both", depth=3)` — trace call graph. Key params: `chains=true` (discover HTTP/CLI/event signal chains), `kind` (http/cli/event/task/main/test), `max_depth` (1–8), `include_impact=true`
- `check_safe(repo="animamesh/backend", symbol="...", mode="edit"|"delete")` — composite preflight: can this symbol be safely edited/deleted?
- `plan_refactoring(repo="animamesh/backend", symbol="...", refactor_type="rename"|"move"|"extract"|"signature")` — generate multi-file edit plan before refactoring
- `get_changed_symbols(repo="animamesh/backend")` — map git diff to affected symbols
- `get_pr_risk_profile(repo="animamesh/backend")` — unified risk assessment for a PR/branch

### Repository intelligence
- `get_repo_health(repo="animamesh/backend")` — one-call triage (dead code %, complexity, hotspots, cycle count)
- `get_repo_map(repo="animamesh/backend")` — signature-level overview ranked by PageRank (cold-start orientation). `mode="outline"` for lightweight directory/language/symbol count overview
- `get_tectonic_map(repo="animamesh/backend")` — logical module topology (hidden boundaries, misplaced files, drifters)
- `find_hot_paths(repo="animamesh/backend")` — top-N symbols by runtime hit count (requires ingested traces)
- `get_dead_code_v2(repo="animamesh/backend", min_confidence=0.67)` — multi-signal dead code detection
- `find_similar_symbols(repo="animamesh/backend")` — cluster similar functions/methods (consolidation candidates)
- `get_symbol_provenance(repo="animamesh/backend", symbol="...")` — git authorship lineage & evolution narrative
- `get_symbol_complexity(repo="animamesh/backend", symbol_id="...")` — cyclomatic complexity, nesting, params
- `get_class_hierarchy(repo="animamesh/backend", class_name="...")` — inheritance ancestors + descendants
- `find_implementations(repo="animamesh/backend", symbol="...")` — find concrete impls of an interface/abstract
- `get_project_intel(repo="animamesh/backend")` — auto-discover Dockerfiles, CI configs, deps, APIs
- `list_workspaces(repo="animamesh/backend")` — enumerate monorepo workspace members
- `search_columns(repo="animamesh/backend", query="...")` — search column metadata across indexed models

### Runtime & indexing
- `import_runtime_signal(repo="animamesh/backend", path="...", source="otel"|"sql_log"|"stack_log")` — ingest runtime traces
- `embed_repo(repo="animamesh/backend")` — precompute symbol embeddings for semantic search. `force=true` to recompute all, `batch_size=50` (default)
- `summarize_repo(repo="animamesh/backend", force=true)` — re-run AI summarization pipeline
- `index_file(path="...")` — surgical single-file reindex after edits
- `index_folder(path="...")` / `index_repo(url="...")` — full index/reindex
- `register_edit(repo="animamesh/backend", file_paths=[...], reindex=true)` — invalidate caches after file edits

### Power User Guide

#### Code Exploration Policy

**Always use jcodemunch-MCP tools for code navigation.** Never fall back to `read_file`, `grep`, `find_path`, or shell for code exploration — they waste tokens and miss structural context.

**Exception:** Use `read_file` when you need to **edit** a file (to get exact line content for the edit tool). Even then, read only the target section, never the full file.

#### Session-Aware Routing (confidence + negative evidence)

Every tool response includes `_meta.confidence` and `_meta.freshness`. Route your behavior by confidence tier:

| Confidence | Action | Max supplementary reads |
|---|---|---|
| `high` (≥ 0.8) | Act directly on the result | 2 |
| `medium` (0.4–0.79) | Explore recommended files to validate | 5 |
| `low` (< 0.4) | Report the gap — don't keep searching | 0 |

**Negative evidence rule:** If a search returns `verdict: "no_implementation_found"` — **stop.** Do not re-search with different terms, broader queries, or fallback tools. Report the absence to the user; let them decide whether the thing should exist.

#### Interpreting Search Results

| `_meta` field | Meaning | Action |
|---|---|---|
| `confidence < 0.4` | Weak result — likely noise | Widen search or report gap, don't proceed as-is |
| `freshness: stale` / `repo_is_stale: true` | Index may not reflect current HEAD | Run `index_file` / `index_folder` before trusting the result |
| `verdict: "no_implementation_found"` | Confirmed absence | Stop searching — report to user |
| `tokens_remaining` ≈ 0 | Budget exhausted | Narrow query or increase `token_budget` |

#### After Editing Files

**Always** call `register_edit(repo="animamesh/backend", file_paths=[...], reindex=true)` after modifying any indexed file. This invalidates stale BM25/search caches so subsequent tool calls in the same session return fresh results. Without it, later searches may return outdated data or miss your changes entirely.

#### Golden Rules
1. **Always start with `resolve_repo` then `assemble_task_context`** — `resolve_repo` confirms the index exists; `assemble_task_context` auto-classifies intent and returns ranked symbols + context in one call. Never manually hunt for entry points.
2. **Batch everything** — use `symbol_ids[]` in `get_context_bundle`, `get_symbol_source`, `search_symbols` instead of serial calls. Token budget is your friend.
3. **Verify with `verify=true` / `verify_against="git_sha"`** — catches index drift vs. working tree.
4. **Use `mode` switches** on `search_symbols`: `context` for query-less ranked context, `winnow` for multi-axis filters, `semantic=true` for embedding search.
5. **Prefer `get_context_bundle` over raw file reads** — deduplicates imports, respects token budget, returns ready-to-use context.
6. **Check `_meta.confidence` before acting** — low confidence means widen the search or report a gap, not proceed as-is.

#### Common Workflows

##### 1. Cold-start orientation (new repo / unfamiliar area)
```
resolve_repo(path=".")                                                      # Confirm repo is indexed
get_repo_map(repo="animamesh/backend", group_by="flat", top_n=30)     # Top symbols by PageRank
get_tectonic_map(repo="animamesh/backend")                               # Logical module boundaries
get_repo_health(repo="animamesh/backend", detailed=true)                 # Dead code %, complexity, cycles
```

##### 2. Feature exploration — "How does X work?"
```
assemble_task_context(repo="animamesh/backend", task="How does X work?")
# → returns ranked symbols + context
get_context_bundle(symbol_ids=[...], budget_strategy="core_first")
```

##### 3. Refactoring safety (rename/move/extract)
```
check_safe(repo="animamesh/backend", symbol="SymbolName", mode="edit")
plan_refactoring(repo="animamesh/backend", symbol="SymbolName", refactor_type="rename", new_name="newName")
get_blast_radius(symbol="SymbolName", depth=2, include_source=true)
```

##### 4. Dead code cleanup
```
get_dead_code_v2(repo="animamesh/backend", min_confidence=0.67, file_pattern="src/**")
find_similar_symbols(repo="animamesh/backend", threshold=0.85, include_kinds=["function", "method"])
```

##### 5. Performance hotspot triage
```
find_hot_paths(repo="animamesh/backend", top_n=20)
get_repo_health(repo="animamesh/backend", detailed=true, top_n=30)
get_symbol_complexity(repo="animamesh/backend", symbol_id="...")
```

##### 6. PR / change risk assessment
```
get_changed_symbols(repo="animamesh/backend", include_blast_radius=true, max_blast_depth=3)
get_pr_risk_profile(repo="animamesh/backend", base_ref="main", head_ref="HEAD")
```

##### 7. Understanding unfamiliar code before modifying
```
get_symbol_provenance(repo="animamesh/backend", symbol="SymbolName", max_commits=30)
get_call_hierarchy(symbol_id="...", direction="both", depth=3, include_impact=true)
find_implementations(repo="animamesh/backend", symbol="InterfaceName", include_subclasses=true)
```

##### 8. Finding config / string literals / comments (not symbols)
```
search_text(repo="animamesh/backend", query="MAX_RETRIES", context_lines=3)
search_ast(repo="animamesh/backend", category="security")              # hardcoded_secret, eval_exec
search_ast(repo="animamesh/backend", pattern="string:/password/i")      # custom pattern
```

#### Parameter Cheatsheet

| Tool | Key params | When to use |
|---|---|---|
| `assemble_task_context` | `task`, `token_budget`, `symbols[]` | **First call for any task** — returns intent, symbols, context |
| `resolve_repo` | `path` | **Session start** — confirm repo is indexed; if not, `index_folder` |
| `search_symbols` | `mode`, `semantic`, `fusion`, `detail_level`, `token_budget` | Symbol discovery; `fusion=true` for vague queries; `detail_level="compact"` = 15 tokens/row |
| `get_context_bundle` | `symbol_ids[]`, `budget_strategy`, `token_budget` | Multi-symbol context in one call; `core_first` keeps primary symbol; `compact` = signatures only |
| `get_blast_radius` | `depth`, `include_source`, `include_depth_scores`, `call_depth`, `include_decisions` | Pre-edit impact; `include_decisions` surfaces commit intent; `call_depth` finds callers |
| `find_references` | `mode` (refs/importers/related), `quick`, `cross_repo` | `quick=true` for dead-code fast-path; `mode="importers"` for file-level deps |
| `get_call_hierarchy` | `direction`, `depth`, `include_impact`, `chains`, `kind`, `max_depth` | `chains=true` discovers signal chains (HTTP/CLI/event); `include_impact=true` for delete-safety |
| `check_safe` | `mode` (edit/delete), `include_runtime` | Preflight — returns verdict + top-5 blockers |
| `plan_refactoring` | `refactor_type`, `new_name`/`new_file`/`new_signature` | Returns `{old_text, new_text}` blocks ready for Edit tool |
| `get_repo_health` | `detailed`, `rules` (layer defs) | One-call triage; `detailed=true` adds cycles, coupling, hotspots |
| `get_repo_map` | `group_by`, `top_n`, `mode` (map/outline) | `mode="outline"` = lightweight dir/lang/symbol counts |
| `get_tectonic_map` | `days`, `min_plate_size` | Module topology; finds drifters, nexus plates (coupled ≥4) |
| `find_similar_symbols` | `threshold`, `semantic_weight`, `include_tests` | Consolidation candidates; `semantic_weight=0.6` default |
| `get_symbol_provenance` | `max_commits` | Authorship lineage + evolution narrative |
| `search_ast` | `category`, `pattern`, `language` | Anti-pattern sweep; `category=all` runs everything |
| `get_changed_symbols` | `since_sha`, `until_sha`, `include_blast_radius` | Maps git diff → symbols + downstream impact |
| `get_pr_risk_profile` | `base_ref`, `head_ref`, `days` | Composite risk score (blast + complexity + churn + tests + volume) |
| `embed_repo` | `force`, `batch_size` | Precompute embeddings; `force=true` to recompute all |

#### Anti-patterns to Avoid
- ❌ Reading full files with `read_file` — use `get_context_bundle` or `get_symbol_source`
- ❌ Using `grep`/`find_path`/shell for code exploration — `search_symbols` understands signatures, imports, types; `grep` is for non-symbol text only
- ❌ Calling `search_symbols` repeatedly — batch with `symbol_ids[]` in `get_context_bundle`
- ❌ Skipping `check_safe` before edits/deletes — 5s call prevents hours of revert
- ❌ Not verifying with `verify=true` — index can drift from working tree
- ❌ Ignoring `_meta.confidence` < 0.4 — low confidence means widen the search or report a gap, not proceed as-is
- ❌ Manual blast radius tracing — `get_blast_radius(depth=2, include_source=true)` is instant
- ❌ Re-searching after `verdict: "no_implementation_found"` — the absence is confirmed; report it, don't re-query with different terms
- ❌ Skipping `register_edit` after modifying files — stale caches cause later searches to return outdated data

#### Pro Tips
- **`budget_strategy="compact"`** on `get_context_bundle` — returns signatures only (min tokens), great for call-chain mapping
- **`embed_repo(repo="animamesh/backend")` once** — then `semantic=true` on `search_symbols` works instantly for semantic queries
- **`index_file` after every edit** — keeps index fresh for subsequent tool calls in same session
- **`cross_repo=true`** on `get_blast_radius` / `find_references` — finds consumers in other indexed repos
- **`chains=true`** on `get_call_hierarchy` — discovers end-to-end signal chains (HTTP routes, CLI commands, event handlers) that involve the symbol
- **Stale index?** `get_repo_health` returns `repo_is_stale`. If true, run `index_folder(path=".")` before trusting search results

#### Token Budget Discipline
- `assemble_task_context(token_budget=4000)` for focused tasks
- `get_context_bundle(token_budget=6000, budget_strategy="core_first")` for multi-symbol context
- `search_symbols(token_budget=3000)` with `detail_level="compact"` for broad discovery (15 tokens/row)
- Always check `_meta.tokens_used` / `_meta.tokens_remaining` in responses⏎         
