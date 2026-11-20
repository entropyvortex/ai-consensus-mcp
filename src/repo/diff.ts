// ─────────────────────────────────────────────────────────────
// Attempt diffs with budgeting
// ─────────────────────────────────────────────────────────────
// One attempt = the changes from merge-base(base, attempt) to the
// attempt. When the attempt's branch is checked out in a worktree, the
// diff is taken against that worktree's files (staged, unstaged and
// untracked), because agents often leave work uncommitted. Lockfiles,
// generated and binary files are listed but not shown; whole files are
// dropped once the per-attempt token budget is spent. Jurors see a header
// naming everything left out.

import { lstat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Git, Worktree } from "./git.js";

export type SkipReason = "lockfile" | "generated" | "binary" | "too-large" | "agent-files";

export interface AttemptDiff {
  ref: string;
  sha: string;
  mergeBase: string;
  worktree: string | null;
  /** True when the diff was taken against the worktree's files. */
  includesUncommitted: boolean;
  /** What jurors see: an omission header, then whole-file patches. */
  content: string;
  /** Estimated tokens of `content` (chars / 4). */
  tokens: number;
  files: {
    included: { path: string; tokens: number }[];
    skipped: { path: string; reason: SkipReason }[];
    /** Dropped whole because the attempt's budget was spent. */
    truncated: { path: string; tokens: number }[];
  };
}

export interface DiffOptions {
  /** Token budget for the files shown for one attempt. */
  tokenBudget: number;
  /** Diff the worktree's files (incl. untracked) when the branch is checked out. Default true. */
  includeUncommitted?: boolean;
  /** Untracked files above this size are skipped. Default 512 KiB. */
  maxUntrackedBytes?: number;
}

export const LOCKFILES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "pdm.lock",
  "composer.lock",
  "go.sum",
  "mix.lock",
  "pubspec.lock",
  "packages.lock.json",
  "flake.lock",
  "Podfile.lock",
  "Package.resolved",
  "gradle.lockfile",
]);

const GENERATED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  "__generated__",
  "vendor",
]);

const GENERATED_SUFFIXES = [
  ".min.js",
  ".min.css",
  ".map",
  ".snap",
  ".pb.go",
  "_pb2.py",
  "_pb2_grpc.py",
  ".g.dart",
  ".freezed.dart",
];

/**
 * Agent tool state (settings, notes, caches). Their paths alone can name
 * the agent that produced an attempt, so they are skipped and jurors only
 * see a count.
 */
const AGENT_DIRS: ReadonlySet<string> = new Set([
  ".claude",
  ".codex",
  ".grok",
  ".cursor",
  ".gemini",
  ".windsurf",
  ".continue",
  ".aider",
  ".emdash",
]);

/** Path-based classification; `linguist-generated` is checked separately. */
export function classifyPath(path: string): "lockfile" | "generated" | "agent-files" | null {
  const first = path.split("/")[0] ?? "";
  if (AGENT_DIRS.has(first) || first.startsWith(".aider")) return "agent-files";
  if (LOCKFILES.has(basename(path))) return "lockfile";
  const parts = path.split("/");
  if (parts.slice(0, -1).some((p) => GENERATED_DIRS.has(p))) return "generated";
  const lower = path.toLowerCase();
  if (GENERATED_SUFFIXES.some((s) => lower.endsWith(s))) return "generated";
  if (/\.generated\.[a-z0-9]+$/i.test(path)) return "generated";
  return null;
}

export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "-M"];

interface NumstatEntry {
  path: string;
  oldPath?: string;
  binary: boolean;
}

/** Parse `git diff --numstat -z` output. */
export function parseNumstatZ(out: string): NumstatEntry[] {
  const tokens = out.split("\0");
  const entries: NumstatEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "") continue;
    const parts = t.split("\t");
    if (parts.length < 3) continue;
    const binary = parts[0] === "-" && parts[1] === "-";
    const rest = parts.slice(2).join("\t");
    if (rest === "") {
      const oldPath = tokens[i + 1] ?? "";
      const newPath = tokens[i + 2] ?? "";
      i += 2;
      if (newPath) entries.push({ path: newPath, oldPath, binary });
    } else {
      entries.push({ path: rest, binary });
    }
  }
  return entries;
}

/** Paths marked `linguist-generated` in .gitattributes. */
async function linguistGenerated(
  git: Git,
  cwd: string,
  paths: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < paths.length; i += 200) {
    const batch = paths.slice(i, i + 200);
    const { stdout } = await git(
      ["check-attr", "-z", "linguist-generated", "--", ...batch],
      cwd,
    ).catch(() => ({ stdout: "" }));
    const f = stdout.split("\0");
    for (let k = 0; k + 2 < f.length; k += 3) {
      const value = f[k + 2];
      if (value === "set" || value === "true") out.add(f[k]!);
    }
  }
  return out;
}

interface Patch {
  path: string;
  text: string;
}

/**
 * Compute one attempt's diff. `baseSha` and `sha` are verified commit
 * shas; `worktree` is the worktree that has the attempt's branch checked
 * out, if any.
 */
