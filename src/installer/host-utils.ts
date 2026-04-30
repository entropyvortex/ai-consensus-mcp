// ─────────────────────────────────────────────────────────────
// Shared helpers for host-config JSON merging
// ─────────────────────────────────────────────────────────────
// Every host (Claude Code, Cursor, Windsurf) stores MCP servers under
// a top-level `mcpServers` map. Differences live in the file path and
// occasional per-host quirks; the merge logic is identical.
//
// All writes are atomic: write to <path>.tmp then rename, so a crash
// mid-write never corrupts the user's config.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { HostInfo, InstallResult, InstallTarget, ServerEntry } from "./types.js";

interface McpServersConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Read an existing host config, or return `{}` if the file does not exist.
 * Throws on any read/parse error other than ENOENT — corrupt config is a
 * loud failure mode, not a silent overwrite trigger.
 */
async function readHostConfig(path: string): Promise<McpServersConfig> {
  if (!existsSync(path)) return {};
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(
      `host config exists but is unreadable: ${path} (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (text.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("config root is not a JSON object");
    }
    return parsed as McpServersConfig;
  } catch (err) {
    throw new Error(
      `host config is not valid JSON: ${path} (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

/**
 * Atomic JSON write: file → .tmp → rename. Never leaves the destination
 * in a partially-written state. Creates parent directories as needed.
 */
async function writeHostConfig(path: string, config: McpServersConfig): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  const serialised = JSON.stringify(config, null, 2);
  await writeFile(tmpPath, `${serialised}\n`, "utf8");
  await rename(tmpPath, path);
}

/**
 * Compare two server entries for semantic equality. Order-independent on
 * `args` would be wrong (args are positional), so we compare them strictly.
 * Env-key order doesn't matter; we compare as records.
 */
function entriesEqual(a: ServerEntry, b: unknown): boolean {
  if (a === null || b === null || typeof b !== "object") return false;
  const obj = b as Partial<ServerEntry>;
  if (obj.type !== a.type) return false;
  if (obj.command !== a.command) return false;
  if (!Array.isArray(obj.args) || obj.args.length !== a.args.length) return false;
  for (let i = 0; i < a.args.length; i++) {
    if (obj.args[i] !== a.args[i]) return false;
  }
  const aEnv = a.env ?? {};
  const bEnv = obj.env ?? {};
  const aKeys = Object.keys(aEnv).sort();
  const bKeys = Object.keys(bEnv).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
    if (aEnv[aKeys[i]!] !== bEnv[aKeys[i]!]) return false;
  }
  return true;
}

/**
 * Merge an MCP-server entry into a host's config under `mcpServers[name]`.
 *
 * Behaviour:
 *   - Preserves every other top-level key in the config (Claude Code's
 *     .claude.json holds far more than just `mcpServers`).
 *   - If `mcpServers[name]` is absent, writes it.
 *   - If present and structurally identical to `target.entry`, does nothing
 *     and returns `{ alreadyPresent: true }`.
 *   - If present but different and `force=false`, refuses (returns ok=false
 *     so the user can rerun with `--force` if they meant to clobber).
 *   - If present and `force=true`, overwrites.
 */
export async function mergeMcpServerEntry(args: {
  host: HostInfo;
  target: InstallTarget;
  force: boolean;
}): Promise<InstallResult> {
  const { host, target, force } = args;
  const path = host.configPath;

  let config: McpServersConfig;
  try {
    config = await readHostConfig(path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      host,
      ok: false,
      alreadyPresent: false,
      message: `${host.displayName}: failed to read config — ${message}`,
      error: message,
    };
  }

  const servers = (config.mcpServers ??= {});
  const existing = servers[target.serverName];

  if (existing !== undefined) {
    if (entriesEqual(target.entry, existing)) {
      return {
        host,
        ok: true,
        alreadyPresent: true,
        message: `${host.displayName}: already registered (${target.serverName}) — no changes.`,
      };
    }
    if (!force) {
      return {
        host,
        ok: false,
        alreadyPresent: true,
        message: `${host.displayName}: an entry named "${target.serverName}" already exists with different settings. Re-run with --force to overwrite.`,
        error: "entry exists with different settings",
      };
    }
  }

  servers[target.serverName] = target.entry;

  try {
    await writeHostConfig(path, config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      host,
      ok: false,
      alreadyPresent: existing !== undefined,
      message: `${host.displayName}: failed to write config — ${message}`,
      error: message,
    };
  }

  return {
    host,
    ok: true,
    alreadyPresent: false,
    message:
      existing === undefined
        ? `${host.displayName}: registered "${target.serverName}" at ${path}.`
        : `${host.displayName}: overwrote "${target.serverName}" at ${path}.`,
  };
}

/**
 * Test-only: read back a host config so installer tests can assert what
 * was written. Not exported through the package's public API.
 */
export async function readHostConfigForTest(path: string): Promise<McpServersConfig> {
  return readHostConfig(path);
}
