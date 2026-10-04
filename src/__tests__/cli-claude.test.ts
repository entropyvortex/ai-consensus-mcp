import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractConfidence,
  extractJudgeConfidence,
  type ModelCallRequest,
} from "ai-consensus-core";
import { createConsensusCaller } from "../caller.js";
import {
  CLAUDE_READINESS_TIMEOUT_MS,
  CLAUDE_SYSTEM_PROMPT,
  ORACLE_JSON_SCHEMA_TEXT,
  buildChildEnv,
  probeCliProviders,
  resetCliProcessNotices,
  type ReadinessState,
} from "../cli-backend/index.js";
import { CliGate } from "../cli-backend/gate.js";
import type { ResolvedCliProvider } from "../config.js";

interface FakeChild extends ChildProcess {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
}

function fakeChild(pid = 515151): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  Object.defineProperty(child, "pid", { value: pid, configurable: true });
  child.kill = () => true;
  return child;
}

function succeed(child: FakeChild, payload: unknown, code = 0): void {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  child.stdout.write(text);
  child.stdout.end();
  child.stderr.end();
  child.emit("close", code, null);
}

function closeSoon(child: FakeChild, code: number, stdout = "", stderr = ""): void {
  queueMicrotask(() => {
    if (stdout) child.stdout.write(stdout);
    if (stderr) child.stderr.write(stderr);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", code, null);
  });
}

function claudeProvider(overrides: Partial<ResolvedCliProvider> = {}): ResolvedCliProvider {
  return {
    id: "claude-sub",
    transport: "cli",
    driver: "claude",
    bin: "claude",
    timeoutMs: 120_000,
    authPath: undefined,
    ...overrides,
  };
}

function request(
  participantId: string,
  overrides: Partial<ModelCallRequest> = {},
): ModelCallRequest {
  return {
    participantId,
    modelId: "opus",
    round: 2,
    phase: "initial-analysis",
    system: "Be precise.",
    user: "Should we ship?",
    temperature: 0.7,
    maxOutputTokens: 1500,
    ...overrides,
  };
}

function parentEnv(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin",
    HOME: "/home/tester",
    USER: "tester",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    ANTHROPIC_API_KEY: "anth",
    ANTHROPIC_AUTH_TOKEN: "anth-token",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "1",
    CLAUDE_CODE_USE_FOUNDRY: "1",
    OPENAI_API_KEY: "oai",
    XAI_API_KEY: "xai",
    LD_PRELOAD: "/tmp/evil.so",
    GH_TOKEN: "gh",
  };
}

