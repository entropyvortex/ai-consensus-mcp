// Shared CLI oracle runner.
// Prompt bytes never become an argv element. Scratch cwd, allowlisted env,
// process-group SIGTERM then SIGKILL, and a char cap on each stream. A call
// settles only after its child has exited. Timeout is a seat Error
// (ETIMEDOUT). Abort is DOMException AbortError. Spawn errors such as
// ENOENT settle on the error event and do not wait for the timer.

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
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
  /** SIGTERM to SIGKILL escalation delay for every spawn. */
  killGraceMs?: number;
  /** Home-dir lookup used when HOME is unset. Defaults to os.homedir. */
  homedir?: () => string;
  /** Platform check override for tests. Defaults to process.platform. */
  platform?: NodeJS.Platform;
}

export const CLI_UNSUPPORTED_ON_WINDOWS =
  "CLI transport is not supported on Windows: process-group kill, the 0600 prompt file and the child env allowlist are Unix-only. Use an http provider.";

/** Throws on win32, where the runner's process and file guarantees do not hold. */
export function assertCliPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") throw new Error(CLI_UNSUPPORTED_ON_WINDOWS);
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
  /** SIGTERM to SIGKILL escalation delay. Defaults to DEFAULT_KILL_GRACE_MS. */
  killGraceMs?: number;
}

export interface SpawnCapturedResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** Signal that ended the child, when it died from one. */
  signal: NodeJS.Signals | null;
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

// One decoder per stream. Decoding each chunk on its own turns a multibyte
// character that straddles a pipe read into U+FFFD.
function chunkToString(decoder: StringDecoder, chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (Buffer.isBuffer(chunk)) return decoder.write(chunk);
  if (chunk instanceof Uint8Array) return decoder.write(Buffer.from(chunk));
  return String(chunk);
}

function clipStreams(stderr: string, stdout: string): string {
  const merged = stderr && stdout ? `${stderr}\n${stdout}` : `${stderr}${stdout}`;
  return merged.slice(0, 2_000);
}

export function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  const pid = child.pid;
  if (typeof pid === "number" && pid > 0) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // A non-detached test double is not a process-group leader.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already exited.
  }
}

// Live CLI children, so a server shutdown can take their process groups
// down with it. The children are detached (own group) for group kill, which
// also means a Ctrl+C on the server would not reach them by itself.
const liveChildren = new Set<ChildProcess>();
const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

/** SIGKILLs the process group of every CLI child that is still running. */
export function killLiveCliChildren(): void {
  for (const child of liveChildren) killProcessGroup(child, "SIGKILL");
}

function onProcessExit(): void {
  killLiveCliChildren();
}

