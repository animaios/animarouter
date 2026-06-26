/**
 * BenchGecko API adapter.
 *
 * Fetches https://benchgecko.ai/api/v1/models and extracts avg_score as
 * the intelligence signal. Maps model slugs to canonical_model_key via
 * canonicalizeModelId().
 *
 * Docs: https://benchgecko.ai/api-docs
 * Free tier: 100 requests/day, 10 req/min — this module fetches the single
 * list endpoint so one call per sync cycle is sufficient.
 */

import { canonicalizeModelId } from '../../db/benchmark-scores.js';
import type Database from 'better-sqlite3';

const API_URL = 'https://benchgecko.ai/api/v1/models';
const FETCH_TIMEOUT_MS = 10_000;

export interface BenchGeckoModel {
  slug: string;
  name: string;
  provider: string;
  avg_score: number;
  scores: Record<string, number>;
  pricing: { input: number; output: number };
  context_window: number;
  release_date: string;
}

export interface BenchGeckoResponse {
  data: BenchGeckoModel[];
  meta: { total: number; page: number };
}

/**
 * Fetch all models from BenchGecko.
 * Free tier: 100 req/day, 10 req/min. The list endpoint returns everything
 * in one call so a single sync cycle uses 1 req.
 */
async function fetchBenchGeckoData(): Promise<BenchGeckoResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(API_URL, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'AnimaRouter/1.0 (BenchGecko sync; contact@animarouter.dev)',
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('application/json')) {
      const body = await res.text().catch(() => '<unreadable>');
      throw new Error(`Non-JSON response (${res.status}): ${body.slice(0, 80)}`);
    }

    const data = await res.json() as BenchGeckoResponse;
    return data;
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error('BenchGecko fetch timed out');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch and upsert BenchGecko scores into per-source columns.
 * Writes to: bg_score, bg_score_updated, bg_confidence.
 * Uses canonical_model_key for matching.
 */
export async function fetchBenchGeckoScores(
  db: Database.Database,
): Promise<{ updated: number; affectedIds: Set<number>; errors: string[] }> {
  const affectedIds = new Set<number>();
  const errors: string[] = [];

  let data: BenchGeckoResponse;
  try {
    data = await fetchBenchGeckoData();
  } catch (err: any) {
    errors.push(`BenchGecko: ${err.message}`);
    return { updated: 0, affectedIds, errors };
  }

  if (!data?.data || !Array.isArray(data.data) || data.data.length === 0) {
    errors.push('BenchGecko: empty response');
    return { updated: 0, affectedIds, errors };
  }

  const upsert = db.prepare(`
    UPDATE models
    SET bg_score = ?,
        bg_score_updated = ?,
        bg_confidence = 1.0
    WHERE canonical_model_key = ?
      AND (bg_score IS NULL OR bg_score != ?)
  `);

  const findId = db.prepare('SELECT id FROM models WHERE canonical_model_key = ?');

  let updated = 0;
  const tx = db.transaction(() => {
    for (const model of data.data) {
      const modelId = model.slug || model.name;
      const score = Number(model.avg_score ?? 0);
      if (!modelId || score <= 0 || score > 100) continue;

      const canonicalKey = canonicalizeModelId(modelId);
      const now = new Date().toISOString();
      const result = upsert.run(score, now, canonicalKey, score);
      if (result.changes > 0) {
        updated += result.changes;
        const row = findId.get(canonicalKey) as { id: number } | undefined;
        if (row) affectedIds.add(row.id);
      }
    }
  });
  tx();

  if (updated > 0) {
    console.log(`[BenchGecko] Updated ${updated} models`);
  }
  return { updated, affectedIds, errors };
}
