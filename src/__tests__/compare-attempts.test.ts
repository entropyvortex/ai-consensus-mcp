import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ModelCallRequest, ModelCaller, Participant } from "ai-consensus-core";
import {
  COMPARE_ATTEMPTS_TOOL,
  LIST_ATTEMPTS_TOOL,
  ToolInputError,
  runCompareAttempts,
  runListAttempts,
  type CompareAttemptsInput,
} from "../compare/attempts.js";
import type { LoadedConfig } from "../config.js";
import { PERSONAS } from "../personas.js";
import { createMcpServer } from "../server.js";
import { createGitFixture, type GitFixture } from "./_git-fixture.js";

// Contracts: the server computes diffs itself and they never reach the
// agent; jurors see neutral labels and content only (never refs or
// labels); CLI jurors are asked to enforce the verdict schema, the judge
// is not; testCommand needs the allow flag and runs only in worktrees;
// the repo tools exist on the stdio server only.

let fx: GitFixture;
beforeAll(() => {
  fx = createGitFixture();
});
afterAll(() => fx.cleanup());
afterEach(() => vi.restoreAllMocks());

const JUDGE = `## Majority Position
Both jurors preferred the correct sum.

## Minority Positions
None.

## Unresolved Disputes
- None

JUDGE_CONFIDENCE: 80`;

/** Label under which the candidate whose content contains `tag` was shown. */
function labelFor(prompt: string, tag: string): string {
  const re = /<<<BEGIN CANDIDATE ([A-Z]) ([0-9a-f]{6})>>>\n([\s\S]*?)\n<<<END CANDIDATE \1 \2>>>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) if (m[3]!.includes(tag)) return m[1]!;
  throw new Error(`no candidate containing ${tag}`);
}

/** Blind juror: prefers ALPHA > GAMMA > BETA by content, flags the BETA bug. */
function verdictFor(prompt: string): string {
  const order = ["ALPHA", "GAMMA", "BETA"].filter((t) => prompt.includes(`// ${t}`));
  return JSON.stringify({
    ranking: order.map((t) => labelFor(prompt, t)),
    assessments: [],
    findings: [
      {
        candidate: labelFor(prompt, "BETA"),
        severity: "high",
        file: "src/sum.ts",
        line: 2,
        quote: "return a - b; // BETA",
        issue: "subtracts instead of adding",
      },
    ],
  });
}

const JURORS: Participant[] = [
  { id: "j1", modelId: "model-1", persona: PERSONAS[0]! },
  { id: "j2", modelId: "model-2", persona: PERSONAS[1]! },
];

function fakeCaller() {
  const calls: ModelCallRequest[] = [];
  const schemas: [string, unknown][] = [];
  const factory = (schemaFor: (id: string) => Record<string, unknown> | undefined): ModelCaller => {
    return (req) => {
      calls.push(req);
      schemas.push([req.participantId, schemaFor(req.participantId)]);
      return Promise.resolve({
        content: req.participantId === "judge" ? JUDGE : verdictFor(req.user),
      });
    };
  };
  return { calls, schemas, factory };
}

function input(overrides: Partial<CompareAttemptsInput> = {}): CompareAttemptsInput {
  return {
    task: "Make sum(a, b) return a + b",
    attempts: [
      { ref: "attempt-a", label: "Claude run" },
      { ref: "attempt-b" },
      { ref: "attempt-c" },
    ],
    randomSeed: 3,
    ...overrides,
  };
}

function ctx(overrides: Partial<Parameters<typeof runCompareAttempts>[0]> = {}) {
  const fake = fakeCaller();
  return {
    fake,
    run: () =>
      runCompareAttempts({
        input: input(),
        jurors: JURORS,
        providers: {},
        providerByParticipant: {},
        judge: { modelId: "judge-model" },
        deps: undefined,
        allowTestCommand: false,
        cwd: fx.worktreeC,
        callerFactory: fake.factory,
        ...overrides,
      }),
  };
}

