import { getDb } from '../db/index.js';
import { fetchAAScores } from '../db/benchmark-scores.js';
import { fetchBenchGeckoScores } from './benchmark-sources/benchgecko.js';
import { fetchAIIQScores } from './benchmark-sources/aiiq.js';
import {
  recomputeBenchmarkComposite,
  backfillCanonicalKeys,
  loadSourceWeights,
  applyManualBenchmarkOverrides,
} from '../db/benchmark-scores.js';

export interface BenchmarkScore {
  modelId: string;
  platform: string;
  score: number;
  source: 'AA' | 'BenchGecko' | 'AIIQ' | 'Composite';
  lastUpdated: Date;
  confidence?: number; // per-source confidence: 1.0 live, 0.6 hardcoded fallback
  // Per-source breakdown
  aaScore?: number | null;
  bgScore?: number | null;
  aiiqScore?: number | null;
}

export class BenchmarkService {
  private cache = new Map<string, { score: number; timestamp: number }>();
  private readonly CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

  /** Sync mutex — concurrent sync calls are rejected. */
  static isSyncing = false;

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
   * Update all benchmark scores from all sources in parallel.
   * AA (Artificial Analysis), BenchGecko, and AI IQ are fetched live via API.
   *
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

        // BenchGecko source
        (async () => {
          console.log('[Benchmarks] Fetching BenchGecko scores...');
          const result = await fetchBenchGeckoScores(db);
          if (result.errors.length > 0) {
            throw new Error('BenchGecko: ' + result.errors.join(', '));
          }
          return { name: 'BenchGecko', updated: result.updated, affectedIds: result.affectedIds };
        })(),

        // AI IQ source
        (async () => {
          console.log('[Benchmarks] Fetching AI IQ scores...');
          const result = await fetchAIIQScores(db);
          if (result.errors.length > 0) {
            throw new Error('AIIQ: ' + result.errors.join(', '));
          }
          return { name: 'AIIQ', updated: result.updated, affectedIds: result.affectedIds };
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

      totalUpdated += applyManualBenchmarkOverrides(db);

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
             aa_score as aaScore,
             bg_score as bgScore,
             aiiq_score as aiiqScore
      FROM models
      WHERE benchmark_score IS NOT NULL
      ORDER BY benchmark_score DESC
    `).all();

    return rows.map((row: any) => ({
      modelId: row.modelId,
      platform: row.platform,
      score: row.score,
      source: 'Composite' as const,
      lastUpdated: row.lastUpdated ? new Date(row.lastUpdated) : new Date(),
      aaScore: row.aaScore,
      bgScore: row.bgScore,
      aiiqScore: row.aiiqScore,
    }));
  }

  async getScoresByPlatform(platform: string): Promise<BenchmarkScore[]> {
    const db = getDb();
    const rows = db.prepare(`
      SELECT model_id as modelId, benchmark_score as score,
             last_benchmark_update as lastUpdated,
             aa_score as aaScore,
             bg_score as bgScore,
             aiiq_score as aiiqScore
      FROM models
      WHERE platform = ? AND benchmark_score IS NOT NULL
      ORDER BY benchmark_score DESC
    `).all(platform);

    return rows.map((row: any) => ({
      modelId: row.modelId,
      platform,
      score: row.score,
      source: 'Composite' as const,
      lastUpdated: row.lastUpdated ? new Date(row.lastUpdated) : new Date(),
      aaScore: row.aaScore,
      bgScore: row.bgScore,
      aiiqScore: row.aiiqScore,
    }));
  }
}
