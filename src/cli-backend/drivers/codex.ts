// Codex CLI subscription oracle. Flags are the executed 0.170.0 set, checked
// against `codex exec --help` and `codex --help` and accepted by an actual
// `codex exec` run that reached the API (it failed only on auth):
//   exec -c approval_policy="never"   approval: documented config key for exec
//                                     (`-a/--ask-for-approval` is top-level only)
//   --disable shell_tool              command execution tool off
//   --disable unified_exec            the other exec tool listed by `codex features list`
//   --sandbox read-only               no writes even if a tool ran
//   --ignore-user-config              $CODEX_HOME/config.toml (and its MCP servers)
//                                     not loaded; auth still uses CODEX_HOME
//   --ignore-rules --ephemeral --skip-git-repo-check --color never
//   --json                            JSONL events on stdout (turn.completed usage)
//   -C <scratch> -m <model> --output-schema <scratch/schema.json>
//   -o <scratch/last-message.txt> -   final message to a file; prompt on stdin
// Not live-verified with a signed-in account: no model answer was observed.
// The prompt is stdin, never argv. CODEX_HOME passes through the shared
// allowlist; OPENAI_API_KEY / CODEX_API_KEY never do.

import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelCallRequest, ModelCallResponse, TokenUsage } from "ai-consensus-core";
import type { ResolvedCliProvider } from "../../config.js";
import { buildChildEnv } from "../env.js";
import { ORACLE_JSON_SCHEMA_TEXT, normalizeCliStdout } from "../normalize.js";
import {
  formatOraclePrompt,
  runOracle,
  spawnCaptured,
  type CliRunOptions,
  type CliRuntimeDeps,
} from "../runner.js";

export const CODEX_INSTALL_URL = "https://developers.openai.com/codex/cli";
export const CODEX_LOGIN = "codex login";
export const CODEX_READINESS_TIMEOUT_MS = 15_000;

/** modelId that omits `-m`, so codex uses its built-in default model. */
export const CODEX_DEFAULT_MODEL = "default";

const SCHEMA_FILE = "schema.json";
const LAST_MESSAGE_FILE = "last-message.txt";

/** Prepended to the stdin transcript; codex has no system-prompt flag. */
export const CODEX_PREAMBLE =
  "You are a text-only consensus oracle. Follow the SYSTEM and USER sections below exactly. Do not run commands, do not edit files, do not browse.";

/**
 * Flags the design required before a codex driver could ship. Both are met:
 * `--sandbox read-only` directly, approval `never` through
 * `-c approval_policy="never"`.
 */
export const CODEX_REQUIRED_GATE_FLAGS = ["--sandbox read-only", "approval never"] as const;

export function buildCodexArgv(args: {
  scratchDir: string;
  schemaPath: string;
  lastMessagePath: string;
  modelId: string;
}): string[] {
  return [
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
    args.scratchDir,
    ...(args.modelId === CODEX_DEFAULT_MODEL ? [] : ["-m", args.modelId]),
    "--output-schema",
    args.schemaPath,
    "-o",
    args.lastMessagePath,
    "-",
  ];
}

export const CODEX_LOGIN_STATUS_ARGV: readonly string[] = ["login", "status"];

export async function probeCodex(
  provider: ResolvedCliProvider,
  deps: CliRuntimeDeps,
  signal?: AbortSignal,
): Promise<void> {
  const cache = deps.readinessCache;
  if (cache?.get(provider.id)?.ok) return;
  const env = buildChildEnv(deps.env ?? process.env);
  const common = {
    driver: "codex",
    bin: provider.bin,
    cwd: tmpdir(),
    env,
    stdin: "ignore" as const,
    timeoutMs: CODEX_READINESS_TIMEOUT_MS,
    signal,
    spawnImpl: deps.spawnImpl,
    scheduleTimeout: deps.scheduleTimeout,
    now: deps.now,
    killGraceMs: deps.killGraceMs,
    installUrl: CODEX_INSTALL_URL,
    loginCommand: CODEX_LOGIN,
  };
  const version = await spawnCaptured({ ...common, argv: ["--version"] });
  if (version.exitCode !== 0) {
    throw new Error(
      `cli driver codex: "${provider.bin} --version" failed (exit ${version.exitCode ?? "null"}). Install ${CODEX_INSTALL_URL} and run ${CODEX_LOGIN}.`,
    );
  }
  // Documented: "Exits with 0 when logged in" and prints the auth mode.
  // Never echoed, as it can include an account identifier. The API-key
  // check below matches text; the exact wording for an API-key login has
  // not been observed (assumed to mention "API key").
  const status = await spawnCaptured({ ...common, argv: CODEX_LOGIN_STATUS_ARGV });
  if (status.exitCode !== 0) {
    throw new Error(`cli driver codex: not signed in. Run ${CODEX_LOGIN}.`);
  }
  if (/api key/i.test(`${status.stdout}\n${status.stderr}`)) {
    throw new Error(
      `cli driver codex: "${provider.bin} login status" reports API-key auth. This seat runs only on a ChatGPT sign-in; an API key would bill the API. Run ${CODEX_LOGIN}.`,
    );
  }
  cache?.set(provider.id, { ok: true });
}