function collectStdin(child: FakeChild): { text: () => string } {
  const chunks: Buffer[] = [];
  child.stdin.on("data", (chunk: unknown) => {
    chunks.push(Buffer.from(chunk as Uint8Array));
  });
  return {
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

const AUTH_STATUS_ARGV = ["--setting-sources", "", "auth", "status", "--json"];

function isAuthStatus(args: readonly string[]): boolean {
  return args.includes("auth") && args.includes("status");
}

function authStatus(fields: Record<string, unknown>): string {
  return JSON.stringify({
    loggedIn: true,
    email: "secret-user@example.com",
    orgName: "Secret Org",
    ...fields,
  });
}

const AUTH_OK = authStatus({ authMethod: "claude.ai", subscriptionType: "max" });

const RESULT = {
  type: "result",
  subtype: "success",
  structured_output: { answer: "Ship the oracle.", confidence: 80 },
};

describe("cli backend claude driver", () => {
  const logs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    resetCliProcessNotices();
    logs.length = 0;
  });

  function harness(options?: {
    spawnImpl?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
    cache?: Map<string, ReadinessState>;
    env?: NodeJS.ProcessEnv;
    scheduleTimeout?: (ms: number, cb: () => void) => () => void;
    provider?: ResolvedCliProvider;
  }) {
    const calls: { command: string; args: string[]; options: SpawnOptions }[] = [];
    const spawnImpl =
      options?.spawnImpl ??
      ((command: string, args: readonly string[]) => {
        const child = fakeChild();
        if (args[0] === "--version" || isAuthStatus(args)) {
          closeSoon(child, 0, isAuthStatus(args) ? AUTH_OK : "2.1.289\n");
          return child;
        }
        queueMicrotask(() => succeed(child, RESULT));
        return child;
      });
    const caller = createConsensusCaller({
      providers: { "claude-sub": options?.provider ?? claudeProvider() },
      providerByParticipant: { p1: "claude-sub", judge: "claude-sub" },
      cliGate: new CliGate(2),
      spawnImpl: (command, args, spawnOptions) => {
        calls.push({ command, args: [...args], options: spawnOptions });
        return spawnImpl(command, args, spawnOptions);
      },
      readinessCache: options?.cache ?? new Map(),
      env: options?.env ?? parentEnv(),
      log: (line) => logs.push(line),
      ...(options?.scheduleTimeout ? { scheduleTimeout: options.scheduleTimeout } : {}),
    });
    return { caller, calls, logs };
  }

  it("spawns the executed claude argv and sends the transcript on stdin", async () => {
    const delays: number[] = [];
    let stdin = "";
    const { caller, calls } = harness({
      scheduleTimeout: (ms) => {
        delays.push(ms);
        return () => undefined;
      },
      spawnImpl: (_command, args) => {
        const child = fakeChild();
        if (args[0] === "--version") {
          closeSoon(child, 0, "2.1.289\n");
          return child;
        }
        if (isAuthStatus(args)) {
          closeSoon(child, 0, AUTH_OK);
          return child;
        }
        const captured = collectStdin(child);
        queueMicrotask(() => {
          stdin = captured.text();
          succeed(child, RESULT);
        });
        return child;
      },
    });

    const res = await caller(request("p1"));
    expect(res.content.endsWith("CONFIDENCE: 80")).toBe(true);
    expect(extractConfidence(res.content)).toBe(80);
    expect(logs.join("")).not.toContain("secret-user@example.com");
    expect(delays.slice(0, 2)).toEqual([CLAUDE_READINESS_TIMEOUT_MS, CLAUDE_READINESS_TIMEOUT_MS]);
    expect(CLAUDE_READINESS_TIMEOUT_MS).toBe(15_000);

    expect(calls.map((call) => call.args)).toEqual([
      ["--version"],
      AUTH_STATUS_ARGV,
      [
        "-p",
        "--output-format",
        "json",
        "--json-schema",
        ORACLE_JSON_SCHEMA_TEXT,
        "--system-prompt",
        CLAUDE_SYSTEM_PROMPT,
        "--model",
        "opus",
        "--permission-mode",
        "dontAsk",
        "--permission-prompts",
        "none",
        "--tools",
        "",
        "--restricted",
        "--no-session-persistence",
        "--setting-sources",
        "",
      ],
    ]);

    const prompt = calls[2]!;
    expect(prompt.command).toBe("claude");
    expect(prompt.options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(prompt.options.detached).toBe(true);
    expect(String(prompt.options.cwd)).toContain("consensus-cli-");
    expect(String(prompt.options.cwd)).not.toBe(process.cwd());
    const argv = prompt.args;
    expect(argv).not.toContain("--bare");
    expect(argv).not.toContain("--max-turns");
    expect(argv).not.toContain("bypassPermissions");
    expect(argv.join("\n")).not.toContain("Be precise.");
    expect(argv.join("\n")).not.toContain("Should we ship?");
    expect(Buffer.byteLength(CLAUDE_SYSTEM_PROMPT, "utf8")).toBeLessThan(400);
    expect(argv[argv.indexOf("--system-prompt") + 1]).toBe(CLAUDE_SYSTEM_PROMPT);
    expect(stdin).toBe("SYSTEM:\nBe precise.\n\nUSER:\nShould we ship?");
    const env = prompt.options.env ?? {};
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(env["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
    expect(env["CLAUDE_CODE_USE_BEDROCK"]).toBeUndefined();
    expect(env["CLAUDE_CODE_USE_VERTEX"]).toBeUndefined();
    expect(env["CLAUDE_CODE_USE_FOUNDRY"]).toBeUndefined();
    expect(env["OPENAI_API_KEY"]).toBeUndefined();
    expect(env["GROK_DISABLE_AUTOUPDATER"]).toBeUndefined();
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["DBUS_SESSION_BUS_ADDRESS"]).toBe("unix:path=/run/user/1000/bus");
  });

  // Contract: a Claude subscription seat keeps working for users whose
  // subscription credential is CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) or
  // whose config lives under CLAUDE_CONFIG_DIR. Both reach the probe and the
  // oracle child; API-billing credentials still do not.
  it("passes the Claude subscription credential env to probe and oracle children", async () => {
    const env = {
      ...parentEnv(),
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-subscription",
      CLAUDE_CONFIG_DIR: "/home/tester/.claude-alt",
    };
    const { caller, calls } = harness({ env });
    await caller(request("p1"));
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      const childEnv = call.options.env ?? {};
      expect(childEnv["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("sk-ant-oat-subscription");
      expect(childEnv["CLAUDE_CONFIG_DIR"]).toBe("/home/tester/.claude-alt");
      expect(childEnv["ANTHROPIC_API_KEY"]).toBeUndefined();
      expect(childEnv["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
      expect(childEnv["CLAUDE_CODE_USE_BEDROCK"]).toBeUndefined();
      expect(childEnv["LD_PRELOAD"]).toBeUndefined();
    }
  });

  // Contract: the Claude credential stays scoped to the claude driver; the
  // shared allowlist does not hand it to other vendors' CLIs.
  it("keeps the Claude credential out of the shared child env allowlist", () => {
    const shared = buildChildEnv({
      PATH: "/usr/bin",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-subscription",
      CLAUDE_CONFIG_DIR: "/home/tester/.claude-alt",
    });
    expect(shared["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined();
    expect(shared["CLAUDE_CONFIG_DIR"]).toBeUndefined();
    expect(shared["PATH"]).toBe("/usr/bin");
  });

  it("keeps a 200_000-character system off argv and on stdin", async () => {
    const system = "S".repeat(200_000);
    const user = "U-question-unique";
    let sawSpawn = false;
    let stdin = "";
    const { caller } = harness({
      cache: new Map([["claude-sub", { ok: true }]]),
      spawnImpl: (_command, args) => {
        sawSpawn = true;
        for (const element of args) {
          expect(Buffer.byteLength(element, "utf8")).toBeLessThan(131_071);
          expect(element).not.toContain(system.slice(0, 32));
          expect(element).not.toContain(user);
        }
        const child = fakeChild();
        const captured = collectStdin(child);
        queueMicrotask(() => {
          stdin = captured.text();
          succeed(child, { structured_output: { answer: "ok", confidence: 60 } });
        });
        return child;
      },
    });
    const res = await caller(request("p1", { system, user }));
    expect(sawSpawn).toBe(true);
    expect(stdin.startsWith("SYSTEM:\n")).toBe(true);
    expect(stdin).toContain(system);
    expect(stdin).toContain(`USER:\n${user}`);
    expect(extractConfidence(res.content)).toBe(60);
  });

  it("maps structured confidence by participant id, not by phase", async () => {
    const payload = {
      type: "result",
      subtype: "success",
      structured_output: { answer: "The panel agrees.", confidence: 91 },
    };
    const { caller } = harness({
      cache: new Map([["claude-sub", { ok: true }]]),
      spawnImpl: () => {
        const child = fakeChild();
        queueMicrotask(() => succeed(child, payload));
        return child;
      },
    });
    const judge = await caller(request("judge", { phase: "synthesis", participantId: "judge" }));
    expect(judge.content.trimEnd().endsWith("JUDGE_CONFIDENCE: 91")).toBe(true);
    expect(extractJudgeConfidence(judge.content)).toBe(91);

    const participant = await caller(request("p1", { phase: "synthesis" }));
    expect(participant.content).toContain("\nCONFIDENCE: 91");
    expect(participant.content).not.toContain("JUDGE_CONFIDENCE");
    expect(extractConfidence(participant.content)).toBe(91);
  });

  it("treats claude auth status as the login check and does not log its stdout", async () => {
    const delays: number[] = [];
    let spawns = 0;
    const cache = new Map<string, ReadinessState>();
    const spawnImpl = (command: string, args: readonly string[]) => {
      spawns += 1;
      expect(command).toBe("claude");
      const child = fakeChild();
      if (args[0] === "--version") closeSoon(child, 0, "2.1.289\n");
      else if (isAuthStatus(args)) {
        closeSoon(child, 1, authStatus({ loggedIn: false, authMethod: "none" }), "not logged in");
      } else {
        throw new Error(`unexpected argv ${args.join(" ")}`);
      }
      return child;
    };
    const note = await probeCliProviders({
      providers: { "claude-sub": claudeProvider() },
      env: parentEnv(),
      cache,
      scheduleTimeout: (ms) => {
        delays.push(ms);
        return () => undefined;
      },
      spawnImpl,
    });
    expect(note).toContain("auth status");
    expect(note).toContain("exit 1");
    expect(note).toContain("not logged in");
    expect(note).toContain("claude auth login");
    expect(note).not.toContain("secret-user@example.com");
    expect(spawns).toBe(2);
    expect(delays).toEqual([CLAUDE_READINESS_TIMEOUT_MS, CLAUDE_READINESS_TIMEOUT_MS]);
    expect(cache.has("claude-sub")).toBe(false);

    // Contract: a failure is not cached, so "claude auth login" after the
    // startup probe takes effect on the next probe without a restart.
    spawns = 0;
    const again = await probeCliProviders({
      providers: { "claude-sub": claudeProvider() },
      env: parentEnv(),
      cache,
      spawnImpl: (_command, args) => {
        spawns += 1;
        const child = fakeChild();
        closeSoon(child, 0, args[0] === "--version" ? "2.1.289\n" : AUTH_OK);
        return child;
      },
    });
    expect(again).toContain("driver=claude ok");
    expect(again).not.toContain("secret-user@example.com");
    expect(spawns).toBe(2);
    expect(cache.get("claude-sub")).toEqual({ ok: true });
  });

  /** Fake claude whose probe children answer; any oracle spawn is counted. */
  function probeOnlySpawn(statusStdout: string, seen: string[][], oracle: { spawns: number }) {
    return (_command: string, args: readonly string[]) => {
      seen.push([...args]);
      const child = fakeChild();
      if (args[0] === "--version") closeSoon(child, 0, "2.1.289\n");
      else if (isAuthStatus(args)) closeSoon(child, 0, statusStdout);
      else {
        oracle.spawns += 1;
        closeSoon(child, 0, JSON.stringify(RESULT));
      }
      return child;
    };
  }

  function probeWith(statusStdout: string, env: NodeJS.ProcessEnv = parentEnv()) {
    const cache = new Map<string, ReadinessState>();
    const seen: string[][] = [];
    const oracle = { spawns: 0 };
    const run = probeCliProviders({
      providers: { "claude-sub": claudeProvider() },
      env,
      cache,
      spawnImpl: probeOnlySpawn(statusStdout, seen, oracle),
    });
    return { run, cache, seen, oracle };
  }

  // Contract: a "subscription" seat never silently bills the API. Only a
  // claude.ai login passes; every other auth method that `auth status` exits 0
  // for is refused before any oracle spawn, and the reason names the billing.
  it.each(["api_key", "api_key_helper", "third_party", "oauth_token", "none"])(
    "refuses auth method %s because the seat would bill the API",
    async (authMethod) => {
      const status = authStatus({ authMethod });
      const { run, cache, seen } = probeWith(status);
      const note = await run;
      expect(seen[1]).toEqual(AUTH_STATUS_ARGV);
      expect(note).toContain(`authMethod=${authMethod}`);
      expect(note).toContain("would bill the API");
      expect(note).toContain("claude auth login");
      expect(note).not.toContain("secret-user@example.com");
      expect(note).not.toContain("Secret Org");
      expect(cache.has("claude-sub")).toBe(false);

      // A seat call re-probes (failures are not cached), is refused for the
      // same reason, and never reaches the oracle spawn.
      const oracle = { spawns: 0 };
      const caller = createConsensusCaller({
        providers: { "claude-sub": claudeProvider() },
        providerByParticipant: { p1: "claude-sub" },
        cliGate: new CliGate(2),
        readinessCache: cache,
        env: parentEnv(),
        log: () => undefined,
        spawnImpl: probeOnlySpawn(status, [], oracle),
      });
      await expect(caller(request("p1"))).rejects.toThrow("would bill the API");
      expect(oracle.spawns).toBe(0);
    },
  );

  // Contract: a setup-token subscription credential reports oauth_token and is
  // accepted, but only when CLAUDE_CODE_OAUTH_TOKEN is what the child received.
  it("accepts oauth_token when the child holds CLAUDE_CODE_OAUTH_TOKEN", async () => {
    const env = { ...parentEnv(), CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-subscription" };
    const { run, cache } = probeWith(authStatus({ authMethod: "oauth_token" }), env);
    expect(await run).toContain("driver=claude ok");
    expect(cache.get("claude-sub")).toEqual({ ok: true });
  });

  // Contract: an auth status that cannot be read is not treated as logged in.
  it("refuses an unreadable auth status even when it exits 0", async () => {
    const { run, cache } = probeWith("Logged in as secret-user@example.com\n");
    const note = await run;
    expect(note).toContain("could not read");
    expect(note).not.toContain("secret-user@example.com");
    expect(cache.has("claude-sub")).toBe(false);
  });

  it("fails a missing claude binary from the spawn error event", async () => {
    const note = await probeCliProviders({
      providers: { "claude-sub": claudeProvider() },
      env: parentEnv(),
      spawnImpl: () => {
        const child = fakeChild();
        queueMicrotask(() => {
          const err = new Error("spawn ENOENT") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          child.emit("error", err);
        });
        return child;
      },
    });
    expect(note).toContain('cli driver claude: "claude" was not found');
    expect(note).toContain("claude auth login");
    expect(note).not.toContain("AbortError");
  });
});