describe("runCompareAttempts", () => {
  it("returns a short verdict first and the typed result, without diffs or raw juror output", async () => {
    const { run } = ctx();
    const out = await run();
    const text = out.content[0]!.text;
    expect(text.split("\n")[0]).toBe("**Verdict: keep `attempt-a` (Claude run).**");
    expect(text).toContain("Nothing was merged, checked out or deleted.");
    const s = out.structuredContent as Record<string, unknown> & {
      recommended: string;
      base: { sha: string };
      attempts: { ref: string; includesUncommitted: boolean; worktree: string | null }[];
      rounds: { verdicts: { raw: string }[] }[];
    };
    expect(s.recommended).toBe("attempt-a");
    expect(s.base.sha).toBe(fx.baseSha); // merge-base of the attempts
    expect(s.attempts.find((a) => a.ref === "attempt-c")).toMatchObject({
      includesUncommitted: true,
      worktree: fx.worktreeC,
    });
    expect(s.rounds[0]!.verdicts.every((v) => v.raw === "")).toBe(true);
    const json = JSON.stringify(s);
    expect(json).not.toContain("return a + b; // ALPHA"); // diff body
    expect(json).not.toContain("GAMMA untracked");
    expect(json).toContain("return a - b; // BETA"); // a verified finding's quote
  });

  it("shows jurors content under neutral labels, never refs, labels or the omission-free truth", async () => {
    const { run, fake } = ctx();
    await run();
    const jurors = fake.calls.filter((c) => c.participantId !== "judge");
    expect(jurors).toHaveLength(2);
    for (const c of jurors) {
      const text = `${c.system}\n${c.user}`;
      expect(text).not.toMatch(/attempt-[abc]|Claude run/);
      expect(c.user).toContain("#   lockfile: package-lock.json");
      expect(c.user).toContain("GAMMA uncommitted");
    }
  });

  it("asks CLI jurors to enforce the verdict schema and leaves the judge on the oracle schema", async () => {
    const { run, fake } = ctx();
    await run();
    const juror = fake.schemas.find(([id]) => id === "j1")![1] as {
      properties: { ranking: { items: { enum: string[] } } };
    };
    expect(juror.properties.ranking.items.enum).toEqual(["A", "B", "C"]);
    expect(fake.schemas.find(([id]) => id === "judge")![1]).toBeUndefined();
  });

  it("defaults to one round plus the judge and reports progress", async () => {
    const sendNotification = vi.fn(() => Promise.resolve());
    const { run, fake } = ctx({ progress: { sendNotification, progressToken: "t" } });
    const out = await run();
    expect(fake.calls.map((c) => c.participantId).sort()).toEqual(["j1", "j2", "judge"]);
    expect((out.structuredContent as { rounds: unknown[] }).rounds).toHaveLength(1);
    const messages = sendNotification.mock.calls.map(
      (c) => (c as unknown as [{ params: { message: string } }])[0].params.message,
    );
    expect(messages[0]).toMatch(/^Round 1 \(blind\)/);
    expect(messages.some((m) => m.startsWith("Judge synthesis complete"))).toBe(true);
  });

  it.each([
    ["duplicate refs", { attempts: [{ ref: "attempt-a" }, { ref: "attempt-a" }] }, /distinct refs/],
    [
      "an option-like ref",
      { attempts: [{ ref: "attempt-a" }, { ref: "-evil" }] },
      /must not start with "-"/,
    ],
    [
      "an unknown ref",
      { attempts: [{ ref: "attempt-a" }, { ref: "nope" }] },
      /does not name a commit/,
    ],
    [
      "no common ancestor",
      { attempts: [{ ref: "attempt-a" }, { ref: "unrelated" }] },
      /no common ancestor/,
    ],
    ["testCommand without the allow flag", { testCommand: ["true"] }, /--allow-test-command/],
  ])("refuses %s", async (_name, patch, re) => {
    const { run } = ctx({ input: input(patch) });
    await expect(run()).rejects.toThrow(re);
  });

  it("caps file lists in the structured result and keeps exact totals", async () => {
    const { run } = ctx({
      input: input({ attempts: [{ ref: "attempt-a" }, { ref: "attempt-noisy" }] }),
    });
    const out = await run();
    const noisy = (
      out.structuredContent as {
        attempts: { ref: string; files: { skipped: unknown[]; skippedTotal: number } }[];
      }
    ).attempts.find((a) => a.ref === "attempt-noisy")!;
    expect(noisy.files.skipped).toHaveLength(50);
    expect(noisy.files.skippedTotal).toBe(61);
    expect(out.content[0]!.text).toContain("61 skipped");
  });

  it("accepts an explicit base", async () => {
    const { run } = ctx({
      input: input({ base: "main", attempts: [{ ref: "attempt-a" }, { ref: "unrelated" }] }),
    });
    const out = await run();
    expect((out.structuredContent as { base: { ref: string } }).base.ref).toBe("main");
  });

  it("runs testCommand only in a worktree that has the attempt checked out", async () => {
    const script =
      "process.exit(require('fs').readFileSync('src/sum.ts','utf8').includes('a + b') ? 0 : 1)";
    const { run } = ctx({
      allowTestCommand: true,
      input: input({ testCommand: [process.execPath, "-e", script], testTimeoutMs: 30_000 }),
    });
    const out = await run();
    const candidates = (
      out.structuredContent as {
        candidates: {
          id: string;
          checks: { name: string; status: string; output?: string }[];
        }[];
      }
    ).candidates;
    const check = (id: string) =>
      candidates.find((c) => c.id === id)!.checks.find((c) => c.name === "testCommand")!;
    expect(check("attempt-c")).toMatchObject({ status: "passed" });
    expect(check("attempt-a")).toMatchObject({
      status: "unknown",
      output: "no worktree has this ref checked out",
    });
  });

  it("is refused as a ToolInputError type for input problems", async () => {
    const { run } = ctx({
      input: input({ attempts: [{ ref: "attempt-a" }, { ref: "attempt-a" }] }),
    });
    await expect(run()).rejects.toBeInstanceOf(ToolInputError);
  });
});

