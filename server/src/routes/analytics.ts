import { Router } from 'express';
import type { Request, Response } from 'express';
import type Database from 'better-sqlite3';
import { getDb } from '../db/index.js';

export const analyticsRouter = Router();

// Format UTC timestamps the same way SQLite stores created_at text values.
const toSqliteDateTime = (timestamp: number) =>
    new Date(timestamp).toISOString().slice(0, 19).replace('T', ' ');

// Return the rolling cutoff timestamp for the selected analytics range.
function getSinceTimestamp(range: string): string {
  const now = Date.now();

  switch (range) {
    case '15m':
      return toSqliteDateTime(now - 15 * 60 * 1000);
    case '1h':
      return toSqliteDateTime(now - 60 * 60 * 1000);
    case '24h':
      return toSqliteDateTime(now - 24 * 60 * 60 * 1000);
    case '30d':
      return toSqliteDateTime(now - 30 * 24 * 60 * 60 * 1000);
    case '7d':
    default:
      return toSqliteDateTime(now - 7 * 24 * 60 * 60 * 1000);
  }
}

/** Return platforms that have ≥1 enabled key AND ≥1 model. */
function getActivePlatforms(db: Database.Database): string[] {
  return (db.prepare(`
    SELECT DISTINCT k.platform
    FROM api_keys k
    WHERE k.enabled = 1
      AND EXISTS (
        SELECT 1 FROM models m
        WHERE m.platform = k.platform
      )
  `).all() as { platform: string }[]).map(r => r.platform);
}

/** Build an IN-clause fragment for active platforms.
 *  Returns { sql, params } — sql is '' when no active platforms exist. */
function buildPlatformFilter(
  activePlatforms: string[],
  alias = '',
): { sql: string; params: string[] } {
  if (activePlatforms.length === 0) return { sql: '', params: [] };
  const col = alias ? `${alias}.platform` : 'platform';
  return {
    sql: `AND ${col} IN (${activePlatforms.map(() => '?').join(',')})`,
    params: activePlatforms,
  };
}

/**
 * Returns the SQL fragments for the models + fallback_config JOINs.
 * Appends LEFT JOINs to requests r for the per-model analytics.
 * No bind params — the JOINs link via m.id, not user input.
 */
function buildModelEnabledFilter() {
  return {
    joinSql: `LEFT JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
      LEFT JOIN fallback_config fc ON fc.model_db_id = m.id`,
    whereSql: '',
  };
}

interface SummaryResponse {
  totalRequests: number; successRate: number;
  totalInputTokens: number; totalOutputTokens: number;
  avgLatencyMs: number;
  pinnedRequests: number; pinHonoredRequests: number;
}

const EMPTY_SUMMARY: SummaryResponse = {
  totalRequests: 0, successRate: 0,
  totalInputTokens: 0, totalOutputTokens: 0,
  avgLatencyMs: 0,
  pinnedRequests: 0, pinHonoredRequests: 0,
};
const EMPTY_ERROR_DIST = { byCategory: [] as any[], byPlatform: [] as any[], detailed: [] as any[] };

