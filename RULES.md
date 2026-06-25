# Repository Rules — AnimaRouter

> **Audience:** AI agents + human maintainers. Follow these rules exactly. Order matters.
> 
> **Last updated:** 2026-06-20

---

## 0. Agent SOP — Planning, Delegation & Review

When your task involves writing or modifying source code, follow this loop.
For read-only tasks (exploration, questions, debugging), skip to step 1 only.

### Step 1: Analyze & Plan

Understand the request, then explore the codebase with jcodemunch:

1. `plan_turn(repo="api-llm-local", query="...")` — opening move. Returns confidence + recommended symbols.
2. `search_symbols` — find exact symbols involved.
3. `get_blast_radius(symbol="...", depth=2)` — understand downstream impact before planning.
4. `get_hotspots` / `find_dead_code` — identify risk areas related to the task.
5. `get_class_hierarchy(class_name="...")` — understand inheritance if relevant.
6. `get_dependency_graph(file="...", direction="imports")` — map module boundaries.

Break the work into the smallest logical, incremental steps. Do not rush.

### Step 2: Delegate ONE Step

Formulate a prompt for `spawn_agent`. Delegate only the immediate next step — never bundle multiple steps.

Include in every delegation prompt:
- **The repo identifier:** `api-llm-local`
- **Target symbol_ids** the subagent needs to read or modify.
- **The jcodemunch mandate:** instruct the subagent to use jcodemunch tools for all code
  lookup — `get_file_outline` before reading any file, `search_symbols`/`get_symbol_source`
  instead of reading whole files, `get_context_bundle`/`get_ranked_context` for task-driven context.
- **A token budget** when using context assembly tools to keep prompts focused.
- **Full context:** `spawn_agent` is stateless and knows nothing from previous turns.
  Pass everything it needs — never assume it remembers prior steps.

Example delegation preamble:
```
You are working in repo "api-llm-local" (indexed via jcodemunch-mcp).
Mandatory: use jcodemunch tools for ALL code lookup.
- get_file_outline before pulling source
- search_symbols / get_symbol_source for targeted retrieval
- Batch with symbol_ids[] instead of repeated calls
- get_ranked_context(query="...", token_budget=4000) for task-driven context

Target symbols: <list symbol_ids>
```

### Step 3: Review the Result

After the subagent returns, verify with jcodemunch:

1. `get_blast_radius(symbol="...", include_source=true)` — confirm impact matches expectations.
2. `find_references(identifier="...")` — verify no call site is broken.
3. `get_call_hierarchy(symbol_id="...", direction="callers")` — trace upstream dependents.
4. `get_symbol_source(symbol_id="...", verify=true)` — confirm indexed source matches what was written.
5. `register_edit(file_paths=["..."], reindex=true)` — keep the index fresh.
6. Run `npm run test` to verify nothing is broken.

If the step is satisfactory, move to the next step (return to step 2).
If revision is needed, delegate again with the symbol_ids, current state, and corrective feedback.
Never fix code yourself — always delegate.

---

## 1. Repository Identity

| Role | URL |
|---|---|
| **Your fork** (origin) | `https://github.com/MLuqmanBR/api-gateway.git` |
| **Upstream** (original) | `https://github.com/tashfeenahmed/freellmapi.git` |

```
upstream/main  ←  the canonical upstream. Never commit here directly.
origin/main    ←  deployable: upstream mirror + all custom features merged in.
origin/feat/*  ←  one branch per custom feature.
test/combined  ←  integration scratchpad: merges all feat/* for testing.
```

---

## 1. Branch Architecture

### 1.1 Branch Purposes

| Branch | Purpose | Upstream tracking? | Direct commits? |
|---|---|---|---|
| `main` | Mirror of `upstream/main` | Yes | ❌ NEVER |
| `feat/<name>` | One custom feature | No (rebased on main) | ✅ Yes |
| `test/combined` | Integration of all `feat/*` | No | ❌ Merge only |

### 1.2 Naming Convention

Feature branches: `feat/<short-descriptive-slug>`

```
feat/lan-auto-grant              ← good
feat/custom-providers-redesign   ← good
feat/dark-mode                   ← good
custom-stuff                     ← bad (no prefix)
feature/new-thing                ← bad (wrong prefix)
```


### 1.4 Features currently on main

All custom features have been merged to `main`. The `feat/*` branches are kept as
historical snapshots. New features should follow the branch architecture in §1.1.

Key features deployed on main:

- Custom providers (CRUD, auto-discovery, rate limits, parallel gating)
- Model editing for all models (built-in and custom)
- /v1/models filtering (only models with active keys)
- Per-key exhaustion recovery (3-retry + 1-RPM recovery mode)
- LAN auto-trust (loopback/RFC1918 callers skip login)
- CLI management tool (`api start`, `api stop`, etc.)
- Encrypted key storage and unified API key auth

### 1.5 What Lives Where


| Code | Where |
|---|---|
| Upstream code (unchanged) | `main` |
| Your custom features (individual) | `feat/*` branches |
| All features merged for testing | `test/combined` |
| Deployable production code | `main` (after merge from test/combined) |

**Key rule:** `main` IS the deployable branch. It contains upstream + all custom features.
This means after testing on `test/combined`, merge everything into `main` and deploy from `main`.

---

## 2. Creating a New Feature

### Step-by-step

