import type { KeyStatus } from "@animarouter/shared/types.js";
import { getDb } from "../db/index.js";
import { decrypt } from "../lib/crypto.js";
import { buildProviderFor } from "../providers/index.js";
import { healthKey, keyHealthMap } from "./heartbeat.js";

export async function checkKeyHealth(keyId: number): Promise<KeyStatus> {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM api_keys WHERE id = ?")
    .get(keyId) as any;
  if (!row) return "error";

  const provider = buildProviderFor(row.platform);
  if (!provider) return "error";

  let apiKey: string;
  try {
    apiKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
  } catch (err: any) {
    console.error(`[Health] Key ${keyId} decrypt failed:`, err.message);
    // Decrypt failure is permanent — mark key invalid but do NOT auto-disable.
    // The user decides whether to disable the key.
    db.prepare(
      "UPDATE api_keys SET status = 'invalid', last_checked_at = datetime('now') WHERE id = ?",
    ).run(keyId);
    // Get the highest-priority model for this key's platform
    const model = db
      .prepare(
        `
      SELECT m.id AS model_db_id, m.model_id
      FROM fallback_config fc
      JOIN models m ON m.id = fc.model_db_id AND m.enabled = 1
      WHERE fc.enabled = 1 AND m.platform = ?
      ORDER BY fc.priority ASC
      LIMIT 1
    `,
      )
      .get(row.platform) as
      | { model_db_id: number; model_id: string }
      | undefined;

    if (model) {
      const healthKeyVal = healthKey(keyId, model.model_id);
      keyHealthMap.set(healthKeyVal, {
        penalty: 0,
        lastPingAt: Date.now(),
        healthy: false,
        lastError: "decrypt failed",
      });
    }
    return "invalid";
  }

  try {
    const isValid = await provider.validateKey(apiKey);
    const status: KeyStatus = isValid ? "healthy" : "invalid";
    db.prepare(
      "UPDATE api_keys SET status = ?, last_checked_at = datetime('now') WHERE id = ?",
    ).run(status, keyId);
    // Get the highest-priority model for this key's platform
    const model = db
      .prepare(`
      SELECT m.id AS model_db_id, m.model_id
      FROM fallback_config fc
      JOIN models m ON m.id = fc.model_db_id AND m.enabled = 1
      WHERE fc.enabled = 1 AND m.platform = ?
      ORDER BY fc.priority ASC
      LIMIT 1
    `)
      .get(row.platform) as
      | { model_db_id: number; model_id: string }
      | undefined;
    if (model) {
      keyHealthMap.set(healthKey(keyId, model.model_id), {
        penalty: 0,
        lastPingAt: Date.now(),
        healthy: status === "healthy",
      });
    }
    return status;
  } catch (err: any) {
    console.error(`[Health] Key ${keyId} transport error:`, err.message);
    db.prepare(
      "UPDATE api_keys SET status = ?, last_checked_at = datetime('now') WHERE id = ?",
    ).run("error", keyId);
    const errModel = db
      .prepare(`
      SELECT m.id AS model_db_id, m.model_id
      FROM fallback_config fc
      JOIN models m ON m.id = fc.model_db_id AND m.enabled = 1
      WHERE fc.enabled = 1 AND m.platform = ?
      ORDER BY fc.priority ASC
      LIMIT 1
    `)
      .get(row.platform) as
      | { model_db_id: number; model_id: string }
      | undefined;
    if (errModel) {
      keyHealthMap.set(healthKey(keyId, errModel.model_id), {
        penalty: 0,
        lastPingAt: Date.now(),
        healthy: false,
        lastError: (err as any).message?.slice(0, 120),
      });
    }
    return "error";
  }
}

export async function checkAllKeys(): Promise<void> {
  const db = getDb();
  const keys = db.prepare("SELECT id, platform FROM api_keys").all() as {
    id: number;
    platform: string;
  }[];
  console.log(`[Health] Checking ${keys.length} keys...`);
  for (const key of keys) {
    await checkKeyHealth(key.id);
  }
  console.log(`[Health] Check complete.`);
}