// Summary stats
analyticsRouter.get('/summary', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '24h';
  const since = getSinceTimestamp(range);
  const db = getDb();

  const active = getActivePlatforms(db);
  if (active.length === 0) return res.json(EMPTY_SUMMARY);
  const pf = buildPlatformFilter(active, 'r');
  const mf = buildModelEnabledFilter();

  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_requests,
      SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) as success_count,
      SUM(r.input_tokens) as total_input_tokens,
      SUM(r.output_tokens) as total_output_tokens,
      AVG(r.latency_ms) as avg_latency_ms,
      SUM(CASE WHEN r.requested_model IS NOT NULL THEN 1 ELSE 0 END) as pinned_count,
      SUM(CASE WHEN r.requested_model = r.model_id THEN 1 ELSE 0 END) as pin_honored_count
    FROM requests r
    ${mf.joinSql}
    WHERE r.created_at >= ?
      ${pf.sql}
      ${mf.whereSql}
  `).get(since, ...pf.params) as any;

  const totalRequests = stats.total_requests ?? 0;
  const successRate = totalRequests > 0 ? (stats.success_count / totalRequests) * 100 : 0;

  res.json({
    totalRequests,
    successRate: Math.round(successRate * 10) / 10,
    totalInputTokens: stats.total_input_tokens ?? 0,
    totalOutputTokens: stats.total_output_tokens ?? 0,
    avgLatencyMs: Math.round(stats.avg_latency_ms ?? 0),
    // Pinned = requests where the client named a specific model (not 'auto').
    // Honored = the pinned model actually served it; the difference is
    // failovers that overrode the pin.
    pinnedRequests: stats.pinned_count ?? 0,
    pinHonoredRequests: stats.pin_honored_count ?? 0,
  });
});

// Stats grouped by model
analyticsRouter.get('/by-model', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '24h';
  const since = getSinceTimestamp(range);
  const db = getDb();

  const active = getActivePlatforms(db);
  if (active.length === 0) return res.json([]);
  const pf = buildPlatformFilter(active, 'r');
  const mf = buildModelEnabledFilter();

  const rows = db.prepare(`
    SELECT
      r.platform,
      r.model_id,
      m.display_name,
      COUNT(*) as requests,
      SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate,
      AVG(r.latency_ms) as avg_latency_ms,
      SUM(r.input_tokens) as total_input_tokens,
      SUM(r.output_tokens) as total_output_tokens,
      SUM(r.reasoning_tokens) as total_reasoning_tokens,
      SUM(CASE WHEN r.requested_model = r.model_id THEN 1 ELSE 0 END) as pinned_requests,
      CASE WHEN SUM(r.latency_ms) > 0
        THEN ROUND(SUM(r.output_tokens + r.reasoning_tokens) * 1000.0 / SUM(r.latency_ms), 1)
        ELSE 0
      END as tok_per_sec
    FROM requests r
    ${mf.joinSql}
    WHERE r.created_at >= ?
      ${pf.sql}
      ${mf.whereSql}
    GROUP BY r.platform, r.model_id
    ORDER BY requests DESC
  `).all(since, ...pf.params) as any[];

  res.json(rows.map(r => ({
    platform: r.platform,
    modelId: r.model_id,
    displayName: r.display_name ?? r.model_id,
    requests: r.requests,
    successRate: Math.round(r.success_rate * 10) / 10,
    avgLatencyMs: Math.round(r.avg_latency_ms),
    totalInputTokens: r.total_input_tokens ?? 0,
    totalOutputTokens: r.total_output_tokens ?? 0,
    totalReasoningTokens: r.total_reasoning_tokens ?? 0,
    // Requests this model served because the client pinned it by name.
    pinnedRequests: r.pinned_requests ?? 0,
    tokPerSec: r.tok_per_sec ?? 0,
  })));
});

// Stats grouped by platform
analyticsRouter.get('/by-platform', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '24h';
  const since = getSinceTimestamp(range);
  const db = getDb();

  const active = getActivePlatforms(db);
  if (active.length === 0) return res.json([]);
  const pf = buildPlatformFilter(active, 'r');
  const mf = buildModelEnabledFilter();

  const rows = db.prepare(`
    SELECT
      r.platform,
      COUNT(*) as requests,
      SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate,
      AVG(r.latency_ms) as avg_latency_ms,
      SUM(r.input_tokens) as total_input_tokens,
      SUM(r.output_tokens) as total_output_tokens
    FROM requests r
    ${mf.joinSql}
    WHERE r.created_at >= ?
      ${pf.sql}
      ${mf.whereSql}
    GROUP BY r.platform
    ORDER BY requests DESC
  `).all(since, ...pf.params) as any[];

  res.json(rows.map(r => ({
    platform: r.platform,
    requests: r.requests,
    successRate: Math.round(r.success_rate * 10) / 10,
    avgLatencyMs: Math.round(r.avg_latency_ms),
    totalInputTokens: r.total_input_tokens ?? 0,
    totalOutputTokens: r.total_output_tokens ?? 0,
  })));
});

// Timeline data
analyticsRouter.get('/timeline', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '24h';
  const interval = (req.query.interval as string) ?? (
    range === '15m' ? 'minute' :
    range === '1h'  ? '5min'  :
    range === '24h' ? 'hour'  : 'day'
  );
  const since = getSinceTimestamp(range);
  const db = getDb();

  const active = getActivePlatforms(db);
  const pf = buildPlatformFilter(active, 'r');
  const mf = buildModelEnabledFilter();

  // dateFormat is a hardcoded whitelist — never user-controlled.
  // For 5-minute buckets we floor the minute value to the nearest multiple of 5.
  const dateFormat =
    interval === 'minute' ? '%Y-%m-%dT%H:%M:00' :
    interval === '5min'   ? "strftime('%Y-%m-%dT%H:', r.created_at) || printf('%02d', (CAST(strftime('%M', r.created_at) AS INTEGER) / 5) * 5) || ':00'" :
    interval === 'hour'   ? '%Y-%m-%dT%H:00:00' : '%Y-%m-%d';

  // selectExpr and groupExpr must be identical SQL fragments so SELECT and GROUP BY match.
  const selectExpr = interval === '5min'
    ? dateFormat
    : `strftime('${dateFormat}', r.created_at)`;
  const groupExpr = selectExpr;

  // Only query when there are active platforms; otherwise dbRows stays empty
  // and the zero-fill below still produces a full flat-line x-axis.
  const dbRows = active.length === 0 ? [] : db.prepare(`
    SELECT
      ${selectExpr} as timestamp,
      COUNT(*) as requests,
      SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN r.status = 'error' THEN 1 ELSE 0 END) as failure_count
    FROM requests r
    ${mf.joinSql}
    WHERE r.created_at >= ?
      ${pf.sql}
      ${mf.whereSql}
    GROUP BY ${groupExpr}
    ORDER BY timestamp ASC
  `).all(since, ...pf.params) as any[];

  // ── Zero-fill: always emit the complete set of buckets ──────────────────
  const BUCKET_MS: Record<string, number> = {
    minute: 60 * 1000,
    '5min': 5 * 60 * 1000,
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
  };

  const floorToBucket = (ms: number, size: number): number =>
    Math.floor(ms / size) * size;

  const msToBucketKey = (ms: number, iv: string): string => {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    const datePart = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    if (iv === 'day') return datePart;
    return `${datePart}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
  };

  const dataMap = new Map(dbRows.map(r => [r.timestamp, r]));

  const bucketSize = BUCKET_MS[interval] ?? BUCKET_MS.hour;
  const nowMs = Date.now();
  const sinceMs = new Date(since.replace(' ', 'T') + 'Z').getTime();
  const startBucket = floorToBucket(sinceMs, bucketSize);
  const endBucket = floorToBucket(nowMs, bucketSize);

  const filled: any[] = [];
  for (let t = startBucket; t <= endBucket; t += bucketSize) {
    const key = msToBucketKey(t, interval);
    const r = dataMap.get(key);
    filled.push({
      timestamp: interval === 'day' ? key + 'T00:00:00Z' : key + 'Z',
      requests: r?.requests ?? 0,
      successCount: r?.success_count ?? 0,
      failureCount: r?.failure_count ?? 0,
    });
  }

  res.json(filled);
});