```bash
# 1. Ensure main is up to date with upstream
git checkout main
git fetch upstream
git merge upstream/main          # should be fast-forward

# 2. Create feature branch from main
git checkout -b feat/my-feature

# 3. Implement the feature
# ... make changes, commit often ...

# 4. Push to your fork
git push -u origin feat/my-feature

# 5. Integrate into test/combined
git checkout test/combined
git merge feat/my-feature
# resolve any conflicts with other feat/* branches
git push origin test/combined

# 6. Test the integration
npm run test
npm run dev                       # manual smoke test
```

### Commit Message Format

```
<type>(<scope>): <description>

feat(auth): LAN auto-grant for loopback/RFC1918 callers
feat(providers): custom providers as first-class platform objects
fix(router): handle null tool_calls on assistant echoes
docs(readme): document custom provider setup
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`

### Feature Isolation Rules

1. **One concern per branch.** Don't mix unrelated features. If your change touches auth AND providers, split into two branches.
2. **New files are your friends.** The less you modify existing upstream files, the less merge conflicts you'll have.
3. **Prefer extension over modification.** Add new routes in new files. Use middleware/decorator patterns. Don't rewrite upstream functions.
4. **If you must modify an upstream file, minimize the diff.** Change only what you need, exactly where you need it.

---

## 3. Syncing from Upstream (Critical)

### When to Sync

- **Weekly** — minimum. Set a calendar reminder.
- **Before starting any new feature** — always.
- **When upstream releases something you need** — immediately.
- **After noticing a large number of upstream commits** — don't let divergence accumulate.

### How to Check if You're Behind

```bash
git fetch upstream
git log --oneline main..upstream/main
# If output appears → you're behind → sync NOW
```

### Full Sync Procedure

```bash
# === PHASE 1: Update main ===
git checkout main
git fetch upstream
git merge upstream/main
# This merges upstream/main into your local main.
# It MUST be a fast-forward. If it's not, investigate.
git push origin main

# === PHASE 2: Rebase each feature branch ===
# Do this ONE branch at a time. Resolve fully before moving to the next.

# For feat/lan-auto-grant:
git checkout feat/lan-auto-grant
git rebase main
# Resolve conflicts if any → git add . → git rebase --continue
# Run tests
npm run test
# Push (force is needed because rebase rewrites history)
git push --force-with-lease origin feat/lan-auto-grant

# For feat/custom-providers-redesign:
git checkout feat/custom-providers-redesign
git rebase main
# Resolve conflicts if any → git add . → git rebase --continue
npm run test
git push --force-with-lease origin feat/custom-providers-redesign

# === PHASE 3: Rebuild test/combined ===
git checkout test/combined
git reset --hard main
git merge feat/lan-auto-grant
git merge feat/custom-providers-redesign
# Resolve cross-feature conflicts if any
npm run test
git push --force-with-lease origin test/combined
```

### ❌ NEVER Do This

```bash
# NEVER merge upstream into a feature branch
git checkout feat/my-feature
git merge upstream/main          # ❌ BAD — creates merge commits, destroys rebaseability

# NEVER merge upstream into test/combined
git checkout test/combined
git merge upstream/main          # ❌ BAD — same reason

# NEVER commit directly to main
git checkout main
# ... make changes ...           # ❌ BAD — main is upstream mirror only
git commit -m "fix stuff"        # ❌ BAD
```

### ✅ Always Do This

```bash
git checkout main
git merge upstream/main          # ✅ fast-forward only
git rebase main feat/my-feature  # ✅ linear history
git checkout test/combined
git reset --hard main            # ✅ clean rebuild
git merge feat/my-feature        # ✅ clean integration
```

---

## 4. Conflict Resolution Guide

### 4.0 The Golden Rules (Learned the Hard Way)

These rules come from solving 11 real conflicts across 2 branches during a
single rebase session. Follow them in order.

1. **NEVER overwrite entire files from old commits.** Old versions lack upstream
   changes. Use targeted `edit` operations instead. Full-file overwrites
   cost 9+ test failures and hours of recovery.

2. **When upstream MOVES code between files, follow the move.** If upstream
   extracts migrations from `db/index.ts` → `db/migrations.ts`, YOUR migrations
   must move too. Don't fight the refactor — embrace it.

3. **Rebase ONE branch at a time.** Resolve completely before touching the next.
   Mixing rebase sessions is how features get lost.

4. **After every conflict resolution, run tests BEFORE `rebase --continue`.**
   Finding a SQL ambiguity at commit-time is painful; finding it after the
   whole rebase is done is catastrophic.

5. **Cherry-pick is NOT a reliable strategy across upstream refactors.**
   Old commits reference old file structures. Cherry-pick works when the
   target files haven't been moved or significantly rewritten. When they have,
   reconstruct the feature manually with targeted edits.

6. **`git checkout --ours/--theirs` is dangerous during rebase.** The meaning
   flips: `--ours` = the branch you're rebasing ONTO (main), `--theirs` =
   the commits being applied (your feature). Double-check with `git status`
   and confirm which version you actually want.

7. **Preserve upstream additions in shared files.** If upstream added a field
   like `reasoning_content` to `ChatMessage`, your rebased `types.ts` must
   keep it. Overwriting with an old version silently removes upstream features.

8. **Push after every completed task.** Commits left local-only are lost on
   disk failure, session switch, or machine change. After any significant
   work that passes tests: `git push origin main` (or the current branch).

