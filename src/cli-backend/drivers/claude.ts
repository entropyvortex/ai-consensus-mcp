// Claude Code subscription oracle. Flags are the executed 2.1.289 set:
// -p, json schema, short --system-prompt, dontAsk, permission prompts none,
// --tools "", --restricted, no session persistence, empty setting sources.
// No --bare (that forces API-key auth), no --max-turns (not in that help),
// no bypassPermissions. The transcript is stdin, never an argv element.
// Stdin-as-prompt is assumed until a smoke shows the CLI reads it. If stdin
// is ignored, do not move the transcript onto argv.
// Claude-only env: CLAUDE_CODE_OAUTH_TOKEN (subscription token from
// `claude setup-token`) and CLAUDE_CONFIG_DIR are added on top of the shared
// allowlist for claude children only, so other vendors' CLIs never see them.
// The runner has no per-driver env hook yet, so the oracle spawn is wrapped.

import { spawn as nodeSpawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { ModelCallRequest, ModelCallResponse } from "ai-consensus-core";
import type { ResolvedCliProvider } from "../../config.js";
import { buildChildEnv } from "../env.js";
import { ORACLE_JSON_SCHEMA_TEXT } from "../normalize.js";
import {
  formatOraclePrompt,
  runOracle,
  spawnCaptured,
  type CliRuntimeDeps,
  type SpawnLike,
} from "../runner.js";

/** Same short constant as grok. Never interpolates request.system or request.user. */
export const CLAUDE_SYSTEM_PROMPT =
  "You are a text-only consensus oracle. Obey the prompt file exactly. Do not use tools, do not edit files, do not browse.";

export const CLAUDE_INSTALL_URL = "https://code.claude.com";
export const CLAUDE_LOGIN = "claude auth login";
export const CLAUDE_READINESS_TIMEOUT_MS = 15_000;

const STDERR_CLIP = 2_000;

/** Claude subscription credential and config location. Never API-billing keys. */
export const CLAUDE_CHILD_ENV_KEYS = ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"] as const;

function claudeExtraEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const extra: NodeJS.ProcessEnv = {};
  for (const key of CLAUDE_CHILD_ENV_KEYS) {
    const value = parent[key];
    if (value !== undefined && value !== "") extra[key] = value;
  }
  return extra;
}

/** Shared allowlist plus the claude-only keys. */
export function buildClaudeChildEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...buildChildEnv(parent), ...claudeExtraEnv(parent) };
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: Parameters<SpawnLike>[2],
): ReturnType<SpawnLike> {
  return nodeSpawn(command, [...args], options);
}

/** Adds the claude-only keys to the env the runner already allowlisted. */
function withClaudeEnv(parent: NodeJS.ProcessEnv, spawnImpl: SpawnLike | undefined): SpawnLike {
  const base = spawnImpl ?? defaultSpawn;
  const extra = claudeExtraEnv(parent);
  return (command, args, options) =>
    base(command, args, { ...options, env: { ...options.env, ...extra } });
}

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

/**
 * Root `--setting-sources ""` matches the oracle run, so an apiKeyHelper in
 * user settings cannot make the probe report a login the run will not use.
 */
export const CLAUDE_AUTH_STATUS_ARGV: readonly string[] = [
  "--setting-sources",
  "",
  "auth",
  "status",
  "--json",
];

function authMethodLabel(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  return /^[A-Za-z0-9_.-]{1,40}$/.test(value) ? value : "unknown";
}

/**
 * Passes only a Claude subscription: a claude.ai login, or `oauth_token` when
 * the child holds CLAUDE_CODE_OAUTH_TOKEN (claude setup-token requires a
 * subscription). ANTHROPIC_AUTH_TOKEN also reports oauth_token but is never in
 * the child env. Never echoes stdout: it carries the email and org.
 */
function assertSubscriptionAuth(bin: string, stdout: string, env: NodeJS.ProcessEnv): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `cli driver claude: could not read "${bin} auth status --json" output. Run ${CLAUDE_LOGIN}.`,
    );
  }
  const rec = parsed as Record<string, unknown>;
  const method = authMethodLabel(rec["authMethod"]);
  const subscription =
    method === "claude.ai" ||
    (method === "oauth_token" && typeof env["CLAUDE_CODE_OAUTH_TOKEN"] === "string");
  if (rec["loggedIn"] !== true || !subscription) {
    throw new Error(
      `cli driver claude: "${bin} auth status" reports authMethod=${method}. This seat runs only on a Claude subscription (claude.ai login, or CLAUDE_CODE_OAUTH_TOKEN from claude setup-token); any other method would bill the API. Run ${CLAUDE_LOGIN}.`,
    );
  }
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
  const env = buildClaudeChildEnv(parent);
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
    argv: CLAUDE_AUTH_STATUS_ARGV,
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
  assertSubscriptionAuth(provider.bin, status.stdout, env);
  cache?.set(provider.id, { ok: true });
}

export async function runClaude(
  provider: ResolvedCliProvider,
  req: ModelCallRequest,
  deps: CliRuntimeDeps,
): Promise<ModelCallResponse> {
  const parentEnv = deps.env ?? process.env;
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
    parentEnv,
    deps: { ...deps, spawnImpl: withClaudeEnv(parentEnv, deps.spawnImpl) },
    installUrl: CLAUDE_INSTALL_URL,
    loginCommand: CLAUDE_LOGIN,
    stdin: "pipe",
    stdinText: formatOraclePrompt(req.system, req.user),
    disableGrokAutoupdater: false,
    ownedFiles: ["prompt.txt"],
    buildArgv: () => buildClaudeArgv({ modelId: req.modelId }),
  });
}
