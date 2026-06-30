import type { Express } from "express";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import { initDb } from "../../db/index.js";
import { BenchmarkService } from "../../services/benchmarks.js";
import { mintDashboardToken } from "../helpers/auth.js";

let dashToken = "";

async function request(
  app: Express,
  method: string,
  path: string,
  token?: string,
) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(url, { method, headers });
  const data = await res.json().catch(() => null);
  server.close();

  return { status: res.status, body: data };
}

describe("Benchmark Sync API", () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = "0".repeat(64);
    initDb(":memory:");
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    // Always reset mutex before each test
    BenchmarkService.isSyncing = false;
  });

  // Note: requireAuth auto-passes for 127.0.0.1 (trusted loopback).
  // Auth is tested via the middleware unit tests, not here.

  it("POST /api/benchmarks/sync returns 200 with per-source breakdown (R7.3)", async () => {
    const mockUpdate = vi
      .spyOn(BenchmarkService.prototype, "updateAllBenchmarkScores")
      .mockResolvedValue({ updated: 5, errors: [] });

    const { status, body } = await request(
      app,
      "POST",
      "/api/benchmarks/sync",
      dashToken,
    );

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.updated).toBe(5);
    expect(body.timestamp).toBeDefined();

    mockUpdate.mockRestore();
  });

  it("POST /api/benchmarks/sync returns 409 when sync already in progress (R7.6)", async () => {
    BenchmarkService.isSyncing = true;

    const { status, body } = await request(
      app,
      "POST",
      "/api/benchmarks/sync",
      dashToken,
    );

    expect(status).toBe(409);
    expect(body.error).toContain("Sync already in progress");
  });

  it("POST /api/benchmarks/sync releases mutex after completion", async () => {
    const mockUpdate = vi
      .spyOn(BenchmarkService.prototype, "updateAllBenchmarkScores")
      .mockResolvedValue({ updated: 0, errors: [] });

    await request(app, "POST", "/api/benchmarks/sync", dashToken);

    // Mutex should be released — second call should succeed
    const { status } = await request(
      app,
      "POST",
      "/api/benchmarks/sync",
      dashToken,
    );
    expect(status).toBe(200);

    mockUpdate.mockRestore();
  });

  it("GET /api/benchmarks/scores returns scores array (R8.3)", async () => {
    const { status, body } = await request(
      app,
      "GET",
      "/api/benchmarks/scores",
      dashToken,
    );

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.scores)).toBe(true);
    expect(body.timestamp).toBeDefined();
  });

  it("GET /api/benchmarks/platform/:platform returns filtered scores", async () => {
    const { status, body } = await request(
      app,
      "GET",
      "/api/benchmarks/platform/google",
      dashToken,
    );

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.platform).toBe("google");
    expect(Array.isArray(body.scores)).toBe(true);
  });
});
