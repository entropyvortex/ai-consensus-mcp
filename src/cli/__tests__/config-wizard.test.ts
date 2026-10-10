import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runConfig } from "../config.js";
import {
  RawConfigSchema,
  loadConfig,
  readRawConfig,
  resolveConfigFromRaw,
  writeRawConfig,
  type RawConfig,
} from "../../config.js";

interface PromptLike {
  message?: string;
  default?: unknown;
  choices?: readonly { value?: unknown }[];
}

const prompts = vi.hoisted(() => {
  const queue: ((prompt: PromptLike) => unknown)[] = [];
  return { queue };
});

vi.mock("@inquirer/prompts", () => {
  const take = (prompt: PromptLike) => {
    const step = prompts.queue.shift();
    if (!step) {
      throw new Error(`unexpected prompt: ${prompt.message ?? ""}`);
    }
    return step(prompt);
  };
  return {
    checkbox: (prompt: PromptLike) => Promise.resolve(take(prompt)),
    confirm: (prompt: PromptLike) => Promise.resolve(take(prompt)),
    input: (prompt: PromptLike) => Promise.resolve(take(prompt)),
    number: (prompt: PromptLike) => Promise.resolve(take(prompt)),
    select: (prompt: PromptLike) => Promise.resolve(take(prompt)),
    Separator: class Separator {},
  };
});

function answer(message: RegExp, value: unknown): (prompt: PromptLike) => unknown {
  return (prompt) => {
    const text = prompt.message ?? "";
    if (!message.test(text)) {
      throw new Error(`expected ${message} but got ${JSON.stringify(text)}`);
    }
    return value;
  };
}

/** Accept the prompt's own default, after checking it is the expected prompt. */
function acceptDefault(message: RegExp, expected?: unknown): (prompt: PromptLike) => unknown {
  return (prompt) => {
    const text = prompt.message ?? "";
    if (!message.test(text)) {
      throw new Error(`expected ${message} but got ${JSON.stringify(text)}`);
    }
    if (expected !== undefined) expect(prompt.default).toEqual(expected);
    return prompt.default;
  };
}

function script(steps: ((prompt: PromptLike) => unknown)[]): void {
  prompts.queue.length = 0;
  prompts.queue.push(...steps);
}

function httpPanel(baseUrl = "https://api.openai.com/v1"): RawConfig {
  return {
    providers: {
      openai: { baseUrl, apiKeyEnv: "OPENAI_API_KEY" },
    },
    participants: [
      { id: "a", provider: "openai", modelId: "gpt-4o", personaId: "pessimist" },
      { id: "b", provider: "openai", modelId: "gpt-4o", personaId: "domain-expert" },
    ],
  };
}

