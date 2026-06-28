import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, initDb } from "../../db/index.js";
import { logRequest } from "../../routes/proxy.js";

describe("proxy request logging", () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = "0".repeat(64);
    initDb(":memory:");
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare("DELETE FROM requests").run();
    db.prepare("DELETE FROM key_stats_temp").run();
  });

  it("averages key speed and TTFB over successful requests only", () => {
    logRequest("testprov", "test-model", 42, "error", 0, 0, 2_000, "429");
    logRequest(
      "testprov",
      "test-model",
      42,
      "success",
      10,
      100,
      1_000,
      null,
      100,
    );
    logRequest("testprov", "test-model", 42, "error", 0, 0, 2_000, "500");
    logRequest(
      "testprov",
      "test-model",
      42,
      "success",
      10,
      200,
      1_000,
      null,
      300,
    );

    const row = getDb()
      .prepare(
        `SELECT successes, failures, totalRequests, tokPerSec, avgTtfbMs
         FROM key_stats_temp
         WHERE platform = 'testprov' AND model_id = 'test-model' AND key_id = 42`,
      )
      .get() as {
      successes: number;
      failures: number;
      totalRequests: number;
      tokPerSec: number;
      avgTtfbMs: number;
    };

    expect(row.successes).toBe(2);
    expect(row.failures).toBe(2);
    expect(row.totalRequests).toBe(4);
    expect(row.tokPerSec).toBe(150);
    expect(row.avgTtfbMs).toBe(200);
  });
});
