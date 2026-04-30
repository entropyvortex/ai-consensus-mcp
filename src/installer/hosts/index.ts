// ─────────────────────────────────────────────────────────────
// Per-host installer adapters
// ─────────────────────────────────────────────────────────────
// Every supported host stores MCP servers under a top-level
// `mcpServers` map; the only differences are the file path on disk
// and the doc URL we link to in installer output. We codify those
// per-host facts here and reuse the shared atomic merge from
// `host-utils.ts`.
//
// Detection probes both the config file itself and its parent
// directory — a fresh install of e.g. Cursor creates `~/.cursor/`
// before the user has ever opened the MCP settings panel, so the
// dir-existence heuristic catches that.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mergeMcpServerEntry } from "../host-utils.js";
import type { HostInfo, HostId, InstallResult, InstallTarget, InstallerHost } from "../types.js";

interface HostDef {
  id: HostId;
  displayName: string;
  /** Path relative to $HOME — `joined` with the (possibly fake) home at runtime. */
  configPathRelToHome: string;
  docsUrl: string;
  /** Optional extra dirs that count as "host installed" if present. */
  extraDetectDirs?: readonly string[];
}

function makeHost(def: HostDef): InstallerHost {
  const realPath = join(homedir(), def.configPathRelToHome);
  const info: HostInfo = {
    id: def.id,
    displayName: def.displayName,
    configPath: realPath,
    docsUrl: def.docsUrl,
  };

  const resolveConfigPath = (fakeHome: string | undefined): string => {
    if (!fakeHome) return realPath;
    return join(fakeHome, def.configPathRelToHome);
  };

  return {
    ...info,
    detect: ({ fakeHome }: { fakeHome?: string }): Promise<boolean> => {
      const path = resolveConfigPath(fakeHome);
      if (existsSync(path)) return Promise.resolve(true);
      // Parent-dir heuristic only kicks in for nested paths
      // (Cursor's `.cursor/`, Windsurf's `.codeium/windsurf/`). Claude Code's
      // config sits directly in $HOME, whose existence carries no signal.
      if (def.configPathRelToHome.includes("/")) {
        if (existsSync(dirname(path))) return Promise.resolve(true);
      }
      for (const dir of def.extraDetectDirs ?? []) {
        const home = fakeHome ?? homedir();
        if (existsSync(join(home, dir))) return Promise.resolve(true);
      }
      return Promise.resolve(false);
    },
    install: ({
      target,
      force,
      fakeHome,
    }: {
      target: InstallTarget;
      force: boolean;
      fakeHome?: string;
    }): Promise<InstallResult> => {
      const path = resolveConfigPath(fakeHome);
      const hostInfo: HostInfo = { ...info, configPath: path };
      return mergeMcpServerEntry({ host: hostInfo, target, force });
    },
  };
}

export const CLAUDE_CODE_HOST = makeHost({
  id: "claude-code",
  displayName: "Claude Code",
  configPathRelToHome: ".claude.json",
  docsUrl: "https://code.claude.com/docs/en/mcp",
  // .claude/ also exists for many users; treat it as a Claude Code signal.
  extraDetectDirs: [".claude"],
});

export const CURSOR_HOST = makeHost({
  id: "cursor",
  displayName: "Cursor",
  configPathRelToHome: ".cursor/mcp.json",
  docsUrl: "https://cursor.com/docs/mcp",
});

export const WINDSURF_HOST = makeHost({
  id: "windsurf",
  displayName: "Windsurf",
  configPathRelToHome: ".codeium/windsurf/mcp_config.json",
  docsUrl: "https://docs.windsurf.com/windsurf/cascade/mcp",
});

export const ALL_HOSTS: readonly InstallerHost[] = [
  CLAUDE_CODE_HOST,
  CURSOR_HOST,
  WINDSURF_HOST,
] as const;

export function findHost(id: string): InstallerHost | undefined {
  return ALL_HOSTS.find((h) => h.id === id);
}
