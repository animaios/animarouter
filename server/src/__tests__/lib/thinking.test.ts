import { describe, expect, it } from "vitest";
import {
  anthropicThinking,
  geminiThinkingConfig,
  normalizeThinking,
  openaiCompatThinkingBody,
} from "../../lib/thinking.js";

// `thinking` is the unified inbound knob. The translators here emit wire-
// shape fragments (`thinking` + `output_config` for Anthropic, etc.) that
// per-provider code folds into the final body. Tests cover all four real
// provider paths plus the unified effort/type normalization.

describe("normalizeThinking", () => {
  it("returns undefined when neither field is set", () => {
    expect(normalizeThinking({})).toBeUndefined();
  });

  it("treats bare `reasoning_effort` as enable-implied", () => {
    const out = normalizeThinking({ reasoning_effort: "high" });
    expect(out).toEqual({ effort: "high", enabled: true });
  });

  it("treats `thinking.type=disabled` explicitly as disabled", () => {
    const out = normalizeThinking({ thinking: { type: "disabled" } });
    expect(out?.enabled).toBe(false);
  });

  it("treats `thinking.type=adaptive` as enabled with the adaptive flag", () => {
    const out = normalizeThinking({
      thinking: { type: "adaptive", effort: "medium" },
    });
    expect(out).toMatchObject({
      adaptive: true,
      enabled: true,
      effort: "medium",
    });
  });

  it("treats `thinking.budget` as budget", () => {
    const out = normalizeThinking({
      thinking: { type: "enabled", budget: 5000 },
    });
    expect(out).toMatchObject({ enabled: true, budget: 5000 });
  });

  it("merges explicit effort into enabled-implied view when only reasoning_effort is set", () => {
    const out = normalizeThinking({ reasoning_effort: "low" });
    expect(out).toMatchObject({ enabled: true, effort: "low" });
  });
});

describe("anthropicThinking", () => {
  it("emits thinking=enabled with budget_tokens when budget is set", () => {
    const out = anthropicThinking({
      enabled: true,
      effort: "high",
      budget: 4000,
      display: "summarized",
    });
    expect(out.thinking).toEqual({
      type: "enabled",
      budget_tokens: 4000,
      display: "summarized",
    });
    expect(out.output_config).toEqual({ effort: "high" });
  });

  it("emits thinking=adaptive + output_config.effort on adaptive mode", () => {
    const out = anthropicThinking({ adaptive: true, effort: "medium" });
    expect(out.thinking).toEqual({ type: "adaptive" });
    expect(out.output_config).toEqual({ effort: "medium" });
  });

  it("honors explicit disabled", () => {
    const out = anthropicThinking({ enabled: false });
    expect(out.thinking).toEqual({ type: "disabled" });
    expect(out.output_config).toBeUndefined();
  });

  it("omits fields when nothing was set", () => {
    expect(anthropicThinking(undefined)).toEqual({});
  });
});

describe("geminiThinkingConfig", () => {
  it("emits thinkingBudget=0 to disable on 2.5-series", () => {
    expect(
      geminiThinkingConfig({ enabled: false }, "gemini-2.5-flash"),
    ).toEqual({ thinkingBudget: 0 });
  });

  it("emits thinkingLevel=minimal to disable on 3-series", () => {
    expect(geminiThinkingConfig({ enabled: false }, "gemini-3-flash")).toEqual({
      thinkingLevel: "minimal",
    });
  });

  it("emits thinkingLevel on 3-series when effort is set", () => {
    expect(
      geminiThinkingConfig(
        { enabled: true, effort: "medium" },
        "gemini-3-flash",
      ),
    ).toMatchObject({ includeThoughts: true, thinkingLevel: "medium" });
  });

  it("emits thinkingBudget on 2.5-series when effort is set", () => {
    expect(
      geminiThinkingConfig(
        { enabled: true, effort: "low" },
        "gemini-2.5-flash",
      ),
    ).toMatchObject({ includeThoughts: true, thinkingBudget: 2048 });
  });

  it("uses explicit budget when no effort is set", () => {
    expect(
      geminiThinkingConfig({ enabled: true, budget: 4096 }, "gemini-3-pro"),
    ).toMatchObject({ includeThoughts: true, thinkingBudget: 4096 });
  });

  it("returns undefined when neither enabled nor disabled", () => {
    expect(geminiThinkingConfig(undefined, "gemini-3-flash")).toBeUndefined();
  });
});

describe("openaiCompatThinkingBody", () => {
  it("emits reasoning_effort shorthand when only that is set", () => {
    const out = openaiCompatThinkingBody(
      { enabled: true, effort: "medium" },
      { reasoning_effort: "medium" },
    );
    expect(out).toEqual({ reasoning_effort: "medium" });
  });

  it("emits the rich `thinking` object when present in the request", () => {
    const obj = {
      type: "enabled" as const,
      effort: "high" as const,
      budget: 4000,
    };
    const out = openaiCompatThinkingBody(
      { enabled: true, effort: "high", budget: 4000 },
      { thinking: obj },
    );
    expect(out).toEqual({ thinking: obj });
  });

  it("returns an empty object when no thinking info is present", () => {
    expect(openaiCompatThinkingBody(undefined, undefined)).toEqual({});
  });
});
