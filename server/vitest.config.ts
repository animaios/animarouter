import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "cobertura"],
      reportsDirectory: "./coverage",
      reportOnFailure: true,
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/__tests__/**", "src/db/migrations/**"],
    },
  },
});