function onShutdownSignal(signal: NodeJS.Signals): void {
  killLiveCliChildren();
  unhookShutdown();
  // Another listener (runServe's shutdown) owns the exit. With none left,
  // re-raise so the default action still terminates the process.
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

function hookShutdown(): void {
  process.on("exit", onProcessExit);
  for (const signal of SHUTDOWN_SIGNALS) process.on(signal, onShutdownSignal);
}

function unhookShutdown(): void {
  process.removeListener("exit", onProcessExit);
  for (const signal of SHUTDOWN_SIGNALS) process.removeListener(signal, onShutdownSignal);
}

function trackChild(child: ChildProcess): void {
  if (typeof child.pid !== "number") return;
  if (liveChildren.size === 0) hookShutdown();
  liveChildren.add(child);
  const untrack = () => {
    if (!liveChildren.delete(child)) return;
    if (liveChildren.size === 0) unhookShutdown();
  };
  child.once("exit", untrack);
  child.once("close", untrack);
}

/** SIGTERM to SIGKILL escalation delay when the caller does not set one. */
export const DEFAULT_KILL_GRACE_MS = 2_000;
/** After SIGKILL, how long to wait for `exit` before settling anyway. */
const REAP_WAIT_MS = 1_000;
/** After `exit`, how long to wait for stdout/stderr to end. */
const STREAM_GRACE_MS = 250;

/**
 * Spawns one CLI child and captures its output.
 *
 * Settles only after the child has exited (or, for a child that survives
 * SIGKILL, after a bounded reap wait), so a caller that holds a gate slot
 * or a scratch dir across this call never releases it under a live child.
 * Timeout, abort, and capture overflow send SIGTERM to the process group,
 * SIGKILL after `killGraceMs`, and then reject. A normal run settles on
 * `close`, or on `exit` plus a short stream grace when a leftover process
 * still holds the pipes; that leftover group is then SIGKILLed.
 */
export async function spawnCaptured(args: SpawnCapturedArgs): Promise<SpawnCapturedResult> {
  if (args.signal?.aborted) {
    throw abortException();
  }
  const spawnImpl = args.spawnImpl ?? defaultSpawn;
  const schedule = args.scheduleTimeout ?? defaultSchedule;
  const now = args.now ?? Date.now;
  const started = now();
  const maxChars = args.maxCaptureChars ?? CAPTURE_CHAR_CAP;
  const killGraceMs = args.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

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
  trackChild(child);

  return new Promise<SpawnCapturedResult>((resolve, reject) => {
    let settled = false;
    let failure: Error | DOMException | undefined;
    let exited = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let groupKilled = false;
    let stdout = "";
    let stderr = "";
    const ended = { stdout: child.stdout === null, stderr: child.stderr === null };
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    const timers = new Set<() => void>();

    // An injected scheduler may fire synchronously, before it returns.
    const later = (delayMs: number, fn: () => void): void => {
      const entry = { fired: false, cancel: (): void => undefined };
      entry.cancel = schedule(delayMs, () => {
        entry.fired = true;
        timers.delete(entry.cancel);
        fn();
      });
      if (!entry.fired) timers.add(entry.cancel);
    };

    const onStdout = (chunk: unknown) => {
      takeChunk("stdout", chunk);
    };
    const onStderr = (chunk: unknown) => {
      takeChunk("stderr", chunk);
    };
    const onStdoutEnd = () => {
      ended.stdout = true;
      maybeFinalizeAfterExit();
    };
    const onStderrEnd = () => {
      ended.stderr = true;
      maybeFinalizeAfterExit();
    };

    const detachStreams = () => {
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
      // Keep draining so a still-running child never blocks on a full pipe.
      child.stdout?.resume();
      child.stderr?.resume();
    };

    const finalize = () => {
      if (settled) return;
      settled = true;
      for (const cancel of timers) cancel();
      timers.clear();
      args.signal?.removeEventListener("abort", onAbort);
      detachStreams();
      if (!ended.stdout || !ended.stderr) {
        // The leader is gone or being reaped, but something still holds our
        // pipes: a leftover helper in the group. Nobody will read it.
        if (!groupKilled) killProcessGroup(child, "SIGKILL");
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      if (failure) {
        reject(failure);
        return;
      }
      stdout += decoders.stdout.end();
      stderr += decoders.stderr.end();
      resolve({
        stdout,
        stderr,
        exitCode,
        signal: exitSignal,
        durationMs: Math.max(0, Math.round(now() - started)),
      });
    };

    function maybeFinalizeAfterExit(): void {
      if (exited && ended.stdout && ended.stderr) finalize();
    }

    // Records the first failure, stops capture, and terminates the group.
    // The promise settles when the child exits, not here.
    const fail = (err: Error | DOMException) => {
      if (settled || failure) return;
      failure = err;
      for (const cancel of timers) cancel();
      timers.clear();
      args.signal?.removeEventListener("abort", onAbort);
      detachStreams();
      if (exited) {
        finalize();
        return;
      }
      killProcessGroup(child, "SIGTERM");
      later(killGraceMs, () => {
        if (exited) return;
        groupKilled = true;
        killProcessGroup(child, "SIGKILL");
        later(REAP_WAIT_MS, finalize);
      });
    };

    function onAbort(): void {
      fail(abortException());
    }

    function takeChunk(which: "stdout" | "stderr", chunk: unknown): void {
      if (settled || failure) return;
      const text = chunkToString(decoders[which], chunk);
      if (which === "stdout") stdout += text;
      else stderr += text;
      const length = which === "stdout" ? stdout.length : stderr.length;
      if (length > maxChars) {
        fail(new Error(`cli driver ${args.driver} ${which} exceeded ${maxChars} characters`));
      }
    }

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);

    child.on("error", (err: unknown) => {
      // Spawn failures (ENOENT, EACCES) arrive here with no live process.
      // Settle at once; a best-effort SIGKILL covers the rare live case.
      groupKilled = true;
      killProcessGroup(child, "SIGKILL");
      failure ??= mapSpawnError(err, args);
      finalize();
    });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      if (failure) {
        finalize();
        return;
      }
      maybeFinalizeAfterExit();
      if (!settled) later(STREAM_GRACE_MS, finalize);
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (!exited) {
        exited = true;
        exitCode = code;
        exitSignal = signal ?? null;
      }
      ended.stdout = true;
      ended.stderr = true;
      finalize();
    });

    if (args.stdin === "pipe" && child.stdin) {
      // A child that exits without draining stdin makes the write fail with
      // EPIPE on the stdin stream. Without a listener that is an uncaught
      // exception that kills the whole server. The exit status already
      // carries the failure, so the stream error is dropped.
      child.stdin.on("error", () => undefined);
      child.stdin.write(args.stdinText ?? "");
      child.stdin.end();
    }

    if (args.signal) {
      if (args.signal.aborted) {
        fail(abortException());
        return;
      }
      args.signal.addEventListener("abort", onAbort, { once: true });
    }

    later(args.timeoutMs, () => {
      const err = new Error(`cli driver ${args.driver} timed out after ${args.timeoutMs}ms`);
      Object.assign(err, { code: "ETIMEDOUT" });
      fail(err);
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
      killGraceMs: spec.deps.killGraceMs,
      installUrl: spec.installUrl,
      loginCommand: spec.loginCommand,
    });
    stdoutBytes = Buffer.byteLength(captured.stdout, "utf8");
    exitLabel = captured.exitCode === null ? "null" : String(captured.exitCode);
    if (captured.exitCode !== 0) {
      const how = captured.signal ? ` (signal ${captured.signal})` : "";
      throw new Error(
        `cli driver ${spec.driver} exited ${captured.exitCode ?? "null"}${how}: ${clipStreams(captured.stderr, captured.stdout)}`,
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
