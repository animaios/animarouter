import type Database from 'better-sqlite3';
import { getDb } from './index.js';

/**
 * Benchmark-derived intelligence scores for LLM models.
 *
 * Source: Artificial Analysis Intelligence Index v4.0 (served/default mode,
 * cross-references from live AA API. Score range [0, 100] where higher
 * = smarter. 0 = no published score (unknown/stealth model).
 *
 * This mirrors the tier bands from V17:
 *   Frontier ≥45  ·  Large 26–44  ·  Medium 13–25  ·  Small ≤12
 *
 * FORMAT: [model_id_pattern (lowercase, LIKE match), score]
 *
 * The applyBenchmarkScores() function runs on every boot (idempotent UPDATE).
 * This ensures newly auto-synced models
 * from any provider pick up their score automatically.
 */

// ─── CANONICAL MODEL KEY ──────────────────────────────────────────────────
// Deterministic, source-agnostic model key normalization. Used for ALL
// benchmark source matching via canonical_model_key.
//
// Algorithm:
//   1. Take last segment after '/' (strip provider prefix)
//   2. Lowercase
//   3. Remove common fine-tune suffixes (-instruct, -chat, -base, etc.)
//   4. Replace dots with dashes (3.3 → 3-3)
//
// canonicalizeModelId('meta/llama-3.3-70b-instruct') === 'llama-3-3-70b'
export function canonicalizeModelId(modelId: string): string {
  // Per spec R10.2: exact algorithm from TASKS.md Task 1.2
  return modelId
    .toLowerCase()
    .replace(/^[a-z0-9-]+\//, '')       // strip "provider/" prefix
    .replace(/[-_]/g, '-')              // normalize separators
    .replace(/-(instruct|chat|it|hf)$/, '')  // strip common suffixes
    .replace(/\.(\d+)(?=\D|$)/g, '-$1'); // normalize version dots
}

// ─── SOURCE WEIGHT LOADING (with in-memory cache) ─────────────────────────
// Loads configurable weights from the benchmark_source_weights DB table.
// Cached in memory; call invalidateSourceWeightsCache() to refresh.
interface SourceWeight {
  name: string;
  weight: number;
  enabled: boolean;
}

let sourceWeightsCache: Map<string, SourceWeight> | null = null;

export function invalidateSourceWeightsCache(): void {
  sourceWeightsCache = null;
}

export function loadSourceWeights(): Map<string, SourceWeight> {
  if (sourceWeightsCache) return sourceWeightsCache;

  const db = getDb();
  const rows = db.prepare(
    'SELECT name, weight, enabled FROM benchmark_source_weights'
  ).all() as Array<{ name: string; weight: number; enabled: number }>;

  sourceWeightsCache = new Map();
  for (const r of rows) {
    sourceWeightsCache.set(r.name, {
      name: r.name,
      weight: r.weight,
      enabled: r.enabled === 1,
    });
  }
  return sourceWeightsCache;
}

// ─── STALENESS DECAY ──────────────────────────────────────────────────────
// Continuous exponential decay: weight = pow(0.5, ageDays / 10).
// NOT a step function. A score from 10 days ago weighs 50 %; 20 days = 25 %.
export function stalenessDecay(updatedIso: string | null | undefined): number {
  if (!updatedIso) return 0;
  const ms = new Date(updatedIso).getTime();
  if (!Number.isFinite(ms)) return 0; // bad date string → treat as missing
  const ageMs = Date.now() - ms;
  if (ageMs < 0) return 1; // future timestamp → treat as fresh
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, ageDays / 10);
}

// ─── CANARY VALIDATION ────────────────────────────────────────────────────
// Rejects NaN, Infinity, <0, >100 composites. Invalid → logged + skipped.
export function validateComposite(score: number): boolean {
  if (!Number.isFinite(score)) return false;
  if (score < 0 || score > 100) return false;
  return true;
}

