# Repository Guidelines

## Tool Selection Strict SOP

**This section is the binding agent constitution for AnimaRouter. The matrix below takes precedence over every other convention in this file. There are no exceptions for code.**

### Forbidden Matrix

| Native tool | Scope of prohibition | Only permitted replacement |
|---|---|---|
| `Read` on any `.ts/.ts/.jsx/.tsx/.js/.mjs/.cjs` file | **FORBIDDEN** — never use to obtain source code symbols, function bodies, class definitions, or imports | `serena___find_symbol`, `serena___get_symbols_overview`, `jcodemunch___get_unit`, `jcodemunch___get_file` |
| `Read` on `src/**` in any workspace | **FORBIDDEN** — use jcodemunch repo map or serena symbol search instead | `jcodemunch___get_repo_map`, `jcodemunch___get_tectonic_map`, `serena___get_symbols_overview` |
| `Grep` inside `server/**`, `client/**`, `worker/**`, `shared/**` | **FORBIDDEN** — for code exploration, signatures, types, imports, calling sites | `jcodemunch___search_units`, `jcodemunch___search_text`, `jcodemunch___search_ast`, `jcodemunch___search_columns`, `serena___find_referencing_symbols`, `serena___find_implementations`, `jcodemunch___find_references` |
| `Glob` or `LS` exploring `src/**` | **FORBIDDEN** — for mapping architecture, finding files, understanding layout | `jcodemunch___get_repo_map`, `jcodemunch___get_tectonic_map`, `jcodemunch___list_content` |
| `find`, `rg`, `grep`, `tree` via Execute for code | **FORBIDDEN** | Same jcodemunch replacements as above |
| Raw `Edit` on source files | **RESTRICTED** — must always use symbol-level retrieval first | `serena___find_symbol` or `serena___find_declaration` to locate the symbol; then `serena___replace_symbol_body`, `serena___insert_after_symbol`, `serena___insert_before_symbol`, `serena___replace_in_files`, or jcodemunch `plan_refactoring` + Edit. Never Grep/Read to find the edit target. |
| `Edit`/`Create` for rename/move/extract | **RESTRICTED** — must produce a plan before any Edit | `jcodemunch___plan_refactoring` first; execute its `{old_text, new_text}` blocks via Edit |
| All native tools for pre-edit impact checks | **FORBIDDEN** — no manual blast-radius hunting | `jcodemunch___check_safe`, `jcodemunch___get_blast_radius` before ANY source-modifying tool |

### Permitted native tools (only these scopes remain)
- `Read` on **non-code documents only**: `docs/**`, `.env.example`, `package.json`, `biome.json`, `eslint.config.js`, `Dockerfile`, `docker-compose.yml`, `wrangler.toml`, `tsconfig*.json`, `turbo.json`, `pnpm-workspace.yaml`, `package-lock.json` (for version confirmation only)
- `Edit`/`Create` **are permitted only after** the symbol location has been obtained via the required tool above — never as a first-class reconnaissance step
- `Execute` is permitted for **build/test/lint/run commands** documented in this AGENTS.md — never for searching code

### STOP clause (zero-tolerance)
If a jcodemunch call returns `_meta.confidence < 0.4`, `verdict: "no_implementation_found"`, a timeout, or MCP error — **the agent must STOP and notify the user. Never silently convert the request into a Grep/Read/Shell fallback.** The absence was confirmed; report it and let the user decide.

---

## Session Startup Protocol

Every session, execute in order **before any code-related tool call**:

1. `jcodemunch___resolve_repo(path=".")` — confirm index freshness. If `repo_is_stale: true`, run `jcodemunch___index_content(path=".")` first.
2. `(optional) jcodemunch___get_repo_health(repo="animamesh/backend")` — one-call triage when debugging or auditing.
3. `jcodemunch___assemble_task_context(repo="animamesh/backend", task="...")` — opening move for every feature/debug/extend/audit/review task.

