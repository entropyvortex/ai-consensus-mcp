// ─────────────────────────────────────────────────────────────
// `install` subcommand — registers the server with detected hosts
// ─────────────────────────────────────────────────────────────
// Detects which MCP hosts (Claude Code, Cursor, Windsurf) are
// installed by probing their config-file paths, then merges a
// stdio entry into each one's mcpServers map. Atomic writes; never
// clobbers existing entries unless --force.
//
// All output goes to stderr; stdout stays clean in case this command
// is ever wrapped by another tool that pipes it.

import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { detectHosts } from "../installer/detect.js";
import { ALL_HOSTS, findHost } from "../installer/hosts/index.js";
import type { HostId, InstallResult, InstallTarget, ServerEntry } from "../installer/types.js";
import { SERVER_NAME } from "../version.js";

export interface InstallArgs {
  hosts: HostId[] | undefined;
  yes: boolean;
  force: boolean;
  configPath: string | undefined;
  serverName: string;
  command: string | undefined;
  help: boolean;
  listHosts: boolean;
}

const INSTALL_HELP = `
${SERVER_NAME} install — register the server with installed MCP hosts

Usage:
  ai-consensus-mcp install --config /abs/path/to/consensus.config.json
  ai-consensus-mcp install --hosts claude-code,cursor --config <path>
  ai-consensus-mcp install --list-hosts

Flags:
  -c, --config <path>      Path to your consensus.config.json (required —
                           the installer registers a stdio command that
                           needs to know which config to load).
      --hosts <list>       Comma-separated host ids (claude-code,cursor,
                           windsurf). Defaults to every detected host.
      --name <id>          Server name (key under mcpServers in each host's
                           config). Defaults to "consensus".
      --command <cmd>      Override the registered command. Defaults to
                           "npx" with args [-y, ai-consensus-mcp, serve,
                           --config, <path>] for portability across global
                           and per-project installs. Set to "ai-consensus-mcp"
                           if you have it on PATH and want lower startup
                           latency.
  -f, --force              Overwrite an existing entry that points elsewhere.
  -y, --yes                Non-interactive (reserved for future prompts;
                           currently a no-op).
      --list-hosts         Print which hosts are detected and exit.
  -h, --help               Show this help.

Supported hosts (April 2026):
  • claude-code   — ~/.claude.json
  • cursor        — ~/.cursor/mcp.json
  • windsurf      — ~/.codeium/windsurf/mcp_config.json

The installer is atomic and merge-only. It never clobbers other top-level
fields in your host's config (Claude Code's .claude.json holds a lot more
than just mcpServers). If an entry named <server-name> already exists with
different settings, the installer refuses unless --force is passed.
`;

export function parseInstallArgs(argv: readonly string[]): InstallArgs | Error {
  const out: InstallArgs = {
    hosts: undefined,
    yes: false,
    force: false,
    configPath: undefined,
    serverName: "consensus",
    command: undefined,
    help: false,
    listHosts: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const takeValue = (flag: string): string | Error => {
      const next = argv[++i];
      if (next === undefined) return new Error(`Missing value for ${flag}`);
      return next;
    };
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--yes" || arg === "-y") out.yes = true;
    else if (arg === "--force" || arg === "-f") out.force = true;
    else if (arg === "--list-hosts") out.listHosts = true;
    else if (arg === "--config" || arg === "-c") {
      const v = takeValue(arg);
      if (v instanceof Error) return v;
      out.configPath = v;
    } else if (arg.startsWith("--config=")) {
      out.configPath = arg.slice("--config=".length);
    } else if (arg === "--hosts") {
      const v = takeValue(arg);
      if (v instanceof Error) return v;
      const parsed = parseHostList(v);
      if (parsed instanceof Error) return parsed;
      out.hosts = parsed;
    } else if (arg.startsWith("--hosts=")) {
      const parsed = parseHostList(arg.slice("--hosts=".length));
      if (parsed instanceof Error) return parsed;
      out.hosts = parsed;
    } else if (arg === "--name") {
      const v = takeValue(arg);
      if (v instanceof Error) return v;
      out.serverName = v;
    } else if (arg.startsWith("--name=")) {
      out.serverName = arg.slice("--name=".length);
    } else if (arg === "--command") {
      const v = takeValue(arg);
      if (v instanceof Error) return v;
      out.command = v;
    } else if (arg.startsWith("--command=")) {
      out.command = arg.slice("--command=".length);
    } else {
      return new Error(`Unknown argument: ${arg}`);
    }
  }
  return out;
}

