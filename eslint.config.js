import tseslint from "typescript-eslint";

// Threshold 60: catches genuinely over-complex functions (>60 branch points)
// without noise from legitimate switch/if chains (provider translation code,
// event handlers, cooldown heuristics). Industry standard is 20, but a
// proxy/router codebase naturally runs higher; 60 still flags the worst
// offenders without requiring a sweeping refactor of legacy handlers.
const MAX_COMPLEXITY = 60;

export default tseslint.config(
  {
    ignores: [
      "**/dist",
      "dist/",
      "node_modules",
      "coverage",
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/__tests__/**",
      "**/*.d.ts",
    ],
  },
  tseslint.configs.base,
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      complexity: ["error", { max: MAX_COMPLEXITY }],
    },
  },
  {
    // scripts/ lacks a tsconfig; use JS-aware rules only
    files: ["scripts/**/*.mjs", "scripts/**/*.cjs"],
    ...tseslint.configs.base,
    rules: { complexity: ["error", { max: MAX_COMPLEXITY }] },
  },
);
