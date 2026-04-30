// Flat config (eslint v9+). Rules are tuned to match the existing
// hand-written style of this codebase: type-only imports enforced,
// strict TypeScript leaning into the strict tsconfig already in place,
// and Prettier handed all formatting concerns via eslint-config-prettier.

import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**", "*.tsbuildinfo"],
  },
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
      // process.env["FOO"] and Record<string, T> bracket access are deliberate
      // conventions in this codebase (greppable env-var lookups; explicit index
      // access). Don't auto-rewrite them to dot notation.
      "@typescript-eslint/dot-notation": [
        "error",
        { allowIndexSignaturePropertyAccess: true },
      ],
      // The codebase has a few legitimate `as` casts at MCP/JSON boundaries
      // and existing uses of type predicates; downgrade these to warnings
      // instead of breaking the green build on Phase 0 day one.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
    },
  },
  {
    files: ["src/**/__tests__/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-call": "off",
    },
  },
  prettier,
);
