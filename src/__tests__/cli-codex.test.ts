import { describe, expect, it, vi } from "vitest";
import { createConsensusCaller } from "../caller.js";
import {
  CODEX_ORACLE_FLAGS_VERIFIED,
  CODEX_REQUIRED_GATE_FLAGS,
  assertCodexDriverAllowed,
  codexDriverRefusalMessage,
  getRegisteredDriver,
} from "../cli-backend/index.js";
import { CliGate } from "../cli-backend/gate.js";
import { resolveConfigFromRaw, type RawConfig, type ResolvedCliProvider } from "../config.js";

function codexRaw(bin?: string): RawConfig {
  return {
    providers: {
      "codex-sub": {
        transport: "cli",
        driver: "codex",
        ...(bin !== undefined ? { bin } : {}),
      },
      openai: {
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
      },
    },
    participants: [
      {
        id: "c1",
        provider: "codex-sub",
        modelId: "gpt-5",
        personaId: "devils-advocate",
      },
      {
        id: "h1",
        provider: "openai",
        modelId: "gpt-4o",
        personaId: "domain-expert",
      },
    ],
  };
}

describe("codex driver refusal", () => {
  it("does not claim oracle flags were verified on this host", () => {
    expect(CODEX_ORACLE_FLAGS_VERIFIED).toBe(false);
    expect([...CODEX_REQUIRED_GATE_FLAGS]).toEqual(["--sandbox read-only", "approval never"]);
  });

  it("names the missing gate flags in the refusal message", () => {
    const message = codexDriverRefusalMessage("codex");
    expect(message).toContain("codex driver refused");
    expect(message).toContain('missing from "codex exec --help"');
    expect(message).toContain("--sandbox read-only");
    expect(message).toContain("approval never");
  });

  it("fails at resolve with the missing-flag message", () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    expect(() => resolveConfigFromRaw(codexRaw(), "test://codex-refuse")).toThrow(
      codexDriverRefusalMessage("codex"),
    );
    expect(() => assertCodexDriverAllowed("codex")).toThrow(codexDriverRefusalMessage("codex"));
  });

  it("uses the configured bin name in the resolve refusal", () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    expect(() => resolveConfigFromRaw(codexRaw("/opt/codex"), "test://codex-refuse-bin")).toThrow(
      codexDriverRefusalMessage("/opt/codex"),
    );
  });

  it("does not register a spawn path and never calls spawn", async () => {
    expect(getRegisteredDriver("codex")).toBeUndefined();

    let spawns = 0;
    const provider: ResolvedCliProvider = {
      id: "codex-sub",
      transport: "cli",
      driver: "codex",
      bin: "codex",
      timeoutMs: 120_000,
      authPath: undefined,
    };
    const caller = createConsensusCaller({
      providers: { "codex-sub": provider },
      providerByParticipant: { x: "codex-sub" },
      cliGate: new CliGate(2),
      spawnImpl: () => {
        spawns += 1;
        throw new Error("spawn must not run for refused codex");
      },
    });
    await expect(
      caller({
        participantId: "x",
        modelId: "gpt-5",
        round: 1,
        phase: "initial-analysis",
        system: "sys",
        user: "user",
        temperature: 0.7,
        maxOutputTokens: 1500,
      }),
    ).rejects.toThrow('cli driver "codex" is not registered');
    expect(spawns).toBe(0);
  });
});
