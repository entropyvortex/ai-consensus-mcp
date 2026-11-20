import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CANDIDATE_LABELS,
  buildJurorVerdictJsonSchema,
  type ModelCallRequest,
} from "ai-consensus-core";
import { createConsensusCaller } from "../caller.js";
import { CODEX_PREAMBLE, CliGate, probeCliProviders } from "../cli-backend/index.js";
import { ORACLE_JSON_SCHEMA_TEXT } from "../cli-backend/normalize.js";
import type { ResolvedCliProvider } from "../config.js";

// Contract: each CLI driver, run against a real executable (a stub that
// records what it received), passes the prompt on stdin or in the 0600
// prompt file — never argv —, runs in an empty scratch cwd, gets an
// allowlisted env with the recursion guard and without API keys, and
// returns the oracle answer (CONFIDENCE trailer) or, in JSON mode, the
// structured JSON untouched.

let dir: string;
let binDir: string;
let logDir: string;

const STUB = (log: string) => `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const name = path.basename(process.argv[1]);
const argv = process.argv.slice(2);
const LOG = ${JSON.stringify(log)};
const after = (flag) => argv[argv.indexOf(flag) + 1];
const record = (extra) =>
  fs.writeFileSync(path.join(LOG, name + "-" + process.pid + ".json"),
    JSON.stringify({ name, argv, cwd: process.cwd(), files: fs.readdirSync(process.cwd()).sort(), env: process.env, ...extra }));
const answerFor = (schemaText) => {
  const schema = JSON.parse(schemaText);
  return schema.properties.ranking
    ? { ranking: ["B", "A"], assessments: [], findings: [] }
    : { answer: "stub answer from " + name, confidence: 61 };
};
if (argv[0] === "--version") { process.stdout.write(name + " 9.9.9\\n"); process.exit(0); }
if (name === "claude" && argv.includes("auth")) {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })); process.exit(0);
}
if (name === "codex" && argv[0] === "login") {
  if (fs.existsSync(path.join(LOG, "codex-logged-out"))) { process.stdout.write("Not logged in\\n"); process.exit(1); }
  process.stdout.write("Logged in using ChatGPT\\n"); process.exit(0);
}
let stdin = "";
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  if (name === "claude") {
    record({ stdin });
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "",
      structured_output: answerFor(after("--json-schema")), usage: { input_tokens: 11, output_tokens: 7 } }));
  } else if (name === "grok") {
    record({ prompt: fs.readFileSync(after("--prompt-file"), "utf8") });
    process.stdout.write(JSON.stringify({ structured_output: answerFor(after("--json-schema")) }));
  } else if (name === "codex") {
    record({ stdin, schema: fs.readFileSync(after("--output-schema"), "utf8") });
    fs.writeFileSync(after("-o"), JSON.stringify(answerFor(fs.readFileSync(after("--output-schema"), "utf8"))));
    process.stdout.write(JSON.stringify({ type: "thread.started" }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 20, cached_input_tokens: 0, output_tokens: 5 } }) + "\\n");
  }
});
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "acm-stubs-"));
  binDir = join(dir, "bin");
  logDir = join(dir, "log");
  mkdirSync(binDir);
  mkdirSync(logDir);
  const script = STUB(logDir);
  for (const name of ["claude", "grok", "codex"]) {
    writeFileSync(join(binDir, name), script);
    chmodSync(join(binDir, name), 0o755);
  }
  writeFileSync(join(dir, "grok-auth.json"), "{}");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  for (const f of readdirSync(logDir)) rmSync(join(logDir, f));
});

function provider(driver: "claude" | "grok" | "codex"): ResolvedCliProvider {
  return {
    id: `${driver}-sub`,
    transport: "cli",
    driver,
    bin: join(binDir, driver),
    timeoutMs: 20_000,
    authPath: driver === "grok" ? join(dir, "grok-auth.json") : undefined,
  };
}

const PARENT_ENV: NodeJS.ProcessEnv = {
  PATH: process.env["PATH"],
  HOME: process.env["HOME"],
  OPENAI_API_KEY: "sk-must-not-leak",
  ANTHROPIC_API_KEY: "must-not-leak",
  XAI_API_KEY: "must-not-leak",
};

function caller(driver: "claude" | "grok" | "codex", jsonSchema?: Record<string, unknown>) {
  return createConsensusCaller({
    providers: { [`${driver}-sub`]: provider(driver) },
    providerByParticipant: { seat: `${driver}-sub`, judge: `${driver}-sub` },
    cliGate: new CliGate(2),
    env: PARENT_ENV,
    readinessCache: new Map(),
    log: () => undefined,
    ...(jsonSchema
      ? {
          jsonSchemaFor: (req: ModelCallRequest) =>
            req.participantId === "judge" ? undefined : jsonSchema,
        }
      : {}),
  });
}

const REQUEST: ModelCallRequest = {
  participantId: "seat",
  modelId: "some-model",
  round: 1,
  phase: "initial-analysis",
  system: "SYSTEM-TEXT-MARKER",
  user: "USER-TEXT-MARKER",
  temperature: 0.7,
  maxOutputTokens: 100,
};

function lastRecord(): {
  argv: string[];
  cwd: string;
  files: string[];
  env: Record<string, string>;
  stdin?: string;
  prompt?: string;
  schema?: string;
} {
  const files = readdirSync(logDir).filter((f) => f.endsWith(".json"));
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(join(logDir, files[0]!), "utf8"));
}

function expectIsolated(rec: ReturnType<typeof lastRecord>) {
  expect(
    rec.cwd.startsWith(join(tmpdir(), "consensus-cli-")) || rec.cwd.includes("consensus-cli-"),
  ).toBe(true);
  expect(rec.env["AI_CONSENSUS_MCP_DEPTH"]).toBe("1");
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY"])
    expect(rec.env[key]).toBeUndefined();
  expect(rec.argv.join(" ")).not.toContain("USER-TEXT-MARKER");
}

const VERDICT_SCHEMA = buildJurorVerdictJsonSchema(CANDIDATE_LABELS.slice(0, 2));

describe("claude driver through a stub executable", () => {
  it("oracle mode: stdin prompt, no tools, no MCP servers, CONFIDENCE trailer", async () => {
    const res = await caller("claude")(REQUEST);
    expect(res.content).toBe("stub answer from claude\nCONFIDENCE: 61");
    expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 7, totalTokens: 18 });
    const rec = lastRecord();
    expectIsolated(rec);
    expect(rec.stdin).toBe("SYSTEM:\nSYSTEM-TEXT-MARKER\n\nUSER:\nUSER-TEXT-MARKER");
    expect(rec.files).toEqual(["prompt.txt"]);
    expect(rec.argv).toEqual(
      expect.arrayContaining([
        "-p",
        "--tools",
        "",
        "--strict-mcp-config",
        "--permission-mode",
        "dontAsk",
      ]),
    );
    expect(rec.argv[rec.argv.indexOf("--json-schema") + 1]).toBe(ORACLE_JSON_SCHEMA_TEXT);
  });

  it("JSON mode: enforces the juror schema and returns the JSON untouched", async () => {
    const res = await caller("claude", VERDICT_SCHEMA)(REQUEST);
    expect(JSON.parse(res.content)).toEqual({ ranking: ["B", "A"], assessments: [], findings: [] });
    expect(res.content).not.toContain("CONFIDENCE");
    const rec = lastRecord();
    expect(rec.argv[rec.argv.indexOf("--json-schema") + 1]).toBe(JSON.stringify(VERDICT_SCHEMA));
  });

  it("the judge keeps the oracle schema in a JSON-mode run", async () => {
    const res = await caller("claude", VERDICT_SCHEMA)({ ...REQUEST, participantId: "judge" });
    expect(res.content).toBe("stub answer from claude\nJUDGE_CONFIDENCE: 61");
  });
});

describe("grok driver through a stub executable", () => {
  it('omits -m for modelId "default"', async () => {
    await caller("grok")({ ...REQUEST, modelId: "default" });
    expect(lastRecord().argv).not.toContain("-m");
  });

  it("JSON mode: prompt in the scratch file, never on argv or stdin", async () => {
    const res = await caller("grok", VERDICT_SCHEMA)(REQUEST);
    expect(JSON.parse(res.content)).toEqual({ ranking: ["B", "A"], assessments: [], findings: [] });
    const rec = lastRecord();
    expectIsolated(rec);
    expect(rec.prompt).toBe("SYSTEM:\nSYSTEM-TEXT-MARKER\n\nUSER:\nUSER-TEXT-MARKER");
    expect(rec.env["GROK_DISABLE_AUTOUPDATER"]).toBe("1");
    expect(rec.argv).toEqual(
      expect.arrayContaining([
        "--no-subagents",
        "--disable-web-search",
        "--permission-mode",
        "dontAsk",
      ]),
    );
  });
});

describe("codex driver through a stub executable", () => {
  it("JSON mode: the verified exec argv, stdin prompt, schema file, -o answer and usage", async () => {
    const res = await caller("codex", VERDICT_SCHEMA)(REQUEST);
    expect(JSON.parse(res.content)).toEqual({ ranking: ["B", "A"], assessments: [], findings: [] });
    expect(res.usage).toEqual({ inputTokens: 20, outputTokens: 5, totalTokens: 25 });
    const rec = lastRecord();
    expectIsolated(rec);
    expect(rec.stdin).toBe(
      `${CODEX_PREAMBLE}\n\nSYSTEM:\nSYSTEM-TEXT-MARKER\n\nUSER:\nUSER-TEXT-MARKER`,
    );
    expect(rec.files).toEqual(["prompt.txt", "schema.json"]);
    expect(JSON.parse(rec.schema!)).toEqual(VERDICT_SCHEMA);
    const scratch = rec.cwd;
    expect(rec.argv).toEqual([
      "exec",
      "-c",
      'approval_policy="never"',
      "--disable",
      "shell_tool",
      "--disable",
      "unified_exec",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--color",
      "never",
      "--json",
      "-C",
      scratch,
      "-m",
      "some-model",
      "--output-schema",
      join(scratch, "schema.json"),
      "-o",
      join(scratch, "last-message.txt"),
      "-",
    ]);
    for (const banned of [
      "--dangerously-bypass-approvals-and-sandbox",
      "workspace-write",
      "danger-full-access",
      "--search",
      "--full-auto",
    ]) {
      expect(rec.argv).not.toContain(banned);
    }
  });

  it("oracle mode: parses the {answer, confidence} message", async () => {
    const res = await caller("codex")(REQUEST);
    expect(res.content).toBe("stub answer from codex\nCONFIDENCE: 61");
  });

  it('omits -m for modelId "default"', async () => {
    await caller("codex")({ ...REQUEST, modelId: "default" });
    expect(lastRecord().argv).not.toContain("-m");
  });
});

describe("readiness probes through stub executables", () => {
  it("passes for all three drivers and reports a signed-out codex", async () => {
    const providers = { a: provider("claude"), b: provider("grok"), c: provider("codex") };
    const ok = await probeCliProviders({ providers, env: PARENT_ENV, cache: new Map() });
    expect(ok).toContain("driver=claude ok");
    expect(ok).toContain("driver=grok ok");
    expect(ok).toContain("driver=codex ok");
    writeFileSync(join(logDir, "codex-logged-out"), "");
    const out = await probeCliProviders({
      providers: { c: provider("codex") },
      env: PARENT_ENV,
      cache: new Map(),
    });
    expect(out).toContain("cli driver codex: not signed in. Run codex login.");
  });
});
