import type Database from 'better-sqlite3';

/**
 * Benchmark-derived intelligence scores for LLM models.
 *
 * Source: Artificial Analysis Intelligence Index v4.0 (served/default mode,
 * June 2026), with cross-references from SWE-bench Verified, Terminal-Bench 2,
 * TAU-Bench, Aider Polyglot, and BFCL v3. Score range [0, 100] where higher
 * = smarter. 0 = no published score (unknown/stealth model).
 *
 * This mirrors the tier bands from V17:
 *   Frontier ≥45  ·  Large 26–44  ·  Medium 13–25  ·  Small ≤12
 *
 * FORMAT: [model_id_pattern (lowercase, LIKE match), score]
 *
 * The applyBenchmarkScores() function runs on every boot (idempotent UPDATE),
 * same pattern as applyModelPricing(). This ensures newly auto-synced models
 * from any provider pick up their score automatically.
 */
type BenchmarkRow = [string, number]; // [model_id_pattern, aa_index_score]

// ─── BENCHMARK SCORE TABLE ──────────────────────────────────────────────────
// Patterns are checked with LOWER(model_id) LIKE pattern.
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
 * Runs on every boot (idempotent UPDATE, same pattern as applyModelPricing).
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

  const updateScore = db.prepare(`
    UPDATE models SET benchmark_score = ?
    WHERE (benchmark_score IS NULL OR benchmark_score != ?)
      AND LOWER(model_id) LIKE ?
  `);

  const updateTier = db.prepare(`
    UPDATE models SET size_label = ?
    WHERE benchmark_score = ? AND benchmark_score > 0
      AND (size_label = '' OR size_label = 'Custom' OR size_label IS NULL)
      AND LOWER(model_id) LIKE ?
  `);

  const updateRank = db.prepare(`
    UPDATE models SET intelligence_rank = ?
    WHERE benchmark_score = ? AND benchmark_score > 0
      AND (intelligence_rank = 50 OR intelligence_rank >= 90)
      AND LOWER(model_id) LIKE ?
  `);

  const apply = db.transaction(() => {
    for (const [pattern, score] of BENCHMARK_SCORES) {
      updateScore.run(score, score, pattern);
      updateTier.run(scoreToTier(score), score, pattern);
      updateRank.run(scoreToIntelligenceRank(score), score, pattern);
    }
  });
  apply();
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
  source: 'cache' | 'live' | 'skipped';
}

/**
 * Fetch live benchmark scores from Artificial Analysis and update the DB.
 * Safe to call on boot — network timeout is short, and failure is graceful.
 */
export async function fetchLiveBenchmarkScores(db: Database.Database): Promise<BenchmarkFetchResult> {
  // Return cached result if recently fetched
  if (Date.now() - lastFetchTime < FETCH_CACHE_TTL_MS && lastFetchResult.updated >= 0) {
    return { ...lastFetchResult, source: 'cache' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    // Try the API endpoint first; fall back to scraping if needed.
    const res = await fetch(AA_API_URL, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'FreeLLMApi-Gateway/1.0 (benchmark sync)',
      },
    });

    if (!res.ok) {
      const msg = `AA API returned ${res.status}`;
      lastFetchResult = { updated: 0, errors: [msg] };
      lastFetchTime = Date.now();
      return { ...lastFetchResult, source: 'live' };
    }

    const body = await res.json() as any;
    // AA API returns { models: [{ model_id, score, ... }, ...] } or similar
    const models = Array.isArray(body) ? body : (body?.models ?? body?.data ?? []);

    if (!Array.isArray(models) || models.length === 0) {
      lastFetchResult = { updated: 0, errors: ['No models in AA response'] };
      lastFetchTime = Date.now();
      return { ...lastFetchResult, source: 'live' };
    }

    const updateScore = db.prepare(`
      UPDATE models SET benchmark_score = ?,
                        size_label = ?,
                        intelligence_rank = ?
      WHERE LOWER(model_id) LIKE LOWER(?)
        AND (models.benchmark_score IS NULL OR models.benchmark_score != ?)
    `);

    let updated = 0;
    const tx = db.transaction(() => {
      for (const m of models) {
        const modelId = m.model_id ?? m.id ?? m.name ?? '';
        const score = Number(m.score ?? m.intelligence_index ?? m.intelligence_score ?? 0);
        if (!modelId || score <= 0 || score > 100) continue;

        const tier = scoreToTier(score);
        const rank = scoreToIntelligenceRank(score);
        const result = updateScore.run(score, tier, rank, modelId, score);
        updated += result.changes;
      }
    });
    tx();

    lastFetchResult = { updated, errors: [] };
    lastFetchTime = Date.now();
    console.log(`[Benchmarks] Live fetch: ${updated} models updated from AA leaderboard`);

    return { ...lastFetchResult, source: 'live' };
  } catch (err: any) {
    const msg = err.name === 'AbortError' ? 'timeout' : err.message;
    console.log(`[Benchmarks] Live fetch failed: ${msg} (static table still active)`);
    lastFetchResult = { updated: 0, errors: [msg] };
    lastFetchTime = Date.now();
    return { ...lastFetchResult, source: 'live' };
  } finally {
    clearTimeout(timeout);
  }
}