function mixedPanel(): RawConfig {
  return {
    providers: {
      "grok-sub": { transport: "cli", driver: "grok", timeoutMs: 120000 },
      "claude-sub": { transport: "cli", driver: "claude", bin: "claude" },
      openai: { baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" },
    },
    participants: [
      { id: "grok", provider: "grok-sub", modelId: "grok-4", personaId: "devils-advocate" },
      { id: "claude", provider: "claude-sub", modelId: "opus", personaId: "domain-expert" },
      { id: "chatgpt", provider: "openai", modelId: "gpt-4o", personaId: "first-principles" },
    ],
    judge: { provider: "claude-sub", modelId: "opus" },
    defaults: { maxRounds: 2, earlyStop: true, cliMaxInFlight: 2 },
  };
}

function cliProviders(config: RawConfig): Record<string, RawConfig["providers"][string]> {
  return Object.fromEntries(
    Object.entries(config.providers).filter(([, provider]) => provider.transport === "cli"),
  );
}

describe("config wizard", () => {
  let dir: string;
  const previousKey = process.env["OPENAI_API_KEY"];

  afterEach(async () => {
    prompts.queue.length = 0;
    vi.restoreAllMocks();
    if (previousKey === undefined) delete process.env["OPENAI_API_KEY"];
    else process.env["OPENAI_API_KEY"] = previousKey;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("editing defaults on a mixed file leaves every CLI provider deep-equal after parse", async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-consensus-mcp-wizard-"));
    const path = join(dir, "consensus.config.json");
    await writeRawConfig(path, mixedPanel());
    const before = cliProviders(await readRawConfig(path));
    script([
      answer(/What would you like to do/, "defaults"),
      answer(/Which defaults/, ["maxRounds", "earlyStop", "cliMaxInFlight"]),
      answer(/maxRounds/, 3),
      answer(/^earlyStop$/, true),
      answer(/cliMaxInFlight/, 2),
      answer(/What would you like to do/, "save"),
    ]);

    const code = await runConfig(["--config", path]);

    expect(code).toBe(0);
    expect(prompts.queue).toEqual([]);
    const after = await readRawConfig(path);
    expect(cliProviders(after)).toEqual(before);
    expect(after.defaults?.maxRounds).toBe(3);
    expect(after.defaults?.cliMaxInFlight).toBe(2);
  });

  it("editing an HTTP provider on a mixed file leaves every CLI provider deep-equal after parse", async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-consensus-mcp-wizard-"));
    const path = join(dir, "consensus.config.json");
    await writeRawConfig(path, mixedPanel());
    const before = cliProviders(await readRawConfig(path));
    script([
      answer(/What would you like to do/, "providers"),
      answer(/^Providers$/, "openai"),
      answer(/Provider "openai"/, "edit"),
      answer(/Provider id/, "openai"),
      answer(/Base URL/, "https://example.openai.test/v1"),
      answer(/Env var holding the API key/, "OPENAI_API_KEY"),
      answer(/extraHeaders/, false),
      answer(/^Providers$/, "__back__"),
      answer(/What would you like to do/, "save"),
    ]);

    const code = await runConfig(["--config", path]);

    expect(code).toBe(0);
    expect(prompts.queue).toEqual([]);
    const after = await readRawConfig(path);
    expect(cliProviders(after)).toEqual(before);
    expect(after.providers["openai"]).toEqual({
      baseUrl: "https://example.openai.test/v1",
      apiKeyEnv: "OPENAI_API_KEY",
    });
  });

  it("wizard save of a CLI provider re-reads through RawConfigSchema and contains no apiKeyEnv", async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-consensus-mcp-wizard-"));
    const path = join(dir, "consensus.config.json");
    await writeRawConfig(path, httpPanel());
    script([
      answer(/What would you like to do/, "providers"),
      answer(/^Providers$/, "__add__"),
      answer(/Provider transport/, "cli"),
      answer(/Provider id/, "grok-sub"),
      (prompt) => {
        const text = prompt.message ?? "";
        if (!text.includes("CLI driver")) {
          throw new Error(`expected CLI driver prompt but got ${JSON.stringify(text)}`);
        }
        const values = (prompt.choices ?? []).map((choice) => choice.value);
        expect(values).toEqual(["grok", "claude"]);
        expect(values.includes("codex")).toBe(false);
        return "grok";
      },
      answer(/Override the binary/, false),
      answer(/Override timeoutMs/, false),
      answer(/Set authPath/, false),
      answer(/^Providers$/, "__back__"),
      answer(/What would you like to do/, "save"),
    ]);

    const code = await runConfig(["--config", path]);

    expect(code).toBe(0);
    const parsed = RawConfigSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const cli = parsed.data.providers["grok-sub"];
    expect(cli).toEqual({ transport: "cli", driver: "grok" });
    expect(cli).not.toHaveProperty("apiKeyEnv");
    expect(cli).not.toHaveProperty("baseUrl");
    expect(JSON.stringify(cli)).not.toContain("apiKeyEnv");
    const reread = await readRawConfig(path);
    expect(reread.providers["grok-sub"]).toEqual(cli);
  });

  it("HTTP-only wizard save is byte-stable aside from formatting the writer already applies", async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-consensus-mcp-wizard-"));
    const path = join(dir, "consensus.config.json");
    const raw = httpPanel();
    await writeRawConfig(path, raw);
    const formatted = await readFile(path, "utf8");
    script([answer(/What would you like to do/, "save")]);

    expect(await runConfig(["--config", path])).toBe(0);
    expect(await readFile(path, "utf8")).toBe(formatted);

    const minPath = join(dir, "min.json");
    await writeFile(minPath, JSON.stringify(raw));
    script([answer(/What would you like to do/, "save")]);
    expect(await runConfig(["--config", minPath])).toBe(0);
    expect(await readFile(minPath, "utf8")).toBe(formatted);
    expect(await readFile(minPath, "utf8")).not.toBe(JSON.stringify(raw));
  });

  it("subscription example parses under the Node allowCli default and fails under allowCli: false", async () => {
    process.env["OPENAI_API_KEY"] = "test-key";
    const examplePath = fileURLToPath(
      new URL("../../../consensus.config.subscription.example.json", import.meta.url),
    );
    const raw = await readRawConfig(examplePath);
    expect(raw.defaults?.maxRounds).toBe(2);
    expect(raw.defaults?.cliMaxInFlight).toBe(2);
    const drivers = Object.values(raw.providers).map((provider) =>
      provider.transport === "cli" ? provider.driver : "http",
    );
    expect(drivers).toEqual(expect.arrayContaining(["grok", "claude", "http"]));
    expect(drivers).not.toContain("codex");

    const loaded = await loadConfig(examplePath);
    expect(loaded.providers["grok-sub"]?.transport).toBe("cli");
    expect(loaded.providers["claude-sub"]?.transport).toBe("cli");
    expect(loaded.providers["openai"]?.transport).toBe("http");
    expect(loaded.defaults.cliMaxInFlight).toBe(2);

    expect(() => resolveConfigFromRaw(raw, examplePath, { allowCli: false })).toThrow(
      /Cloudflare Workers/,
    );
  });

  // Contract: a CLI block whose driver the wizard does not offer (codex) is
  // never rewritten by "edit". The wizard prints a note and leaves it as-is.
  it("editing a codex provider leaves the block untouched and asks nothing", async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-consensus-mcp-wizard-"));
    const path = join(dir, "consensus.config.json");
    const raw = mixedPanel();
    raw.providers["codex-sub"] = { transport: "cli", driver: "codex", bin: "codex" };
    await writeRawConfig(path, raw);
    const before = await readRawConfig(path);
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    script([
      answer(/What would you like to do/, "providers"),
      answer(/^Providers$/, "codex-sub"),
      answer(/Provider "codex-sub"/, "edit"),
      answer(/^Providers$/, "__back__"),
      answer(/What would you like to do/, "save"),
    ]);

    expect(await runConfig(["--config", path])).toBe(0);
    expect(prompts.queue).toEqual([]);
    const after = await readRawConfig(path);
    expect(after.providers["codex-sub"]).toEqual({
      transport: "cli",
      driver: "codex",
      bin: "codex",
    });
    expect(after.providers).toEqual(before.providers);
    expect(writes.join("")).toMatch(
      /"codex-sub" uses driver "codex", which the wizard does not offer[\s\S]*left unchanged/,
    );
  });

  // Contract: accepting every default on an existing claude seat changes
  // nothing, including an authPath the wizard no longer prompts for.
  it("editing a claude provider with authPath and accepting defaults round-trips", async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-consensus-mcp-wizard-"));
    const path = join(dir, "consensus.config.json");
    const raw = mixedPanel();
    raw.providers["claude-sub"] = {
      transport: "cli",
      driver: "claude",
      bin: "/usr/local/bin/claude",
      timeoutMs: 90000,
      authPath: "/home/u/.claude/auth.json",
    };
    await writeRawConfig(path, raw);
    const before = await readRawConfig(path);
    script([
      answer(/What would you like to do/, "providers"),
      answer(/^Providers$/, "claude-sub"),
      answer(/Provider "claude-sub"/, "edit"),
      acceptDefault(/Provider id/, "claude-sub"),
      acceptDefault(/CLI driver/, "claude"),
      acceptDefault(/Override the binary/, true),
      acceptDefault(/Binary name or path/, "/usr/local/bin/claude"),
      acceptDefault(/Override timeoutMs/, true),
      acceptDefault(/^timeoutMs$/, 90000),
      answer(/^Providers$/, "__back__"),
      answer(/What would you like to do/, "save"),
    ]);

    expect(await runConfig(["--config", path])).toBe(0);
    expect(prompts.queue).toEqual([]);
    expect((await readRawConfig(path)).providers).toEqual(before.providers);
  });

  // Contract: the authPath prompt is grok-only and describes what the path
  // does (a sign-in readiness check), not a login override.
  it("offers authPath only for grok, worded as the sign-in readiness path", async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-consensus-mcp-wizard-"));
    const path = join(dir, "consensus.config.json");
    await writeRawConfig(path, httpPanel());
    script([
      answer(/What would you like to do/, "providers"),
      answer(/^Providers$/, "__add__"),
      answer(/Provider transport/, "cli"),
      answer(/Provider id/, "grok-sub"),
      answer(/CLI driver/, "grok"),
      answer(/Override the binary/, false),
      answer(/Override timeoutMs/, false),
      answer(/sign-in readiness/, true),
      answer(/authPath/, "/home/u/.grok/auth.json"),
      answer(/^Providers$/, "__add__"),
      answer(/Provider transport/, "cli"),
      answer(/Provider id/, "claude-sub"),
      answer(/CLI driver/, "claude"),
      answer(/Override the binary/, false),
      answer(/Override timeoutMs/, false),
      answer(/^Providers$/, "__back__"),
      answer(/What would you like to do/, "save"),
    ]);

    expect(await runConfig(["--config", path])).toBe(0);
    expect(prompts.queue).toEqual([]);
    const after = await readRawConfig(path);
    expect(after.providers["grok-sub"]).toEqual({
      transport: "cli",
      driver: "grok",
      authPath: "/home/u/.grok/auth.json",
    });
    expect(after.providers["claude-sub"]).toEqual({ transport: "cli", driver: "claude" });
  });

  // Contract: switching driver does not carry over a bin that names a
  // driver binary other than the new one, nor a grok-only authPath.
  it("switching driver drops a bin that names the old driver and keeps a custom one", async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-consensus-mcp-wizard-"));
    const path = join(dir, "consensus.config.json");
    const raw = mixedPanel();
    raw.providers["grok-sub"] = {
      transport: "cli",
      driver: "grok",
      bin: "grok",
      authPath: "/home/u/.grok/auth.json",
    };
    raw.providers["claude-sub"] = {
      transport: "cli",
      driver: "claude",
      bin: "/usr/local/bin/claude",
    };
    raw.providers["custom-sub"] = { transport: "cli", driver: "grok", bin: "/opt/tools/mycli" };
    await writeRawConfig(path, raw);
    script([
      answer(/What would you like to do/, "providers"),
      // grok (bin "grok") -> claude: bin override defaults off.
      answer(/^Providers$/, "grok-sub"),
      answer(/Provider "grok-sub"/, "edit"),
      acceptDefault(/Provider id/),
      answer(/CLI driver/, "claude"),
      acceptDefault(/Override the binary/, false),
      acceptDefault(/Override timeoutMs/, false),
      // claude (bin ".../claude") -> grok: bin override defaults off.
      answer(/^Providers$/, "claude-sub"),
      answer(/Provider "claude-sub"/, "edit"),
      acceptDefault(/Provider id/),
      answer(/CLI driver/, "grok"),
      acceptDefault(/Override the binary/, false),
      acceptDefault(/Override timeoutMs/, false),
      acceptDefault(/sign-in readiness/, false),
      // grok (custom bin) -> claude: a custom bin is kept by default.
      answer(/^Providers$/, "custom-sub"),
      answer(/Provider "custom-sub"/, "edit"),
      acceptDefault(/Provider id/),
      answer(/CLI driver/, "claude"),
      acceptDefault(/Override the binary/, true),
      acceptDefault(/Binary name or path/, "/opt/tools/mycli"),
      acceptDefault(/Override timeoutMs/, false),
      answer(/^Providers$/, "__back__"),
      answer(/What would you like to do/, "save"),
    ]);

    expect(await runConfig(["--config", path])).toBe(0);
    expect(prompts.queue).toEqual([]);
    const after = await readRawConfig(path);
    expect(after.providers["grok-sub"]).toEqual({ transport: "cli", driver: "claude" });
    expect(after.providers["claude-sub"]).toEqual({ transport: "cli", driver: "grok" });
    expect(after.providers["custom-sub"]).toEqual({
      transport: "cli",
      driver: "claude",
      bin: "/opt/tools/mycli",
    });
  });
});
