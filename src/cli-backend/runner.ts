// Shared CLI oracle runner.
// Prompt bytes never become an argv element. Scratch cwd, allowlisted env,
// process-group kill, and a char cap on each stream. Timeout is a seat
// Error (ETIMEDOUT). Abort is DOMException AbortError. ENOENT and E2BIG
// settle on the spawn error event and do not wait for the timer.

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelCallResponse } from "ai-consensus-core";
import { buildChildEnv } from "./env.js";
import { abortException } from "./gate.js";
import { CAPTURE_CHAR_CAP, normalizeCliStdout, type ConfidenceSource } from "./normalize.js";

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type ScheduleTimeout = (delayMs: number, onFire: () => void) => () => void;

export type MkdtempLike = (prefix: string) => Promise<string>;

export type RmLike = (
  path: string,
  options: { recursive: boolean; force: boolean },
) => Promise<void>;

export type AccessLike = (path: string) => Promise<void>;

export type ReadinessState = { ok: true } | { ok: false; message: string };

export interface CliRuntimeDeps {
  spawnImpl?: SpawnLike;
  scheduleTimeout?: ScheduleTimeout;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  mkdtempImpl?: MkdtempLike;
  rmImpl?: RmLike;
  accessImpl?: AccessLike;
  readinessCache?: Map<string, ReadinessState>;
  now?: () => number;
}

export interface SpawnCapturedArgs {
  driver: string;
  bin: string;
  argv: readonly string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  stdin: "ignore" | "pipe";
  stdinText?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  spawnImpl?: SpawnLike;
  scheduleTimeout?: ScheduleTimeout;
  now?: () => number;
  installUrl: string;
  loginCommand: string;
  maxCaptureChars?: number;
}

export interface SpawnCapturedResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

export function formatOraclePrompt(system: string, user: string): string {
  return `SYSTEM:\n${system}\n\nUSER:\n${user}`;
}

const PROMPT_FILE_NAME = "prompt.txt";

function defaultSchedule(delayMs: number, onFire: () => void): () => void {
  const timer = setTimeout(onFire, delayMs);
  return () => {
    clearTimeout(timer);
  };
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  return nodeSpawn(command, [...args], options);
}

function errnoCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function mapSpawnError(
  err: unknown,
  args: { driver: string; bin: string; installUrl: string; loginCommand: string },
): Error {
  const code = errnoCode(err);
  if (code === "ENOENT") {
    return new Error(
      `cli driver ${args.driver}: "${args.bin}" was not found. Install ${args.installUrl} and run ${args.loginCommand}. HTTP participants in this panel are unaffected.`,
    );
  }
  if (code === "E2BIG") {
    return new Error(
      `cli driver ${args.driver}: argument list too long (E2BIG). Each argv element must stay under 131071 bytes on this Linux.`,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`cli driver ${args.driver} failed to spawn: ${message}`);
}

function chunkToString(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString("utf8");
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf8");
  return String(chunk);
}

function clipStreams(stderr: string, stdout: string): string {
  const merged = stderr && stdout ? `${stderr}\n${stdout}` : `${stderr}${stdout}`;
  return merged.slice(0, 2_000);
}

export function killProcessGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (typeof pid === "number" && pid > 0) {
    try {
      process.kill(-pid, "SIGTERM");
      return;
    } catch {
      // A non-detached test double is not a process-group leader.
    }
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // Already exited.
  }
}

export async function spawnCaptured(args: SpawnCapturedArgs): Promise<SpawnCapturedResult> {
  if (args.signal?.aborted) {
    throw abortException();
  }
  const spawnImpl = args.spawnImpl ?? defaultSpawn;
  const schedule = args.scheduleTimeout ?? defaultSchedule;
  const started = (args.now ?? Date.now)();
  const maxChars = args.maxCaptureChars ?? CAPTURE_CHAR_CAP;

  let child: ChildProcess;
  try {
    child = spawnImpl(args.bin, args.argv, {
      cwd: args.cwd,
      env: args.env,
      detached: true,
      windowsHide: true,
      stdio: [args.stdin, "pipe", "pipe"],
    });
  } catch (err) {
    throw mapSpawnError(err, args);
  }

  if (args.signal?.aborted) {
    killProcessGroup(child);
    throw abortException();
  }

  return new Promise<SpawnCapturedResult>((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const clearNothing = (): void => {
      return undefined;
    };
    let cancelTimer: () => void = clearNothing;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cancelTimer();
      args.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const onAbort = () => {
      killProcessGroup(child);
      finish(() => {
        reject(abortException());
      });
    };
    if (args.signal) {
      args.signal.addEventListener("abort", onAbort, { once: true });
    }

    const takeChunk = (which: "stdout" | "stderr", chunk: unknown) => {
      const text = chunkToString(chunk);
      if (which === "stdout") stdout += text;
      else stderr += text;
      const length = which === "stdout" ? stdout.length : stderr.length;
      if (length > maxChars) {
        killProcessGroup(child);
        finish(() => {
          reject(new Error(`cli driver ${args.driver} ${which} exceeded ${maxChars} characters`));
        });
      }
    };

    child.stdout?.on("data", (chunk: unknown) => {
      takeChunk("stdout", chunk);
    });
    child.stderr?.on("data", (chunk: unknown) => {
      takeChunk("stderr", chunk);
    });
    child.on("error", (err: unknown) => {
      killProcessGroup(child);
      finish(() => {
        reject(mapSpawnError(err, args));
      });
    });
    child.on("close", (code: number | null) => {
      finish(() => {
        resolve({
          stdout,
          stderr,
          exitCode: code,
          durationMs: Math.max(0, Math.round((args.now ?? Date.now)() - started)),
        });
      });
    });

    if (args.stdin === "pipe" && child.stdin) {
      child.stdin.write(args.stdinText ?? "");
      child.stdin.end();
    }

    cancelTimer = schedule(args.timeoutMs, () => {
      killProcessGroup(child);
      const err = new Error(`cli driver ${args.driver} timed out after ${args.timeoutMs}ms`);
      Object.assign(err, { code: "ETIMEDOUT" });
      finish(() => {
        reject(err);
      });
    });
  });
}