export async function computeAttemptDiff(
  git: Git,
  root: string,
  args: {
    ref: string;
    sha: string;
    baseSha: string;
    worktree: Worktree | null;
    options: DiffOptions;
  },
): Promise<AttemptDiff> {
  const { ref, sha, baseSha, worktree, options } = args;
  const mb = await git(["merge-base", baseSha, sha], root, [0, 1]);
  const mergeBase = mb.exitCode === 0 && mb.stdout.trim() ? mb.stdout.trim() : baseSha;
  const useWorktree =
    (options.includeUncommitted ?? true) && worktree !== null && worktree.head === sha;
  const cwd = useWorktree ? worktree.path : root;
  const range = useWorktree ? [mergeBase] : [mergeBase, sha];

  const skipped: AttemptDiff["files"]["skipped"] = [];
  const patches: Patch[] = [];

  // Tracked changes (committed, plus staged/unstaged in worktree mode).
  const numstat = await git(["diff", "--numstat", "-z", ...DIFF_FLAGS, ...range], cwd);
  const entries = parseNumstatZ(numstat.stdout);
  const generated = await linguistGenerated(
    git,
    cwd,
    entries.map((e) => e.path),
  );
  for (const e of entries) {
    const reason: SkipReason | null = e.binary
      ? "binary"
      : (classifyPath(e.path) ?? (generated.has(e.path) ? "generated" : null));
    if (reason) {
      skipped.push({ path: e.path, reason });
      continue;
    }
    const paths = e.oldPath ? [e.oldPath, e.path] : [e.path];
    const { stdout } = await git(["diff", ...DIFF_FLAGS, ...range, "--", ...paths], cwd);
    if (stdout.trim()) patches.push({ path: e.path, text: stdout.trimEnd() });
  }

  // Untracked files in worktree mode.
  if (useWorktree) {
    const maxBytes = options.maxUntrackedBytes ?? 512 * 1024;
    const { stdout } = await git(["ls-files", "--others", "--exclude-standard", "-z"], cwd);
    const untracked = stdout.split("\0").filter((p) => p.length > 0);
    const untrackedGenerated = await linguistGenerated(git, cwd, untracked);
    for (const path of untracked) {
      const reason: SkipReason | null =
        classifyPath(path) ?? (untrackedGenerated.has(path) ? "generated" : null);
      if (reason) {
        skipped.push({ path, reason });
        continue;
      }
      const st = await lstat(join(cwd, path)).catch(() => null);
      if (!st || (!st.isFile() && !st.isSymbolicLink())) continue;
      if (st.isFile() && st.size > maxBytes) {
        skipped.push({ path, reason: "too-large" });
        continue;
      }
      const { stdout: patch } = await git(
        ["diff", "--no-index", ...DIFF_FLAGS, "--", "/dev/null", path],
        cwd,
        [0, 1],
      );
      if (/^Binary files /m.test(patch)) {
        skipped.push({ path, reason: "binary" });
        continue;
      }
      if (patch.trim()) patches.push({ path, text: patch.trimEnd() });
    }
  }

  // Whole files in path order until the budget is spent. The (capped)
  // omission header for skipped files counts against the budget too.
  patches.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const included: AttemptDiff["files"]["included"] = [];
  const truncated: AttemptDiff["files"]["truncated"] = [];
  const shown: string[] = [];
  let remaining = options.tokenBudget - estimateTokens(skippedHeader(skipped));
  for (const p of patches) {
    const t = estimateTokens(p.text);
    if (t <= remaining) {
      included.push({ path: p.path, tokens: t });
      shown.push(p.text);
      remaining -= t;
    } else {
      truncated.push({ path: p.path, tokens: t });
    }
  }

  const top = skippedHeader(skipped);
  const header = [top, truncatedHeader(truncated, top === "")].filter(Boolean).join("\n");
  const body = shown.length > 0 ? shown.join("\n") : "(no textual changes against the base)";
  const content = header ? `${header}\n${body}` : body;
  return {
    ref,
    sha,
    mergeBase,
    worktree: worktree?.path ?? null,
    includesUncommitted: useWorktree,
    content,
    tokens: estimateTokens(content),
    files: { included, skipped, truncated },
  };
}

const REASON_LABEL: Record<Exclude<SkipReason, "agent-files">, string> = {
  lockfile: "lockfile",
  generated: "generated",
  binary: "binary",
  "too-large": "too large",
};

/** Paths listed per reason in the jurors' header before "+N more". */
export const HEADER_PATHS_PER_REASON = 20;

/**
 * Header naming skipped files, at most HEADER_PATHS_PER_REASON paths per
 * reason. Agent tool files appear as a count only.
 */
function skippedHeader(skipped: AttemptDiff["files"]["skipped"]): string {
  if (skipped.length === 0) return "";
  const lines = ["# Changed but not shown (paths only):"];
  for (const reason of Object.keys(REASON_LABEL) as (keyof typeof REASON_LABEL)[]) {
    const paths = skipped.filter((s) => s.reason === reason).map((s) => s.path);
    for (const p of paths.slice(0, HEADER_PATHS_PER_REASON))
      lines.push(`#   ${REASON_LABEL[reason]}: ${p}`);
    if (paths.length > HEADER_PATHS_PER_REASON) {
      lines.push(
        `#   … and ${paths.length - HEADER_PATHS_PER_REASON} more ${REASON_LABEL[reason]} files`,
      );
    }
  }
  const agent = skipped.filter((s) => s.reason === "agent-files").length;
  if (agent > 0) lines.push(`#   ${agent} agent tool file(s) (paths withheld)`);
  return lines.join("\n");
}

function truncatedHeader(truncated: AttemptDiff["files"]["truncated"], withTitle = true): string {
  if (truncated.length === 0) return "";
  const lines = withTitle ? ["# Changed but not shown (paths only):"] : [];
  lines.push(
    ...truncated
      .slice(0, HEADER_PATHS_PER_REASON)
      .map((t) => `#   over the size budget: ${t.path}`),
  );
  if (truncated.length > HEADER_PATHS_PER_REASON) {
    lines.push(
      `#   … and ${truncated.length - HEADER_PATHS_PER_REASON} more files over the size budget`,
    );
  }
  return lines.join("\n");
}