Do **not** manually hunt for entry points via Grep/Read/LS first.

---

## Pre-Edit Protocol

Before **any** `Edit`, `Create`, `ApplyPatch`, or source-modifying tool call, run **in order**:

1. `jcodemunch___check_safe(symbol="X", mode="edit"|"delete")` — composite safety preflight
2. `jcodemunch___get_blast_radius(symbol="X", include_source=true, call_depth=1)` — surface affected symbols
3. If the change is a rename/move/extract/signature change: `jcodemunch___plan_refactoring(...)` — use its `{old_text, new_text}` blocks for the actual Edit
4. Use `serena___find_symbol` or `serena___find_declaration` to get the **exact** symbol line/column — never manually grep for line numbers
5. Prefer `serena___replace_symbol_body` / `serena___insert_after_symbol` / `serena___insert_before_symbol` / `serena___replace_in_files` over raw Edit when working at symbol boundaries
6. `jcodemunch___register_edit(repo="animamesh/backend", file_paths=[...], reindex=true)` immediately after every successful edit

---

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
- **All other agent behavior is governed by the Tool Selection Strict SOP at the top of this file.**

## jcodemunch

Repo: `animamesh/backend` (indexed). Symbol ID: `{file_path}::{qualified_name}#{kind}`

**Use these tools for every code-related operation. Never fall back to native Read/Grep/LS when exploring or modifying source code.**

### Session start
- `resolve_repo(path=".")` — **always first call** — confirm repo is indexed. If not: `index_content(path=".")`

### Core lookup
- `assemble_task_context(repo="animamesh/backend", task="...")` — opening move; auto-classifies intent (explore/debug/refactor/extend/audit/review), surfaces symbols + ranked context
- `get_outline` → `get_unit` / `get_unit_context(symbol_ids=[...])` — targeted retrieval, never full files
- `search_units(repo="animamesh/backend", query="...")` — find by name, signature, summary
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
- `index_content(path="...")` / `index_folder(path="...")` — full index/reindex
- `register_edit(repo="animamesh/backend", file_paths=[...], reindex=true)` — invalidate caches after file edits

---

## Serena Code Operations

**All source code edits should be done through these symbol-level tools.** They provide exact AST-aware locations, scoped insertion/replacement, and knowledge of imports/types that raw Edit cannot guarantee.

### Discovery
- `get_symbols_overview(relative_path="...")` — signature-level overview grouped by kind. First call when you would reach for Read.
- `find_symbol(name_path_pattern="...")` — symbol search by name with depth for descendants. Returns full symbol kind/signature.
- `find_referencing_symbols(name_path="...", relative_path="...")` — all references to a symbol.
- `find_declaration(relative_path="...", regex="...")` — find declarations via regex capture group.
- `find_implementations(name_path="...", relative_path="...")` — concrete impls of an interface/abstract/method.

### Editing
- `replace_symbol_body(name_path="...", relative_path="...", body="...")` — edit only the body below the symbol signature line
- `insert_after_symbol(name_path="...", relative_path="...", body="...")` — insert after a class/method/function declaration
- `insert_before_symbol(name_path="...", relative_path="...", body="...")` — insert before a declaration (e.g., new field)
- `rename_symbol(name_path="...", relative_path="...", new_name="...")` — rename across the codebase (prefer jcodemunch `plan_refactoring` for cross-package moves)
- `safe_delete_symbol(name_path_pattern="...", relative_path="...")` — delete if there are no references; returns references if blocked
- `replace_content(relative_path="...", needle="...", repl="...", mode="regex|literal")` — text pattern replacement (fallback when no symbol-level applies)
- `replace_in_files(needle="...", repl="...", mode="regex|literal")` — bulk text replacement across many files (dry_run recommended first)