9. **Never set git credentials globally.** Use `git config user.email` (without
   `--global`) so credentials stay scoped to this project directory. This fork
   uses a noreply GitHub address. Personal credentials should never leak into
   commit metadata outside their own repos.

10. **Never commit API keys, tokens, or secrets.** Not in migrations, not in config
    files, not in scripts committed to git. Use one-time import scripts that are
    deleted immediately after running. The DB file (`server/data/`) is gitignored
    — secrets live there encrypted, not in source.

11. **INSERT OR IGNORE needs a companion UPDATE for corrections.** If you add a
    migration that inserts data, also add UPDATE statements for fields that might
    change between runs (RPM limits, model properties, size labels). Otherwise a
    re-run silently skips stale values.

12. **When adding custom providers, verify every property after migration.** Check
    RPM limits, parallel gating, model size labels, intelligence ranks, context
    windows, and max output tokens against the source config. A single typo or
    omission (e.g., a source config has parallel disabled but the migration sets
    a concurrency limit) breaks behavior silently.

13. **Providers with similar names may be completely different services.** Always
    verify the actual provider configuration (base URL, credential format, auth
    method) before assuming. Multi-field credentials (e.g., account ID + API key)
    map to a combined key format with colon separation — the UI already handles
    such cases through platform-specific input fields.

### 4.1 Conflict Hotspots (files you modify that upstream also touches)

| File | Your Features Touching It | Risk Level |
|---|---|---|
| `server/src/app.ts` | BOTH features | 🔴 HIGH |
| `server/src/db/index.ts` | custom-providers-redesign | 🔴 HIGH |
| `server/src/db/migrations.ts` | custom-providers-redesign (indirect) | 🔴 HIGH |
| `server/src/providers/index.ts` | custom-providers-redesign | 🟡 MEDIUM |
| `server/src/services/router.ts` | custom-providers-redesign | 🟡 MEDIUM |
| `shared/types.ts` | custom-providers-redesign | 🟡 MEDIUM |
| `server/src/routes/keys.ts` | custom-providers-redesign | 🟡 MEDIUM |
| `server/src/middleware/requireAuth.ts` | lan-auto-grant | 🟢 LOW |
| `server/src/routes/auth.ts` | lan-auto-grant | 🟢 LOW |
| `client/src/App.tsx` | lan-auto-grant | 🟢 LOW |

### 4.2 New Files You Added (zero conflict risk)

```
server/src/routes/custom.ts       ← custom-providers-redesign
server/src/lib/ip-trust.ts        ← lan-auto-grant
server/src/__tests__/routes/custom-providers.test.ts
server/src/__tests__/routes/requireAuth.test.ts
```

### 4.3 Decision Framework: How to Resolve ANY Conflict

When you see `<<<<<<< HEAD ... >>>>>>>` markers, don't guess. Apply this framework.

#### Step 1: Classify the conflict

| Category | What it looks like | Decision |
|---|---|---|
| **Upstream MOVED code** (same logic, different file) | Your change is in `foo.ts` but upstream deleted that section and recreated it in `bar.ts` | Accept upstream's file deletion. Port your change to `bar.ts`. |
| **Upstream ADDED code near yours** (adjacent, non-overlapping) | Your change at line 50, upstream added something at line 48 | Keep both. The auto-merge usually handles this. |
| **Upstream ADDED code OVER your code** (same lines) | Both you and upstream modified the same function signature | Merge manually: keep upstream's new parameter AND your new parameter. |
| **Upstream REMOVED what you modified** | Upstream deleted a function you patched | Your feature's hook point no longer exists. Rethink: can you attach elsewhere? |
| **Your ADDITION to shared types** | You added a field to an interface, upstream added a different field | Keep BOTH fields. Never drop upstream additions. |

#### Step 2: Choose a strategy

```
┌──────────────────────────────────────────────────────────┐
│                    Conflict Strategy                      │
├─────────────┬────────────────────┬───────────────────────┤
│  Upstream   │   Your change is   │      Decision         │
│  change     │   in the same spot │                       │
├─────────────┼────────────────────┼───────────────────────┤
│ Moved file  │       Yes          │  Follow the move      │
│ New param   │   No (diff lines)  │  Merge both           │
│ New param   │       Yes          │  Merge manually       │
│ Deleted fn  │       Yes          │  Find new hook point  │
│ New field   │   No (diff field)  │  Keep both            │
└─────────────┴────────────────────┴───────────────────────┘
```

#### Step 3: Apply the resolution

- **Targeted edits ONLY.** Never `git checkout --ours/--theirs` blindly. Never copy
  old file versions wholesale. Use the edit tool to change only conflicting lines.
- **Test after EVERY resolution.** Not at the end. After each `git rebase --continue`,
  run `npm test -w server`. If 468 → 459, you know EXACTLY which resolution broke it.

#### Step 4: Common sub-patterns

**Pattern A: Upstream extracted code to a new file**

Your feature modified code that upstream moved from `file-a.ts` → `file-b.ts`.

1. Accept upstream's version of `file-a.ts` (deletion of your code)
2. Port your change to `file-b.ts` at the equivalent location
3. If `file-b.ts` didn't exist before (your feature never touched it), add your
   change as a new edit to that file

> *Example from 2026-06-08: Upstream moved all migrations from `db/index.ts` →
> `db/migrations.ts`. Our custom_providers migration was ported from the old file
> to the new one as a CREATE TABLE + function + call in migrateDbSchema().*

**Pattern B: Both you and upstream modified the same function**