// ─── RECOMPUTE BENCHMARK COMPOSITE (incremental) ─────────────────────────
// Only processes rows in affectedIds. For each:
//   1. Load per-source scores + staleness decay
//   2. Apply source weights from benchmark_source_weights
//   3. Weighted average → benchmark_score
//   4. Canary-validate before writing
export function recomputeBenchmarkComposite(
  db: Database.Database,
  affectedIds: Set<number>,
  weights: Map<string, SourceWeight>,
): number {
  let recomputed = 0;

  const select = db.prepare(`
    SELECT id, aa_score, aa_score_updated, aa_confidence
    FROM models WHERE id = ?
  `);

  const update = db.prepare(`
    UPDATE models SET
      benchmark_score = ?,
      last_benchmark_update = ?,
      size_label = ?,
      intelligence_rank = ?,
      benchmark_composite_version = ?
    WHERE id = ?
  `);

  const tx = db.transaction(() => {
    for (const id of affectedIds) {
      const row = select.get(id) as any;
      if (!row) continue;

      let totalWeightedScore = 0;
      let totalWeight = 0;

      // Helper: effective weight with staleness decay + confidence
      const effectiveWeight = (
        baseWeight: number,
        updatedIso: string | null,
        confidence: number | null,
        sourceName: string,
      ): number => {
        const decay = stalenessDecay(updatedIso);
        const conf = confidence ?? 1;
        const w = baseWeight * decay * conf;
        // R9.3: Log when decay reduces weight by >25% relative to base
        if (decay < 0.75 && baseWeight > 0) {
          console.log(
            `[Benchmarks] Staleness decay applied: model id=${id}, source=${sourceName}` +
            `, decay=${decay.toFixed(2)}, effectiveWeight=${w.toFixed(3)}`
          );
        }
        return w;
      };

      // AA source
      const aaW = weights.get('aa');
      if (aaW?.enabled && row.aa_score != null) {
        const w = effectiveWeight(aaW.weight, row.aa_score_updated, row.aa_confidence, 'aa');
        totalWeightedScore += row.aa_score * w;
        totalWeight += w;
      }

      // (SWE-rebench and NIMStats purged — only AA is used as intelligence source)

      if (totalWeight <= 0) continue; // no valid sources (R4.4)

      const composite = totalWeightedScore / totalWeight;

      // Canary: reject NaN, Infinity, <0, >100 (R8.1b)
      if (!validateComposite(composite)) {
        console.warn(`[Benchmarks] Invalid composite for model id=${id}: ${composite} — skipping`);
        continue;
      }

      const lastUpdate = row.aa_score_updated;

      update.run(
        composite,
        lastUpdate,
        scoreToTier(composite),
        scoreToIntelligenceRank(composite),
        1, // COMPOSITE_VERSION
        id,
      );
      recomputed++;
    }
  });
  tx();

  if (recomputed > 0) {
    console.log(`[Composite] Recomputed ${recomputed} benchmark composites`);
  }
  return recomputed;
}

type BenchmarkRow = [string, number]; // [model_id_pattern, aa_index_score]