### Diagnostics & memory
- `get_diagnostics_for_file(relative_path="...")` — LSP diagnostics grouped by severity
- `write_memory(memory_name="...", content="...")` — durable project notes keyed by topic
- `read_memory(memory_name="...")` — retrieve project notes
- `list_memories(topic="...")` / `delete_memory(memory_name="...")` — manage stored project knowledge

**When the Edit target is a symbol boundary (function body, class method, field declaration), use `replace_symbol_body` / `insert_after_symbol` / `insert_before_symbol`. Only fall back to raw `Edit`/`Create` when the change is NOT symbol-bounded (e.g., new file, config key, doc string).**

---

## Power User Guide

#### Code Exploration Policy

**Always use jcodemunch-MCP and serena tools for code navigation and editing.** Never fall back to `Read`, `Grep`, `Glob`, `LS`, or shell commands for code exploration — they waste tokens and miss structural context (see Tool Selection Strict SOP for the full forbidden list).

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
| `confidence < 0.4` | Weak result — likely noise | Widen search or report gap; STOP and don't proceed silently |
| `freshness: stale` / `repo_is_stale: true` | Index may not reflect current HEAD | Run `index_file` / `index_content` before trusting the result |
| `verdict: "no_implementation_found"` | Confirmed absence | STOP searching — report to user |
| `tokens_remaining` ≈ 0 | Budget exhausted | Narrow query or increase `token_budget` |

#### After Editing Files

**Always** call `register_edit(repo="animamesh/backend", file_paths=[...], reindex=true)` after modifying any indexed file. This invalidates stale BM25/search caches so subsequent tool calls in the same session return fresh results. Without it, later searches may return outdated data or miss your changes entirely.

#### Golden Rules
1. **Always start with `resolve_repo` then `assemble_task_context`** — `resolve_repo` confirms the index exists; `assemble_task_context` auto-classifies intent and returns ranked symbols + context in one call. Never manually hunt for entry points.
2. **Batch everything** — use `symbol_ids[]` in `get_unit_context`, `get_unit`, `search_units` instead of serial calls. Token budget is your friend.
3. **Verify with `verify=true` / `verify_against="git_sha"`** — catches index drift vs. working tree.
4. **Use `mode` switches** on `search_units`: `context` for query-less ranked context, `semantic=true` for embedding search.
5. **Prefer `get_unit_context` over raw file reads** — deduplicates imports, respects token budget, returns ready-to-use context.
6. **Check `_meta.confidence` before acting** — low confidence means widen the search or report a gap, not proceed as-is.
7. **For any symbol-bounded edit, reach for `serena___replace_symbol_body` / `insert_after_symbol` / `insert_before_symbol` first** — raw Edit is the fallback for non-symbol-bounded changes (new files, configs).

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
get_unit_context(symbol_ids=[...], budget_strategy="core_first")
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

##### 9. Editing a function body (strict protocol)
```
check_safe(symbol="X", mode="edit")
get_blast_radius(symbol="X", include_source=true)
serena___find_symbol(name_path_pattern="ModuleName/myFunction", include_body=false)
serena___replace_symbol_body(name_path="ModuleName/myFunction", body="...")
jcodemunch___register_edit(file_paths=["server/src/whatever.ts"])
```

#### Parameter Cheatsheet