function parseHostList(value: string): HostId[] | Error {
  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const known = new Set(ALL_HOSTS.map((h) => h.id));
  const out: HostId[] = [];
  for (const p of parts) {
    if (!known.has(p as HostId)) {
      return new Error(`Unknown host id "${p}". Known: ${[...known].join(", ")}.`);
    }
    out.push(p as HostId);
  }
  if (out.length === 0) return new Error("--hosts: no valid host ids");
  return out;
}

export function buildEntry(args: { command: string | undefined; configAbs: string }): ServerEntry {
  const { command, configAbs } = args;
  if (command === undefined) {
    return {
      type: "stdio",
      command: "npx",
      args: ["-y", "ai-consensus-mcp", "serve", "--config", configAbs],
    };
  }
  return {
    type: "stdio",
    command,
    args: ["serve", "--config", configAbs],
  };
}

export async function runInstall(argv: readonly string[]): Promise<number> {
  const parsed = parseInstallArgs(argv);
  if (parsed instanceof Error) {
    process.stderr.write(`${SERVER_NAME}: ${parsed.message}\n${INSTALL_HELP}\n`);
    return 2;
  }
  if (parsed.help) {
    process.stderr.write(`${INSTALL_HELP}\n`);
    return 0;
  }

  if (parsed.listHosts) {
    const detected = await detectHosts();
    process.stderr.write(`\n${SERVER_NAME} install — host detection\n`);
    for (const h of detected) {
      const tag = h.detected ? "✓ detected" : "  not detected";
      process.stderr.write(`  ${tag}  ${h.id.padEnd(12)} ${h.configPath}\n`);
    }
    process.stderr.write(`\nUse --hosts <id,...> to register against specific hosts.\n`);
    return 0;
  }

  if (!parsed.configPath) {
    process.stderr.write(
      `${SERVER_NAME}: install requires --config <path-to-your-consensus.config.json>.\n${INSTALL_HELP}\n`,
    );
    return 2;
  }

  const configAbs = resolvePath(parsed.configPath);
  if (!existsSync(configAbs)) {
    process.stderr.write(
      `${SERVER_NAME}: --config path "${configAbs}" doesn't exist. Create your consensus.config.json (see README) before running install.\n`,
    );
    return 2;
  }

  const detected = await detectHosts();
  const targetHosts = parsed.hosts
    ? detected.filter((h) => parsed.hosts!.includes(h.id))
    : detected.filter((h) => h.detected);

  if (targetHosts.length === 0) {
    process.stderr.write(
      parsed.hosts
        ? `${SERVER_NAME}: none of the requested hosts (${parsed.hosts.join(", ")}) match a known id.\n`
        : `${SERVER_NAME}: no MCP hosts detected. Pass --hosts <id,...> to register explicitly. Known: ${ALL_HOSTS.map((h) => h.id).join(", ")}.\n`,
    );
    return 2;
  }

  const target: InstallTarget = {
    serverName: parsed.serverName,
    entry: buildEntry({ command: parsed.command, configAbs }),
  };

  process.stderr.write(`\n${SERVER_NAME} install — registering "${parsed.serverName}"\n`);
  process.stderr.write(`  command: ${target.entry.command} ${target.entry.args.join(" ")}\n\n`);

  const results: InstallResult[] = [];
  for (const detectedHost of targetHosts) {
    const installer = findHost(detectedHost.id);
    if (!installer) {
      // Should be unreachable given parseHostList validates against ALL_HOSTS.
      results.push({
        host: detectedHost,
        ok: false,
        alreadyPresent: false,
        message: `${detectedHost.displayName}: internal — host adapter not found`,
        error: "host adapter missing",
      });
      continue;
    }
    const result = await installer.install({ target, force: parsed.force });
    results.push(result);
  }

  for (const r of results) {
    process.stderr.write(`  ${r.ok ? "✓" : "✗"} ${r.message}\n`);
  }

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;
  process.stderr.write(`\n${okCount} ok, ${failCount} failed.\n`);

  if (failCount > 0) {
    process.stderr.write(
      `\nTip: rerun with --force to overwrite an existing entry, or --hosts <id> to scope the run.\n`,
    );
    return 1;
  }

  process.stderr.write(
    `\nNext: restart the affected MCP host(s). The "${parsed.serverName}" server should appear with 6 tools (consensus + 5 presets).\n`,
  );
  return 0;
}