describe("runListAttempts", () => {
  it("renders a table with the current worktree marked", async () => {
    const out = await runListAttempts({ input: {}, cwd: fx.worktreeC });
    expect(out.content[0]!.text).toContain("| `attempt-c` (this worktree) | 1 | 1 |");
    expect((out.structuredContent as { base: { ref: string } }).base.ref).toBe("main");
  });
});

// ── Through the MCP server ───────────────────────────────────

function config(): LoadedConfig {
  return {
    sourcePath: "/fake",
    providers: {
      test: {
        id: "test",
        transport: "http",
        baseUrl: "https://api.test.local",
        apiKey: "k",
        extraHeaders: {},
      },
    },
    participants: JURORS,
    providerByParticipant: { j1: "test", j2: "test" },
    memory: { enabled: false, storageRoot: "/tmp/x", maxResults: 1, maxAgeDays: 1, raw: undefined },
    judge: undefined,
    defaults: {
      maxRounds: 4,
      earlyStop: true,
      convergenceDelta: 3,
      disagreementThreshold: 20,
      blindFirstRound: true,
      randomizeOrder: true,
      participantTemperature: 0.7,
      maxOutputTokens: 1500,
      useJudge: false,
    },
  };
}

async function connect(repoTools?: { allowTestCommand: boolean }) {
  const server = createMcpServer(config(), repoTools ? { repoTools } : undefined);
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, close: async () => (await client.close(), await server.close()) };
}

function sseResponse(content: string): Response {
  const body = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`;
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(body));
        c.close();
      },
    }),
    { status: 200 },
  );
}

describe("MCP server — repo tools", () => {
  it("are not offered unless the stdio entry point enables them", async () => {
    const env = await connect();
    const names = (await env.client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain(COMPARE_ATTEMPTS_TOOL);
    expect(names).not.toContain(LIST_ATTEMPTS_TOOL);
    const res = await env.client.callTool({ name: LIST_ATTEMPTS_TOOL, arguments: {} });
    expect(res.isError).toBe(true);
    await env.close();
  });

  it("list and compare attempts end to end over an HTTP provider", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      const raw = init?.body;
      const body = JSON.parse(typeof raw === "string" ? raw : "{}") as {
        messages: { content: string }[];
      };
      return Promise.resolve(sseResponse(verdictFor(body.messages[1]!.content)));
    });
    const env = await connect({ allowTestCommand: false });
    const tools = (await env.client.listTools()).tools;
    expect(tools.find((t) => t.name === LIST_ATTEMPTS_TOOL)?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === COMPARE_ATTEMPTS_TOOL)).toBeDefined();

    const list = await env.client.callTool({
      name: LIST_ATTEMPTS_TOOL,
      arguments: { repoPath: fx.root },
    });
    expect(JSON.stringify(list.content)).toContain("attempt-b");

    const res = await env.client.callTool({
      name: COMPARE_ATTEMPTS_TOOL,
      arguments: {
        task: "sum",
        repoPath: fx.root,
        attempts: [{ ref: "attempt-a" }, { ref: "attempt-b" }],
        randomSeed: 1,
      },
    });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { recommended: string }).recommended).toBe("attempt-a");
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const refused = await env.client.callTool({
      name: COMPARE_ATTEMPTS_TOOL,
      arguments: {
        task: "sum",
        repoPath: fx.root,
        attempts: [{ ref: "attempt-a" }, { ref: "attempt-b" }],
        testCommand: ["npm", "test"],
      },
    });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("--allow-test-command");
    const invalid = await env.client.callTool({
      name: COMPARE_ATTEMPTS_TOOL,
      arguments: { task: "x", attempts: [{ ref: "a" }] },
    });
    expect(invalid.isError).toBe(true);
    await env.close();
  });
});
