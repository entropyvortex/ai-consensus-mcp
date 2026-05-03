import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
    globals: false,
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      // src/index.ts: thin runtime shim, exercised via the smoke test.
      // src/cli/config.ts: interactive TUI flow — covered end-to-end by
      // the smoke test (`scripts/smoke-stdio.mjs` style); unit-mocking
      // every @inquirer prompt would be more brittle than the value adds.
      exclude: ["src/**/__tests__/**", "src/index.ts", "src/cli/config.ts"],
      // Thresholds anchored at the current baseline as a regression guard.
      // Ratchet: every phase that introduces tested modules raises the floor.
      // Target by Phase 5 is statements ≥75 globally and ≥85 on new modules.
      // Don't lower without explicit justification in a CHANGELOG entry.
      //
      // Phase 1.7 ratchet: globals raised from 35→55 after presets module
      // landed at 96% coverage; src/presets/** has its own stricter floor.
      thresholds: {
        statements: 55,
        branches: 47,
        functions: 57,
        lines: 55,
        "src/presets/**/*.ts": {
          statements: 90,
          branches: 75,
          functions: 95,
          lines: 90,
        },
      },
    },
  },
});