/** Sum `usage` from `turn.completed` events in codex's JSONL stdout. */
export function codexUsage(stdout: string): TokenUsage | undefined {
  let input = 0;
  let output = 0;
  let seen = false;
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const e = event as { type?: unknown; usage?: Record<string, unknown> };
    if (e.type !== "turn.completed" || !e.usage) continue;
    const i = e.usage["input_tokens"];
    const o = e.usage["output_tokens"];
    if (typeof i === "number" && typeof o === "number") {
      input += i;
      output += o;
      seen = true;
    }
  }
  return seen
    ? { inputTokens: input, outputTokens: output, totalTokens: input + output }
    : undefined;
}

/** Last `{"type":"error","message":…}` event, for a useful failure message. */
function lastErrorEvent(stdout: string): string | undefined {
  let found: string | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const e = JSON.parse(line) as { type?: unknown; message?: unknown };
      if (e.type === "error" && typeof e.message === "string") found = e.message;
    } catch {
      // not an event line
    }
  }
  return found ? found.slice(0, 300) : undefined;
}

export async function runCodex(
  provider: ResolvedCliProvider,
  req: ModelCallRequest,
  deps: CliRuntimeDeps,
  opts?: CliRunOptions,
): Promise<ModelCallResponse> {
  const jsonMode = opts?.jsonSchema !== undefined;
  const schemaText = jsonMode ? JSON.stringify(opts.jsonSchema) : ORACLE_JSON_SCHEMA_TEXT;
  return runOracle({
    driver: "codex",
    bin: provider.bin,
    providerId: provider.id,
    participantId: req.participantId,
    round: req.round,
    system: req.system,
    user: req.user,
    timeoutMs: provider.timeoutMs,
    signal: req.signal,
    parentEnv: deps.env ?? process.env,
    deps,
    installUrl: CODEX_INSTALL_URL,
    loginCommand: CODEX_LOGIN,
    stdin: "pipe",
    stdinText: `${CODEX_PREAMBLE}\n\n${formatOraclePrompt(req.system, req.user)}`,
    disableGrokAutoupdater: false,
    ownedFiles: [SCHEMA_FILE, LAST_MESSAGE_FILE],
    prepare: async (dir) => {
      await writeFile(join(dir, SCHEMA_FILE), schemaText, { encoding: "utf8", mode: 0o600 });
    },
    buildArgv: ({ scratchDir }) =>
      buildCodexArgv({
        scratchDir,
        schemaPath: join(scratchDir, SCHEMA_FILE),
        lastMessagePath: join(scratchDir, LAST_MESSAGE_FILE),
        modelId: req.modelId,
      }),
    finalize: async ({ stdout, scratchDir, log }) => {
      const message = (
        await readFile(join(scratchDir, LAST_MESSAGE_FILE), "utf8").catch(() => "")
      ).trim();
      if (message === "") {
        const detail = lastErrorEvent(stdout);
        throw new Error(`cli driver codex returned an empty answer${detail ? `: ${detail}` : ""}`);
      }
      const usage = codexUsage(stdout);
      if (jsonMode)
        return { content: message, ...(usage ? { usage } : {}), source: "json" as const };
      // Oracle mode: the message is the {answer, confidence} object.
      let structured: unknown;
      try {
        structured = JSON.parse(message);
      } catch {
        structured = undefined;
      }
      const envelope = JSON.stringify(
        structured && typeof structured === "object"
          ? {
              structured_output: structured,
              ...(usage
                ? { usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens } }
                : {}),
            }
          : { result: message },
      );
      return normalizeCliStdout({
        driver: "codex",
        participantId: req.participantId,
        round: req.round,
        stdout: envelope,
        log,
      });
    },
  });
}
