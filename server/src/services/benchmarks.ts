import { getDb } from '../db/index.js';
import { fetchLiveBenchmarkScores, BenchmarkFetchResult } from '../db/benchmark-scores.js';

export interface BenchmarkScore {
  modelId: string;
  platform: string;
  score: number;
  source: 'SWE-bench' | 'HumanEval' | 'MMLU' | 'NIM';
  lastUpdated: Date;
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

  // Available benchmark sources
  private sources: BenchmarkSource[] = [
    {
      name: 'SWE-bench',
      apiUrl: 'https://huggingface.co/datasets/princeton-nlp/SWE-bench-lite/resolve/main/swe_bench_lite_leaderboard.json',
      rateLimit: 60 // requests per minute
    },
    {
      name: 'NIM Self-Hosted',
      apiUrl: 'http://localhost:3000/api/benchmarks', // Self-hosted NIMStats instance
      rateLimit: 120 // requests per minute
    },
    {
      name: 'NIM External',
      apiUrl: 'https://nimstats.maurodruwel.be/api/v1/benchmarks',
      rateLimit: 60 // requests per minute
    }
  ];

  async fetchSWEBenchScores(): Promise<BenchmarkScore[]> {
    try {
      const response = await fetch(this.sources[0].apiUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const data = await response.json();

      // Handle the SWE-bench data format
      return (data as any[]).map((item: any) => ({
        modelId: item.model,
        platform: this.extractPlatform(item.model),
        score: this.normalizeScore(item.score),
        source: 'SWE-bench' as const,
        lastUpdated: new Date()
      }));
    } catch (error) {
      console.error('Failed to fetch SWE-bench scores:', error);
      throw error;
    }
  }

  async fetchNIMBenchmarks(): Promise<BenchmarkScore[]> {
    const results: BenchmarkScore[] = [];

    // Try self-hosted first
    try {
      const scores = await this.fetchFromSource(this.sources[1].name, this.sources[1].apiUrl);
      results.push(...scores);
    } catch (error) {
      console.warn('Self-hosted NIMStats not available, trying external:', (error as Error).message);

      // Fallback to external
      try {
        const scores = await this.fetchFromSource(this.sources[2].name, this.sources[2].apiUrl);
        results.push(...scores);
      } catch (fallbackError) {
        console.warn('External NIMStats also not available:', (fallbackError as Error).message);
      }
    }

    return results;
  }

  private async fetchFromSource(sourceName: string, apiUrl: string): Promise<BenchmarkScore[]> {
    try {
      const response = await fetch(apiUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      // Handle NIMStats data format
      if ((data as any)?.models && Array.isArray((data as any).models)) {
        return (data as any).models.map((model: any) => ({
          modelId: model.id,
          platform: this.extractPlatform(model.id),
          score: this.normalizeScore(model.score || 0),
          source: 'NIM' as const,
          lastUpdated: new Date()
        }));
      }

      // Fallback for different response formats
      if (Array.isArray(data)) {
        return (data as any[]).map((item: any) => ({
          modelId: item.model || item.id,
          platform: this.extractPlatform(item.model || item.id),
          score: this.normalizeScore(item.score || item.accuracy || 0),
          source: 'NIM' as const,
          lastUpdated: new Date()
        }));
      }

      throw new Error(`Unexpected data format from ${sourceName}`);
    } catch (error) {
      throw new Error(`${sourceName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private normalizeScore(score: number): number {
    // Keep scores in [0, 100] range for database storage.
    // intelligenceComposite() expects benchmark_score in [0, 100].
    if (score <= 1) {
      // Score is in [0, 1] range (e.g., 0.85 = 85%), convert to [0, 100]
      return Math.min(100, Math.max(0, score * 100));
    }
    // Score is already in [0, 100] range, clamp to valid bounds
    return Math.min(100, Math.max(0, score));
  }

  private extractPlatform(modelId: string): string {
    const parts = modelId.split('/');
    return parts.length > 1 ? parts[0] : 'unknown';
  }

  async updateAllBenchmarkScores(): Promise<{ updated: number; errors: string[] }> {
    const errors: string[] = [];
    let totalUpdated = 0;

    try {
      // Step 1: Fetch live scores from Artificial Analysis (existing system)
      console.log('[Benchmarks] Starting live benchmark fetch from AA...');
      const aaResult = await fetchLiveBenchmarkScores(getDb());

      if (aaResult.errors.length > 0) {
        errors.push('Artificial Analysis failed: ' + aaResult.errors.join(', '));
      } else if (aaResult.updated > 0) {
        console.log(`[Benchmarks] AA updated ${aaResult.updated} models`);
        totalUpdated += aaResult.updated;
      }

      // Step 2: Fetch SWE-bench scores for supplement
      try {
        console.log('[Benchmarks] Fetching SWE-bench scores...');
        const sweBenchScores = await this.fetchSWEBenchScores();

        // Update SWE-bench scores (only for models that don't have AA scores yet)
        const db = getDb();
        let sweUpdated = 0;

        for (const score of sweBenchScores) {
          const existing = db.prepare(`
            SELECT benchmark_score FROM models
            WHERE platform = ? AND model_id = ? AND benchmark_score IS NULL
          `).get(score.platform, score.modelId);

          if (existing) {
            db.prepare(`
              UPDATE models
              SET benchmark_score = ?, last_benchmark_update = ?
              WHERE platform = ? AND model_id = ?
            `).run(score.score, score.lastUpdated.toISOString(), score.platform, score.modelId);
            sweUpdated++;
          }
        }

        if (sweUpdated > 0) {
          console.log(`[Benchmarks] SWE-bench added scores for ${sweUpdated} models`);
          totalUpdated += sweUpdated;
        }
      } catch (sweError) {
        console.warn('[Benchmarks] SWE-bench fetch failed:', sweError);
        errors.push('SWE-bench failed: ' + (sweError instanceof Error ? sweError.message : 'Unknown error'));
      }

      // Step 3: Fetch NIM scores with fallback (for NIM provider models)
      try {
        console.log('[Benchmarks] Fetching NIM scores...');
        const nimBenchmarks = await this.fetchNIMBenchmarks();

        // Update NIM scores (only for NIM models that don't have scores yet)
        const db = getDb();
        let nimUpdated = 0;

        for (const score of nimBenchmarks) {
          const existing = db.prepare(`
            SELECT benchmark_score FROM models
            WHERE platform = ? AND model_id = ? AND benchmark_score IS NULL
          `).get(score.platform, score.modelId);

          if (existing) {
            db.prepare(`
              UPDATE models
              SET benchmark_score = ?, last_benchmark_update = ?
              WHERE platform = ? AND model_id = ?
            `).run(score.score, score.lastUpdated.toISOString(), score.platform, score.modelId);
            nimUpdated++;
          }
        }

        if (nimUpdated > 0) {
          console.log(`[Benchmarks] NIM added scores for ${nimUpdated} models`);
          totalUpdated += nimUpdated;
        }
      } catch (nimError) {
        console.warn('[Benchmarks] NIM fetch failed:', nimError);
        errors.push('NIM failed: ' + (nimError instanceof Error ? nimError.message : 'Unknown error'));
      }

      console.log(`[Benchmarks] Total benchmark update completed: ${totalUpdated} models updated`);
      return { updated: totalUpdated, errors };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      errors.push('General error: ' + errorMessage);
      console.error('Error updating benchmark scores:', errorMessage);
      return { updated: 0, errors };
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
             last_benchmark_update as lastUpdated
      FROM models
      WHERE benchmark_score IS NOT NULL
      ORDER BY benchmark_score DESC
    `).all();

    return rows.map((row: any) => ({
      modelId: row.modelId,
      platform: row.platform,
      score: row.score,
      source: 'SWE-bench' as const, // Default source, can be enhanced
      lastUpdated: new Date(row.lastUpdated)
    }));
  }

  async getScoresByPlatform(platform: string): Promise<BenchmarkScore[]> {
    const db = getDb();
    const rows = db.prepare(`
      SELECT model_id as modelId, benchmark_score as score,
             last_benchmark_update as lastUpdated
      FROM models
      WHERE platform = ? AND benchmark_score IS NOT NULL
      ORDER BY benchmark_score DESC
    `).all(platform);

    return rows.map((row: any) => ({
      modelId: row.modelId,
      platform,
      score: row.score,
      source: 'SWE-bench' as const,
      lastUpdated: new Date(row.lastUpdated)
    }));
  }
}
