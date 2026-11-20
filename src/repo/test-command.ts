// ─────────────────────────────────────────────────────────────
// Optional per-attempt test command — EXECUTES REPOSITORY CODE
// ─────────────────────────────────────────────────────────────
// Only reachable when the server was started with
// --allow-test-command. The command is an argv array run with spawn (no
// shell) in the attempt's own worktree, in its own process group, with a
// timeout that kills the whole group. The result becomes a check:
// exit 0 → passed, other exit → failed, timeout or spawn error → unknown.

import { spawn as nodeSpawn } from "node:child_process";
import type { CandidateCheck } from "ai-consensus-core";
import { DEPTH_ENV, currentDepth } from "../cli-backend/env.js";
import { killProcessGroup, type SpawnLike } from "../cli-backend/runner.js";

export const TEST_CHECK_NAME = "testCommand";
const TAIL_CHARS = 2_000;
const KEEP_CHARS = 64 * 1024;
const KILL_GRACE_MS = 2_000;

export interface TestCommandArgs {
  argv: readonly string[];
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: SpawnLike;
}

/** Run one test command; never throws. */
export function runTestCommand(args: TestCommandArgs): Promise<CandidateCheck> {
  const [file, ...rest] = args.argv;
  if (!file)
    return Promise.resolve({
      name: TEST_CHECK_NAME,
      status: "unknown",
      output: "empty testCommand",
    });
  const base = args.env ?? process.env;
  const env = { ...base, [DEPTH_ENV]: String(currentDepth(base) + 1) };
  const spawn = args.spawnImpl ?? ((cmd, argv, opts) => nodeSpawn(cmd, [...argv], opts));
  return new Promise<CandidateCheck>((resolve) => {
    let out = "";
    let timedOut = false;
    let settled = false;
    const finish = (check: CandidateCheck) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(check);
    };
    const tail = () => out.slice(-TAIL_CHARS).trim();
    let child: ReturnType<SpawnLike>;
    try {
      child = spawn(file, rest, {
        cwd: args.cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        name: TEST_CHECK_NAME,
        status: "unknown",
        output: `could not start: ${String(err)}`,
      });
      return;
    }
    const take = (chunk: unknown) => {
      out +=
        typeof chunk === "string"
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString("utf8")
            : String(chunk);
      if (out.length > KEEP_CHARS) out = out.slice(-KEEP_CHARS);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child, "SIGTERM");
      setTimeout(() => killProcessGroup(child, "SIGKILL"), KILL_GRACE_MS).unref?.();
    }, args.timeoutMs);
    child.on("error", (err: Error) => {
      finish({
        name: TEST_CHECK_NAME,
        status: "unknown",
        output: `could not start: ${err.message}`,
      });
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (timedOut) {
        finish({
          name: TEST_CHECK_NAME,
          status: "unknown",
          output: `timed out after ${args.timeoutMs} ms\n${tail()}`.trim(),
        });
        return;
      }
      const status = code === 0 ? "passed" : "failed";
      const how = code === null ? `signal ${signal ?? "?"}` : `exit ${code}`;
      finish({ name: TEST_CHECK_NAME, status, output: `${how}\n${tail()}`.trim() });
    });
  });
}
