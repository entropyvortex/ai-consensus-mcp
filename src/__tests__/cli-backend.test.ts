import { EventEmitter } from "node:events";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConsensusEngine,
  extractConfidence,
  extractJudgeConfidence,
  type ModelCallRequest,
  type ModelCallResponse,
} from "ai-consensus-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createConsensusCaller } from "../caller.js";
import {
  GROK_SYSTEM_OVERRIDE,
  ORACLE_JSON_SCHEMA_TEXT,
  probeCliProviders,
  resetCliProcessNotices,
  type ReadinessState,
} from "../cli-backend/index.js";
import { CliGate } from "../cli-backend/gate.js";
import { spawnCaptured } from "../cli-backend/runner.js";
import type { LoadedConfig, ResolvedCliProvider, ResolvedHttpProvider } from "../config.js";
import { PERSONAS } from "../personas.js";
import { createMcpServer } from "../server.js";

interface FakeChild extends ChildProcess {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
}

interface SpawnCapture {
  command: string;
  args: string[];
  options: SpawnOptions;
}

function fakeChild(pid = 424242): FakeChild {
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

function errno(code: string): NodeJS.ErrnoException {
  const err = new Error(`spawn ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function grokProvider(overrides: Partial<ResolvedCliProvider> = {}): ResolvedCliProvider {
  return {
    id: "grok-sub",
    transport: "cli",
    driver: "grok",
    bin: "grok",
    timeoutMs: 120_000,
    authPath: undefined,
    ...overrides,
  };
}

function httpProvider(): ResolvedHttpProvider {
  return {
    id: "openai",
    transport: "http",
    baseUrl: "https://api.test.local",
    apiKey: "k",
    extraHeaders: {},
  };
}

function request(
  participantId: string,
  overrides: Partial<ModelCallRequest> = {},
): ModelCallRequest {
  return {
    participantId,
    modelId: "grok-4",
    round: 1,
    phase: "initial-analysis",
    system: "Be precise.",
    user: "Should we ship?",
    temperature: 0.7,
    maxOutputTokens: 1500,
    ...overrides,
  };
}

function readyCache(id = "grok-sub"): Map<string, ReadinessState> {
  return new Map([[id, { ok: true }]]);
}

const ALLOWED_EXACT = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "TMPDIR",
  "TMP",
  "TEMP",
  "GROK_HOME",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "GROK_DISABLE_AUTOUPDATER",
]);

function parentEnv(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin",
    HOME: "/home/tester",
    USER: "tester",
    LOGNAME: "tester",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    lc_ctype: "nope",
    TMPDIR: "/tmp",
    GROK_HOME: "/home/tester/.grok",
    XAI_API_KEY: "xai",
    GROK_CODE_XAI_API_KEY: "grok-code",
    ANTHROPIC_API_KEY: "anth",
    ANTHROPIC_AUTH_TOKEN: "anth-token",
    OPENAI_API_KEY: "oai",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "1",
    CLAUDE_CODE_USE_FOUNDRY: "1",
    GROK_SANDBOX: "danger",
    LD_PRELOAD: "/tmp/evil.so",
    GH_TOKEN: "gh",
    AWS_SECRET_ACCESS_KEY: "aws",
  };
}

function sse(content: string): Response {
  const encoder = new TextEncoder();
  const text = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, statusText: "OK" });
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await delay(5);
  }
}

describe("cli backend grok oracle", () => {
  const logs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetCliProcessNotices();
    logs.length = 0;
  });

  function harness(options?: {
    spawnImpl?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
    gate?: CliGate;
    cache?: Map<string, ReadinessState>;
    env?: NodeJS.ProcessEnv;
    provider?: ResolvedCliProvider;
    providers?: Record<string, ResolvedCliProvider | ResolvedHttpProvider>;
    map?: Record<string, string>;
    scheduleTimeout?: (ms: number, cb: () => void) => () => void;
    rmImpl?: (path: string, opts: { recursive: boolean; force: boolean }) => Promise<void>;
    accessImpl?: (path: string) => Promise<void>;
    omitGate?: boolean;
  }) {
    const captures: SpawnCapture[] = [];
    const spawnImpl =
      options?.spawnImpl ??
      ((command, args, spawnOptions) => {
        captures.push({ command, args: [...args], options: spawnOptions });
        const child = fakeChild();
        queueMicrotask(() => {
          succeed(child, {
            structured_output: { answer: "Ship the oracle.", confidence: 80 },
          });
        });
        return child;
      });
    const caller = createConsensusCaller({
      providers: options?.providers ?? { "grok-sub": options?.provider ?? grokProvider() },
      providerByParticipant: options?.map ?? { p1: "grok-sub", judge: "grok-sub" },
      ...(options?.omitGate ? {} : { cliGate: options?.gate ?? new CliGate(2) }),
      spawnImpl: (command, args, spawnOptions) => {
        captures.push({ command, args: [...args], options: spawnOptions });
        return spawnImpl(command, args, spawnOptions);
      },
      readinessCache: options?.cache ?? readyCache(),
      env: options?.env ?? parentEnv(),
      log: (line) => logs.push(line),
      ...(options?.scheduleTimeout ? { scheduleTimeout: options.scheduleTimeout } : {}),
      ...(options?.rmImpl ? { rmImpl: options.rmImpl } : {}),
      ...(options?.accessImpl ? { accessImpl: options.accessImpl } : {}),
    });
    return { caller, captures, logs };
  }

  it("spawns the executed grok argv and scores structured confidence", async () => {
    let mode = 0;
    let promptBody = "";
    const { caller, captures } = harness({
      spawnImpl: (command, args, options) => {
        const child = fakeChild();
        void (async () => {
          const promptPath = args[args.indexOf("--prompt-file") + 1] ?? "";
          promptBody = await readFile(promptPath, "utf8");
          mode = (await stat(promptPath)).mode & 0o777;
          succeed(child, {
            structured_output: { answer: "Ship the oracle.", confidence: 80 },
            usage: { input_tokens: 3, output_tokens: 4 },
          });
        })();
        expect(command).toBe("grok");
        expect(options.cwd).toBeDefined();
        return child;
      },
    });
    const tokens: string[] = [];
    const res = await caller({ ...request("p1"), onToken: (token) => tokens.push(token) });
    expect(res.content.endsWith("CONFIDENCE: 80")).toBe(true);
    expect(extractConfidence(res.content)).toBe(80);
    const lower = res.content.toLowerCase();
    expect(lower.indexOf("confidence:")).toBe(lower.lastIndexOf("confidence:"));
    expect(res.content).not.toContain("confidence defaulted");
    expect(tokens).toEqual([res.content]);
    expect(res.usage).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 7 });
    expect(mode).toBe(0o600);
    expect(promptBody).toBe("SYSTEM:\nBe precise.\n\nUSER:\nShould we ship?");

    const promptSpawn = captures.find((c) => c.args.includes("--prompt-file"));
    expect(promptSpawn).toBeDefined();
    const argv = promptSpawn!.args;
    const scratch = promptSpawn!.options.cwd as string;
    expect(scratch).not.toBe(process.cwd());
    expect(scratch).toContain("consensus-cli-");
    expect(argv).toEqual([
      "--no-alt-screen",
      "--no-subagents",
      "--disable-web-search",
      "--verbatim",
      "--permission-mode",
      "dontAsk",
      "--output-format",
      "json",
      "--json-schema",
      ORACLE_JSON_SCHEMA_TEXT,
      "--cwd",
      scratch,
      "--max-turns",
      "2",
      "--prompt-file",
      join(scratch, "prompt.txt"),
      "--system-prompt-override",
      GROK_SYSTEM_OVERRIDE,
      "-m",
      "grok-4",
      "--no-plan",
    ]);
    const flat = argv.join("\n");
    for (const forbidden of [
      "--always-approve",
      "--tools",
      "--worktree",
      "bypassPermissions",
      "--sandbox",
      "--disallowed-tools",
      "--deny",
    ]) {
      expect(flat).not.toContain(forbidden);
    }
    expect(promptSpawn!.options.detached).toBe(true);
    expect(promptSpawn!.options.windowsHide).toBe(true);
    expect(promptSpawn!.options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    const env = promptSpawn!.options.env ?? {};
    for (const key of Object.keys(env)) {
      expect(ALLOWED_EXACT.has(key) || /^LC_[A-Z0-9_]+$/.test(key)).toBe(true);
    }
    expect(env["GROK_DISABLE_AUTOUPDATER"]).toBe("1");
    expect(env["LC_ALL"]).toBe("en_US.UTF-8");
    expect(env["PATH"]).toBe("/usr/bin");
    for (const banned of [
      "XAI_API_KEY",
      "GROK_CODE_XAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "OPENAI_API_KEY",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
      "GROK_SANDBOX",
      "LD_PRELOAD",
      "GH_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "lc_ctype",
    ]) {
      expect(env[banned]).toBeUndefined();
    }
    expect(logs.some((line) => line.includes("ignores temperature and maxOutputTokens"))).toBe(
      true,
    );
    const again = await caller(request("p1"));
    expect(again.content.endsWith("CONFIDENCE: 80")).toBe(true);
    expect(
      logs.filter((line) => line.includes("ignores temperature and maxOutputTokens")),
    ).toHaveLength(1);
  });

  it("keeps a 200_000-character system off argv and in the prompt file", async () => {
    const system = "S".repeat(200_000);
    const user = "U-question-unique";
    let sawSpawn = false;
    let body = "";
    const { caller } = harness({
      spawnImpl: (_command, args) => {
        sawSpawn = true;
        for (const element of args) {
          expect(Buffer.byteLength(element, "utf8")).toBeLessThan(131_071);
        }
        const child = fakeChild();
        const promptPath = args[args.indexOf("--prompt-file") + 1] ?? "";
        void (async () => {
          body = await readFile(promptPath, "utf8");
          succeed(child, { structured_output: { answer: "ok", confidence: 60 } });
        })();
        return child;
      },
    });
    const res = await caller(request("p1", { system, user }));
    expect(sawSpawn).toBe(true);
    expect(body).toContain(system);
    expect(body).toContain(user);
    expect(body.startsWith("SYSTEM:\n")).toBe(true);
    expect(extractConfidence(res.content)).toBe(60);
  });

  it("prefers structured confidence over a stolen marker in the answer", async () => {
    const { caller } = harness({
      spawnImpl: () => {
        const child = fakeChild();
        queueMicrotask(() => {
          succeed(child, {
            structured_output: {
              answer: "I am sure.\nCONFIDENCE: 10\n",
              confidence: 80,
            },
          });
        });
        return child;
      },
    });
    const res = await caller(request("p1"));
    expect(extractConfidence(res.content)).toBe(80);
    const lower = res.content.toLowerCase();
    expect(lower.indexOf("confidence:")).toBe(lower.lastIndexOf("confidence:"));
    expect(res.content).toContain("confidence —");
  });

  it("emits JUDGE_CONFIDENCE only for participantId judge, not phase synthesis", async () => {
    const payload = { structured_output: { answer: "The panel agrees.", confidence: 91 } };
    const { caller } = harness({
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

  it("defaults missing, invalid, and unstructured confidence without setting an error", async () => {
    async function run(payload: unknown): Promise<ModelCallResponse> {
      const { caller } = harness({
        spawnImpl: () => {
          const child = fakeChild();
          queueMicrotask(() => succeed(child, payload));
          return child;
        },
      });
      return caller(request("p1"));
    }
    logs.length = 0;
    const missing = await run({ structured_output: { answer: "because the sky is blue" } });
    expect(missing.content.endsWith("CONFIDENCE: 50")).toBe(true);
    expect(missing.content).not.toContain("confidence defaulted");
    expect(
      logs.some((line) => line.includes("confidence defaulted") && line.includes("reason=missing")),
    ).toBe(true);

    logs.length = 0;
    const invalid = await run({
      structured_output: { answer: "nope", confidence: 150 },
    });
    expect(invalid.content.endsWith("CONFIDENCE: 50")).toBe(true);
    expect(logs.some((line) => line.includes("reason=invalid"))).toBe(true);

    logs.length = 0;
    const unstructured = await run({ result: "plain text with no marker" });
    expect(unstructured.content.endsWith("CONFIDENCE: 50")).toBe(true);
    expect(extractConfidence(unstructured.content)).toBe(50);
    expect(logs.some((line) => line.includes("reason=unstructured"))).toBe(true);

    logs.length = 0;
    const prose = await run({ result: "answer line\nCONFIDENCE: 70" });
    expect(extractConfidence(prose.content)).toBe(70);
    expect(logs.some((line) => line.includes("confidenceSource=prose"))).toBe(true);
    expect(logs.some((line) => line.includes("confidence defaulted"))).toBe(false);
  });

  it("throws on an empty answer and keeps the other seat", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sse("from-http"));
    const { caller } = harness({
      providers: { "grok-sub": grokProvider(), openai: httpProvider() },
      map: { a: "grok-sub", b: "openai" },
      spawnImpl: () => {
        const child = fakeChild();
        queueMicrotask(() => {
          succeed(child, { structured_output: { answer: "   ", confidence: 10 } });
        });
        return child;
      },
    });
    await expect(caller(request("a"))).rejects.toThrow("cli driver grok returned an empty answer");
    const engine = new ConsensusEngine(caller);
    const result = await engine.run({
      question: "q",
      participants: [
        { id: "a", modelId: "grok-4", persona: PERSONAS[0]! },
        { id: "b", modelId: "gpt", persona: PERSONAS[1]! },
      ],
      maxRounds: 1,
      earlyStop: false,
      blindFirstRound: true,
      randomizeOrder: false,
    });
    const responses = result.rounds[0]?.responses ?? [];
    const a = responses.find((row) => row.participantId === "a");
    const b = responses.find((row) => row.participantId === "b");
    expect(a?.error).toContain("empty answer");
    expect(b?.error).toBeUndefined();
    expect(b?.content).toContain("from-http");
    expect(result.stopReason).not.toBe("aborted");
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("includes a non-zero exit clip and still calls the HTTP seat", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sse("http-ok"));
    const { caller } = harness({
      providers: { "grok-sub": grokProvider(), openai: httpProvider() },
      map: { a: "grok-sub", b: "openai" },
      spawnImpl: () => {
        const child = fakeChild();
        queueMicrotask(() => {
          child.stderr.write("rate limit");
          child.stderr.end();
          child.stdout.end();
          child.emit("close", 1, null);
        });
        return child;
      },
    });
    let caught: unknown;
    try {
      await caller(request("a"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).not.toBe("AbortError");
    expect((caught as Error).message).toContain("rate limit");
    expect((caught as Error).message).toContain("exited 1");
    const http = await caller(request("b", { modelId: "gpt", participantId: "b" }));
    expect(http.content).toBe("http-ok");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("times out with ETIMEDOUT and a process-group SIGTERM, not AbortError", async () => {
    const kills: { pid: number; signal: NodeJS.Signals | undefined }[] = [];
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals) => {
      kills.push({ pid, signal });
      return true;
    }) as typeof process.kill);
    const scheduled: number[] = [];
    const { caller } = harness({
      scheduleTimeout: (ms, cb) => {
        scheduled.push(ms);
        cb();
        return () => undefined;
      },
      spawnImpl: () => fakeChild(),
    });
    let caught: unknown;
    try {
      await caller(request("p1"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(DOMException);
    expect((caught as Error).name).not.toBe("AbortError");
    expect((caught as NodeJS.ErrnoException).code).toBe("ETIMEDOUT");
    expect((caught as Error).message).toContain("timed out after 120000ms");
    expect(scheduled).toEqual([120_000]);
    expect(kills).toContainEqual({ pid: -424242, signal: "SIGTERM" });
  });

  it("aborts an in-flight spawn with AbortError and a process-group SIGTERM", async () => {
    const kills: { pid: number; signal: NodeJS.Signals | undefined }[] = [];
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals) => {
      kills.push({ pid, signal });
      return true;
    }) as typeof process.kill);
    const ac = new AbortController();
    const { caller } = harness({
      spawnImpl: () => {
        const child = fakeChild();
        queueMicrotask(() => ac.abort());
        return child;
      },
    });
    await expect(caller({ ...request("p1"), signal: ac.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(kills).toContainEqual({ pid: -424242, signal: "SIGTERM" });
  });

  it("does not spawn when the signal is already aborted", async () => {
    let spawns = 0;
    const ac = new AbortController();
    ac.abort();
    const { caller } = harness({
      spawnImpl: () => {
        spawns += 1;
        return fakeChild();
      },
    });
    await expect(caller({ ...request("p1"), signal: ac.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(spawns).toBe(0);
  });

  it("rejects ENOENT from the error event without waiting for the timeout", async () => {
    let fired = false;
    const started = Date.now();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sse("still-http"));
    const { caller } = harness({
      providers: { "grok-sub": grokProvider(), openai: httpProvider() },
      map: { a: "grok-sub", b: "openai" },
      scheduleTimeout: (ms, cb) => {
        expect(ms).toBe(120_000);
        const timer = setTimeout(() => {
          fired = true;
          cb();
        }, ms);
        return () => clearTimeout(timer);
      },
      spawnImpl: () => {
        const child = fakeChild();
        queueMicrotask(() => child.emit("error", errno("ENOENT")));
        return child;
      },
    });
    let caught: unknown;
    try {
      await caller(request("a"));
    } catch (err) {
      caught = err;
    }
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(fired).toBe(false);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).not.toBe("AbortError");
    expect((caught as Error).message).toContain('cli driver grok: "grok" was not found');
    expect((caught as Error).message).toContain("https://x.ai/cli");
    expect((caught as Error).message).toContain("grok login");
    expect((caught as Error).message).toContain("HTTP participants in this panel are unaffected");
    const http = await caller(request("b", { participantId: "b", modelId: "gpt" }));
    expect(http.content).toBe("still-http");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("maps a synchronous ENOENT throw to a seat error", async () => {
    const { caller } = harness({
      spawnImpl: () => {
        throw errno("ENOENT");
      },
    });
    await expect(caller(request("p1"))).rejects.toThrow(/grok login/);
  });

  it("maps E2BIG to a seat error that names the 131071-byte limit", async () => {
    let fired = false;
    const { caller } = harness({
      scheduleTimeout: (_ms, cb) => {
        const timer = setTimeout(() => {
          fired = true;
          cb();
        }, 120_000);
        return () => clearTimeout(timer);
      },
      spawnImpl: () => {
        const child = fakeChild();
        queueMicrotask(() => child.emit("error", errno("E2BIG")));
        return child;
      },
    });
    let caught: unknown;
    try {
      await caller(request("p1"));
    } catch (err) {
      caught = err;
    }
    expect(fired).toBe(false);
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(DOMException);
    expect((caught as Error).name).not.toBe("AbortError");
    expect((caught as Error).message).toContain("131071");
    expect((caught as Error).message).toContain("E2BIG");
  });

  it("throws the oracle error for tools before acquire or spawn", async () => {
    const gate = new CliGate(2);
    const acquire = vi.spyOn(gate, "acquire");
    let spawns = 0;
    const { caller } = harness({
      gate,
      spawnImpl: () => {
        spawns += 1;
        return fakeChild();
      },
    });
    await expect(
      caller(
        request("p1", {
          tools: [{ name: "read_file", description: "read", parameters: { type: "object" } }],
        }),
      ),
    ).rejects.toThrow(/text oracle and cannot run tools/);
    await expect(
      caller(
        request("p1", {
          toolCallTurns: [
            {
              toolCalls: [{ id: "1", name: "read_file", arguments: {} }],
              toolResults: [{ content: "x" }],
            },
          ],
        }),
      ),
    ).rejects.toThrow(/text oracle/);
    expect(spawns).toBe(0);
    expect(acquire).not.toHaveBeenCalled();
  });

  it("throws when the gate is missing and does not spawn", async () => {
    let spawns = 0;
    const { caller } = harness({
      omitGate: true,
      spawnImpl: () => {
        spawns += 1;
        return fakeChild();
      },
    });
    let caught: unknown;
    try {
      await caller(request("p1"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("cli gate was not provided");
    expect((caught as Error).name).not.toBe("AbortError");
    expect(spawns).toBe(0);
  });

  it("honors CONSENSUS_DISABLE_CLI before spawn and still runs HTTP", async () => {
    let spawns = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sse("http-lives"));
    const { caller } = harness({
      env: { ...parentEnv(), CONSENSUS_DISABLE_CLI: "1" },
      providers: { "grok-sub": grokProvider(), openai: httpProvider() },
      map: { cli: "grok-sub", http: "openai" },
      spawnImpl: () => {
        spawns += 1;
        return fakeChild();
      },
    });
    await expect(caller(request("cli"))).rejects.toThrow(
      "CLI transports are disabled by CONSENSUS_DISABLE_CLI",
    );
    const res = await caller(request("http", { participantId: "http", modelId: "gpt" }));
    expect(res.content).toBe("http-lives");
    expect(spawns).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("leaves claude and codex unregistered", async () => {
    let spawns = 0;
    const { caller } = harness({
      providers: {
        "claude-sub": grokProvider({ id: "claude-sub", driver: "claude", bin: "claude" }),
        "codex-sub": grokProvider({ id: "codex-sub", driver: "codex", bin: "codex" }),
      },
      map: { c: "claude-sub", x: "codex-sub" },
      cache: new Map(),
      spawnImpl: () => {
        spawns += 1;
        return fakeChild();
      },
    });
    await expect(caller(request("c"))).rejects.toThrow('cli driver "claude" is not registered');
    await expect(caller(request("x"))).rejects.toThrow('cli driver "codex" is not registered');
    expect(spawns).toBe(0);
  });

  it("deletes the scratch dir and rejects unexpected files", async () => {
    const removed: string[] = [];
    const { caller } = harness({
      rmImpl: async (path, opts) => {
        removed.push(path);
        await rm(path, opts);
      },
      spawnImpl: (_command, args, options) => {
        const child = fakeChild();
        queueMicrotask(() => {
          succeed(child, { structured_output: { answer: "ok", confidence: 55 } });
        });
        expect(String(options.cwd)).not.toBe(process.cwd());
        expect(args[args.indexOf("--prompt-file") + 1]?.startsWith(String(options.cwd))).toBe(true);
        return child;
      },
    });
    await caller(request("p1"));
    expect(removed).toHaveLength(1);
    expect(removed[0]).toContain("consensus-cli-");

    const removedAfter: string[] = [];
    const evil = harness({
      rmImpl: async (path, opts) => {
        removedAfter.push(path);
        await rm(path, opts);
      },
      spawnImpl: (_command, _args, options) => {
        const child = fakeChild();
        const cwd = String(options.cwd);
        void (async () => {
          await writeFile(join(cwd, "evil.txt"), "nope");
          succeed(child, { structured_output: { answer: "ok", confidence: 55 } });
        })();
        return child;
      },
    });
    await expect(evil.caller(request("p1"))).rejects.toThrow(/evil\.txt/);
    expect(removedAfter).toHaveLength(1);
  });

  it("caps concurrent CLI spawns and does not queue HTTP", async () => {
    let active = 0;
    let maxActive = 0;
    const held: (() => void)[] = [];
    const gate = new CliGate(2);
    const acquire = vi.spyOn(gate, "acquire");
    const { caller } = harness({
      gate,
      providers: { "grok-sub": grokProvider(), openai: httpProvider() },
      map: { a: "grok-sub", b: "grok-sub", c: "grok-sub", http: "openai" },
      spawnImpl: () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const child = fakeChild();
        held.push(() => {
          active -= 1;
          succeed(child, { structured_output: { answer: "ok", confidence: 61 } });
        });
        return child;
      },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sse("not-queued"));
    const pending = [caller(request("a")), caller(request("b")), caller(request("c"))];
    await waitFor(() => held.length === 2);
    await delay(30);
    expect(held.length).toBe(2);
    expect(maxActive).toBe(2);
    const acquiresBeforeHttp = acquire.mock.calls.length;
    const http = await caller(request("http", { participantId: "http", modelId: "gpt" }));
    expect(http.content).toBe("not-queued");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(acquire.mock.calls.length).toBe(acquiresBeforeHttp);
    const httpAcquires = acquire.mock.calls.length;
    for (let i = 0; i < 5 && held.length > 0; i += 1) {
      expect(maxActive).toBeLessThanOrEqual(2);
      held.shift()?.();
      await delay(10);
    }
    await Promise.all(pending);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(acquire.mock.calls.length).toBe(httpAcquires);
  });

  it("aborts a queued call without spawning it", async () => {
    const held: (() => void)[] = [];
    let spawns = 0;
    let timers = 0;
    const { caller } = harness({
      gate: new CliGate(2),
      map: { a: "grok-sub", b: "grok-sub", c: "grok-sub" },
      scheduleTimeout: (_ms, cb) => {
        timers += 1;
        const timer = setTimeout(cb, 120_000);
        return () => clearTimeout(timer);
      },
      spawnImpl: () => {
        spawns += 1;
        const child = fakeChild();
        held.push(() => succeed(child, { structured_output: { answer: "ok", confidence: 50 } }));
        return child;
      },
    });
    const first = caller(request("a"));
    const second = caller(request("b"));
    await waitFor(() => held.length === 2);
    const ac = new AbortController();
    const third = caller({ ...request("c"), signal: ac.signal });
    await delay(20);
    expect(spawns).toBe(2);
    expect(timers).toBe(2);
    ac.abort();
    await expect(third).rejects.toMatchObject({ name: "AbortError" });
    expect(spawns).toBe(2);
    expect(timers).toBe(2);
    held.shift()?.();
    held.shift()?.();
    await Promise.all([first, second]);
  });

  it("shares one gate across two createMcpServer instances", async () => {
    let active = 0;
    let maxActive = 0;
    const held: (() => void)[] = [];
    const gate = new CliGate(1);
    const cache = readyCache();
    const spawnImpl = () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const child = fakeChild();
      held.push(() => {
        active -= 1;
        succeed(child, { structured_output: { answer: "yes", confidence: 70 } });
      });
      return child;
    };
    const config = cliConfig();
    const deps = {
      cliGate: gate,
      readinessCache: cache,
      spawnImpl,
      log: () => undefined,
      env: parentEnv(),
    };
    const serverA = createMcpServer(config, deps);
    const serverB = createMcpServer(config, deps);
    const clientA = new Client({ name: "a", version: "0" }, { capabilities: {} });
    const clientB = new Client({ name: "b", version: "0" }, { capabilities: {} });
    const [aClientT, aServerT] = InMemoryTransport.createLinkedPair();
    const [bClientT, bServerT] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      serverA.connect(aServerT),
      clientA.connect(aClientT),
      serverB.connect(bServerT),
      clientB.connect(bClientT),
    ]);
    const args = { prompt: "Ship?", maxRounds: 1, earlyStop: false, judge: false };
    const runs = Promise.all([
      clientA.callTool({ name: "consensus", arguments: args }),
      clientB.callTool({ name: "consensus", arguments: args }),
    ]);
    await waitFor(() => held.length >= 1);
    await delay(40);
    expect(maxActive).toBe(1);
    expect(held.length).toBe(1);
    for (let i = 0; i < 8; i += 1) {
      if (held.length === 0) {
        await delay(10);
        continue;
      }
      expect(active).toBeLessThanOrEqual(1);
      held.shift()?.();
      await delay(15);
    }
    const results = await runs;
    expect(maxActive).toBe(1);
    for (const result of results) {
      expect(result.isError).not.toBe(true);
    }
    await Promise.all([clientA.close(), clientB.close(), serverA.close(), serverB.close()]);
  });

  it("probes grok readiness without sending a prompt and caches the failure", async () => {
    const cache = new Map<string, ReadinessState>();
    const spawns: string[][] = [];
    const note = await probeCliProviders({
      providers: { "grok-sub": grokProvider() },
      env: parentEnv(),
      cache,
      accessImpl: (path) => {
        expect(path).toBe("/home/tester/.grok/auth.json");
        return Promise.resolve();
      },
      spawnImpl: (_command, args, options) => {
        spawns.push([...args]);
        expect(options.env?.["OPENAI_API_KEY"]).toBeUndefined();
        expect(options.env?.["GROK_SANDBOX"]).toBeUndefined();
        expect(options.env?.["GROK_DISABLE_AUTOUPDATER"]).toBe("1");
        const child = fakeChild();
        queueMicrotask(() => {
          child.stdout.end();
          child.stderr.end();
          child.emit("close", 0, null);
        });
        return child;
      },
    });
    expect(note).toContain("driver=grok ok");
    expect(spawns).toEqual([["--version"]]);
    expect(cache.get("grok-sub")).toEqual({ ok: true });

    const failing = new Map<string, ReadinessState>();
    let accessCalls = 0;
    const failNote = await probeCliProviders({
      providers: { "grok-sub": grokProvider({ authPath: "/tmp/missing-auth.json" }) },
      env: parentEnv(),
      cache: failing,
      accessImpl: (path) => {
        accessCalls += 1;
        expect(path).toBe("/tmp/missing-auth.json");
        return Promise.reject(new Error("ENOENT"));
      },
      spawnImpl: () => {
        const child = fakeChild();
        queueMicrotask(() => child.emit("close", 0, null));
        return child;
      },
    });
    expect(failNote).toContain("not signed in");
    expect(failNote).toContain("grok login");
    const second = await probeCliProviders({
      providers: { "grok-sub": grokProvider() },
      cache: failing,
      spawnImpl: () => {
        throw new Error("should not spawn");
      },
    });
    expect(second).toContain("not signed in");
    expect(accessCalls).toBe(1);
  });

  it("skips readiness probes when CLI transports are disabled", async () => {
    let spawns = 0;
    const note = await probeCliProviders({
      providers: {
        "grok-sub": grokProvider(),
        openai: httpProvider(),
        "claude-sub": grokProvider({ id: "claude-sub", driver: "claude", bin: "claude" }),
      },
      env: { CONSENSUS_DISABLE_CLI: "1" },
      spawnImpl: () => {
        spawns += 1;
        return fakeChild();
      },
    });
    expect(note).toContain("CONSENSUS_DISABLE_CLI");
    expect(spawns).toBe(0);

    const unregistered = await probeCliProviders({
      providers: {
        "claude-sub": grokProvider({ id: "claude-sub", driver: "claude", bin: "claude" }),
      },
      env: {},
      spawnImpl: () => {
        spawns += 1;
        return fakeChild();
      },
    });
    expect(unregistered).toContain('cli driver "claude" is not registered');
    expect(spawns).toBe(0);
  });

  it("writes a piped stdin transcript and kills on capture overflow", async () => {
    const child = fakeChild();
    const chunks: string[] = [];
    const done = spawnCaptured({
      driver: "grok",
      bin: "grok",
      argv: ["--version"],
      env: {},
      stdin: "pipe",
      stdinText: "SYSTEM:\npersona\n\nUSER:\nquestion",
      timeoutMs: 1000,
      installUrl: "https://x.ai/cli",
      loginCommand: "grok login",
      spawnImpl: () => {
        child.stdin.on("data", (buf: Buffer) => chunks.push(buf.toString("utf8")));
        queueMicrotask(() => {
          child.stdout.end();
          child.stderr.end();
          child.emit("close", 0, null);
        });
        return child;
      },
    });
    await expect(done).resolves.toMatchObject({ exitCode: 0 });
    expect(chunks.join("")).toContain("SYSTEM:\npersona");
    expect(chunks.join("")).toContain("USER:\nquestion");

    const kills: number[] = [];
    vi.spyOn(process, "kill").mockImplementation((pid: number) => {
      kills.push(pid);
      return true;
    });
    const overflow = spawnCaptured({
      driver: "grok",
      bin: "grok",
      argv: ["--version"],
      env: {},
      stdin: "ignore",
      timeoutMs: 5_000,
      maxCaptureChars: 8,
      installUrl: "https://x.ai/cli",
      loginCommand: "grok login",
      spawnImpl: () => {
        const bomb = fakeChild();
        queueMicrotask(() => {
          bomb.stdout.write("0123456789abcdef");
        });
        return bomb;
      },
    });
    await expect(overflow).rejects.toThrow(/exceeded 8 characters/);
    expect(kills).toContain(-424242);
  });
});

function cliConfig(): LoadedConfig {
  return {
    sourcePath: "/fake/cli.json",
    providers: { "grok-sub": grokProvider() },
    participants: [
      { id: "p1", modelId: "grok-4", persona: PERSONAS[0]! },
      { id: "p2", modelId: "grok-4", persona: PERSONAS[1]! },
    ],
    providerByParticipant: { p1: "grok-sub", p2: "grok-sub" },
    judge: undefined,
    defaults: {
      maxRounds: 1,
      earlyStop: false,
      convergenceDelta: 3,
      disagreementThreshold: 20,
      blindFirstRound: true,
      randomizeOrder: false,
      participantTemperature: 0.7,
      maxOutputTokens: 1500,
      useJudge: false,
      cliMaxInFlight: 2,
    },
    memory: {
      enabled: false,
      storageRoot: "/tmp/test-memory",
      maxResults: 10,
      maxAgeDays: 1,
      raw: undefined,
    },
  };
}
