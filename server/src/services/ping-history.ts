import { getDb } from "../db/index.js";
import { getFeatureSetting } from "./feature-settings.js";

const TABLE_READY = new WeakSet<object>();
const DAY_MS = 24 * 60 * 60 * 1000;

function toSqliteTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

// ping_history is created in server/src/db/migrations.ts. For environments that
// boot outside that path we lazily ensure the table exists here too. The
// WeakSet keyed on the db handle makes this cheap after the first call.
function ensureTable(db: ReturnType<typeof getDb>): void {
  if (TABLE_READY.has(db as object)) return;
  db.prepare(`
    CREATE TABLE IF NOT EXISTS ping_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      key_id INTEGER NOT NULL,
      success INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();
  db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_ping_history_created_at ON ping_history(created_at)",
  ).run();
  db.prepare(
    "CREATE INDEX IF NOT EXISTS idx_ping_history_platform ON ping_history(platform)",
  ).run();
  TABLE_READY.add(db as object);
}

export interface PingRecord {
  platform: string;
  modelId: string;
  keyId: number;
  success: boolean;
  latencyMs: number;
  error?: string;
}

function shouldPersist(): boolean {
  try {
    return getFeatureSetting("heartbeat_persist_pings") as boolean;
  } catch {
    return true;
  }
}

// Persist a single ping. Always call from a try/catch in the ping path — a
// persistence failure must never break the main heartbeat cycle.
export function insertPing(
  record: Pick<
    PingRecord,
    "platform" | "modelId" | "keyId" | "success" | "latencyMs" | "error"
  >,
): void {
  if (!shouldPersist()) return;
  const db = getDb();
  ensureTable(db);
  db.prepare(`
    INSERT INTO ping_history (platform, model_id, key_id, success, latency_ms, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    record.platform,
    record.modelId,
    record.keyId,
    record.success ? 1 : 0,
    record.latencyMs,
    record.error ?? null,
  );
}

// Delete ping rows older than the configured analytics retention window.
// Called from the same sweeper that trims the requests table.
export function prunePingHistory(
  options: {
    db?: ReturnType<typeof getDb>;
    retentionDays?: number;
    now?: Date;
  } = {},
): number {
  try {
    const retentionDays =
      options.retentionDays ??
      (getFeatureSetting("analytics_retention_days") as number);
    if (retentionDays <= 0) return 0;
    const db = options.db ?? getDb();
    ensureTable(db);
    const cutoff = toSqliteTimestamp(
      new Date((options.now ?? new Date()).getTime() - retentionDays * DAY_MS),
    );
    return db
      .prepare("DELETE FROM ping_history WHERE created_at < ?")
      .run(cutoff).changes;
  } catch (err) {
    console.error("[Retention] Failed to prune ping history:", err);
    return 0;
  }
}