export interface OracleRunSpec {
  driver: string;
  bin: string;
  providerId: string;
  participantId: string;
  round: number;
  system: string;
  user: string;
  timeoutMs: number;
  signal?: AbortSignal;
  parentEnv: NodeJS.ProcessEnv;
  deps: CliRuntimeDeps;
  installUrl: string;
  loginCommand: string;
  stdin: "ignore" | "pipe";
  stdinText?: string;
  disableGrokAutoupdater: boolean;
  ownedFiles: readonly string[];
  buildArgv: (ctx: { scratchDir: string; promptPath: string }) => readonly string[];
}

export async function runOracle(spec: OracleRunSpec): Promise<ModelCallResponse> {
  if (spec.signal?.aborted) {
    throw abortException();
  }
  const mkdtempImpl = spec.deps.mkdtempImpl ?? mkdtemp;
  const rmImpl = spec.deps.rmImpl ?? rm;
  const log =
    spec.deps.log ??
    ((line: string) => {
      process.stderr.write(line);
    });
  const now = spec.deps.now ?? Date.now;
  const started = now();
  let dir: string | undefined;
  let exitLabel = "none";
  let confidenceSource: ConfidenceSource | "error" = "error";
  let stdoutBytes = 0;
  let result: ModelCallResponse | undefined;
  let failure: unknown;
  try {
    dir = await mkdtempImpl(join(tmpdir(), "consensus-cli-"));
    if (spec.signal?.aborted) {
      throw abortException();
    }
    const promptPath = join(dir, PROMPT_FILE_NAME);
    await writeFile(promptPath, formatOraclePrompt(spec.system, spec.user), {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(promptPath, 0o600);
    const captured = await spawnCaptured({
      driver: spec.driver,
      bin: spec.bin,
      argv: spec.buildArgv({ scratchDir: dir, promptPath }),
      cwd: dir,
      env: buildChildEnv(spec.parentEnv, { disableGrokAutoupdater: spec.disableGrokAutoupdater }),
      stdin: spec.stdin,
      stdinText: spec.stdinText,
      timeoutMs: spec.timeoutMs,
      signal: spec.signal,
      spawnImpl: spec.deps.spawnImpl,
      scheduleTimeout: spec.deps.scheduleTimeout,
      now: spec.deps.now,
      installUrl: spec.installUrl,
      loginCommand: spec.loginCommand,
    });
    stdoutBytes = Buffer.byteLength(captured.stdout, "utf8");
    exitLabel = captured.exitCode === null ? "null" : String(captured.exitCode);
    if (captured.exitCode !== 0) {
      throw new Error(
        `cli driver ${spec.driver} exited ${captured.exitCode ?? "null"}: ${clipStreams(captured.stderr, captured.stdout)}`,
      );
    }
    const names = await readdir(dir);
    const owned = new Set<string>([PROMPT_FILE_NAME, ...spec.ownedFiles]);
    const unexpected = names.filter((name) => !owned.has(name)).sort();
    if (unexpected.length > 0) {
      throw new Error(
        `cli driver ${spec.driver} wrote unexpected files in the scratch dir: ${unexpected.join(", ")}`,
      );
    }
    const normalized = normalizeCliStdout({
      driver: spec.driver,
      participantId: spec.participantId,
      round: spec.round,
      stdout: captured.stdout,
      log,
    });
    confidenceSource = normalized.source;
    result = {
      content: normalized.content,
      ...(normalized.usage ? { usage: normalized.usage } : {}),
    };
  } catch (err) {
    failure = err;
  } finally {
    const durationMs = Math.max(0, Math.round(now() - started));
    log(
      `ai-consensus-mcp: cli driver=${spec.driver} provider=${spec.providerId} participant=${spec.participantId} round=${spec.round} durationMs=${durationMs} exit=${exitLabel} confidenceSource=${confidenceSource} stdoutBytes=${stdoutBytes}\n`,
    );
    if (dir !== undefined) {
      await rmImpl(dir, { recursive: true, force: true });
    }
  }
  if (failure !== undefined) {
    if (failure instanceof Error) throw failure;
    throw new Error(`cli driver ${spec.driver} failed`);
  }
  if (!result) {
    throw new Error(`cli driver ${spec.driver} produced no result`);
  }
  return result;
}
