import { describe, expect, it } from "vitest";
import { isRouterStatsPathname } from "./router-shell";

describe("isRouterStatsPathname", () => {
  it("matches the canonical router stats path", () => {
    expect(isRouterStatsPathname("/router-stats")).toBe(true);
  });

  it("matches a router stats path with a trailing slash", () => {
    expect(isRouterStatsPathname("/router-stats/")).toBe(true);
  });

  it("does not match nested or unrelated paths", () => {
    expect(isRouterStatsPathname("/router-stats/details")).toBe(false);
    expect(isRouterStatsPathname("/analytics")).toBe(false);
  });
});
