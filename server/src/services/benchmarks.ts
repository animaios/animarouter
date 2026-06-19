import { getDb } from '../db/index.js';
import { fetchSWERebenchLeaderboard, normalizeModelName, SWERebenchEntry } from './swe-rebench-parser.js';
import {
  fetchAAScores,
  BenchmarkFetchResult,
  canonicalizeModelId,
  recomputeBenchmarkComposite,
  backfillCanonicalKeys,
  loadSourceWeights,
} from '../db/benchmark-scores.js';

export interface BenchmarkScore {
  modelId: string;
  platform: string;
  score: number;
  source: 'SWE-rebench' | 'HumanEval' | 'MMLU' | 'NIM';
  lastUpdated: Date;
  confidence?: number; // per-source confidence: 1.0 live, 0.6 hardcoded fallback
  // Per-source breakdown
  aaScore?: number | null;
  sweRebenchScore?: number | null;
  nimScore?: number | null;
  // NIM-specific speed/reliability metrics (nullable) — per spec R5.1
  nimThroughputTps?: number | null;
  nimAvgResponseMs?: number | null;
  nimUptimePct?: number | null;
}

export interface BenchmarkSource {
  name: string;
  apiUrl: string;
  apiKey?: string;
  rateLimit: number; // requests per minute
}

export class BenchmarkService {
  private cache = new Map<string, { score: number; timestamp: number }>();
  private readonly CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

  /** Sync mutex — concurrent sync calls are rejected. */
  static isSyncing = false;

  // Available benchmark sources (no self-hosted NIM — purged in V34)
  private sources: BenchmarkSource[] = [
    {
      name: 'SWE-rebench',
      apiUrl: 'https://swe-rebench.com/',
      rateLimit: 60
    },
    {
      name: 'NIM External',
      apiUrl: 'https://nimstats.maurodruwel.be/api/v1/benchmarks',
      rateLimit: 60
    }
  ];

  /**
   * Return SWE-rebench leaderboard scores (resolved rate %).
   *
   * Tries to live-scrape https://swe-rebench.com/ first (HTML is SSR).
   * Falls back to hardcoded scores from the May 2026 window if the fetch fails.
   */
  async fetchSWERebenchScores(): Promise<BenchmarkScore[]> {
    // Try live fetch from the leaderboard page
    try {
      const entries = await fetchSWERebenchLeaderboard();
      const scores = this.entriesToBenchmarkScores(entries);
      if (scores.length > 0) return scores;
    } catch (liveError) {
      console.warn('[SWE-rebench] Live fetch failed, using hardcoded fallback:', (liveError as Error).message);
    }

    // Hardcoded fallback — May 2026 window
    const fallback: Array<[string, number]> = [
      ['gpt-5.5', 62.7],
      ['gpt-5.4', 54.9],
      ['claude-opus-4.8', 56.5],
      ['claude-opus-4.7', 53.1],
      ['claude-sonnet-4.6', 51.3],
      ['claude-opus-4.6', 47.8],
      ['gemini-3.1-pro', 51.1],
      ['gemini-3.5-flash', 49.5],
      ['glm-5.1', 50.7],
      ['kimi-k2.6', 46.5],
      ['minimax-m3', 45.6],
      ['glm-4.7', 38.2],
    ];

    return fallback.map(([modelId, score]) => ({
      modelId,
      platform: this.extractPlatform(modelId),
      score: this.normalizeScore(score),
      source: 'SWE-rebench' as const,
      lastUpdated: new Date(),
      confidence: 0.6, // hardcoded fallback → confidence 0.6 per R2.1b
    }));
  }

  /** Convert parsed SWE-rebench entries into BenchmarkScore objects.
   *  Live scrape → confidence 1.0 per spec R2.1b.
   */
  private entriesToBenchmarkScores(entries: SWERebenchEntry[]): BenchmarkScore[] {
    return entries
      .filter(e => e.resolvedRate > 0)
      .map(entry => {
        const modelId = normalizeModelName(entry.model);
        return {
          modelId,
          platform: this.extractPlatform(modelId),
          score: this.normalizeScore(entry.resolvedRate),
          source: 'SWE-rebench' as const,
          lastUpdated: new Date(),
          confidence: 1.0, // live scrape → confidence 1.0 per R2.1b
        };
      });
  }

