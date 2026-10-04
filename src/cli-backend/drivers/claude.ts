// Claude Code subscription oracle. Flags are the executed 2.1.289 set:
// -p, json schema, short --system-prompt, dontAsk, permission prompts none,
// --tools "", --restricted, no session persistence, empty setting sources.
// No --bare (that forces API-key auth), no --max-turns (not in that help),
// no bypassPermissions. The transcript is stdin, never an argv element.
// Stdin-as-prompt is assumed until a smoke shows the CLI reads it. If stdin
// is ignored, do not move the transcript onto argv.

import { tmpdir } from "node:os";
import type { ModelCallRequest, ModelCallResponse } from "ai-consensus-core";
import type { ResolvedCliProvider } from "../../config.js";
import { buildChildEnv } from "../env.js";
import { ORACLE_JSON_SCHEMA_TEXT } from "../normalize.js";
import { formatOraclePrompt, runOracle, spawnCaptured, type CliRuntimeDeps } from "../runner.js";

/** Same short constant as grok. Never interpolates request.system or request.user. */
export const CLAUDE_SYSTEM_PROMPT =
  "You are a text-only consensus oracle. Obey the prompt file exactly. Do not use tools, do not edit files, do not browse.";

export const CLAUDE_INSTALL_URL = "https://code.claude.com";
export const CLAUDE_LOGIN = "claude auth login";
export const CLAUDE_READINESS_TIMEOUT_MS = 15_000;

const STDERR_CLIP = 2_000;

export function buildClaudeArgv(args: { modelId: string }): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    ORACLE_JSON_SCHEMA_TEXT,
    "--system-prompt",
    CLAUDE_SYSTEM_PROMPT,
    "--model",
    args.modelId,
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
  ];
}

export async function probeClaude(
  provider: ResolvedCliProvider,
  deps: CliRuntimeDeps,
  signal?: AbortSignal,
): Promise<void> {
  // Only success is cached. A failure is re-probed on the next call so
  // "claude auth login" takes effect without a restart.
  const cache = deps.readinessCache;
  if (cache?.get(provider.id)?.ok) return;
  const parent = deps.env ?? process.env;
  const env = buildChildEnv(parent);
  const version = await spawnCaptured({
    driver: "claude",
    bin: provider.bin,
    argv: ["--version"],
    cwd: tmpdir(),
    env,
    stdin: "ignore",
    timeoutMs: CLAUDE_READINESS_TIMEOUT_MS,
    signal,
    spawnImpl: deps.spawnImpl,
    scheduleTimeout: deps.scheduleTimeout,
    now: deps.now,
    killGraceMs: deps.killGraceMs,
    installUrl: CLAUDE_INSTALL_URL,
    loginCommand: CLAUDE_LOGIN,
  });
  if (version.exitCode !== 0) {
    throw new Error(
      `cli driver claude: "${provider.bin} --version" failed (exit ${version.exitCode ?? "null"}). Install ${CLAUDE_INSTALL_URL} and run ${CLAUDE_LOGIN}.`,
    );
  }
  const status = await spawnCaptured({
    driver: "claude",
    bin: provider.bin,
    argv: ["auth", "status"],
    cwd: tmpdir(),
    env,
    stdin: "ignore",
    timeoutMs: CLAUDE_READINESS_TIMEOUT_MS,
    signal,
    spawnImpl: deps.spawnImpl,
    scheduleTimeout: deps.scheduleTimeout,
    now: deps.now,
    killGraceMs: deps.killGraceMs,
    installUrl: CLAUDE_INSTALL_URL,
    loginCommand: CLAUDE_LOGIN,
  });
  if (status.exitCode !== 0) {
    const clip = status.stderr.slice(0, STDERR_CLIP);
    throw new Error(
      `cli driver claude: "${provider.bin} auth status" failed (exit ${status.exitCode ?? "null"}): ${clip} Run ${CLAUDE_LOGIN}.`,
    );
  }
  cache?.set(provider.id, { ok: true });
}

export async function runClaude(
  provider: ResolvedCliProvider,
  req: ModelCallRequest,
  deps: CliRuntimeDeps,
): Promise<ModelCallResponse> {
  return runOracle({
    driver: "claude",
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
    installUrl: CLAUDE_INSTALL_URL,
    loginCommand: CLAUDE_LOGIN,
    stdin: "pipe",
    stdinText: formatOraclePrompt(req.system, req.user),
    disableGrokAutoupdater: false,
    ownedFiles: ["prompt.txt"],
    buildArgv: () => buildClaudeArgv({ modelId: req.modelId }),
  });
}