1. Read the conflict block. Identify which lines are upstream's and which are yours.
2. Keep upstream's new logic AND your new logic.
3. If the edits touch the same expression (e.g., different function calls in the
   same assignment), evaluate: can both coexist? If yes, merge. If no, your feature
   may need to adapt to upstream's new API.

> *Example from 2026-06-08: Upstream added a TPM budget guard before provider
> resolution. Our feature replaced `getProvider()` with `buildProviderFor()`.
> Both changes were on adjacent lines — kept both.*

**Pattern C: SQL query with JOIN introduces column ambiguity**

Adding a JOIN to an existing SQL query is risky because:
1. Both tables may have an `id` column → ambiguous in ORDER BY
2. Table-qualified columns (`m.id`) don't survive into outer scopes of subqueries

Use `EXISTS` subqueries instead of JOINs for filtering:
```sql
-- ✅ SAFE: no column ambiguity
FROM models m
WHERE m.enabled = 1
  AND EXISTS (SELECT 1 FROM other_table o WHERE o.ref_id = m.id AND o.active = 1)
```

**Pattern D: Shared types file gained upstream fields**

Upstream added a field to an interface you also modified. If you overwrite the file,
you silently drop the upstream field. Tests for that field will fail.

Always: `git diff upstream/main -- shared/types.ts` before committing to verify
no upstream fields were removed.

### 4.4 Full Rebase Workflow

```bash
# === PHASE 1: Update main ===
git checkout main
git fetch upstream
git merge upstream/main
git push origin main

# === PHASE 2: Rebase each feature (ONE AT A TIME) ===
# Start with the simplest feature (least conflicts) as a warm-up.
git checkout feat/<simple-one>
git rebase main
# Resolve conflicts if any, test, push:
npm run test -w server
git push --force-with-lease origin feat/<simple-one>

# Then do the complex one:
git checkout feat/<complex-one>
git rebase main
# Expect conflicts. For each:
#   1. Classify per §4.3 Step 1
#   2. Choose strategy per §4.3 Step 2
#   3. Resolve with targeted edits per §4.3 Step 3
#   4. git add → git rebase --continue → npm test
git push --force-with-lease origin feat/<complex-one>

# Repeat for all feat/* branches.

# === PHASE 3: Rebuild integration branch ===
git checkout test/combined
git reset --hard main
git merge feat/<simple-one>
npm run test -w server
git merge feat/<complex-one>
npm run test -w server
git push --force-with-lease origin test/combined

# === PHASE 4: Apply uncommitted session work ===
# If you have new features on test/combined that aren't in any feat/* branch:
# Apply them as targeted edits (NEVER file overwrites).
# Commit in logical groups, testing after each commit.
npm run test -w server

# === PHASE 5: Deploy to main ===
git checkout main
git merge test/combined
git push origin main
```

### 4.5 Conflict Resolution Checklist

When rebase pauses for conflict:

```
□ git status                        — see conflicted files
□ git diff --name-only --diff-filter=U  — just the filenames
□ For each conflicted file:
  □ Classify per §4.3 Step 1 (moved? adjacent? deleted? shared type?)
  □ Choose strategy per §4.3 Step 2
  □ Apply resolution with TARGETED edits (not file overwrites)
  □ Remove conflict markers
  □ For SQL changes: use EXISTS not JOIN to avoid column ambiguity
  □ For type changes: verify no upstream fields were dropped
□ git add <resolved files>
□ git diff --cached                  — review what you're about to commit
□ git rebase --continue
□ npm run test -w server              — MUST PASS before pushing
□ If tests fail:
  □ Read the error carefully (the test output tells you what's wrong)
  □ Common post-rebase errors:
    - "ambiguous column name" → SQL JOIN added ambiguity; switch to EXISTS
    - "no such column: m.id" → table alias in outer ORDER BY
    - "expected 500 to be 200" → likely SQL syntax error (check stderr)
    - "property X missing" → upstream addition dropped from shared types
  □ Fix → git add → git commit --amend → continue
```

---

## 5. Testing

### 5.1 Run Tests After Every Significant Change

```bash
# Full test suite
npm run test

# Server only
npm run test -w server

# Client only
npm run test -w client --if-present
```

### 5.2 Manual Smoke Test

```bash
# Start dev server + client
npm run dev

# Verify:
# 1. Dashboard loads on LAN (lan-auto-grant feature)
# 2. Custom providers page works (custom-providers feature)
# 3. Send a chat request through the proxy
```

### 5.3 Test After Upstream Sync (Mandatory)

```
After rebase:
  □ npm run test -w server    — all tests pass (currently 468, 43 test files)
  □ npm run dev               — manual smoke test
  □ If ANYTHING fails → DO NOT PUSH → fix first
  □ Common failure patterns after upstream sync:
    - /v1/models tests fail with 500 → SQL query broken (ambiguous columns)
    - proxy retry tests fail → upstream added new retry helpers; your proxy.ts
      overwrote them. Restore proxy.ts and re-apply your changes with edits.
    - router tests fail → upstream changed RouteResult/routeRequest signature.
      Check for new parameters (skipModels?) and add them to your code.
```

---

## 6. Before Committing: Self-Check

