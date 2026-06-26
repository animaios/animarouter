/**
 * AI IQ public metadata API adapter.
 *
 * Fetches model benchmarks from https://www.aiiq.org/api/models.
 * Fully public read-only endpoint — no auth required.
 *
 * The API returns sanitized JSON with model listings, benchmark data,
 * and rankings. This adapter normalises it into our per-source score
 * columns (aiiq_score, aiiq_score_updated, aiiq_confidence).
 */

import { canonicalizeModelId } from '../../db/benchmark-scores.js';
import type Database from 'better-sqlite3';

const API_URL = 'https://www.aiiq.org/api/models';
const FETCH_TIMEOUT_MS = 10_000;

interface AIIQModel {
  id?: string;
  name?: string;
  slug?: string;
  score?: number;
  avg_score?: number;
  ranking?: number;
  [key: string]: unknown;
}

interface AIIQResponse {
  models?: AIIQModel[];
  data?: AIIQModel[];
  [key: string]: unknown;
}

/**
 * Fetch all models from AI IQ public API.
 * No auth required. One call per sync cycle.
 */
async function fetchAIIQData(): Promise<AIIQResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(API_URL, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'AnimaRouter/1.0 (AI IQ sync; contact@animarouter.dev)',
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

    const data = await res.json() as AIIQResponse;
    return data;
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error('AI IQ fetch timed out');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Extract a models array from the AI IQ response.
 * Defensively handles multiple possible JSON shapes.
 */
function extractModels(data: AIIQResponse): AIIQModel[] {
  if (data.models && Array.isArray(data.models) && data.models.length > 0) {
    return data.models;
  }
  if (data.data && Array.isArray(data.data) && data.data.length > 0) {
    return data.data;
  }
  return [];
}

/**
 * Fetch and upsert AI IQ scores into per-source columns.
 * Writes to: aiiq_score, aiiq_score_updated, aiiq_confidence.
 * Uses canonical_model_key for matching.
 */
export async function fetchAIIQScores(
  db: Database.Database,
): Promise<{ updated: number; affectedIds: Set<number>; errors: string[] }> {
  const affectedIds = new Set<number>();
  const errors: string[] = [];

  let data: AIIQResponse;
  try {
    data = await fetchAIIQData();
  } catch (err: any) {
    errors.push(`AIIQ: ${err.message}`);
    return { updated: 0, affectedIds, errors };
  }

  const models = extractModels(data);
  if (models.length === 0) {
    errors.push('AIIQ: empty response');
    return { updated: 0, affectedIds, errors };
  }

  const upsert = db.prepare(`
    UPDATE models
    SET aiiq_score = ?,
        aiiq_score_updated = ?,
        aiiq_confidence = 1.0
    WHERE canonical_model_key = ?
      AND (aiiq_score IS NULL OR aiiq_score != ?)
  `);

  const findIds = db.prepare('SELECT id FROM models WHERE canonical_model_key = ?');

  let updated = 0;
  const tx = db.transaction(() => {
    for (const m of models) {
      const modelId = m.id || m.slug || m.name || '';
      // Use AI IQ score directly; normalize from ~[55, 135] range into [0, 100]
      let score = Number(m.iq ?? 0);
      if (score > 100) score = 100; // cap AI IQ above 100
      if (!modelId || score <= 0 || score > 100) continue;

      const canonicalKey = canonicalizeModelId(modelId);
      const now = new Date().toISOString();
      const result = upsert.run(score, now, canonicalKey, score);
      if (result.changes > 0) {
        updated += result.changes;
        const rows = findIds.all(canonicalKey) as { id: number }[];
        for (const r of rows) affectedIds.add(r.id);
      }
    }
  });
  tx();

  if (updated > 0) {
    console.log(`[AIIQ] Updated ${updated} models`);
  }
  return { updated, affectedIds, errors };
}
