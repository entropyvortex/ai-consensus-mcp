// ─────────────────────────────────────────────────────────────
// Built-in bench fixtures
// ─────────────────────────────────────────────────────────────
// Ships a small but representative set of cases for each major panel
// family. Stored as JSON next to this file so users can copy and edit
// them; loaded with the same `BenchCaseFileSchema` used for user
// case files, so the validator is the only path that touches them.

import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { BenchCaseFileSchema, type BenchCase, type BenchCaseFile } from "./types.js";

const FIXTURES_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), "fixtures");

export interface LoadedFixture {
  /** Absolute path on disk (for diagnostics). */
  path: string;
  /** Bare filename, e.g. "architecture.json". */
  name: string;
  file: BenchCaseFile;
}

/**
 * Load every JSON file in the built-in fixtures directory. Throws if any
 * fixture fails validation — the built-ins must always be valid because
 * they double as the example for users authoring their own case-files.
 */
export async function loadBuiltInFixtures(): Promise<LoadedFixture[]> {
  const entries = await readdir(FIXTURES_DIR);
  const jsonFiles = entries.filter((e) => e.endsWith(".json")).sort();
  const out: LoadedFixture[] = [];
  for (const name of jsonFiles) {
    const path = join(FIXTURES_DIR, name);
    const text = await readFile(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(
        `bench: built-in fixture ${path} is not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const validated = BenchCaseFileSchema.safeParse(parsed);
    if (!validated.success) {
      const detail = validated.error.errors
        .map((e) => `  • ${e.path.join(".") || "<root>"}: ${e.message}`)
        .join("\n");
      throw new Error(`bench: built-in fixture ${path} failed validation:\n${detail}`);
    }
    out.push({ path, name, file: validated.data });
  }
  return out;
}

/**
 * Concatenate every fixture's cases into a single flat list. Convenient for
 * "run the bench against all built-in fixtures" without bookkeeping.
 */
export async function allBuiltInCases(): Promise<BenchCase[]> {
  const loaded = await loadBuiltInFixtures();
  return loaded.flatMap((l) => l.file.cases);
}

/**
 * Return the cases from built-in fixtures filtered to a single panel id.
 * Each fixture's `cases` may target multiple panels; this collapses to one.
 */
export async function builtInCasesForPanel(panelId: string): Promise<BenchCase[]> {
  const cases = await allBuiltInCases();
  return cases.filter((c) => !c.panelId || c.panelId === panelId);
}

/** Absolute path of the directory shipping the built-in fixtures. */
export const BUILT_IN_FIXTURES_DIR = FIXTURES_DIR;
