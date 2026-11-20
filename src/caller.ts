// ─────────────────────────────────────────────────────────────
// Consensus caller — HTTP adapter or a registered CLI oracle
// ─────────────────────────────────────────────────────────────
// HTTP never acquires the process CLI gate. A CLI call with no gate
// throws a seat Error before spawn. An unregistered driver throws a seat Error.

import type { ModelCaller, ModelCallRequest } from "ai-consensus-core";
import { createOpenAICompatibleCaller } from "./adapter.js";
import {
  ensureCliReady,
  getRegisteredDriver,
  noteIgnoredSampling,
  type CliRuntimeDeps,
} from "./cli-backend/index.js";
import { isTruthyFlag } from "./cli-backend/flags.js";
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
  /**
   * Enables consensus_list_attempts and consensus_compare_attempts. Set by
   * the stdio entry point only: these tools read local repositories, so
   * remote (HTTP / Workers) callers never get them.
   */
  repoTools?: {
    /** Allow `testCommand` (executes repository code). Off unless --allow-test-command. */
    allowTestCommand: boolean;
  };
}

export interface ConsensusCallerOptions extends McpServerDeps {
  providers: Record<string, ResolvedProvider>;
  providerByParticipant: Record<string, string>;
  /**
   * JSON Schema a CLI seat must enforce for this request (e.g. an
   * adjudication juror verdict), replacing the oracle schema. HTTP seats
   * ignore it: their prompt carries the contract.
   */
  jsonSchemaFor?: (req: ModelCallRequest) => Record<string, unknown> | undefined;
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
      const jsonSchema = opts.jsonSchemaFor?.(req);
      const result = await driver.run(
        provider,
        req,
        runtime,
        jsonSchema ? { jsonSchema } : undefined,
      );
      if (req.onToken) req.onToken(result.content);
      return result;
    } finally {
      opts.cliGate.release();
    }
  };
}
