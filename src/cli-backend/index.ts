// CLI driver registry. PR 2 registers grok only. Claude and codex stay
// unregistered so a seat for those drivers throws rather than spawning.

import type { ModelCallRequest, ModelCallResponse } from "ai-consensus-core";
import type { ResolvedCliProvider, ResolvedProvider } from "../config.js";
import { probeGrok, runGrok } from "./drivers/grok.js";
import { abortException } from "./gate.js";
import { assertCliPlatform } from "./runner.js";
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

// In-flight probes keyed by the shared readiness cache, so every caller and
// the startup probe that share one cache also share one spawn per provider.
const inflightProbes = new WeakMap<Map<string, ReadinessState>, Map<string, Promise<void>>>();

function raceAbort(work: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(abortException());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      reject(abortException());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err instanceof Error || err instanceof DOMException ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Runs the driver's readiness probe unless a success is cached.
 * A cached failure is dropped first: the fix is usually "install the CLI"
 * or "run the login command", and that must work without a restart.
 * Concurrent callers sharing `deps.readinessCache` share one probe; the
 * shared probe runs without any one caller's signal, and each caller can
 * still abort its own wait.
 */
export async function ensureCliReady(
  driver: CliDriver,
  provider: ResolvedCliProvider,
  deps: CliRuntimeDeps,
  signal?: AbortSignal,
): Promise<void> {
  const cache = deps.readinessCache;
  if (!cache) {
    await driver.probe(provider, deps, signal);
    return;
  }
  const cached = cache.get(provider.id);
  if (cached?.ok) return;
  if (cached) cache.delete(provider.id);
  let inflight = inflightProbes.get(cache);
  if (!inflight) {
    inflight = new Map();
    inflightProbes.set(cache, inflight);
  }
  const table = inflight;
  let shared = table.get(provider.id);
  if (!shared) {
    shared = driver.probe(provider, deps).finally(() => {
      table.delete(provider.id);
    });
    table.set(provider.id, shared);
  }
  await raceAbort(shared, signal);
}

export async function probeCliProviders(args: {
  providers: Record<string, ResolvedProvider>;
  env?: NodeJS.ProcessEnv;
  cache?: Map<string, ReadinessState>;
  spawnImpl?: SpawnLike;
  accessImpl?: AccessLike;
  scheduleTimeout?: ScheduleTimeout;
  log?: (line: string) => void;
  homedir?: () => string;
  platform?: NodeJS.Platform;
}): Promise<string> {
  const cliProviders = Object.values(args.providers).filter(
    (provider): provider is ResolvedCliProvider => provider.transport === "cli",
  );
  if (cliProviders.length === 0) return "";
  const env = args.env ?? process.env;
  if (env["CONSENSUS_DISABLE_CLI"] === "1") {
    return "ai-consensus-mcp: CLI transports are disabled by CONSENSUS_DISABLE_CLI\n";
  }
  try {
    assertCliPlatform(args.platform);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `ai-consensus-mcp: cli readiness failed: ${message}\n`;
  }
  const deps: CliRuntimeDeps = {
    env,
    spawnImpl: args.spawnImpl,
    accessImpl: args.accessImpl,
    scheduleTimeout: args.scheduleTimeout,
    log: args.log,
    readinessCache: args.cache,
    homedir: args.homedir,
  };
  // Probes run in parallel; one slow CLI does not delay the others. Lines
  // keep provider order.
  const lines = await Promise.all(
    cliProviders.map(async (provider) => {
      const driver = getRegisteredDriver(provider.driver);
      if (!driver) {
        return `ai-consensus-mcp: cli readiness provider=${provider.id} driver=${provider.driver} failed: cli driver "${provider.driver}" is not registered\n`;
      }
      try {
        await ensureCliReady(driver, provider, deps);
        return `ai-consensus-mcp: cli readiness provider=${provider.id} driver=${provider.driver} ok\n`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `ai-consensus-mcp: cli readiness provider=${provider.id} driver=${provider.driver} failed: ${message}\n`;
      }
    }),
  );
  return lines.join("");
}

export { CliGate, abortException } from "./gate.js";
export { buildChildEnv } from "./env.js";
export { GROK_SYSTEM_OVERRIDE, GROK_INSTALL_URL, GROK_LOGIN } from "./drivers/grok.js";
export { ORACLE_JSON_SCHEMA_TEXT } from "./normalize.js";
export type { CliRuntimeDeps, ReadinessState, SpawnLike } from "./runner.js";
