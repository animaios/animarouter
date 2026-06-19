# Benchmark Unification — Kiro-Style Spec (v2 — Post-Review)

**Status:** Final Draft · **Author:** Architect (jCodeMunch-augmented) · **Date:** 2026-06-19

The three benchmark sources — Artificial Analysis, SWE-rebench, and NIMStats — currently
fight each other. This spec defines how they cooperate as a single, coherent
benchmark pipeline.

**v2** incorporates architectural review feedback from three independent reviewers
(ChatGPT, Gemini 3.1 Pro, Claude 4.5 Sonnet). All "Must fix" and "Should fix" items
are addressed. See the change tracking tables in each document for specifics.

## Documents

| File | Purpose |
|------|---------|
| [REQUIREMENTS.md](./REQUIREMENTS.md) | What must be true when we're done (14 requirement groups, R1–R10) |
| [DESIGN.md](./DESIGN.md) | How it works — data model, composite arbitration, canonical keys, incremental recomputation, phased NIM routing |
| [TASKS.md](./TASKS.md) | Ordered, delegable implementation steps (13 tasks across 4 phases + Phase 2 placeholder) |

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Source attribution | Per-source columns, not shared `benchmark_score` | No source can clobber another; provenance is traceable |
| Composite derivation | Weighted average with exponential freshness decay + confidence | Smooth, continuous, no step-function cliffs |
| Weights | DB-configurable, not hardcoded | Runtime tuning without code deploy |
| Model matching | Canonical model key, not `LIKE` | Prevents `llama-3.1-70b` vs `llama-3.1-70b-instruct` collisions |
| Recomputation | Incremental (dirty IDs only), not full table | O(touched) not O(all) |
| NIM routing | **Phase 1:** store + observe only. **Phase 2:** Bayesian blend | De-risk: prove correlation before blending into production bandit |
| Sync concurrency | `isSyncing` mutex | Prevents `SQLITE_BUSY` errors |
| Rollback | Documented down-migration + `COALESCE` safety net | Safe rollback if composite algorithm has bugs |

## Architect's Reading Notes

- **Core file:** `server/src/services/benchmarks.ts` — the `BenchmarkService` class
- **DB patterns:** `server/src/db/benchmark-scores.ts` — static table + live AA fetch
- **Scoring consumer:** `server/src/services/router.ts` → `intelligenceComposite()` and `scoreChainEntry()`
- **Speed axis:** `server/src/services/scoring.ts` → `speedScore()` and `heavyWeightedSpeedScore()`