| Tool | Key params | When to use |
|---|---|---|
| `assemble_task_context` | `task`, `token_budget`, `symbols[]` | **First call for any task** — returns intent, symbols, context |
| `resolve_repo` | `path` | **Session start** — confirm repo is indexed; if not, `index_content` |
| `search_units` | `semantic`, `fusion`, `detail_level`, `token_budget` | Symbol discovery; `fusion=true` for vague queries; `detail_level="compact"` = 15 tokens/row |
| `get_unit_context` | `symbol_ids[]`, `budget_strategy`, `token_budget` | Multi-symbol context in one call; `core_first` keeps primary symbol; `compact` = signatures only |
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
| `serena___find_symbol` | `name_path_pattern`, `depth`, `include_body`, `relative_path` | Mandatory first step for any symbol-level edit |
| `serena___get_symbols_overview` | `relative_path`, `depth` | File structure, grouped by kind — replaces Read for source |
| `serena___replace_symbol_body` | `name_path`, `relative_path`, `body` | Symbol-bounded edit — body only, signature stays |
| `serena___insert_after_symbol` | `name_path`, `relative_path`, `body` | Add after declaration (new field/method) |
| `serena___insert_before_symbol` | `name_path`, `relative_path`, `body` | Add before declaration |
| `serena___rename_symbol` | `name_path`, `relative_path`, `new_name` | Rename in one file; for cross-package use jcodemunch `plan_refactoring` |
| `serena___find_referencing_symbols` | `name_path`, `relative_path` | Who uses a symbol |
| `serena___find_implementations` | `name_path`, `relative_path`, `depth` | Concrete impls of interface/abstract |
| `serena___get_diagnostics_for_file` | `relative_path`, `min_severity` | LSP diagnostics by file |
| `serena___replace_in_files` | `needle`, `repl`, `mode`, `dry_run` | Bulk multi-file text replacements |

#### Anti-patterns to Avoid
- ❌ **Reading `.ts/.ts/.js/.mjs` files via `Read`** — use `get_unit`, `get_unit_context`, or `serena___find_symbol`
- ❌ **Using Grep/RG/shell for code exploration** — `search_units` / `serena___find_referencing_symbols` understand signatures, imports, types; grep is for non-symbol text only
- ❌ **Calling `search_units` repeatedly** — batch with `symbol_ids[]` in `get_unit_context`
- ❌ **Skipping `check_safe` before edits/deletes** — 5s call prevents hours of revert
- ❌ **Skipping `register_edit` after modifying files** — stale caches cause later searches to return outdated data
- ❌ **Manual blast radius tracing** — `get_blast_radius(depth=2, include_source=true)` is instant
- ❌ **Re-searching after `verdict: "no_implementation_found"`** — the absence is confirmed; report it
- ❌ **Reading `src/**` via Read instead of `serena___get_symbols_overview`**
- ❌ **Using raw Edit for symbol-bounded changes** — use `serena___replace_symbol_body` / `insert_after_symbol` / `insert_before_symbol`
- ❌ **Grep-then-Edit cycle** — if your Edit target is a symbol, find it via `serena___find_symbol` first, not Grep
- ❌ **Manual LS/Glob to map architecture** — use `jcodemunch___get_repo_map` and `jcodemunch___get_tectonic_map`
- ❌ **Silently falling back to native tools when an MCP call fails** — STOP and report, never Grep/Read as backup

#### Pro Tips
- **`budget_strategy="compact"`** on `get_unit_context` — returns signatures only (min tokens), great for call-chain mapping
- **`embed_repo()` once** — then `semantic=true` on `search_units` works instantly for semantic queries
- **`index_file` after every edit** — keeps index fresh for subsequent tool calls in same session
- **`cross_repo=true`** on `get_blast_radius` / `find_references` — finds consumers in other indexed repos
- **`chains=true`** on `get_call_hierarchy` — discovers end-to-end signal chains (HTTP routes, CLI commands, event handlers) that involve the symbol
- **For any boundaried edit (function, method, class field)** — always prefer serena symbol-level edits (`replace_symbol_body`, `insert_after_symbol`, `insert_before_symbol`) over raw Edit; pair with `jcodemunch___register_edit` after
- **Stale index?** `get_repo_health` returns `repo_is_stale`. If true, run `index_content(path=".")` before trusting search results

#### Token Budget Discipline
- `assemble_task_context(token_budget=4000)` for focused tasks
- `get_unit_context(token_budget=6000, budget_strategy="core_first")` for multi-symbol context
- `search_units(token_budget=3000)` with `detail_level="compact"` for broad discovery (15 tokens/row)
- Always check `_meta.tokens_used` / `_meta.tokens_remaining` in responses