// Error distribution (grouped by error type and platform)
analyticsRouter.get('/error-distribution', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '24h';
  const since = getSinceTimestamp(range);
  const db = getDb();

  const active = getActivePlatforms(db);
  if (active.length === 0) return res.json(EMPTY_ERROR_DIST);
  const pf = buildPlatformFilter(active, 'r');
  const mf = buildModelEnabledFilter();

  // Group errors by category (extract the key part of the error message)
  const rows = db.prepare(`
    SELECT
      r.platform,
      r.model_id,
      CASE
        WHEN r.error LIKE '%429%' OR r.error LIKE '%rate limit%' OR r.error LIKE '%too many%' OR r.error LIKE '%quota%' THEN 'Rate Limited (429)'
        WHEN r.error LIKE '%401%' OR r.error LIKE '%unauthorized%' OR r.error LIKE '%invalid.*key%' THEN 'Auth Error (401)'
        WHEN r.error LIKE '%403%' OR r.error LIKE '%forbidden%' THEN 'Forbidden (403)'
        WHEN r.error LIKE '%404%' OR r.error LIKE '%not found%' THEN 'Not Found (404)'
        WHEN r.error LIKE '%timeout%' OR r.error LIKE '%ETIMEDOUT%' OR r.error LIKE '%ECONNREFUSED%' THEN 'Timeout/Connection'
        WHEN r.error LIKE '%500%' OR r.error LIKE '%internal server%' THEN 'Server Error (500)'
        WHEN r.error LIKE '%503%' OR r.error LIKE '%unavailable%' THEN 'Unavailable (503)'
        ELSE 'Other'
      END as error_category,
      COUNT(*) as count
    FROM requests r
    ${mf.joinSql}
    WHERE r.status = 'error' AND r.created_at >= ?
      ${pf.sql}
      ${mf.whereSql}
    GROUP BY r.platform, error_category
    ORDER BY count DESC
  `).all(since, ...pf.params) as any[];

  // Also get totals by category
  const byCategory = db.prepare(`
    SELECT
      CASE
        WHEN r.error LIKE '%429%' OR r.error LIKE '%rate limit%' OR r.error LIKE '%too many%' OR r.error LIKE '%quota%' THEN 'Rate Limited (429)'
        WHEN r.error LIKE '%401%' OR r.error LIKE '%unauthorized%' OR r.error LIKE '%invalid.*key%' THEN 'Auth Error (401)'
        WHEN r.error LIKE '%403%' OR r.error LIKE '%forbidden%' THEN 'Forbidden (403)'
        WHEN r.error LIKE '%404%' OR r.error LIKE '%not found%' THEN 'Not Found (404)'
        WHEN r.error LIKE '%timeout%' OR r.error LIKE '%ETIMEDOUT%' OR r.error LIKE '%ECONNREFUSED%' THEN 'Timeout/Connection'
        WHEN r.error LIKE '%500%' OR r.error LIKE '%internal server%' THEN 'Server Error (500)'
        WHEN r.error LIKE '%503%' OR r.error LIKE '%unavailable%' THEN 'Unavailable (503)'
        ELSE 'Other'
      END as category,
      COUNT(*) as count
    FROM requests r
    ${mf.joinSql}
    WHERE r.status = 'error' AND r.created_at >= ?
      ${pf.sql}
      ${mf.whereSql}
    GROUP BY category
    ORDER BY count DESC
  `).all(since, ...pf.params) as any[];

  // Errors by platform
  const byPlatform = db.prepare(`
    SELECT r.platform, COUNT(*) as count
    FROM requests r
    ${mf.joinSql}
    WHERE r.status = 'error' AND r.created_at >= ?
      ${pf.sql}
      ${mf.whereSql}
    GROUP BY r.platform
    ORDER BY count DESC
  `).all(since, ...pf.params) as any[];

  res.json({
    byCategory,
    byPlatform,
    detailed: rows,
  });
});

// Recent errors
analyticsRouter.get('/errors', (req: Request, res: Response) => {
  const range = (req.query.range as string) ?? '24h';
  const since = getSinceTimestamp(range);
  const db = getDb();

  const active = getActivePlatforms(db);
  if (active.length === 0) return res.json([]);
  const pf = buildPlatformFilter(active, 'r');
  const mf = buildModelEnabledFilter();

  const rows = db.prepare(`
    SELECT r.id, r.platform, r.model_id, r.error, r.latency_ms, r.created_at
    FROM requests r
    ${mf.joinSql}
    WHERE r.status = 'error' AND r.created_at >= ?
      ${pf.sql}
      ${mf.whereSql}
    ORDER BY r.created_at DESC
    LIMIT 50
  `).all(since, ...pf.params) as any[];

  res.json(rows.map(r => ({
    id: r.id,
    platform: r.platform,
    modelId: r.model_id,
    error: r.error,
    latencyMs: r.latency_ms,
    createdAt: r.created_at,
  })));
});
