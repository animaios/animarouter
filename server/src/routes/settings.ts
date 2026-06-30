import type { Request, Response } from "express";
import { Router } from "express";
import { getUnifiedApiKey, regenerateUnifiedKey } from "../db/index.js";
import {
  getAllFeatureSettings,
  hasPendingRestart,
  saveFeatureSettings,
} from "../services/feature-settings.js";
import { pokeAllKeys, pokeKey } from "../services/heartbeat.js";

export const settingsRouter = Router();

// Get the unified API key
settingsRouter.get("/api-key", (_req: Request, res: Response) => {
  res.json({ apiKey: getUnifiedApiKey() });
});

// Regenerate the unified API key
settingsRouter.post("/api-key/regenerate", (_req: Request, res: Response) => {
  const newKey = regenerateUnifiedKey();
  res.json({ apiKey: newKey });
});

// ── Feature settings ───────────────────────────────────────────────────────

// Get all feature settings with current values + restart-detection flag
settingsRouter.get("/features", (_req: Request, res: Response) => {
  res.json({
    settings: getAllFeatureSettings(),
    pendingRestart: hasPendingRestart(),
  });
});

// Save a partial update of feature settings (validates server-side)
settingsRouter.put("/features", (req: Request, res: Response) => {
  const updates = req.body as Record<string, boolean | number | string>;
  const errors = saveFeatureSettings(updates);
  if (errors.length > 0) {
    res.status(400).json({ error: errors.join("; ") });
    return;
  }
  res.json({
    settings: getAllFeatureSettings(),
    pendingRestart: hasPendingRestart(),
  });
});

// ── Heartbeat admin ─────────────────────────────────────────────────────────

// Poke a single key (by keyId) or all keys (omit keyId)
settingsRouter.post("/heartbeat/poke", async (req: Request, res: Response) => {
  const { keyId } = req.body ?? {};
  if (keyId != null && keyId !== "") {
    const id = Number(keyId);
    if (isNaN(id)) {
      res.status(400).json({ error: { message: "keyId must be a number" } });
      return;
    }
    const ok = await pokeKey(id);
    res.json({ success: ok ? "key_ok" : "key_unhealthy_or_missing" });
    return;
  }
  // Poke all keys
  const result = await pokeAllKeys();
  res.json(result);
});
