// ─────────────────────────────────────────────────────────────
// Bench case-file loader (JSON)
// ─────────────────────────────────────────────────────────────
// Bench cases ship as JSON so users and contributors can add their
// own without writing TypeScript. This module is the boundary that
// validates raw JSON against `BenchCaseFileSchema` and normalises
// the result. Errors carry the source path so CLI feedback points
// at the right file.

import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { BenchCaseFileSchema, type BenchCaseFile } from "./types.js";

export interface LoadCaseFileResult {
  /** Absolute path the cases were loaded from. */
  sourcePath: string;
  /** The parsed and validated case file. */
  file: BenchCaseFile;
}

/**
 * Read a JSON case-file from disk, parse, and validate. Throws an Error
 * with a clear message on any of: read failure, JSON parse failure, or
 * schema-validation failure. The error message includes the absolute
 * source path so CLI output points at the offending file.
 */
export async function loadCaseFile(path: string): Promise<LoadCaseFileResult> {
  const absolute = resolvePath(path);
  let text: string;
  try {
    text = await readFile(absolute, "utf8");
  } catch (err) {
    throw new Error(
      `bench: could not read case file at ${absolute}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `bench: case file at ${absolute} is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const validated = BenchCaseFileSchema.safeParse(parsed);
  if (!validated.success) {
    const detail = validated.error.errors
      .map((e) => `  • ${e.path.join(".") || "<root>"}: ${e.message}`)
      .join("\n");
    throw new Error(`bench: case file at ${absolute} failed validation:\n${detail}`);
  }

  const ids = new Set<string>();
  for (const c of validated.data.cases) {
    if (ids.has(c.id)) {
      throw new Error(`bench: duplicate case id "${c.id}" in ${absolute}.`);
    }
    ids.add(c.id);
  }

  return { sourcePath: absolute, file: validated.data };
}

/**
 * Parse and validate a JSON string without going to disk. Useful for tests
 * and for embedding cases inline.
 */
export function parseCaseFile(json: string, sourceLabel = "<inline>"): BenchCaseFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `bench: ${sourceLabel}: not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const validated = BenchCaseFileSchema.safeParse(parsed);
  if (!validated.success) {
    const detail = validated.error.errors
      .map((e) => `  • ${e.path.join(".") || "<root>"}: ${e.message}`)
      .join("\n");
    throw new Error(`bench: ${sourceLabel}: failed validation:\n${detail}`);
  }
  return validated.data;
}
