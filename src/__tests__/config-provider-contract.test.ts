import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { formatZodError, loadConfigFromJson } from "../config.js";

// Contract: a provider block is validated against exactly one transport arm,
// chosen by `transport` ("cli" → CLI arm, omitted/"http" → HTTP arm), and each
// issue prints once with its path from the config root.

function panel(providers: Record<string, unknown>): unknown {
  const ids = Object.keys(providers);
  return {
    providers,
    participants: [
      { id: "a", provider: ids[0], modelId: "m", personaId: "pessimist" },
      { id: "b", provider: ids[ids.length - 1], modelId: "m", personaId: "domain-expert" },
    ],
  };
}

/** Bullet lines printed under "failed validation:" for a raw config. */
function validationLines(raw: unknown): string[] {
  let message: string | undefined;
  try {
    loadConfigFromJson(JSON.stringify(raw), "test");
  } catch (err) {
    message = (err as Error).message;
  }
  if (message === undefined) throw new Error("expected validation to fail");
  const [head, ...lines] = message.split("\n");
  expect(head).toBe("ai-consensus-mcp: config at test failed validation:");
  return lines;
}

describe("provider validation messages", () => {
  it("prints main's single line for an HTTP provider missing apiKeyEnv", () => {
    expect(validationLines(panel({ openai: { baseUrl: "https://api.openai.com/v1" } }))).toEqual([
      "  • providers.openai.apiKeyEnv: Required",
    ]);
  });

  it("prints only the CLI arm's issue for a bad driver", () => {
    expect(validationLines(panel({ g: { transport: "cli", driver: "gemini" } }))).toEqual([
      "  • providers.g.driver: Invalid enum value. Expected 'grok' | 'claude' | 'codex', received 'gemini'",
    ]);
  });

  it("prints only the CLI arm's unknown-key issue for baseUrl beside driver", () => {
    expect(
      validationLines(
        panel({ g: { transport: "cli", driver: "grok", baseUrl: "https://api.x.ai/v1" } }),
      ),
    ).toEqual(["  • providers.g: Unrecognized key(s) in object: 'baseUrl'"]);
  });

  it("names the accepted transports for an unknown transport", () => {
    expect(validationLines(panel({ p: { transport: "stdio" } }))).toEqual([
      '  • providers.p.transport: transport must be "cli" or "http" (omit it for HTTP)',
    ]);
  });

  it("formatZodError flattens a union without repeating the path", () => {
    const schema = z.object({ a: z.object({ b: z.union([z.string(), z.number()]) }) });
    const result = schema.safeParse({ a: { b: true } });
    if (result.success) throw new Error("expected failure");
    expect(formatZodError(result.error).split("\n")).toEqual([
      "  • a.b: Expected string, received boolean",
      "  • a.b: Expected number, received boolean",
    ]);
  });
});

// Contract (back-compat): the HTTP arm strips unknown keys exactly like main,
// so existing files keep loading; it rejects only the CLI-only keys, which
// signal a block that was meant to be `transport: "cli"`.
describe("HTTP provider back-compat", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads a main-era HTTP provider carrying extra descriptive keys", () => {
    vi.stubEnv("OPENAI_KEY", "k");
    const cfg = loadConfigFromJson(
      JSON.stringify(
        panel({
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKeyEnv: "OPENAI_KEY",
            name: "OpenAI",
            $comment: "kept from an older template",
          },
        }),
      ),
      "test",
    );
    expect(cfg.providers["openai"]).toEqual({
      id: "openai",
      transport: "http",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "k",
      extraHeaders: {},
    });
  });

  it("rejects each CLI-only key on an HTTP provider with a transport hint", () => {
    expect(
      validationLines(
        panel({
          xai: {
            baseUrl: "https://api.x.ai/v1",
            apiKeyEnv: "GROK_API_KEY",
            driver: "grok",
            bin: "grok",
            timeoutMs: 5_000,
            authPath: "/a.json",
          },
        }),
      ),
    ).toEqual(
      ["driver", "bin", "timeoutMs", "authPath"].map(
        (key) =>
          `  • providers.xai.${key}: "${key}" is only valid on a CLI provider; add "transport": "cli" or remove "${key}"`,
      ),
    );
  });
});

// Contract: with allowCli false the whole file is rejected with the Workers
// CLI error whenever any CLI provider is present, regardless of key order and
// before any HTTP provider's API key is looked up.
describe("allowCli false", () => {
  it("reports the CLI rejection even when an HTTP provider with an unset key comes first", () => {
    vi.stubEnv("UNSET_WORKER_KEY", "");
    try {
      expect(() =>
        loadConfigFromJson(
          JSON.stringify(
            panel({
              openai: { baseUrl: "https://api.openai.com/v1", apiKeyEnv: "UNSET_WORKER_KEY" },
              "grok-sub": { transport: "cli", driver: "grok" },
            }),
          ),
          "worker",
          { allowCli: false },
        ),
      ).toThrow(/provider "grok-sub" uses transport "cli"/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