// ─── BENCHMARK SCORE TABLE ──────────────────────────────────────────────────
// Patterns are matched via canonical_model_key lookup.
// Order matters for overlapping patterns — more specific patterns should
// come first (e.g. 'gemini-3.1-pro%' before 'gemini-3%').
const BENCHMARK_SCORES: BenchmarkRow[] = [
  // ── Frontier (AA ≥ 45) ──
  ['%kimi-k2.6%', 58],
  ['%kimi-k2.5%', 54],
  ['%kimi-k2-thinking%', 55],
  ['%deepseek-v4-pro%', 60],
  ['%deepseek-v4-flash%', 55],
  ['%glm-5.1%', 52],
  ['%glm-5%', 48],
  ['%minimax-m2.7%', 56],
  ['%qwen3.6-max%', 57],
  ['%qwen-3.6-max%', 57],
  ['%qwen3.6-plus%', 42],
  ['%qwen3-coder-next%', 46],
  ['%qwen3-coder%480b%', 44],
  ['%gemini-3.1-pro%', 60],
  ['%gemini-3.5-flash%', 55],
  ['%gemini-3-flash%', 48],
  ['%gpt-4.1%', 52],
  ['%gpt-5%', 55],

  // ── Large (AA 26–44) ──
  ['%minimax-m2.5%', 40],
  ['%minimax-m3%', 38],
  ['%qwen3-next-80b%', 44],
  ['%qwen-3-235b%', 42],
  ['%qwen3-235b%', 42],
  ['%gpt-oss-120b%', 38],
  ['%gpt-oss:120b%', 38],
  ['%glm-4.7%', 42],
  ['%glm-4.7-flash%', 39],
  ['%nemotron-3-super%', 36],
  ['%nemotron-3-120b%', 36],
  ['%nemotron-3-ultra%', 40],
  ['%gemini-2.5-pro%', 35],
  ['%deepseek-v3.2%', 32],
  ['%deepseek-v3.1%', 28],
  ['%trinity-large%', 32],
  ['%mistral-medium%', 35],
  ['%magistral-medium%', 33],
  ['%gemma-4-31b%', 39],
  ['%gemma4:31b%', 39],
  ['%gemma-4-26b%', 31],
  ['%gemini-3.1-flash-lite%', 34],
  ['%step-3.7-flash%', 35],
  ['%step-3.5-flash%', 30],
  ['%command-a-03-2025%', 30],
  ['%command-r-plus%', 28],

  // ── Medium (AA 13–25) ──
  ['%qwen3-30b%', 25],
  ['%qwen3-32b%', 25],
  ['%mistral-large%', 23],
  ['%gpt-oss-20b%', 22],
  ['%gpt-oss:20b%', 22],
  ['%gpt-oss-safeguard-20b%', 18],
  ['%glm-4.5-air%', 23],
  ['%glm-4.5-flash%', 20],
  ['%glm-4.6v-flash%', 24],
  ['%devstral%', 22],
  ['%deepseek-r1-distill%', 17],
  ['%llama-4-maverick%', 18],
  ['%llama-4-scout%', 14],
  ['%llama-3.3-70b%', 14],
  ['%llama-3.1-70b%', 14],
  ['%llama-3.3-70b-instruct-fp8-fast%', 14],
  ['%gemini-2.5-flash%', 21],
  ['%gemini-2.5-flash-lite%', 17],
  ['%gpt-4o%', 17],
  ['%nemotron-3-nano%', 15],
  ['%nemotron-nano-9b%', 13],
  ['%nemotron-nano-12b-v2-vl%', 16],
  ['%north-mini-code%', 18],
  ['%command-r-08-2024%', 7],
  ['%moonshotai/kimi-k2.6%', 58],
  ['%moonshotai/kimi-k2.5%', 54],

  // ── Small (AA ≤ 12) ──
  ['%llama-3.1-8b%', 9],
  ['%llama3.1-8b%', 9],
  ['%meta-llama-3.1-8b%', 9],
  ['%gemma-3-12b%', 9],
  ['%ministral-8b%', 8],
  ['%granite-4.0-h-micro%', 6],
  ['%lfm-2.5-1.2b%', 3],
  ['%codestral%', 8],

  // ── Stealth / No Score ──
  // Cogito, Owl Alpha, Poolside Laguna, big-pickle, dolphin-mistral,
  // Hermes 3 (text tool calls not structured) — no published AA score.
  // They stay NULL (benchmark_score = 0 treated as "unscored").
];

// ─── TIER DERIVATION ────────────────────────────────────────────────────────
// Map an AA Intelligence Index score to the same tier bands the router uses.
// This lets auto-synced models land in the right tier without manual curation.
export const TIER_BANDS = {
  frontier: 45,
  large: 26,
  medium: 13,
  // small = everything below 13
} as const;

export function scoreToTier(score: number): string {
  if (score >= TIER_BANDS.frontier) return 'Frontier';
  if (score >= TIER_BANDS.large) return 'Large';
  if (score >= TIER_BANDS.medium) return 'Medium';
  return 'Small';
}

// ─── INTELLIGENCE RANK FROM SCORE ───────────────────────────────────────────
// Convert a benchmark score [0,100] into an intelligence_rank [1,100].
// Lower rank = smarter (the convention the DB uses). We invert so
// score 60 → rank 1, score 3 → rank 97. Clamped to [1,100].
export function scoreToIntelligenceRank(score: number): number {
  // Invert: higher score → lower (better) rank.
  // Score 60 gets rank 1, score 0 gets rank 100 (worst).
  // Use a simple linear mapping with offset so even a score of 60
  // doesn't compete with hand-tuned rank-1 models.
  // Formula: rank = max(1, 101 - score)
  return Math.max(1, Math.min(100, Math.round(101 - score)));
}

