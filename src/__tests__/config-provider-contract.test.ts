import { afterEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { formatCliProviderStartupNote, formatZodError, loadConfigFromJson } from "../config.js";

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

// Contract: `env` replaces process.env for apiKeyEnv lookups, so a Worker can
// pass its `env` binding; it is not merged with process.env.
describe("ResolveConfigOptions.env", () => {
  const raw = panel({ openai: { baseUrl: "https://api.openai.com/v1", apiKeyEnv: "BOUND_KEY" } });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads apiKeyEnv from the supplied env instead of process.env", () => {
    vi.stubEnv("BOUND_KEY", "");
    const cfg = loadConfigFromJson(JSON.stringify(raw), "worker", { env: { BOUND_KEY: "bound" } });
    expect(cfg.providers["openai"]).toMatchObject({ transport: "http", apiKey: "bound" });
  });

  it("does not fall back to process.env when env is supplied", () => {
    vi.stubEnv("BOUND_KEY", "from-process");
    expect(() => loadConfigFromJson(JSON.stringify(raw), "worker", { env: {} })).toThrow(
      'ai-consensus-mcp: provider "openai" requires env var BOUND_KEY but it is not set.',
    );
  });
});

// Contract: `bin` is a bare command name resolved on PATH or an absolute path.
// Relative paths would resolve against the runner's scratch cwd, a leading "-"
// reads as an option, and whitespace/control characters are never a command.
// `authPath` is absolute or "~/"-prefixed, and "~" expands at resolve time.
describe("CLI bin and authPath", () => {
  const cli = (extra: Record<string, unknown>) =>
    panel({ g: { transport: "cli", driver: "grok", ...extra } });
  const resolve = (extra: Record<string, unknown>) =>
    loadConfigFromJson(JSON.stringify(cli(extra)), "test", { env: {} }).providers["g"];

  it.each(["grok", "grok-beta_2.1", "/usr/local/bin/grok", "/Applications/My App/grok"])(
    "accepts bin %j",
    (bin) => {
      expect(resolve({ bin })).toMatchObject({ bin });
    },
  );

  const RELATIVE =
    'bin must be a bare command name on PATH (e.g. "grok") or an absolute path; relative paths are not allowed';
  it.each([
    ["./grok", RELATIVE],
    ["bin/grok", RELATIVE],
    ["../x", RELATIVE],
    ["bin\\grok", RELATIVE],
    ["grok cli", "bin must not contain whitespace unless it is an absolute path"],
    ["-grok", 'bin must not start with "-"'],
    ["grok\n", "bin must not contain control characters"],
    ["/usr/bin/gr\u0000ok", "bin must not contain control characters"],
  ])("rejects bin %j", (bin, message) => {
    expect(validationLines(cli({ bin }))).toEqual([`  • providers.g.bin: ${message}`]);
  });

  it("expands a ~/ authPath against the home directory", () => {
    expect(resolve({ authPath: "~/.grok/auth.json" })).toMatchObject({
      authPath: join(homedir(), ".grok/auth.json"),
    });
  });

  it("keeps an absolute authPath unchanged", () => {
    expect(resolve({ authPath: "/etc/grok/auth.json" })).toMatchObject({
      authPath: "/etc/grok/auth.json",
    });
  });

  it.each([
    ["auth.json", 'authPath must be an absolute path or start with "~/"'],
    ["~grok/auth.json", 'authPath must be an absolute path or start with "~/"'],
    ["/a\u0007b.json", "authPath must not contain control characters"],
  ])("rejects authPath %j", (authPath, message) => {
    expect(validationLines(cli({ authPath }))).toEqual([`  • providers.g.authPath: ${message}`]);
  });
});

// Contract: `serve` prints exactly one note line per resolved CLI provider and
// nothing for HTTP-only configs.
describe("formatCliProviderStartupNote", () => {
  it("prints one line per CLI provider and skips HTTP providers", () => {
    const cfg = loadConfigFromJson(
      JSON.stringify(
        panel({
          "grok-sub": { transport: "cli", driver: "grok" },
          openai: { baseUrl: "https://api.openai.com/v1", apiKeyEnv: "K" },
          "claude-sub": { transport: "cli", driver: "claude" },
        }),
      ),
      "test",
      { env: { K: "k" } },
    );
    const tail = "resolved. HTTP providers in this process are unaffected.";
    expect(formatCliProviderStartupNote(cfg)).toBe(
      `ai-consensus-mcp: CLI provider "grok-sub" (driver grok) ${tail}\n` +
        `ai-consensus-mcp: CLI provider "claude-sub" (driver claude) ${tail}\n`,
    );
  });

  it("returns an empty string for an HTTP-only config", () => {
    const cfg = loadConfigFromJson(
      JSON.stringify(panel({ openai: { baseUrl: "https://api.openai.com/v1", apiKeyEnv: "K" } })),
      "test",
      { env: { K: "k" } },
    );
    expect(formatCliProviderStartupNote(cfg)).toBe("");
  });
});

// Contract: an explicit `defaults.cliMaxInFlight` is kept as written (not
// replaced by the CLI default of 2), and only 1-4 is accepted.
describe("defaults.cliMaxInFlight", () => {
  const withCap = (cliMaxInFlight: number) => ({
    ...(panel({ g: { transport: "cli", driver: "grok" } }) as object),
    defaults: { cliMaxInFlight },
  });

  it.each([1, 3, 4])("keeps an explicit %i", (cap) => {
    const cfg = loadConfigFromJson(JSON.stringify(withCap(cap)), "test", { env: {} });
    expect(cfg.defaults.cliMaxInFlight).toBe(cap);
  });

  it.each([
    [0, "Number must be greater than or equal to 1"],
    [5, "Number must be less than or equal to 4"],
  ])("rejects %i", (cap, message) => {
    expect(validationLines(withCap(cap))).toEqual([`  • defaults.cliMaxInFlight: ${message}`]);
  });
});

// Contract: provider ids are looked up as own keys only, so names inherited
// from Object.prototype are not mistaken for configured providers.
describe("provider id lookup", () => {
  it.each(["constructor", "toString", "__proto__"])(
    "rejects a participant referencing undeclared provider %j",
    (id) => {
      const raw = {
        providers: { openai: { baseUrl: "https://api.openai.com/v1", apiKeyEnv: "K" } },
        participants: [
          { id: "a", provider: "openai", modelId: "m", personaId: "pessimist" },
          { id: "b", provider: id, modelId: "m", personaId: "domain-expert" },
        ],
      };
      expect(() => loadConfigFromJson(JSON.stringify(raw), "test", { env: { K: "k" } })).toThrow(
        `ai-consensus-mcp: participant "b" references unknown provider "${id}". Known: openai.`,
      );
    },
  );

  it('rejects a judge referencing undeclared provider "constructor"', () => {
    const raw = {
      ...(panel({ openai: { baseUrl: "https://api.openai.com/v1", apiKeyEnv: "K" } }) as object),
      judge: { provider: "constructor", modelId: "m" },
    };
    expect(() => loadConfigFromJson(JSON.stringify(raw), "test", { env: { K: "k" } })).toThrow(
      /judge references unknown provider "constructor"/,
    );
  });
});
