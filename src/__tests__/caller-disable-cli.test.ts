import { describe, expect, it } from "vitest";
import type { ModelCallRequest } from "ai-consensus-core";
import { createConsensusCaller } from "../caller.js";

// Contract: CONSENSUS_DISABLE_CLI accepts the usual truthy spellings
// (1/true/yes/on, any case, surrounding whitespace ignored) and fails a CLI
// seat before driver lookup; any other value leaves CLI seats enabled.

const request: ModelCallRequest = {
  participantId: "cliSeat",
  modelId: "m",
  round: 1,
  phase: "initial-analysis",
  system: "s",
  user: "u",
  temperature: 0.7,
  maxOutputTokens: 100,
};

function callWith(value: string | undefined): Promise<unknown> {
  const caller = createConsensusCaller({
    providers: {
      "grok-sub": {
        id: "grok-sub",
        transport: "cli",
        driver: "grok",
        bin: "grok",
        timeoutMs: 120_000,
        authPath: undefined,
      },
    },
    providerByParticipant: { cliSeat: "grok-sub" },
    env: value === undefined ? {} : { CONSENSUS_DISABLE_CLI: value },
  });
  return caller(request);
}

describe("CONSENSUS_DISABLE_CLI", () => {
  it.each(["1", "true", "TRUE", "yes", "Yes", "on", " ON "])(
    "disables CLI seats for %j",
    async (value) => {
      await expect(callWith(value)).rejects.toThrow(
        "CLI transports are disabled by CONSENSUS_DISABLE_CLI",
      );
    },
  );

  it.each([undefined, "", "0", "false", "off", "no", "2"])(
    "leaves CLI seats enabled for %j",
    async (value) => {
      // The seat gets past the switch and fails later (no gate in this test);
      // only the switch's own message would mean it was treated as disabled.
      const err = await callWith(value).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain("CONSENSUS_DISABLE_CLI");
    },
  );
});
