// Grok subscription oracle. Flags are the executed 1.0.46 text set:
// dontAsk, no subagents, no web search, max-turns 2, no plan, verbatim.
// No --sandbox, no --tools, no --always-approve, no --worktree, no
// bypassPermissions. The transcript lives in the scratch prompt file.

import { access } from "node:fs/promises";
import { homedir as osHomedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelCallRequest, ModelCallResponse } from "ai-consensus-core";
import type { ResolvedCliProvider } from "../../config.js";
import { buildChildEnv } from "../env.js";
import { ORACLE_JSON_SCHEMA_TEXT } from "../normalize.js";
import { runOracle, spawnCaptured, type CliRuntimeDeps } from "../runner.js";

export const GROK_SYSTEM_OVERRIDE =
  "You are a text-only consensus oracle. Obey the prompt file exactly. Do not use tools, do not edit files, do not browse.";

export const GROK_INSTALL_URL = "https://x.ai/cli";
export const GROK_LOGIN = "grok login";

const VERSION_TIMEOUT_MS = 15_000;

/**
 * Where grok keeps its login. Explicit authPath, then GROK_HOME, then
 * HOME, then the OS home dir. Throws rather than return a path relative to
 * the server's cwd when no home dir is known.
 */
export function grokAuthPath(
  authPath: string | undefined,
  env: NodeJS.ProcessEnv,
  homedir: () => string = osHomedir,
): string {
  if (authPath) return authPath;
  const grokHome = env["GROK_HOME"];
  if (grokHome) return join(grokHome, "auth.json");
  // An empty HOME counts as unset.
  const envHome = env["HOME"];
  const home = envHome !== undefined && envHome !== "" ? envHome : homedir();
  if (!home) {
    throw new Error(
      `cli driver grok: cannot locate the grok auth file: HOME is unset and the OS reports no home directory. Set GROK_HOME or the provider authPath.`,
    );
  }
  return join(home, ".grok", "auth.json");
}

export function buildGrokArgv(args: {
  scratchDir: string;
  promptPath: string;
  modelId: string;
}): string[] {
  return [
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
    args.scratchDir,
    "--max-turns",
    "2",
    "--prompt-file",
    args.promptPath,
    "--system-prompt-override",
    GROK_SYSTEM_OVERRIDE,
    "-m",
    args.modelId,
    "--no-plan",
  ];
}

export async function probeGrok(
  provider: ResolvedCliProvider,
  deps: CliRuntimeDeps,
  signal?: AbortSignal,
): Promise<void> {
  // Only success is cached. A failure must be re-probed on the next call so
  // "install grok" or "grok login" takes effect without a restart.
  const cache = deps.readinessCache;
  if (cache?.get(provider.id)?.ok) return;
  const parent = deps.env ?? process.env;
  const captured = await spawnCaptured({
    driver: "grok",
    bin: provider.bin,
    argv: ["--version"],
    cwd: tmpdir(),
    env: buildChildEnv(parent, { disableGrokAutoupdater: true }),
    stdin: "ignore",
    timeoutMs: VERSION_TIMEOUT_MS,
    signal,
    spawnImpl: deps.spawnImpl,
    scheduleTimeout: deps.scheduleTimeout,
    now: deps.now,
    killGraceMs: deps.killGraceMs,
    installUrl: GROK_INSTALL_URL,
    loginCommand: GROK_LOGIN,
  });
  if (captured.exitCode !== 0) {
    throw new Error(
      `cli driver grok: "${provider.bin} --version" failed (exit ${captured.exitCode ?? "null"}). Install from ${GROK_INSTALL_URL} and run ${GROK_LOGIN}.`,
    );
  }
  const authPath = grokAuthPath(provider.authPath, parent, deps.homedir);
  const accessImpl = deps.accessImpl ?? access;
  try {
    await accessImpl(authPath);
  } catch {
    throw new Error(
      `cli driver grok: not signed in. Install from ${GROK_INSTALL_URL} and run ${GROK_LOGIN}.`,
    );
  }
  cache?.set(provider.id, { ok: true });
}

export async function runGrok(
  provider: ResolvedCliProvider,
  req: ModelCallRequest,
  deps: CliRuntimeDeps,
): Promise<ModelCallResponse> {
  return runOracle({
    driver: "grok",
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
    installUrl: GROK_INSTALL_URL,
    loginCommand: GROK_LOGIN,
    stdin: "ignore",
    disableGrokAutoupdater: true,
    ownedFiles: [],
    buildArgv: ({ scratchDir, promptPath }) =>
      buildGrokArgv({ scratchDir, promptPath, modelId: req.modelId }),
  });
}
