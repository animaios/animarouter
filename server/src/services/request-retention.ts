import { getDb } from "../db/index.js";
import { getFeatureSetting } from "./feature-settings.js";
import { prunePingHistory } from "./ping-history.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_MAX_ROWS = 100_000;
const PRUNE_TIMER_MS = 10 * 60 * 1000; // 10 minutes

let pruneTimer: ReturnType<typeof setInterval> | null = null;

export function startRequestRetentionPruner(): void {
  if (pruneTimer) return;
  console.log("[Retention] Starting request analytics pruner (every 10m)");
  pruneRequestAnalytics({ force: true });
  pruneTimer = setInterval(() => {
    pruneRequestAnalytics({ force: true });
  }, PRUNE_TIMER_MS);
}

export function stopRequestRetentionPruner(): void {
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}

const PRUNE_INTERVAL_MS = 60_000;

type RetentionDb = ReturnType<typeof getDb>;

export interface RequestAnalyticsRetentionConfig {
  retentionDays: number;
  maxRows: number;
}

let nextPruneAtMs = 0;

function toSqliteTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

export function getRequestAnalyticsRetentionConfig(): RequestAnalyticsRetentionConfig {
  return {
    retentionDays: getFeatureSetting("analytics_retention_days") as number,
    maxRows: getFeatureSetting("analytics_max_rows") as number,
  };
}

export function pruneRequestAnalytics(
  options: { db?: RetentionDb; force?: boolean; now?: Date } = {},
): { deleted: number; skipped: boolean } {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();

  if (!options.force && nowMs < nextPruneAtMs) {
    return { deleted: 0, skipped: true };
  }
  nextPruneAtMs = nowMs + PRUNE_INTERVAL_MS;

  const db = options.db ?? getDb();
  const { retentionDays, maxRows } = getRequestAnalyticsRetentionConfig();
  let deleted = 0;

  if (retentionDays > 0) {
    const cutoff = toSqliteTimestamp(new Date(nowMs - retentionDays * DAY_MS));
    deleted += db
      .prepare("DELETE FROM requests WHERE created_at < ?")
      .run(cutoff).changes;
  }

  if (maxRows > 0) {
    deleted += db
      .prepare(`
      DELETE FROM requests
      WHERE id IN (
        SELECT id
        FROM requests
        ORDER BY created_at DESC, id DESC
        LIMIT -1 OFFSET ?
      )
    `)
      .run(maxRows).changes;
  }

  prunePingHistory({ db, now });

  return { deleted, skipped: false };
}
