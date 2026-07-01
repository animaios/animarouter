import type { ProviderRoutingStrategy } from "@animarouter/shared/types.js";
import { getDb } from "../db/index.js";

/**
 * Per-provider routing strategy persistence.
 *
 * Each platform (a free-form slug) maps to a single strategy literal. The
 * strategy is one of the 9 ProviderRoutingStrategy literals. The value 'auto'
 * is the per-provider dispatch trigger for the Thompson-sampling orchestrator;
 * all other literals route directly.
 *
 * Missing platforms return `null`, signaling "no override set" so the routing
 * engine falls back to the global `routing_strategy` setting.
 */

const UPSERT_SQL = `
  INSERT INTO provider_strategies (platform, strategy, updated_at)
  VALUES (?, ?, datetime('now'))
  ON CONFLICT(platform) DO UPDATE SET
    strategy = excluded.strategy,
    updated_at = excluded.updated_at;
`;

const SELECT_SQL = `
  SELECT platform, strategy, updated_at
  FROM provider_strategies
  WHERE platform = ?;
`;

const LIST_SQL = `
  SELECT platform, strategy, updated_at
  FROM provider_strategies
  ORDER BY platform ASC;
`;

const DELETE_SQL = `
  DELETE FROM provider_strategies
  WHERE platform = ?;
`;

export function setProviderStrategy(
  platform: string,
  strategy: ProviderRoutingStrategy,
): { platform: string; strategy: ProviderRoutingStrategy; updated_at: string } {
  const db = getDb();
  db.prepare(UPSERT_SQL).run(platform, strategy);
  // Fresh read to get the actual stored `updated_at`
  const row = db.prepare(SELECT_SQL).get(platform) as {
    platform: string;
    strategy: string;
    updated_at: string;
  };
  return {
    platform: row.platform,
    strategy: row.strategy as ProviderRoutingStrategy,
    updated_at: row.updated_at,
  };
}

export function getProviderStrategy(
  platform: string,
): ProviderRoutingStrategy | null {
  const db = getDb();
  const row = db.prepare(SELECT_SQL).get(platform) as
    | { strategy: string }
    | undefined;
  return (row?.strategy as ProviderRoutingStrategy | undefined) ?? null;
}

export interface ProviderStrategyRow {
  platform: string;
  strategy: ProviderRoutingStrategy;
  updated_at: string;
}

export function listProviderStrategies(): ProviderStrategyRow[] {
  const db = getDb();
  const rows = db.prepare(LIST_SQL).all() as Array<{
    platform: string;
    strategy: string;
    updated_at: string;
  }>;
  return rows.map((r) => ({
    platform: r.platform,
    strategy: r.strategy as ProviderRoutingStrategy,
    updated_at: r.updated_at,
  }));
}

export function deleteProviderStrategy(platform: string): boolean {
  const db = getDb();
  const info = db.prepare(DELETE_SQL).run(platform);
  return info.changes > 0;
}
