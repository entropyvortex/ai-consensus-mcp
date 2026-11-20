// ─────────────────────────────────────────────────────────────
// Read-only git access for attempt comparison
// ─────────────────────────────────────────────────────────────
// Every call is `execFile("git", argv)`: no shell, no string
// interpolation. User strings (refs, base) are validated with
// `rev-parse --verify --end-of-options` and refused when they start with
// "-", so they can never be read as options. Paths that come from git
// itself go after `--` with literal pathspecs. Nothing writes to the
// index or the working tree: GIT_OPTIONAL_LOCKS=0 keeps `git status`
// from refreshing the index, fsmonitor is off, and diffs run with
// --no-ext-diff --no-textconv so repository config cannot launch
// helper programs.

import { execFile as nodeExecFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; maxBuffer: number; timeout: number },
  callback: (error: (Error & { code?: unknown }) | null, stdout: string, stderr: string) => void,
) => unknown;

export interface GitOptions {
  /** Injected for tests. Defaults to node's execFile. */
  execFileImpl?: ExecFileLike;
  /** Base environment. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Per-call timeout. Default 60 s. */
  timeoutMs?: number;
}

export interface GitResult {
  stdout: string;
  exitCode: number;
}

export type Git = (
  args: readonly string[],
  cwd: string,
  okExitCodes?: readonly number[],
) => Promise<GitResult>;

const MAX_BUFFER = 64 * 1024 * 1024;

/** Global options prepended to every git call. */
const GLOBAL_ARGS = ["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.quotepath=off"];

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

export function createGit(options: GitOptions = {}): Git {
  const run = options.execFileImpl ?? nodeExecFile;
  const env: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LITERAL_PATHSPECS: "1",
    LC_ALL: "C",
  };
  const timeout = options.timeoutMs ?? 60_000;
  return (args, cwd, okExitCodes = [0]) =>
    new Promise<GitResult>((resolve, reject) => {
      run(
        "git",
        [...GLOBAL_ARGS, ...args],
        { cwd, env, maxBuffer: MAX_BUFFER, timeout },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
          if (error && !okExitCodes.includes(code)) {
            const detail = (stderr || error.message).trim().split("\n")[0] ?? "";
            reject(new GitError(`git ${args[0] ?? ""} failed: ${detail}`));
            return;
          }
          resolve({ stdout, exitCode: code });
        },
      );
    });
}

// ── Validation ──────────────────────────────────────────────

/** Characters git never allows in a ref, plus anything that could start an option. */
function refIssue(ref: string): string | undefined {
  if (ref.length === 0) return "is empty";
  if (ref.length > 256) return "is longer than 256 characters";
  if (ref.startsWith("-")) return 'must not start with "-"';
  for (const ch of ref) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f) return "contains control characters";
  }
  return undefined;
}

/**
 * Resolve a user-supplied ref to a commit sha. Refuses refs that could be
 * read as options and anything git cannot resolve to a commit.
 */
export async function resolveCommit(
  git: Git,
  cwd: string,
  ref: string,
  what = "ref",
): Promise<string> {
  const issue = refIssue(ref);
  if (issue) throw new GitError(`${what} "${ref}" ${issue}`);
  const { stdout, exitCode } = await git(
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
    cwd,
    [0, 1],
  );
  const sha = stdout.trim();
  if (exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) {
    throw new GitError(`${what} "${ref}" does not name a commit in this repository`);
  }
  return sha;
}

/** Absolute top-level directory of the repository (or worktree) containing `path`. */
export async function repoRoot(git: Git, path: string): Promise<string> {
  const abs = isAbsolute(path) ? path : resolvePath(path);
  let stat;
  try {
    stat = await lstat(abs);
  } catch {
    throw new GitError(`repoPath "${path}" does not exist`);
  }
  if (!stat.isDirectory()) throw new GitError(`repoPath "${path}" is not a directory`);
  const { stdout } = await git(["rev-parse", "--show-toplevel"], abs).catch(() => {
    throw new GitError(`repoPath "${path}" is not inside a git repository`);
  });
  return stdout.trim();
}

// ── Worktrees, branches, base ───────────────────────────────

export interface Worktree {
  path: string;
  head: string | null;
  /** Full ref, e.g. refs/heads/feature-x; null when detached. */
  branch: string | null;
}

export async function listWorktrees(git: Git, cwd: string): Promise<Worktree[]> {
  const { stdout } = await git(["worktree", "list", "--porcelain", "-z"], cwd);
  const out: Worktree[] = [];
  let current: Worktree | null = null;
  for (const field of stdout.split("\0")) {
    if (field === "") {
      if (current) out.push(current);
      current = null;
      continue;
    }
    const space = field.indexOf(" ");
    const key = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? "" : field.slice(space + 1);
    if (key === "worktree") current = { path: value, head: null, branch: null };
    else if (current && key === "HEAD") current.head = value;
    else if (current && key === "branch") current.branch = value;
  }
  if (current) out.push(current);
  return out;
}

