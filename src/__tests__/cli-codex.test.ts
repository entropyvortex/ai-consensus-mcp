import { describe, expect, it, vi } from "vitest";
import { createConsensusCaller } from "../caller.js";
import {
  CODEX_REQUIRED_GATE_FLAGS,
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
  // Contract: the refusal states what is true — the driver is not
  // implemented and its flags were never checked — and never claims a help
  // check that did not run. It names the gate flags, the provider and the seat.
  it("refuses with an honest not-implemented message", () => {
    const message = codexDriverRefusalMessage("codex-sub", "c1");
    expect(message).toContain("codex driver is not yet implemented");
    expect(message).toContain('have not been verified against "codex exec --help"');
    for (const flag of CODEX_REQUIRED_GATE_FLAGS) expect(message).toContain(flag);
    expect(message).toContain('Provider "codex-sub"');
    expect(message).toContain('"c1"');
    expect(message).not.toContain("missing from");
  });

  // Contract: an unused codex provider entry does not stop the server from
  // starting; HTTP participants in the same file still load.
  it("loads a config whose codex provider no seat uses", () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const raw = codexRaw();
    raw.participants = raw.participants.filter((p) => p.provider !== "codex-sub");
    raw.participants.push({
      id: "h2",
      provider: "openai",
      modelId: "gpt-4o",
      personaId: "devils-advocate",
    });
    const cfg = resolveConfigFromRaw(raw, "test://codex-unused");
    expect(cfg.participants.map((p) => p.id)).toEqual(["h1", "h2"]);
    expect(cfg.providers["codex-sub"]).toMatchObject({ transport: "cli", driver: "codex" });
    expect(Object.values(cfg.providerByParticipant)).not.toContain("codex-sub");
  });

  // Contract: a panel seat that would run on codex is refused at resolve,
  // before any spawn, and the error names the provider and the seat.
  it("refuses at resolve when a participant uses the codex provider", () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    expect(() => resolveConfigFromRaw(codexRaw(), "test://codex-refuse")).toThrow(
      codexDriverRefusalMessage("codex-sub", "c1"),
    );
  });

  it("refuses at resolve when the judge uses the codex provider", () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const raw = codexRaw();
    raw.participants = raw.participants.filter((p) => p.provider !== "codex-sub");
    raw.judge = { provider: "codex-sub", modelId: "gpt-5" };
    expect(() => resolveConfigFromRaw(raw, "test://codex-judge")).toThrow(
      codexDriverRefusalMessage("codex-sub", "judge"),
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
