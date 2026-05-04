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
      // Don't lower without explicit justification in a CHANGELOG entry.
      //
      // Phase 1.7 ratchet: globals raised from 35→55 after presets module
      // landed at 96% coverage; src/presets/** has its own stricter floor.
      // Phase 2 ratchet: globals raised from 55→78/69/83/80 (stmts/br/fn/li)
      // after adapter HTTP-caller and progress.ts unit tests landed
      // (response to consensus code-review feedback).
      thresholds: {
        statements: 78,
        branches: 69,
        functions: 83,
        lines: 80,
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