// ─── PATTERN LOOKUP ─────────────────────────────────────────────────────────
// Given a model_id, find the best matching benchmark score.
// Returns 0 if no pattern matches (unknown model).
export function lookupBenchmarkScore(modelId: string): number {
  const lower = modelId.toLowerCase();
  // First match wins (the table is ordered specific → general)
  for (const [pattern, score] of BENCHMARK_SCORES) {
    const sqlPattern = pattern.replace(/%/g, '');
    // SQL LIKE semantics: % matches any sequence, _ matches one char.
    // We use a simpler approach: check if the model_id contains the
    // pattern stripped of % wildcards.
    if (lower.includes(sqlPattern)) {
      return score;
    }
  }
  return 0; // unknown — will leave benchmark_score as NULL
}

// ─── DB APPLICATION ─────────────────────────────────────────────────────────
/**
 * Apply benchmark scores to every model that matches a known pattern.
 * Runs on every boot (idempotent UPDATE).
 *
 * Also auto-sets size_label and intelligence_rank for models that have
 * benchmark_score populated but still carry the default "Custom" or empty
 * tier label — this is the key value: auto-synced models get realistic
 * intelligence metadata without manual curation.
 */
export function applyBenchmarkScores(db: Database.Database): void {
  // Ensure the column exists (defensive — the migration should have added it)
  const columns = db.prepare('PRAGMA table_info(models)').all() as { name: string }[];
  if (!columns.some(c => c.name === 'benchmark_score')) return;

  // Backfill canonical_model_key for any models missing it
  backfillCanonicalKeys(db);

  // Write AA scores to aa_score column (NOT benchmark_score directly).
  // Uses canonical_model_key for exact matching.
  const updateAAScore = db.prepare(`
    UPDATE models SET aa_score = ?, aa_score_updated = ?, aa_confidence = 1.0
    WHERE canonical_model_key = ?
      AND (aa_score IS NULL OR aa_score != ?)
  `);

  const apply = db.transaction(() => {
    for (const [pattern, score] of BENCHMARK_SCORES) {
      // Strip SQL LIKE wildcards to derive the canonical key
      const canonicalKey = canonicalizeModelId(pattern.replace(/%/g, ''));
      updateAAScore.run(score, new Date().toISOString(), canonicalKey, score);
    }
  });
  apply();
}

// ─── CANONICAL KEY BACKFILL ────────────────────────────────────────────────
// Populates canonical_model_key for all models that don't have one yet.
export function backfillCanonicalKeys(db: Database.Database): number {
  const rows = db.prepare('SELECT id, model_id FROM models WHERE canonical_model_key IS NULL').all() as
    Array<{ id: number; model_id: string }>;

  const update = db.prepare('UPDATE models SET canonical_model_key = ? WHERE id = ?');
  let count = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      update.run(canonicalizeModelId(r.model_id), r.id);
      count++;
    }
  });
  tx();
  if (count > 0) console.log(`[Canonical] Backfilled ${count} model keys`);
  return count;
}

// ─── LIVE FETCH (Artificial Analysis leaderboard) ──────────────────────────
// Attempts to fetch the latest AA leaderboard JSON and upserts any new scores.
// Runs on boot after the static table, and can be called from a cron/sync
// endpoint. Gracefully degrades on network failure — the static table still
// provides coverage for ~95% of the catalog.

const AA_LEADERBOARD_URL = 'https://artificialanalysis.ai/leaderboards/models/intelligence/overall';
const AA_API_URL = 'https://artificialanalysis.ai/api/leaderboards/intelligence';

// Simple in-memory cache so we don't re-fetch on every boot within a short window.
let lastFetchTime = 0;
let lastFetchResult: { updated: number; errors: string[] } = { updated: 0, errors: [] };
const FETCH_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

export interface BenchmarkFetchResult {
  updated: number;
  errors: string[];
  source: 'cache' | 'live' | 'skipped' | 'static';
}

/**
 * Fetch live AA scores from Artificial Analysis and update the DB.
 * AA writes ONLY to aa_score, aa_score_updated, aa_confidence.
 * Uses canonical_model_key for matching. Returns affected IDs for composite.
 *
 * Resilience (spec boot-benchmark-fixes R2, R4):
 *   - 404 → graceful fallback to static BENCHMARK_SCORES table (no error surfaced)
 *   - Single retry on 5xx or network errors (2 s delay)
 *   - 10 s AbortController timeout (unchanged)
 */
