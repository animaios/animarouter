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

Repo: `api-llm-local` (indexed). Symbol ID: `{file_path}::{qualified_name}#{kind}`

### Core lookup
- `assemble_task_context(repo="api-llm-local", task="...")` — opening move; auto-classifies intent (explore/debug/refactor/extend/audit/review), surfaces symbols + ranked context
- `get_file_outline` → `get_symbol_source` / `get_context_bundle(symbol_ids=[...])` — targeted retrieval, never full files
- `search_symbols(repo="api-llm-local", query="...")` — find by name, signature, summary
  - `mode="context"` — query-less ranked context assembly
  - `mode="winnow"` — multi-axis constraint filter (kind, language, complexity, churn, etc.)
  - `semantic=true` — embedding-based search (requires embed provider)
- `search_text(repo="api-llm-local", query="...")` — full-text search across file contents (string literals, comments, configs)
- `search_ast(repo="api-llm-local", pattern="..." | category="...")` — structural anti-pattern scan (empty_catch, god_function, hardcoded_secret, etc.)

### Impact & safety
- `get_blast_radius(symbol="...", include_source=true)` — check impact before changes
- `find_references` / `get_call_hierarchy` — trace who uses a symbol
- `check_safe(repo="api-llm-local", symbol="...", mode="edit"|"delete")` — composite preflight: can this symbol be safely edited/deleted?
- `plan_refactoring(repo="api-llm-local", symbol="...", refactor_type="rename"|"move"|"extract"|"signature")` — generate multi-file edit plan before refactoring
- `get_changed_symbols(repo="api-llm-local")` — map git diff to affected symbols
- `get_pr_risk_profile(repo="api-llm-local")` — unified risk assessment for a PR/branch

### Repository intelligence
- `get_repo_health(repo="api-llm-local")` — one-call triage (dead code %, complexity, hotspots, cycle count)
- `get_repo_map(repo="api-llm-local")` — signature-level overview ranked by PageRank (cold-start orientation)
- `get_tectonic_map(repo="api-llm-local")` — logical module topology (hidden boundaries, misplaced files, drifters)
- `find_hot_paths(repo="api-llm-local")` — top-N symbols by runtime hit count (requires ingested traces)
- `get_dead_code_v2(repo="api-llm-local", min_confidence=0.67)` — multi-signal dead code detection
- `find_similar_symbols(repo="api-llm-local")` — cluster similar functions/methods (consolidation candidates)
- `get_symbol_provenance(repo="api-llm-local", symbol="...")` — git authorship lineage & evolution narrative
- `get_symbol_complexity(repo="api-llm-local", symbol_id="...")` — cyclomatic complexity, nesting, params
- `get_class_hierarchy(repo="api-llm-local", class_name="...")` — inheritance ancestors + descendants
- `find_implementations(repo="api-llm-local", symbol="...")` — find concrete impls of an interface/abstract
- `get_project_intel(repo="api-llm-local")` — auto-discover Dockerfiles, CI configs, deps, APIs
- `list_workspaces(repo="api-llm-local")` — enumerate monorepo workspace members
- `search_columns(repo="api-llm-local", query="...")` — search column metadata across indexed models

### Runtime & indexing
- `import_runtime_signal(repo="api-llm-local", path="...", source="otel"|"sql_log"|"stack_log")` — ingest runtime traces
- `embed_repo(repo="api-llm-local")` — precompute symbol embeddings for semantic search
- `summarize_repo(repo="api-llm-local", force=true)` — re-run AI summarization pipeline
- `index_file(path="...")` — surgical single-file reindex after edits
- `index_folder(path="...")` / `index_repo(url="...")` — full index/reindex
- `register_edit(repo="api-llm-local", file_paths=[...], reindex=true)` — invalidate caches after file edits

### Power User Guide

#### Golden Rules
1. **Always start with `assemble_task_context`** — it auto-classifies intent and returns ranked symbols + context in one call. Never manually hunt for entry points.
2. **Batch everything** — use `symbol_ids[]` in `get_context_bundle`, `get_symbol_source`, `search_symbols` instead of serial calls. Token budget is your friend.
3. **Verify with `verify=true` / `verify_against="git_sha"`** — catches index drift vs. working tree.
4. **Use `mode` switches** on `search_symbols`: `context` for query-less ranked context, `winnow` for multi-axis filters, `semantic=true` for embedding search.
5. **Prefer `get_context_bundle` over raw file reads** — deduplicates imports, respects token budget, returns ready-to-use context.

#### Common Workflows

##### 1. Cold-start orientation (new repo / unfamiliar area)
```
get_repo_map(repo="api-llm-local", group_by="flat", top_n=30)     # Top symbols by PageRank
get_tectonic_map(repo="api-llm-local")                               # Logical module boundaries
get_repo_health(repo="api-llm-local", detailed=true)                 # Dead code %, complexity, cycles
```

##### 2. Feature exploration — "How does X work?"
```
assemble_task_context(repo="api-llm-local", task="How does X work?")
# → returns ranked symbols + context
get_context_bundle(symbol_ids=[...], budget_strategy="core_first")
```

