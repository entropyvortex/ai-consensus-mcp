// CLI driver registry. PR 2 registers grok only. Claude and codex stay
// unregistered so a seat for those drivers throws rather than spawning.

import type { ModelCallRequest, ModelCallResponse } from "ai-consensus-core";
import type { ResolvedCliProvider, ResolvedProvider } from "../config.js";
import { probeGrok, runGrok } from "./drivers/grok.js";
import type {
  CliRuntimeDeps,
  ReadinessState,
  SpawnLike,
  ScheduleTimeout,
  AccessLike,
} from "./runner.js";

export interface CliDriver {
  probe: (
    provider: ResolvedCliProvider,
    deps: CliRuntimeDeps,
    signal?: AbortSignal,
  ) => Promise<void>;
  run: (
    provider: ResolvedCliProvider,
    req: ModelCallRequest,
    deps: CliRuntimeDeps,
  ) => Promise<ModelCallResponse>;
}

const DRIVERS: Partial<Record<ResolvedCliProvider["driver"], CliDriver>> = {
  grok: { probe: probeGrok, run: runGrok },
};

export function getRegisteredDriver(driver: ResolvedCliProvider["driver"]): CliDriver | undefined {
  return DRIVERS[driver];
}

const samplingNoted = new Set<string>();

export function noteIgnoredSampling(driver: string, log: (line: string) => void): void {
  if (samplingNoted.has(driver)) return;
  samplingNoted.add(driver);
  log(`ai-consensus-mcp: cli driver ${driver} ignores temperature and maxOutputTokens\n`);
}

export function resetCliProcessNotices(): void {
  samplingNoted.clear();
}

export async function probeCliProviders(args: {
  providers: Record<string, ResolvedProvider>;
  env?: NodeJS.ProcessEnv;
  cache?: Map<string, ReadinessState>;
  spawnImpl?: SpawnLike;
  accessImpl?: AccessLike;
  scheduleTimeout?: ScheduleTimeout;
  log?: (line: string) => void;
}): Promise<string> {
  const cliProviders = Object.values(args.providers).filter(
    (provider): provider is ResolvedCliProvider => provider.transport === "cli",
  );
  if (cliProviders.length === 0) return "";
  const env = args.env ?? process.env;
  if (env["CONSENSUS_DISABLE_CLI"] === "1") {
    return "ai-consensus-mcp: CLI transports are disabled by CONSENSUS_DISABLE_CLI\n";
  }
  const lines: string[] = [];
  const deps: CliRuntimeDeps = {
    env,
    spawnImpl: args.spawnImpl,
    accessImpl: args.accessImpl,
    scheduleTimeout: args.scheduleTimeout,
    log: args.log,
    readinessCache: args.cache,
  };
  for (const provider of cliProviders) {
    const driver = getRegisteredDriver(provider.driver);
    if (!driver) {
      lines.push(
        `ai-consensus-mcp: cli readiness provider=${provider.id} driver=${provider.driver} failed: cli driver "${provider.driver}" is not registered\n`,
      );
      continue;
    }
    try {
      await driver.probe(provider, deps);
      lines.push(
        `ai-consensus-mcp: cli readiness provider=${provider.id} driver=${provider.driver} ok\n`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lines.push(
        `ai-consensus-mcp: cli readiness provider=${provider.id} driver=${provider.driver} failed: ${message}\n`,
      );
    }
  }
  return lines.join("");
}

export { CliGate, abortException } from "./gate.js";
export { buildChildEnv } from "./env.js";
export { GROK_SYSTEM_OVERRIDE, GROK_INSTALL_URL, GROK_LOGIN } from "./drivers/grok.js";
export { ORACLE_JSON_SCHEMA_TEXT, ORACLE_JSON_SCHEMA } from "./normalize.js";
export type { CliRuntimeDeps, ReadinessState, SpawnLike } from "./runner.js";