export interface BranchInfo {
  /** Full ref, e.g. refs/heads/x. */
  ref: string;
  /** Short name, e.g. x. */
  name: string;
  sha: string;
  committedAt: number;
}

export async function listBranches(git: Git, cwd: string, limit: number): Promise<BranchInfo[]> {
  const { stdout } = await git(
    [
      "for-each-ref",
      "--sort=-committerdate",
      `--count=${Math.max(1, Math.trunc(limit))}`,
      "--format=%(refname)%00%(refname:short)%00%(objectname)%00%(committerdate:unix)",
      "refs/heads",
    ],
    cwd,
  );
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [ref = "", name = "", sha = "", ts = "0"] = line.split("\0");
      return { ref, name, sha, committedAt: Number(ts) * 1000 };
    });
}

export interface BaseInfo {
  ref: string;
  sha: string;
  source: "input" | "origin-head" | "main" | "master" | "head";
}

/** Base for listing: the input, else origin/HEAD, main, master, then HEAD. */
export async function resolveListBase(git: Git, cwd: string, base?: string): Promise<BaseInfo> {
  if (base !== undefined)
    return { ref: base, sha: await resolveCommit(git, cwd, base, "base"), source: "input" };
  const sym = await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], cwd, [0, 1]);
  const originHead = sym.stdout.trim();
  if (sym.exitCode === 0 && originHead) {
    const ref = originHead.replace(/^refs\/remotes\//, "");
    return { ref, sha: await resolveCommit(git, cwd, ref, "base"), source: "origin-head" };
  }
  for (const name of ["main", "master"] as const) {
    const sha = await resolveCommit(git, cwd, `refs/heads/${name}`, "base").catch(() => null);
    if (sha) return { ref: name, sha, source: name };
  }
  return { ref: "HEAD", sha: await resolveCommit(git, cwd, "HEAD", "base"), source: "head" };
}

export async function aheadBehind(
  git: Git,
  cwd: string,
  baseSha: string,
  sha: string,
): Promise<{ ahead: number; behind: number }> {
  const { stdout } = await git(["rev-list", "--left-right", "--count", `${baseSha}...${sha}`], cwd);
  const [behind = "0", ahead = "0"] = stdout.trim().split(/\s+/);
  return { ahead: Number(ahead), behind: Number(behind) };
}

/** Number of changed or untracked paths in a worktree (no index refresh). */
export async function dirtyCount(git: Git, worktree: string): Promise<number> {
  const { stdout } = await git(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    worktree,
  );
  // Renames add a second NUL-terminated field; count entries by their status prefix.
  let n = 0;
  const fields = stdout.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f.length < 4) continue;
    n += 1;
    if (f.startsWith("R") || f.startsWith("C")) i += 1;
  }
  return n;
}

export interface ListedAttempt {
  ref: string;
  name: string;
  sha: string;
  worktree: string | null;
  ahead: number;
  behind: number;
  /** Uncommitted paths in its worktree; null without a worktree. */
  uncommitted: number | null;
  /** True for the branch checked out where the server runs. */
  current: boolean;
  committedAt: string;
}

export interface ListAttemptsResult {
  repoRoot: string;
  base: BaseInfo;
  attempts: ListedAttempt[];
  /** Worktrees with a detached HEAD (listed for completeness). */
  detachedWorktrees: { path: string; head: string | null }[];
}

/**
 * Branches (most recent first) with ahead/behind against the base, their
 * worktree when checked out, and that worktree's uncommitted count.
 * Makes no assumption about branch naming.
 */
export async function listAttempts(
  git: Git,
  repoPath: string,
  options: { base?: string; limit?: number } = {},
): Promise<ListAttemptsResult> {
  const root = await repoRoot(git, repoPath);
  const [base, worktrees, branches] = await Promise.all([
    resolveListBase(git, root, options.base),
    listWorktrees(git, root),
    listBranches(git, root, options.limit ?? 50),
  ]);
  const realRoot = await realpath(root).catch(() => root);
  const byBranch = new Map(worktrees.filter((w) => w.branch).map((w) => [w.branch!, w]));
  const attempts = await Promise.all(
    branches.map(async (b) => {
      const wt = byBranch.get(b.ref) ?? null;
      const [{ ahead, behind }, uncommitted, wtReal] = await Promise.all([
        aheadBehind(git, root, base.sha, b.sha),
        wt ? dirtyCount(git, wt.path).catch(() => null) : Promise.resolve(null),
        wt ? realpath(wt.path).catch(() => wt.path) : Promise.resolve(null),
      ]);
      return {
        ref: b.ref,
        name: b.name,
        sha: b.sha,
        worktree: wt ? wt.path : null,
        ahead,
        behind,
        uncommitted,
        current: wtReal !== null && wtReal === realRoot,
        committedAt: new Date(b.committedAt).toISOString(),
      };
    }),
  );
  return {
    repoRoot: root,
    base,
    attempts,
    detachedWorktrees: worktrees
      .filter((w) => w.branch === null)
      .map((w) => ({ path: w.path, head: w.head })),
  };
}
