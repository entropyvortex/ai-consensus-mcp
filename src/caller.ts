// ─────────────────────────────────────────────────────────────
// Consensus caller — HTTP today, CLI seat stub until a driver lands
// ─────────────────────────────────────────────────────────────
// HTTP providers delegate to the existing OpenAI-compatible adapter.
// A CLI provider throws a seat Error. Nothing is spawned. The in-flight
// semaphore is intentionally absent until the runner lands.

import type { ModelCaller } from "ai-consensus-core";
import { createOpenAICompatibleCaller } from "./adapter.js";
import type { ResolvedProvider } from "./config.js";

export interface ConsensusCallerOptions {
  providers: Record<string, ResolvedProvider>;
  providerByParticipant: Record<string, string>;
  /**
   * Defaults to `process.env`. `CONSENSUS_DISABLE_CLI=1` fails each CLI
   * call before any driver lookup. HTTP calls ignore the switch.
   */
  env?: NodeJS.ProcessEnv;
}

export function createConsensusCaller(opts: ConsensusCallerOptions): ModelCaller {
  const httpCaller = createOpenAICompatibleCaller({
    providers: opts.providers,
    providerByParticipant: opts.providerByParticipant,
  });
  return async (req) => {
    const providerId = opts.providerByParticipant[req.participantId];
    const provider = providerId !== undefined ? opts.providers[providerId] : undefined;
    if (provider?.transport === "cli") {
      const env = opts.env ?? process.env;
      if (env["CONSENSUS_DISABLE_CLI"] === "1") {
        throw new Error("CLI transports are disabled by CONSENSUS_DISABLE_CLI");
      }
      throw new Error(`cli driver "${provider.driver}" is not registered`);
    }
    return httpCaller(req);
  };
}
