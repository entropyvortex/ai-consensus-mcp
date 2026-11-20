import { describe, expect, it, vi } from "vitest";
import { CODEX_REQUIRED_GATE_FLAGS, getRegisteredDriver } from "../cli-backend/index.js";
import { buildCodexArgv, codexUsage } from "../cli-backend/drivers/codex.js";
import { normalizeCliJsonStdout } from "../cli-backend/normalize.js";
import { resolveConfigFromRaw, type RawConfig } from "../config.js";

// Contracts: codex is a registered driver whose seats resolve like grok
// and claude; its argv meets the gate the design set before it could ship
// (read-only sandbox, approval never) using flags checked against the
// installed codex 0.170.0; usage comes from turn.completed events.

function codexRaw(): RawConfig {
  return {
    providers: {
      "codex-sub": { transport: "cli", driver: "codex" },
      openai: { baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" },
    },
    participants: [
      { id: "c1", provider: "codex-sub", modelId: "default", personaId: "devils-advocate" },
      { id: "h1", provider: "openai", modelId: "gpt-4o", personaId: "domain-expert" },
    ],
    judge: { provider: "codex-sub", modelId: "default" },
  };
}

describe("codex driver", () => {
  it("is registered", () => {
    expect(getRegisteredDriver("codex")).toBeDefined();
  });

  it("resolves participant and judge seats on a codex provider", () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const cfg = resolveConfigFromRaw(codexRaw(), "test://codex");
    expect(cfg.providerByParticipant).toMatchObject({ c1: "codex-sub", judge: "codex-sub" });
    expect(cfg.providers["codex-sub"]).toMatchObject({
      transport: "cli",
      driver: "codex",
      bin: "codex",
      timeoutMs: 120_000,
    });
    vi.unstubAllEnvs();
  });

  it("meets the design gate: read-only sandbox and approval never", () => {
    const argv = buildCodexArgv({
      scratchDir: "/s",
      schemaPath: "/s/schema.json",
      lastMessagePath: "/s/out",
      modelId: "m",
    });
    const flat = argv.join(" ");
    expect(CODEX_REQUIRED_GATE_FLAGS).toEqual(["--sandbox read-only", "approval never"]);
    expect(flat).toContain("--sandbox read-only");
    expect(flat).toContain('-c approval_policy="never"');
    expect(argv.at(-1)).toBe("-");
  });

  it("sums usage over turn.completed events and ignores other lines", () => {
    const out = [
      '{"type":"thread.started"}',
      "not json",
      '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":3}}',
      '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":2}}',
    ].join("\n");
    expect(codexUsage(out)).toEqual({ inputTokens: 15, outputTokens: 5, totalTokens: 20 });
    expect(codexUsage('{"type":"turn.started"}')).toBeUndefined();
  });
});

describe("normalizeCliJsonStdout — contract: JSON mode returns the answer JSON untouched", () => {
  it("prefers structured_output, then result/text/answer strings, then the object itself", () => {
    expect(
      normalizeCliJsonStdout({
        driver: "d",
        stdout: '{"structured_output":{"a":1},"usage":{"input_tokens":1,"output_tokens":2}}',
      }),
    ).toEqual({
      content: '{"a":1}',
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    });
    expect(
      normalizeCliJsonStdout({ driver: "d", stdout: '{"result":"{\\"b\\":2}"}' }).content,
    ).toBe('{"b":2}');
    expect(normalizeCliJsonStdout({ driver: "d", stdout: '{"ranking":["A"]}' }).content).toBe(
      '{"ranking":["A"]}',
    );
  });

  it("throws on error results, non-JSON and empty output", () => {
    expect(() =>
      normalizeCliJsonStdout({
        driver: "d",
        stdout: '{"is_error":true,"subtype":"error_max_turns"}',
      }),
    ).toThrow("cli driver d returned an error result: error_max_turns");
    expect(() => normalizeCliJsonStdout({ driver: "d", stdout: "hello" })).toThrow(/not JSON/);
    expect(() => normalizeCliJsonStdout({ driver: "d", stdout: "  " })).toThrow(/empty answer/);
    expect(() => normalizeCliJsonStdout({ driver: "d", stdout: '{"result":""}' })).toThrow(
      /empty answer/,
    );
  });
});
