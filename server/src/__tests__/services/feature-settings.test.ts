import { describe, expect, it } from "vitest";
import { REGISTRY } from "../../services/feature-settings.js";

describe("feature settings registry", () => {
  it("registers Iterative Refinement oscillator settings with spec defaults and env overrides", () => {
    expect(
      REGISTRY.filter(
        (entry) =>
          entry.key === "iterative_refinement_weights" ||
          entry.key.startsWith("oscillator_"),
      ).map((entry) => ({
        key: entry.key,
        default: entry.default,
        envVar: entry.envVar,
        effect: entry.effect,
        group: entry.group,
        parentToggle: entry.parentToggle,
      })),
    ).toEqual([
      {
        key: "iterative_refinement_weights",
        default: "",
        envVar: "ITERATIVE_REFINEMENT_WEIGHTS",
        effect: "live",
        group: "Routing",
        parentToggle: undefined,
      },
      {
        key: "oscillator_foundation_selection",
        default: "auto",
        envVar: "OSCILLATOR_FOUNDATION_SELECTION",
        effect: "live",
        group: "Routing",
        parentToggle: undefined,
      },
      {
        key: "oscillator_injection_selection",
        default: "divergent",
        envVar: "OSCILLATOR_INJECTION_SELECTION",
        effect: "live",
        group: "Routing",
        parentToggle: undefined,
      },
      {
        key: "oscillator_min_intelligence_gap",
        default: 0,
        envVar: "OSCILLATOR_MIN_INTELLIGENCE_GAP",
        effect: "live",
        group: "Routing",
        parentToggle: undefined,
      },
      {
        key: "oscillator_injection_max_sentences",
        default: 2,
        envVar: "OSCILLATOR_INJECTION_MAX_SENTENCES",
        effect: "live",
        group: "Routing",
        parentToggle: undefined,
      },
      {
        key: "oscillator_load_shed_threshold",
        default: 21,
        envVar: "OSCILLATOR_LOAD_SHED_THRESHOLD",
        effect: "live",
        group: "Routing",
        parentToggle: undefined,
      },
      {
        key: "oscillator_step_timeout_ms",
        default: 30000,
        envVar: "OSCILLATOR_STEP_TIMEOUT_MS",
        effect: "live",
        group: "Routing",
        parentToggle: undefined,
      },
    ]);
  });
});