##### 3. Refactoring safety (rename/move/extract)
```
check_safe(repo="api-llm-local", symbol="SymbolName", mode="edit")
plan_refactoring(repo="api-llm-local", symbol="SymbolName", refactor_type="rename", new_name="newName")
get_blast_radius(symbol="SymbolName", depth=2, include_source=true)
```

##### 4. Dead code cleanup
```
get_dead_code_v2(repo="api-llm-local", min_confidence=0.67, file_pattern="src/**")
find_similar_symbols(repo="api-llm-local", threshold=0.85, include_kinds=["function", "method"])
```

##### 5. Performance hotspot triage
```
find_hot_paths(repo="api-llm-local", top_n=20)
get_repo_health(repo="api-llm-local", detailed=true, top_n=30)
get_symbol_complexity(repo="api-llm-local", symbol_id="...")
```

##### 6. PR / change risk assessment
```
get_changed_symbols(repo="api-llm-local", include_blast_radius=true, max_blast_depth=3)
get_pr_risk_profile(repo="api-llm-local", base_ref="main", head_ref="HEAD")
```

##### 7. Understanding unfamiliar code before modifying
```
get_symbol_provenance(repo="api-llm-local", symbol="SymbolName", max_commits=30)
get_call_hierarchy(symbol_id="...", direction="both", depth=3, include_impact=true)
find_implementations(repo="api-llm-local", symbol="InterfaceName", include_subclasses=true)
```

##### 8. Finding config / string literals / comments (not symbols)
```
search_text(repo="api-llm-local", query="MAX_RETRIES", context_lines=3)
search_ast(repo="api-llm-local", category="security")              # hardcoded_secret, eval_exec
search_ast(repo="api-llm-local", pattern="string:/password/i")      # custom pattern
```

#### Parameter Cheatsheet

| Tool | Key params | When to use |
|---|---|---|
| `assemble_task_context` | `task`, `token_budget` (8k default) | **First call for any task** — returns intent, symbols, context |
| `search_symbols` | `mode`, `semantic`, `fusion`, `token_budget` | Symbol discovery; `mode=context` = ranked context w/o query |
| `get_context_bundle` | `symbol_ids[]`, `budget_strategy`, `token_budget` | Multi-symbol context in one call; `core_first` keeps primary symbol |
| `get_blast_radius` | `depth`, `include_source`, `include_depth_scores` | Pre-edit impact; `include_depth_scores` = per-hop risk |
| `check_safe` | `mode` (edit/delete), `include_runtime` | Preflight — returns verdict + top-5 blockers |
| `plan_refactoring` | `refactor_type`, `new_name`/`new_file`/`new_signature` | Returns `{old_text, new_text}` blocks ready for Edit tool |
| `get_repo_health` | `detailed`, `rules` (layer defs) | One-call triage; `detailed=true` adds cycles, coupling, hotspots |
| `get_tectonic_map` | `days`, `min_plate_size` | Module topology; finds drifters, nexus plates (coupled ≥4) |
| `find_similar_symbols` | `threshold`, `semantic_weight`, `include_tests` | Consolidation candidates; `semantic_weight=0.6` default |
| `get_symbol_provenance` | `max_commits` | Authorship lineage + evolution narrative |
| `search_ast` | `category`, `pattern`, `language` | Anti-pattern sweep; `category=all` runs everything |
| `get_changed_symbols` | `since_sha`, `until_sha`, `include_blast_radius` | Maps git diff → symbols + downstream impact |
| `get_pr_risk_profile` | `base_ref`, `head_ref`, `days` | Composite risk score (blast + complexity + churn + tests + volume) |

#### Anti-patterns to Avoid
- ❌ Reading full files with `read_file` — use `get_context_bundle` or `get_symbol_source`
- ❌ Calling `search_symbols` repeatedly — batch with `symbol_ids[]` in `get_context_bundle`
- ❌ Skipping `check_safe` before edits/deletes — 5s call prevents hours of revert
- ❌ Not verifying with `verify=true` — index can drift from working tree
- ❌ Using `grep` for symbol lookup — `search_symbols` understands signatures, imports, types
- ❌ Manual blast radius tracing — `get_blast_radius(depth=2, include_source=true)` is instant

#### Pro Tips
- **`fusion=true` on `search_symbols`** — uses Weighted Reciprocal Rank across lexical/structural/similarity/identity channels; best for vague queries
- **`budget_strategy="compact"`** on `get_context_bundle` — returns signatures only (min tokens), great for call-chain mapping
- **`include_decisions=true`** on `get_blast_radius` / `get_call_hierarchy(include_impact=true)` — surfaces git commit intent (revert/perf/refactor/bugfix) from history
- **`embed_repo(repo="api-llm-local")` once** — then `semantic=true` on `search_symbols` works instantly for semantic queries
- **`index_file` after every edit** — keeps index fresh for subsequent tool calls in same session
- **`cross_repo=true`** on `get_blast_radius` / `find_references` — finds consumers in other indexed repos

#### Token Budget Discipline
- `assemble_task_context(token_budget=4000)` for focused tasks
- `get_context_bundle(token_budget=6000, budget_strategy="core_first")` for multi-symbol context
- `search_symbols(token_budget=3000)` with `detail_level="compact"` for broad discovery (15 tokens/row)
- Always check `_meta.tokens_used` / `_meta.tokens_remaining` in responses