```
□ Am I on a feat/* branch or test/combined? (not pushing to main directly)
□ Did I fetch upstream and check if I'm behind?
  → git fetch upstream && git log --oneline main..upstream/main
□ Did I write tests for new behavior?
□ Did I run the full test suite? (npm run test -w server, expect 468 passing)
□ Is my commit message in conventional commit format?
□ Does my change touch a file that upstream modifies?
  → If yes: Am I prepared for a conflict at next rebase?
  → If yes: Did I minimize my diff footprint on that file?
□ If I edited SQL queries: did I test with an in-memory DB?
  → In-memory DB has seeded models + fallback_config + api_keys from tests.
□ If I edited shared/types.ts: did I preserve all upstream type fields?
  → Compare with: git diff upstream/main -- shared/types.ts
□ If this is a rebase resolution: did I run tests BEFORE git rebase --continue?
```

---

## 7. Quick Reference Commands

```bash
# Check status
git fetch upstream
git log --oneline main..upstream/main    # commits upstream has that you don't
git log --oneline upstream/main..main    # (should be empty — main == upstream)

# List all feature branches
git branch | grep feat/

# See what a feature branch changes vs upstream
git diff upstream/main...feat/lan-auto-grant --stat
git diff upstream/main...feat/custom-providers-redesign --stat

# Full sync (when behind upstream)
git checkout main && git merge upstream/main && git push origin main
git checkout feat/lan-auto-grant && git rebase main && npm test && git push --force-with-lease origin feat/lan-auto-grant
git checkout feat/custom-providers-redesign && git rebase main && npm test && git push --force-with-lease origin feat/custom-providers-redesign
git checkout test/combined && git reset --hard main && git merge feat/lan-auto-grant feat/custom-providers-redesign && npm test && git push --force-with-lease origin test/combined

# Create new feature
git checkout main && git fetch upstream && git merge upstream/main
git checkout -b feat/new-feature
# ... implement ...
git push -u origin feat/new-feature

# Add new feature to test/combined
git checkout test/combined
git merge feat/new-feature
npm test
git push origin test/combined
# Set git credentials (project-only, never --global)
git config user.name "MLuqmanBR"
git config user.email "57311290+MLuqmanBR@users.noreply.github.com"

# Push after completing work
git push origin main
``` (Don't Do These)

| Anti-Pattern | Why It's Bad | What Actually Happened |
|---|---|---|
| `git merge upstream/main` into a feat branch | Creates merge commits. Rebase instead. | — |
| Multiple features in one branch | Can't rebase independently. Can't revert one without the other. | — |
| Committing to main directly | main must stay identical to upstream/main. | — |
| `push --force` on main | Destroys upstream tracking. Use `--force-with-lease` on feat/* only. | — |
| Skipping tests after rebase | Conflicts can silently break things. | Skipped tests, got 11 failures later |
| Letting divergence accumulate >2 weeks | Each week of delay = more conflicts to resolve at once. | 23 commits behind → complex migration refactor |
| Copying upstream files into feat branches | Rebase handles this. Copying = duplication hell. | — |
| Squashing feature commits into one during rebase | Keep granular commits within the feature branch. | — |
| **Cherry-picking old commits after upstream refactor** | Old commits reference old file structures (e.g., `db/index.ts` when migrations moved to `db/migrations.ts`). Cherry-pick hits conflicts that are harder to resolve than a rebase. | Cherry-pick of 7bb4280 hit 2 conflicts immediately. Switched to manual reconstruction. |
| **Overwriting entire files from old versions** | Old files lack upstream additions. Overwriting `proxy.ts` with an old version wiped out V25 retry helpers and `reasoning_content` support. 11 test failures. | Took 3 rounds of restore + edit to recover. |
| **`git checkout --theirs` during rebase without understanding direction** | During rebase, `--theirs` = the feature branch being applied, `--ours` = main (the base). Easy to pick the wrong side. | Accidentally used `--theirs` thinking it was main. Had to `rebase --abort` and restart. |
| **Using JOIN instead of EXISTS for filtering in SQL subqueries** | JOIN introduces column ambiguity when both tables have `id` columns. EXISTS avoids the ambiguity entirely. | `ambiguous column name: id` error in /v1/models query. Fixed by switching JOIN → EXISTS. |
| **Replacing shared type files wholesale** | `shared/types.ts` has fields added by upstream (e.g., `reasoning_content`). Overwriting removes them silently. | `reasoning_content` test failed after overwrite. |
| **Not testing between consecutive rebase resolutions** | If you resolve conflict 1, continue, hit conflict 2, and only test at the end — you won't know WHICH resolution broke things. | — |
| **Committing API keys to git (even in migrations)** | Keys in source code leak to GitHub on push. Even if you delete the file later, it's in git history forever. | — |
| **INSERT OR IGNORE without companion UPDATE** | First run inserts correct data. Second run skips silently, leaving stale values from the first run. Broken RPM limits and wrong model sizes persist until you notice. | A model showed wrong size label after migration re-ran. A provider had mismatched parallel gating config. |
| **Not verifying provider config against source** | Source config had different settings than migration assumptions. Silent mismatch until manually caught. | Provider parallel gating was wrong until caught during review. |
| **Changing UI to batch-save pattern but leaving stale mutation refs** | JSX still referenced removed mutation hooks. React crashes with "is not defined" and the component goes black. | Component broke completely until stale refs were removed. |
| **Adding models but forgetting to update provider lookup** | `hasProvider()` only checked the built-in provider map. Custom providers added programmatically weren't found, breaking tests and API responses. | Tests failed because custom providers were invisible to the lookup function. |


---

## 8. Tooling & Workflow

### 8.1 CLI Management Tool

The project ships a CLI tool (`scripts/cli.mjs`) installed via `npm link`.
Commands:

```
api start [--port <N>]    Start server (builds only if needed)
api stop [--port <N>]     Stop a specific instance
api stop --all            Stop all instances
api restart               Stop then start (uses .env PORT)
api status                Show running instances
api list                  List all instances across ports
api build                 Force rebuild
api logs                  Tail server.log
api help                  Show help
```

The CLI tracks instances via `.animarouter.instances` (gitignored). Multiple
instances on different ports are supported. The `api` command is registered
via the `bin` field in `package.json` — run `npm link` after cloning to
activate it globally.

### 8.2 Build & Dev Loop

```bash
npm run dev           # server :3001, dashboard :5173 (HMR)
npm run build         # production build
npm test              # full test suite
npm run build -w server  # server only
```

### 8.3 Environment Configuration

`.env` (gitignored) controls runtime behavior. Key variables:

| Variable | Purpose |
|---|---|
| `ENCRYPTION_KEY` | 64-char hex key for API key encryption (required) |
| `PORT` | Server port (default 3001) |
| `ANIMAROUTER_CONTEXT_HANDOFF` | Enable context handoff (`on_model_switch`) |
| `REQUEST_ANALYTICS_RETENTION_DAYS` | Analytics retention (default 90) |
| `REQUEST_ANALYTICS_MAX_ROWS` | Max analytics rows (default 100000) |

See `.env.example` for the full commented template.

### 8.4 Adding CLI Commands

New CLI commands follow the pattern in `scripts/cli.mjs`:
1. Add a handler function (e.g., `function doThing() { ... }`)
2. Add a branch in `main()` that matches the subcommand
3. Use `parseFlags()` for any `--option` flags

Keep the CLI self-contained — no external dependencies beyond Node.js built-ins.
---

## 9. Project-Specific Notes

### 9.1 Known Integration Points

These are the files where custom features intersect with upstream code. When upstream
modifies these files, expect conflicts.

| File | Why it conflicts |
|---|---|
| `server/src/app.ts` | Multiple features mount middleware/routers. New upstream routes will overlap. |
| `server/src/db/migrations.ts` | Custom tables and migrations live alongside upstream ones. Upstream refactors affect placement. |
| `server/src/providers/index.ts` | Custom provider resolution (`buildProviderFor`) replaces upstream's lookup. |
| `server/src/services/router.ts` | Request routing modified for custom providers and parallel gating. |
| `shared/types.ts` | Custom interfaces add fields; upstream adds fields too. Both must survive. |
| `server/src/routes/proxy.ts` | /v1/models query customized; proxy error handling adds release() call. |

**General principle:** When upstream adds code near your hooks, merge both. When upstream
moves where code lives, follow the move.

### 9.2 Custom Migration Naming

Name your migrations to not collide with upstream numbering. If upstream has
`migrateModelsV24`, `migrateModelsV25`, yours could be `migrateCustomProvidersV24`.
The function names don't need to match upstream's sequence — they just need to be
called from `migrateDbSchema()` in the right order.

If upstream creates a function with the same name as yours, rename your function.
The name doesn't affect behavior — only the call site in `migrateDbSchema()` matters.

### 9.3 Custom Database Tables

Any tables you add (e.g., `custom_providers`) are **only in your fork**. Upstream will
never create or migrate them. When upstream refactors the migration system (extracting
functions to new files, renaming init patterns), your custom tables and migrations must
follow the same pattern.

**General rule for custom migrations:**
1. CREATE TABLE goes in the same function that creates upstream tables (currently
   `createTables()` in `db/migrations.ts`).
2. Column additions use `ensure*` pattern so existing DBs get new columns on restart.
3. Data migrations (backfills, renames) go as a function called from the migration
   orchestrator (`migrateDbSchema()`).

If upstream moves where migrations live, move yours too. The file location and function
name may change; the pattern stays the same.

### 9.4 General Architecture Principles

**Resource pooling:** Gating (rate limits, concurrency) should be at the appropriate
level. Currently parallel requests are provider-level, not model-level, because all
models under one provider share the same upstream endpoint capacity.

**Cleanup contracts:** Any resource acquired during routing (slots, locks, connections)
must have a paired release in a `finally` block. Both proxy and responses routes follow
this pattern.

**Dynamic config:** Operational limits (max parallel, rpm/tpm) are read from the database
at request time, not cached. This means dashboard changes take effect immediately.

**Testability:** Custom provider auto-discovery skips in test environments (`VITEST` env
var) to avoid timeouts from unreachable fake URLs. Follow the same pattern for any new
network-dependent feature.

**Exhaustion retry architecture:** The retry system has three layers:
1. **Per-key 3-retry** (immediate): Same key retried up to 3 times for transient
   errors (429, timeouts). Dead-turn errors (in-band errors, empty completions,
   stream stalls) skip immediately — retrying the same key won't help.
2. **Key cycling** (exhaustion order): When a key exhausts after 3 failures, the
   router cycles to the next available key. Exhausted keys are tracked in-memory
   and rebuilt from DB cooldowns on restart. Keys are tried in exhaustion-time
   order (earliest exhausted first) so the key with the longest recovery window
   gets the first chance.
3. **1-RPM recovery mode** (global retry limit): When ALL keys for a pinned model
   (or ALL models in auto mode) are exhausted, the system throttles to 1 request
   per minute and cycles through exhausted keys. The global retry limit (1-100 or
   0=∞) controls how many recovery cycles to attempt before giving up. A single
   successful request clears the exhaustion and restores normal operation.

The 1-RPM throttle is purely in-memory — the model's DB `rpm_limit` is never
changed. This means switching models mid-recovery immediately uses the new model's
configured RPM.

**Queued edits pattern:** When multiple UI changes (model edits, slider, sort order)
can be pending simultaneously, batch them behind a single FloatingBar "Save changes"
button. Each change type stores to local state, and the save handler fires all
mutations in sequence. Discard reverts everything. This avoids:
- Mid-edit API calls that leave partial state
- Multiple overlapping mutations racing
- Sliders that fire an API call on every pixel of drag

**Custom provider hasProvider fix:** `hasProvider()` originally only checked the
built-in provider map. Custom providers added via `custom_providers` table weren't
found, breaking the idempotency test and `/api/models` response. Fix: check
`custom_providers` table as a fallback:
```ts
export function hasProvider(platform: Platform): boolean {
  if (providers.has(platform)) return true;
  return !!db.prepare('SELECT 1 FROM custom_providers WHERE slug = ?').get(platform);
}
```

---

## 10. Emergency Recovery

### "I messed up a rebase"

```bash
# Abort the rebase
git rebase --abort

# Your branch is back to where it was before the rebase.
# Try again, slower this time. Follow §4.4 exactly.
```

### "I force-pushed wrong to main"

```bash
# Reset main to upstream's version
git checkout main
git fetch upstream
git reset --hard upstream/main
git push --force-with-lease origin main

# Then redo the merge from test/combined:
git checkout test/combined
git reset --hard main
git merge feat/lan-auto-grant
git merge feat/custom-providers-redesign
# Re-apply session features from §4.4 Phase 4
npm test
git checkout main && git merge test/combined && git push origin main
```

### "test/combined is broken after merge"

```bash
# Rebuild from scratch
git checkout main
git fetch upstream && git merge upstream/main
git checkout test/combined
git reset --hard main
git merge feat/lan-auto-grant
npm test                                  # If passes:
git merge feat/custom-providers-redesign
npm test                                  # If passes, re-apply session features
```

### "I accidentally committed to main"

```bash
# If not yet pushed:
git reset HEAD~1
git stash
git checkout -b feat/recovered-feature
git stash pop

# If already pushed (worse):
git reset --hard upstream/main
git push --force-with-lease origin main
```

### "I overwrote a file with an old version and tests are broken"

```bash
# Restore the file to the pre-overwrite state
git checkout HEAD -- path/to/file

# Re-apply your changes with targeted edits (NOT overwrite)
# See §4.3 Conflict 4 for the types.ts example
```

### "The rebase editor opened and I don't know what to do"

```bash
# The editor is asking for a commit message. Skip it:
GIT_EDITOR=true git rebase --continue

# Or set it globally:
git config --global core.editor true
```

## 11. Case Study: The 2026-06-08 Rebase (Full War Story)

> This section captures the actual sequence of events, mistakes, recoveries,
> and lessons from a major rebase session. Read it before attempting any
> non-trivial upstream sync.

### The Situation

- **Upstream:** 23 commits ahead (from `d42380b` to `3acd45a`)
- **Custom features to preserve:**
  1. `feat/lan-auto-grant` (1 commit, clean)
  2. `feat/custom-providers-redesign` (1 commit, complex)
  3. Session features on `test/combined`: parallel gating, auto-discovery,
     model editing, /v1/models filter, RULES.md
- **Main upstream change:** All migrations extracted from `db/index.ts` →
  `db/migrations.ts`. Model catalog refreshed (V24 Zen, V25 dead promos).

### The Plan

1. Update `main` to upstream HEAD
2. Rebase `feat/lan-auto-grant` on main (expected: clean)
3. Rebase `feat/custom-providers-redesign` on main (expected: conflicts)
4. Rebuild `test/combined` from main + rebased feature branches
5. Apply session features on top of test/combined
6. Merge to main

### What Actually Happened

#### Round 1: feat/lan-auto-grant ✅
```bash
git rebase main          # Clean. Zero conflicts.
npm test                 # All 468 passed.
```

#### Round 2: feat/custom-providers-redesign — First Attempt
```bash
git rebase main          # 2 conflicts: db/index.ts, services/router.ts
```

**Mistake 1: Used `--theirs` thinking it was main's version**
```bash
git checkout --theirs server/src/db/index.ts   # ❌ Got OLD feature version
git add server/src/db/index.ts
```
Realized the error, aborted: `git rebase --abort`

**Mistake 2: Tried cherry-picking session commits**
```bash
git cherry-pick 7bb4280   # ❌ Conflict in db/index.ts (old structure)
git cherry-pick --abort
```
Lesson: cherry-pick doesn't work when target files have been refactored.

**Mistake 3: Overwrote files from old test/combined**
```bash
git show e83e0f8:server/src/routes/proxy.ts > server/src/routes/proxy.ts
# ... same for responses.ts, router.ts, fallback.ts, custom.ts, types.ts, etc.
npm test   # 11 FAILURES! Upstream V25 features wiped out.
```

**Recovery:**
```bash
git checkout HEAD -- server/src/routes/proxy.ts server/src/routes/responses.ts server/src/services/router.ts
# Now re-apply changes with TARGETED edits, not file overwrites:
# - proxy.ts: add fc.enabled EXISTS, route.release(), fix SQL ambiguity
# - router.ts: add in-flight tracking, tryReserveSlot, release
# - responses.ts: add route.release() finally
npm test   # 11 → 2 failures
```

#### Round 3: Fixing the 2 Remaining Failures

Both in `proxy-auto-model.test.ts`:
```
[Error] ambiguous column name: id
→ Fixed: m.id AS id in SELECT, changed JOIN to EXISTS

[Error] no such column: m.id
→ Fixed: removed m.id from outer ORDER BY (use unqualified id)

npm test   # 468 passed ✅
```

#### Round 4: Missing reasoning_content

After types.ts was restored, `reasoning_content` was missing from ChatMessage
(dropped during the old-file overwrite). Manually re-added:
```typescript
reasoning_content?: string;  // DeepSeek thinking traces, upstream #255
```

#### Round 5: Commit and Merge

```bash
git add .
git commit -m "feat: parallel gating, auto-discovery, model editing, /v1/models filter"
npm test   # 468 passed ✅
git checkout main
git merge test/combined   # Fast-forward
git push origin main
```

### Key Takeaways

1. **Rebase is the right approach** but requires patience and file-by-file precision.
2. **Targeted edits > file overwrites** — always. One wrong overwrite costs hours.
3. **Test after every resolution** — finding bugs early saves debug time.
4. **EXISTS > JOIN** for SQL subqueries — no column ambiguity.
5. **Cherry-pick is fragile** — only use when target files haven't been refactored.
6. **The rebase direction matters** — `--ours` = main (base), `--theirs` = feature (applied).
7. **Preserve upstream additions** — especially in shared types files.


## 12. Credential Import

When migrating credentials from another tool or config file, follow the
one-time import pattern to avoid leaking secrets into git history.

### 12.1 Never Commit Secrets

API keys, tokens, and account IDs must NEVER appear in committed files. The
`server/data/` directory (which contains the SQLite DB with encrypted keys)
is gitignored. Any secret-containing scripts must be deleted immediately
after use.

### 12.2 One-Time Import Script Pattern

Write a throwaway script that reads credentials from your source, encrypts
them, and inserts them into the database. The pattern:

1. Import `initDb` and `encrypt` from the server modules
2. Define your credentials as a plain array (never commit this)
3. Insert each credential with `INSERT OR IGNORE` to avoid duplicates
4. Run the script once, then delete it immediately

```ts
// scripts/import-keys.ts — RUN ONCE, DELETE IMMEDIATELY
import { initDb } from '../server/src/db/index.js';
import { encrypt } from '../server/src/lib/crypto.js';

const KEYS = [
  { platform: 'openrouter', label: 'Key 1', value: 'sk-or-v1-...' },
  // ... all keys ...
];

const db = initDb();
const insertKey = db.prepare(`
  INSERT OR IGNORE INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
  VALUES (?, ?, ?, ?, ?, 'healthy', 1)
`);

for (const { platform, label, value } of KEYS) {
  const { encrypted, iv, authTag } = encrypt(value);
  insertKey.run(platform, label, encrypted, iv, authTag);
}
```

Run with `npx tsx scripts/import-keys.ts`, then `rm scripts/import-keys.ts`.

### 12.3 Multi-Field Credentials

Some providers require more than one credential field (e.g., account ID +
API key, or project ID + token). AnimaRouter handles these with a colon-
separated combined format. The "Add a provider key" form in the dashboard
automatically shows multiple input fields for platforms that need them.

When importing programmatically, join the fields with a colon before
encrypting: `encrypt(accountId + ':' + apiKey)`.

### 12.4 Post-Import Verification

```bash
sqlite3 server/data/api-gateway.db \
  "SELECT platform, COUNT(*) FROM api_keys WHERE enabled=1 GROUP BY platform ORDER BY COUNT(*) DESC"
```

Compare counts against the source config to verify every credential was imported.
---

## 13. Select Component Positioning (Base UI)

This project uses `@base-ui/react` Select, not Radix UI. The dropdown popup
is rendered via `SelectPrimitive.Portal` to `document.body` with a
`SelectPrimitive.Positioner` that anchors to the trigger element.

### 13.1 Common Positioning Issues

| Symptom | Cause | Fix |
|---|---|---|
| Dropdown appears detached from trigger | Positioner defaults to `positionMethod="absolute"` which anchors relative to nearest positioned ancestor, not the viewport | Add `positionMethod="fixed"` to `Positioner` |
| Dropdown doesn't follow trigger on scroll | Same cause — absolute positioning doesn't track viewport scroll | Same fix |
| Dropdown renders behind other elements | z-index stacking context issue | Ensure `Positioner` has `className="isolate z-50"` |

### 13.2 The Fix

In `client/src/components/ui/select.tsx`, add to the `Positioner`:
```tsx
<SelectPrimitive.Positioner
  positionMethod="fixed"   // ← anchors to viewport, tracks scroll
  className="isolate z-50" // ← stacks above other content
  ...
>
```

---

*Last updated: 2026-06-10 — CLI management tool, desktop removal, catalog-sync removal, credential import generalized, all custom features merged to main.*
*Features tracked: custom provider CRUD, auto-discovery, model editing, /v1/models filtering, exhaustion recovery, LAN auto-trust, parallel gating, CLI tool, queued edits*