// ─────────────────────────────────────────────────────────────
// Consensus caller — HTTP adapter or a registered CLI oracle
// ─────────────────────────────────────────────────────────────
// HTTP never acquires the process CLI gate. A CLI call with no gate
// throws a seat Error before spawn. Claude and codex stay unregistered
// until their driver PRs.

import type { ModelCaller, ModelCallRequest } from "ai-consensus-core";
import { createOpenAICompatibleCaller } from "./adapter.js";
import {
  ensureCliReady,
  getRegisteredDriver,
  noteIgnoredSampling,
  type CliRuntimeDeps,
} from "./cli-backend/index.js";
import { abortException, type CliGate } from "./cli-backend/gate.js";
import { assertCliPlatform } from "./cli-backend/runner.js";
import type { ResolvedProvider } from "./config.js";

export interface McpServerDeps extends CliRuntimeDeps {
  /**
   * Process-wide cap. `runServe`, bench, and (when linked) the Node HTTP
   * server each construct one and pass that same object into every
   * `createMcpServer`. This module does not construct a gate.
   */
  cliGate?: CliGate;
}

export interface ConsensusCallerOptions extends McpServerDeps {
  providers: Record<string, ResolvedProvider>;
  providerByParticipant: Record<string, string>;
}

function toolsRefused(req: ModelCallRequest): boolean {
  return (
    (req.tools !== undefined && req.tools.length > 0) ||
    (req.toolCallTurns !== undefined && req.toolCallTurns.length > 0)
  );
}

export function createConsensusCaller(opts: ConsensusCallerOptions): ModelCaller {
  const httpCaller = createOpenAICompatibleCaller({
    providers: opts.providers,
    providerByParticipant: opts.providerByParticipant,
  });
  const log =
    opts.log ??
    ((line: string) => {
      process.stderr.write(line);
    });
  return async (req) => {
    const providerId = opts.providerByParticipant[req.participantId];
    const provider = providerId !== undefined ? opts.providers[providerId] : undefined;
    if (provider?.transport !== "cli") {
      return httpCaller(req);
    }

    const env = opts.env ?? process.env;
    if (req.signal?.aborted) {
      throw abortException();
    }
    if (isTruthyFlag(env["CONSENSUS_DISABLE_CLI"])) {
      throw new Error("CLI transports are disabled by CONSENSUS_DISABLE_CLI");
    }

    assertCliPlatform(opts.platform);

    const driver = getRegisteredDriver(provider.driver);
    if (!driver) {
      throw new Error(`cli driver "${provider.driver}" is not registered`);
    }
    if (toolsRefused(req)) {
      throw new Error(
        `ai-consensus-mcp: cli provider "${provider.id}" (driver ${provider.driver}) is a text oracle and cannot run tools. ` +
          `Remove tools from this participant, or point it at an http provider.`,
      );
    }
    if (!opts.cliGate) {
      throw new Error("cli gate was not provided");
    }

    noteIgnoredSampling(provider.driver, log);
    const runtime: CliRuntimeDeps = {
      spawnImpl: opts.spawnImpl,
      scheduleTimeout: opts.scheduleTimeout,
      env,
      log,
      mkdtempImpl: opts.mkdtempImpl,
      rmImpl: opts.rmImpl,
      accessImpl: opts.accessImpl,
      readinessCache: opts.readinessCache,
      now: opts.now,
      killGraceMs: opts.killGraceMs,
      homedir: opts.homedir,
      platform: opts.platform,
    };
    await ensureCliReady(driver, provider, runtime, req.signal);

    await opts.cliGate.acquire(req.signal);
    try {
      if (req.signal?.aborted) {
        throw abortException();
      }
      const result = await driver.run(provider, req, runtime);
      if (req.onToken) req.onToken(result.content);
      return result;
    } finally {
      opts.cliGate.release();
    }
  };
}

const TRUTHY_FLAGS = new Set(["1", "true", "yes", "on"]);

function isTruthyFlag(value: string | undefined): boolean {
  return value !== undefined && TRUTHY_FLAGS.has(value.trim().toLowerCase());
}
