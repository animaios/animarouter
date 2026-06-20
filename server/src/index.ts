import './env.js';
import { createApp } from './app.js';
import { initDb, getDb } from './db/index.js';
import { pruneSessions } from './services/auth.js';
import { startHealthChecker } from './services/health.js';
import { startRequestRetentionPruner } from './services/request-retention.js';
import { rebuildExhaustionFromDB } from './services/key-exhaustion.js';
import { initDegradation, loadState, applyDecay, flushDirtyStates, evictGhostStates } from './services/degradation.js';

const PORT = process.env.PORT ?? 3001;
// Dual-stack ('::') by default so the dashboard is reachable over both IPv4
// and IPv6 (e.g. IPv6-enabled Docker networks — #180). Hosts with IPv6
// disabled fall back to IPv4-only below; HOST overrides the default outright.
const HOST = process.env.HOST ?? '::';

process.on('unhandledRejection', (reason: unknown) => {
  console.error('\n[server] Unhandled rejection:\n  ' + (reason instanceof Error ? reason.stack : reason) + '\n');
  process.exit(1);
});
process.on('uncaughtException', (err: Error) => {
  console.error('\n[server] Uncaught exception:\n  ' + (err?.stack ?? err) + '\n');
  process.exit(1);
});
async function main() {
  initDb();
  pruneSessions();
  rebuildExhaustionFromDB();
  startRequestRetentionPruner();

  // ── Degradation: init + hydrate from DB ────────────────────────────────────
  initDegradation();
  const now = Date.now();
  const rows = getDb().prepare('SELECT * FROM model_degradation').all() as any[];
  for (const row of rows) {
    const elapsed = now - (row.last_hit_at ?? now);
    const decayedPenalty = applyDecay(row.penalty, elapsed, row.half_life_ms);
    if (decayedPenalty >= 0.01) {
      loadState(row.model_db_id, {
        penalty: decayedPenalty,
        tier: row.tier,
        consecutiveHits: row.consecutive,
        consecutiveMajorHits: row.consecutive_major,
        lastHitAt: now,
        halfLifeMs: row.half_life_ms,
        dirty: false,
      });
    } else {
      getDb().prepare('DELETE FROM model_degradation WHERE model_db_id = ?').run(row.model_db_id);
    }
  }

  // ── Degradation: periodic persistence + ghost eviction (every 60s) ────────
  const FLUSH_INTERVAL_MS = 60_000;
  const degradationFlushInterval = setInterval(() => {
    try {
      const dirty = flushDirtyStates();
      if (dirty.length > 0) {
        const upsert = getDb().prepare(`
          INSERT OR REPLACE INTO model_degradation
          (model_db_id, penalty, tier, consecutive, consecutive_major, last_hit_at, half_life_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const { modelDbId, state } of dirty) {
          upsert.run(modelDbId, state.penalty, state.tier,
            state.consecutiveHits, state.consecutiveMajorHits,
            state.lastHitAt, state.halfLifeMs);
        }
      }
      const evicted = evictGhostStates();
      if (evicted.length > 0) {
        const del = getDb().prepare('DELETE FROM model_degradation WHERE model_db_id = ?');
        for (const id of evicted) {
          del.run(id);
        }
      }
    } catch (e) {
      console.error('[Degradation] Periodic flush error:', e);
    }
  }, FLUSH_INTERVAL_MS);
  degradationFlushInterval.unref();

  const app = createApp();

  const onReady = (host: string) => () => {
    const display = host.includes(':') ? `[${host}]` : host;
    console.log(`Server running on http://${display}:${PORT}`);
    console.log(`Proxy endpoint: http://${display}:${PORT}/v1/chat/completions`);
    startHealthChecker();
  };

  const server = app.listen(Number(PORT), HOST, onReady(HOST));
  server.on('error', (err: NodeJS.ErrnoException) => {
    // The default '::' bind fails where IPv6 is disabled (kernel
    // ipv6.disable=1 and the like) — retry IPv4-only rather than dying.
    // Anything else (EADDRINUSE, an explicit HOST that can't bind) keeps the
    // fail-fast posture documented in main().catch below.
    if (!process.env.HOST && (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL')) {
      console.warn('[server] IPv6 unavailable on this host — falling back to 0.0.0.0 (IPv4-only)');
      const ipv4Server = app.listen(Number(PORT), '0.0.0.0', onReady('0.0.0.0'));
      ipv4Server.on('error', (err: NodeJS.ErrnoException) => {
        console.error('\n[server] IPv4 fallback failed to start:\n  ' + (err?.message ?? err) + '\n');
        process.exit(1);
      });
      return;
    }
    console.error('\n[server] Failed to start:\n  ' + (err?.message ?? err) + '\n');
    process.exit(1);
  });
  process.on('SIGTERM', () => {
    console.log('[server] SIGTERM received — shutting down gracefully');
    shutdownFlushDegradation();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 30_000).unref();
  });
  process.on('SIGINT', () => {
    console.log('[server] SIGINT received — shutting down gracefully');
    shutdownFlushDegradation();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 30_000).unref();
  });
}

main().catch((err) => {
  // A boot failure (e.g. a missing production ENCRYPTION_KEY) must exit
  // non-zero rather than leaving a half-initialized process that never starts
  // listening — that silent state is what surfaces in the client as
  // "Can't reach the server".
  console.error('\n[server] Failed to start:\n  ' + (err?.message ?? err) + '\n');
  process.exit(1);
});