  /**
   * Fetch NIM benchmarks from external source only (no self-hosted).
   * Returns scores with speed/reliability metrics for logging (Phase 1 — not blended).
   */
  async fetchNIMBenchmarks(): Promise<BenchmarkScore[]> {
    const source = this.sources[1]; // NIM External
    try {
      const response = await fetch(source.apiUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      // Handle NIMStats data format with speed metrics
      if ((data as any)?.models && Array.isArray((data as any).models)) {
        return (data as any).models.map((model: any) => ({
          modelId: model.id,
          platform: this.extractPlatform(model.id),
          score: this.normalizeScore(model.score || 0),
          source: 'NIM' as const,
          lastUpdated: new Date(),
          nimThroughputTps: model.tps ?? model.tokens_per_second ?? model.throughput_tps ?? null,
          nimAvgResponseMs: model.ttfb_ms ?? model.ttfb ?? model.avg_response_ms ?? null,
          nimUptimePct: model.uptime_pct ?? model.uptime ?? null,
        }));
      }

      // Fallback for different response formats
      if (Array.isArray(data)) {
        return (data as any[]).map((item: any) => ({
          modelId: item.model || item.id,
          platform: this.extractPlatform(item.model || item.id),
          score: this.normalizeScore(item.score || item.accuracy || 0),
          source: 'NIM' as const,
          lastUpdated: new Date(),
          nimThroughputTps: item.tps ?? item.tokens_per_second ?? item.throughput_tps ?? null,
          nimAvgResponseMs: item.ttfb_ms ?? item.ttfb ?? item.avg_response_ms ?? null,
          nimUptimePct: item.uptime_pct ?? item.uptime ?? null,
        }));
      }

      throw new Error(`Unexpected data format from ${source.name}`);
    } catch (error) {
      console.warn(`[NIM] External fetch failed:`, (error as Error).message);
      return [];
    }
  }

  private normalizeScore(score: number): number {
    // Keep scores in [0, 100] range for database storage.
    if (score <= 1) {
      return Math.min(100, Math.max(0, score * 100));
    }
    return Math.min(100, Math.max(0, score));
  }

  private extractPlatform(modelId: string): string {
    const parts = modelId.split('/');
    return parts.length > 1 ? parts[0] : 'unknown';
  }

  /**
   * Fetch and upsert SWE-rebench scores into per-source columns ONLY.
   * SWE writes to: swe_rebench_score, swe_rebench_score_updated, swe_rebench_confidence.
   * Uses canonical_model_key for exact matching.
   * Returns affected model IDs for composite recomputation.
   */
  private async upsertSWERebenchScores(): Promise<{ updated: number; affectedIds: Set<number> }> {
    const affectedIds = new Set<number>();
    const scores = await this.fetchSWERebenchScores();
    const db = getDb();
    let updated = 0;

    const upsert = db.prepare(`
      UPDATE models
      SET swe_rebench_score = ?,
          swe_rebench_score_updated = ?,
          swe_rebench_confidence = ?
      WHERE canonical_model_key = ?
        AND (swe_rebench_score IS NULL OR swe_rebench_score != ?)
    `);

    const findId = db.prepare('SELECT id FROM models WHERE canonical_model_key = ?');

    const tx = db.transaction(() => {
      for (const score of scores) {
        const canonicalKey = canonicalizeModelId(score.modelId);
        const confidence = score.confidence ?? 1.0;
        const result = upsert.run(
          score.score, score.lastUpdated.toISOString(), confidence,
          canonicalKey, score.score
        );
        if (result.changes > 0) {
          updated += result.changes;
          const row = findId.get(canonicalKey) as { id: number } | undefined;
          if (row) affectedIds.add(row.id);
        }
      }
    });
    tx();

    if (updated > 0) {
      console.log(`[Benchmarks] SWE-rebench updated ${updated} models`);
    }
    return { updated, affectedIds };
  }

  /**
   * Fetch and upsert NIM scores into per-source columns ONLY.
   * NIM writes to: nim_score, nim_score_updated, nim_confidence,
   *   nim_throughput_tps, nim_avg_response_ms, nim_uptime_pct.
   * Uses canonical_model_key for matching.
   * Returns affected model IDs for composite recomputation.
   */
  private async upsertNIMScores(): Promise<{ updated: number; affectedIds: Set<number> }> {
    const affectedIds = new Set<number>();
    const scores = await this.fetchNIMBenchmarks();
    const db = getDb();
    let updated = 0;

    const upsert = db.prepare(`
      UPDATE models
      SET nim_score = ?,
          nim_score_updated = ?,
          nim_confidence = 1.0,
          nim_throughput_tps = ?,
          nim_avg_response_ms = ?,
          nim_uptime_pct = ?
      WHERE canonical_model_key = ?
        AND (nim_score IS NULL OR nim_score != ?)
    `);

    const findId = db.prepare('SELECT id FROM models WHERE canonical_model_key = ?');

    const tx = db.transaction(() => {
      for (const score of scores) {
        const canonicalKey = canonicalizeModelId(score.modelId);
        const result = upsert.run(
          score.score, score.lastUpdated.toISOString(),
          score.nimThroughputTps ?? null, score.nimAvgResponseMs ?? null, score.nimUptimePct ?? null,
          canonicalKey, score.score
        );
        if (result.changes > 0) {
          updated += result.changes;
          const row = findId.get(canonicalKey) as { id: number } | undefined;
          if (row) affectedIds.add(row.id);
        }
      }
    });
    tx();

    if (updated > 0) {
      console.log(`[Benchmarks] NIM updated ${updated} models`);
    }
    return { updated, affectedIds };
  }

  /**
   * Update all benchmark scores from all sources in parallel.
   * Uses Promise.allSettled() — partial failures don't block other sources.
   * After all sources complete, recomputes benchmark_score composites
   * for affected rows only (incremental, not full-table scan).
   *
   * Sync mutex: concurrent calls return error immediately.
   */
  async updateAllBenchmarkScores(): Promise<{ updated: number; errors: string[] }> {
    // Sync mutex
    if (BenchmarkService.isSyncing) {
      return { updated: 0, errors: ['Sync already in progress'] };
    }
    BenchmarkService.isSyncing = true;

    const errors: string[] = [];
    let totalUpdated = 0;
    const allAffectedIds = new Set<number>();

    try {
      const db = getDb();

      // Ensure canonical keys are populated
      backfillCanonicalKeys(db);

      // Fetch all sources in parallel using Promise.allSettled()
      console.log('[Benchmarks] Starting parallel benchmark fetch...');
      const results = await Promise.allSettled([
        // AA source
        (async () => {
          console.log('[Benchmarks] Fetching AA scores...');
          const result = await fetchAAScores(db);
          if (result.errors.length > 0) {
            throw new Error('AA: ' + result.errors.join(', '));
          }
          return { name: 'AA', updated: result.updated, affectedIds: result.affectedIds };
        })(),
        // SWE-rebench source
        (async () => {
          console.log('[Benchmarks] Fetching SWE-rebench scores...');
          const result = await this.upsertSWERebenchScores();
          return { name: 'SWE-rebench', updated: result.updated, affectedIds: result.affectedIds };
        })(),
        // NIM source
        (async () => {
          console.log('[Benchmarks] Fetching NIM scores...');
          const result = await this.upsertNIMScores();
          return { name: 'NIM', updated: result.updated, affectedIds: result.affectedIds };
        })(),
      ]);

      // Collect results and errors
      for (const r of results) {
        if (r.status === 'fulfilled') {
          totalUpdated += r.value.updated;
          for (const id of r.value.affectedIds) allAffectedIds.add(id);
        } else {
          errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
        }
      }

      // Recompute composites for affected rows only (incremental)
      if (allAffectedIds.size > 0) {
        const weights = loadSourceWeights();
        recomputeBenchmarkComposite(db, allAffectedIds, weights);
      }

      console.log(`[Benchmarks] Total: ${totalUpdated} models updated, ${allAffectedIds.size} composites recomputed`);
      return { updated: totalUpdated, errors };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      errors.push('General error: ' + errorMessage);
      console.error('Error updating benchmark scores:', errorMessage);
      return { updated: 0, errors };
    } finally {
      BenchmarkService.isSyncing = false;
    }
  }

  private isNewer(newDate: Date, existingDate?: string): boolean {
    if (!existingDate) return true;
    return newDate.getTime() > new Date(existingDate).getTime();
  }

  async getBenchmarkScores(): Promise<BenchmarkScore[]> {
    const db = getDb();
    const rows = db.prepare(`
      SELECT model_id as modelId, platform, benchmark_score as score,
             last_benchmark_update as lastUpdated,
             aa_score as aaScore, swe_rebench_score as sweRebenchScore,
             nim_score as nimScore,
             nim_throughput_tps as nimThroughputTps, nim_avg_response_ms as nimAvgResponseMs, nim_uptime_pct as nimUptimePct
      FROM models
      WHERE benchmark_score IS NOT NULL
      ORDER BY benchmark_score DESC
    `).all();

    return rows.map((row: any) => ({
      modelId: row.modelId,
      platform: row.platform,
      score: row.score,
      source: 'SWE-rebench' as const,
      lastUpdated: row.lastUpdated ? new Date(row.lastUpdated) : new Date(),
      aaScore: row.aaScore,
      sweRebenchScore: row.sweRebenchScore,
      nimScore: row.nimScore,
      nimThroughputTps: row.nimThroughputTps,
      nimAvgResponseMs: row.nimAvgResponseMs,
      nimUptimePct: row.nimUptimePct,
    }));
  }

  async getScoresByPlatform(platform: string): Promise<BenchmarkScore[]> {
    const db = getDb();
    const rows = db.prepare(`
      SELECT model_id as modelId, benchmark_score as score,
             last_benchmark_update as lastUpdated,
             aa_score as aaScore, swe_rebench_score as sweRebenchScore,
             nim_score as nimScore,
             nim_throughput_tps as nimThroughputTps, nim_avg_response_ms as nimAvgResponseMs, nim_uptime_pct as nimUptimePct
      FROM models
      WHERE platform = ? AND benchmark_score IS NOT NULL
      ORDER BY benchmark_score DESC
    `).all(platform);

    return rows.map((row: any) => ({
      modelId: row.modelId,
      platform,
      score: row.score,
      source: 'SWE-rebench' as const,
      lastUpdated: row.lastUpdated ? new Date(row.lastUpdated) : new Date(),
      aaScore: row.aaScore,
      sweRebenchScore: row.sweRebenchScore,
      nimScore: row.nimScore,
      nimThroughputTps: row.nimThroughputTps,
      nimAvgResponseMs: row.nimAvgResponseMs,
      nimUptimePct: row.nimUptimePct,
    }));
  }
}
