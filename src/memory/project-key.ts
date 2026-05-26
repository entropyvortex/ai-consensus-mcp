// ─────────────────────────────────────────────────────────────
// Project-key derivation
// ─────────────────────────────────────────────────────────────
// One stable, collision-resistant short string per project, derived
// from the absolute resolved path. Used to scope memory storage so
// `/home/alice/code/project-a` and `/home/bob/code/project-a` never
// share storage (premortem F4).

import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

/**
 * Derive the project key for an absolute path. The path MUST already be
 * canonical (`realpath` resolved); pass through `resolveProjectPath()`
 * first if it isn't.
 */
export function projectKeyForPath(absolutePath: string): string {
  const hash = createHash("sha256").update(absolutePath, "utf8").digest("hex");
  return hash.slice(0, 12);
}

/**
 * Canonicalise a path: resolve to absolute and follow symlinks. Used at
 * store-time so the key is stable across symlink topology changes
 * (premortem F4).
 *
 * Falls back to the resolved-but-not-realpathed path if `realpath` fails
 * (path doesn't exist yet, permission denied, etc.) — callers can still
 * store entries against a not-yet-existing project root.
 */
export async function resolveProjectPath(path: string): Promise<string> {
  const absolute = resolvePath(path);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Convenience: resolve + derive in one call. Returns `{ projectPath, projectKey }`
 * where both are guaranteed to be derived from the same canonical string.
 */
export async function resolveProjectIdentity(
  path: string,
): Promise<{ projectPath: string; projectKey: string }> {
  const projectPath = await resolveProjectPath(path);
  return { projectPath, projectKey: projectKeyForPath(projectPath) };
}