export async function fetchAAScores(db: Database.Database): Promise<BenchmarkFetchResult & { affectedIds: Set<number> }> {
  const affectedIds = new Set<number>();

  // Return cached result if recently fetched
  if (Date.now() - lastFetchTime < FETCH_CACHE_TTL_MS && lastFetchResult.updated >= 0) {
    return { ...lastFetchResult, source: 'cache', affectedIds };
  }

  // Retry loop: up to 2 attempts (1 retry on 5xx / network errors)
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const res = await fetch(AA_API_URL, {
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'AnimaRouter/1.0 (benchmark sync)',
        },
      });

      clearTimeout(timeout);

      if (!res.ok) {
        // ── R2: 404 → static fallback (not an error) ──────────────────────
        if (res.status === 404) {
          console.warn('[Benchmarks] AA fetch: 404, falling back to static scores');
          applyBenchmarkScores(db);
          const staticCount = BENCHMARK_SCORES.length;
          lastFetchResult = { updated: staticCount, errors: [] };
          lastFetchTime = Date.now();
          return { ...lastFetchResult, source: 'static', affectedIds };
        }

        // 5xx → retryable; 4xx (other than 404) → terminal error
        if (res.status >= 500 && attempt === 0) {
          console.warn(`[Benchmarks] AA fetch: ${res.status} — retrying in 2 s`);
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }

        const bodySnippet = await res.text().catch(() => '<unreadable>');
        const msg = `AA API returned ${res.status}: ${bodySnippet.slice(0, 80)}`;
        lastFetchResult = { updated: 0, errors: [msg] };
        lastFetchTime = Date.now();
        return { ...lastFetchResult, source: 'live', affectedIds };
      }

      const body = await res.json() as any;
      const models = Array.isArray(body) ? body : (body?.models ?? body?.data ?? []);

      if (!Array.isArray(models) || models.length === 0) {
        lastFetchResult = { updated: 0, errors: ['No models in AA response'] };
        lastFetchTime = Date.now();
        return { ...lastFetchResult, source: 'live', affectedIds };
      }

      // AA writes ONLY to aa_score columns. Uses canonical_model_key.
      const updateScore = db.prepare(`
        UPDATE models SET aa_score = ?, aa_score_updated = ?, aa_confidence = 1.0
        WHERE canonical_model_key = ?
          AND (aa_score IS NULL OR aa_score != ?)
      `);

      const findId = db.prepare('SELECT id FROM models WHERE canonical_model_key = ?');

      let updated = 0;
      const tx = db.transaction(() => {
        for (const m of models) {
          const modelId = m.model_id ?? m.id ?? m.name ?? '';
          const score = Number(m.score ?? m.intelligence_index ?? m.intelligence_score ?? 0);
          if (!modelId || score <= 0 || score > 100) continue;

          const canonicalKey = canonicalizeModelId(modelId);
          const result = updateScore.run(score, new Date().toISOString(), canonicalKey, score);
          if (result.changes > 0) {
            updated += result.changes;
            const row = findId.get(canonicalKey) as { id: number } | undefined;
            if (row) affectedIds.add(row.id);
          }
        }
      });
      tx();

      lastFetchResult = { updated, errors: [] };
      lastFetchTime = Date.now();
      console.log(`[Benchmarks] AA fetch: ${updated} models updated`);

      return { ...lastFetchResult, source: 'live', affectedIds };
    } catch (err: any) {
      clearTimeout(timeout);

      // AbortError = timeout → retryable on first attempt
      const isTimeout = err.name === 'AbortError';
      const isNetwork = err.cause?.code === 'ECONNRESET'
        || err.cause?.code === 'ENOTFOUND'
        || err.cause?.code === 'ECONNREFUSED'
        || err.message?.includes('fetch failed');

      if (attempt === 0 && (isTimeout || isNetwork || err.cause)) {
        const reason = isTimeout ? 'timeout' : err.message;
        console.warn(`[Benchmarks] AA fetch: ${reason} — retrying in 2 s`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      const msg = isTimeout ? 'timeout' : err.message;
      console.log(`[Benchmarks] AA fetch failed: ${msg} (static table still active)`);
      lastFetchResult = { updated: 0, errors: [msg] };
      lastFetchTime = Date.now();
      return { ...lastFetchResult, source: 'live', affectedIds };
    }
  }

  // Unreachable, but TypeScript needs a return
  lastFetchResult = { updated: 0, errors: ['AA fetch exhausted retries'] };
  lastFetchTime = Date.now();
  return { ...lastFetchResult, source: 'live', affectedIds };
}
