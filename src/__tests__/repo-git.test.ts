import { statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyPath, computeAttemptDiff, parseNumstatZ } from "../repo/diff.js";
import {
  createGit,
  listAttempts,
  listWorktrees,
  repoRoot,
  resolveCommit,
  type ExecFileLike,
  type Git,
} from "../repo/git.js";
import { createGitFixture, type GitFixture } from "./_git-fixture.js";

let fx: GitFixture;
let git: Git;

beforeAll(() => {
  fx = createGitFixture();
  git = createGit();
});
afterAll(() => fx.cleanup());

describe("git runner — contract: execFile only, hardened global options and env", () => {
  it("runs git through execFile with hardening options and no shell", async () => {
    const seen: { file: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    const fake: ExecFileLike = (file, args, options, cb) => {
      seen.push({ file, args, env: options.env });
      cb(null, "ok\n", "");
    };
    const g = createGit({ execFileImpl: fake, env: { PATH: "/usr/bin" } });
    await g(["status"], "/tmp");
    expect(seen[0]!.file).toBe("git");
    expect(seen[0]!.args.slice(0, 5)).toEqual([
      "--no-pager",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.quotepath=off",
    ]);
    expect(seen[0]!.env).toMatchObject({
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_LITERAL_PATHSPECS: "1",
    });
  });

  it("maps a non-allowed exit code to a GitError with the first stderr line", async () => {
    const fake: ExecFileLike = (_f, _a, _o, cb) =>
      cb(Object.assign(new Error("x"), { code: 2 }), "", "fatal: nope\nmore");
    await expect(createGit({ execFileImpl: fake })(["diff"], "/tmp")).rejects.toThrow(
      "git diff failed: fatal: nope",
    );
    const allowed = await createGit({ execFileImpl: fake })(["diff"], "/tmp", [0, 2]);
    expect(allowed.exitCode).toBe(2);
  });
});

describe("resolveCommit — contract: user refs never become options", () => {
  it("resolves branches, short and full refs, and HEAD", async () => {
    const a = await resolveCommit(git, fx.root, "attempt-a");
    expect(a).toMatch(/^[0-9a-f]{40}$/);
    expect(await resolveCommit(git, fx.root, "refs/heads/attempt-a")).toBe(a);
    expect(await resolveCommit(git, fx.root, "main~1")).toBe(fx.baseSha);
  });

  it("refuses a ref that starts with '-', even when such a branch exists", async () => {
    await expect(resolveCommit(git, fx.root, "-evil")).rejects.toThrow(/must not start with "-"/);
    await expect(resolveCommit(git, fx.root, "--output=/tmp/x")).rejects.toThrow(
      /must not start with "-"/,
    );
    expect(await resolveCommit(git, fx.root, "refs/heads/-evil")).toBe(fx.baseSha);
  });

  it("refuses unknown refs and control characters", async () => {
    await expect(resolveCommit(git, fx.root, "no-such-branch")).rejects.toThrow(
      /does not name a commit/,
    );
    await expect(resolveCommit(git, fx.root, "main\nHEAD")).rejects.toThrow(/control characters/);
    await expect(resolveCommit(git, fx.root, "")).rejects.toThrow(/is empty/);
  });
});

describe("repoRoot / listWorktrees / listAttempts", () => {
  it("finds the top level from a subdirectory and refuses non-repositories", async () => {
    expect(await repoRoot(git, join(fx.root, "src"))).toBe(fx.root);
    await expect(repoRoot(git, "/definitely/not/here")).rejects.toThrow(/does not exist/);
    await expect(repoRoot(git, join(fx.root, "README.md"))).rejects.toThrow(/not a directory/);
  });

  it("lists worktrees with their branch", async () => {
    const wts = await listWorktrees(git, fx.root);
    expect(wts.map((w) => [w.path, w.branch])).toEqual([
      [fx.root, "refs/heads/main"],
      [fx.worktreeC, "refs/heads/attempt-c"],
    ]);
  });

  it("lists branches with ahead/behind, worktree and uncommitted count, base defaulting to main", async () => {
    const r = await listAttempts(git, fx.worktreeC);
    expect(r.base).toMatchObject({ ref: "main", source: "main" });
    const by = Object.fromEntries(r.attempts.map((a) => [a.name, a]));
    expect(by["attempt-a"]).toMatchObject({
      ahead: 1,
      behind: 1,
      worktree: null,
      uncommitted: null,
      current: false,
    });
    expect(by["attempt-c"]).toMatchObject({
      ahead: 1,
      behind: 1,
      worktree: fx.worktreeC,
      uncommitted: 2,
      current: true,
    });
    expect(by["main"]).toMatchObject({ ahead: 0, behind: 0, current: false });
    expect(Object.keys(by)).toContain("-evil");
  });

  it("honours an explicit base and the limit", async () => {
    const r = await listAttempts(git, fx.root, { base: "attempt-a", limit: 2 });
    expect(r.base).toMatchObject({ ref: "attempt-a", source: "input" });
    expect(r.attempts).toHaveLength(2);
  });

  it("does not write the index when listing (GIT_OPTIONAL_LOCKS=0)", async () => {
    const index = join(fx.root, ".git", "worktrees", "wt-c", "index");
    const before = statSync(index).mtimeMs;
    await listAttempts(git, fx.worktreeC);
    expect(statSync(index).mtimeMs).toBe(before);
  });
});

describe("computeAttemptDiff — contract: filtered, budgeted, whole files, omissions listed", () => {
  it("skips lockfiles, generated and binary files and lists them for jurors", async () => {
    const sha = await resolveCommit(git, fx.root, "attempt-a");
    const d = await computeAttemptDiff(git, fx.root, {
      ref: "attempt-a",
      sha,
      baseSha: fx.baseSha,
      worktree: null,
      options: { tokenBudget: 10_000 },
    });
    expect(d.mergeBase).toBe(fx.baseSha);
    expect(d.includesUncommitted).toBe(false);
    expect(d.files.included.map((f) => f.path)).toEqual(["src/sum.ts"]);
    expect(d.files.skipped).toEqual([
      { path: "dist/sum.js", reason: "generated" },
      { path: "logo.png", reason: "binary" },
      { path: "package-lock.json", reason: "lockfile" },
    ]);
    expect(d.content).toContain("#   lockfile: package-lock.json");
    expect(d.content).toContain("+  return a + b; // ALPHA");
    expect(d.content).not.toContain("lockfileVersion");
  });

  it("diffs from the merge-base, so later commits on the base do not leak in", async () => {
    const sha = await resolveCommit(git, fx.root, "attempt-a");
    const mainSha = await resolveCommit(git, fx.root, "main");
    const d = await computeAttemptDiff(git, fx.root, {
      ref: "attempt-a",
      sha,
      baseSha: mainSha,
      worktree: null,
      options: { tokenBudget: 10_000 },
    });
    expect(d.mergeBase).toBe(fx.baseSha);
    expect(d.content).not.toContain("CHANGELOG");
  });

  it("drops whole files beyond the token budget and names them", async () => {
    const sha = await resolveCommit(git, fx.root, "attempt-b");
    const d = await computeAttemptDiff(git, fx.root, {
      ref: "attempt-b",
      sha,
      baseSha: fx.baseSha,
      worktree: null,
      options: { tokenBudget: 1_000 },
    });
    expect(d.files.included.map((f) => f.path)).toEqual(["src/sum.ts"]);
    expect(d.files.truncated.map((f) => f.path)).toEqual(["src/big.ts"]);
    expect(d.content).toContain("#   over the size budget: src/big.ts");
    expect(d.content).not.toContain("filler");
  });

  it("uses the checked-out worktree, including uncommitted and untracked changes, without touching it", async () => {
    const sha = await resolveCommit(git, fx.root, "attempt-c");
    const wt = (await listWorktrees(git, fx.root)).find(
      (w) => w.branch === "refs/heads/attempt-c",
    )!;
    const index = join(fx.root, ".git", "worktrees", "wt-c", "index");
    const before = statSync(index).mtimeMs;
    const d = await computeAttemptDiff(git, fx.root, {
      ref: "attempt-c",
      sha,
      baseSha: fx.baseSha,
      worktree: wt,
      options: { tokenBudget: 10_000 },
    });
    expect(d.includesUncommitted).toBe(true);
    expect(d.worktree).toBe(fx.worktreeC);
    expect(d.content).toContain("GAMMA uncommitted");
    expect(d.content).toContain("GAMMA untracked");
    expect(d.content).not.toContain("a + b + 0");
    expect(statSync(index).mtimeMs).toBe(before);

    const committedOnly = await computeAttemptDiff(git, fx.root, {
      ref: "attempt-c",
      sha,
      baseSha: fx.baseSha,
      worktree: wt,
      options: { tokenBudget: 10_000, includeUncommitted: false },
    });
    expect(committedOnly.includesUncommitted).toBe(false);
    expect(committedOnly.content).toContain("a + b + 0");
  });
});

describe("computeAttemptDiff — caps and blinding for noisy attempts", () => {
  it("caps the jurors' header per reason, counts it against the budget, and withholds agent paths", async () => {
    const sha = await resolveCommit(git, fx.root, "attempt-noisy");
    const d = await computeAttemptDiff(git, fx.root, {
      ref: "attempt-noisy",
      sha,
      baseSha: fx.baseSha,
      worktree: null,
      options: { tokenBudget: 2_000 },
    });
    expect(d.files.skipped).toHaveLength(61);
    expect(d.files.skipped.filter((s) => s.reason === "agent-files")).toEqual([
      { path: ".claude/settings.local.json", reason: "agent-files" },
    ]);
    expect(d.content).toContain("#   … and 40 more generated files");
    expect(d.content).toContain("#   1 agent tool file(s) (paths withheld)");
    expect(d.content).not.toContain(".claude");
    expect(d.content).toContain("// DELTA");
    expect(d.tokens).toBeLessThanOrEqual(2_000);
  });
});

describe("classifyPath / parseNumstatZ", () => {
  it.each([
    ["pnpm-lock.yaml", "lockfile"],
    ["services/api/go.sum", "lockfile"],
    ["web/dist/app.js", "generated"],
    ["node_modules/x/index.js", "generated"],
    ["app.min.js", "generated"],
    ["__snapshots__/a.test.ts.snap", "generated"],
    ["api/user.generated.ts", "generated"],
    ["src/dist.ts", null],
    [".claude/settings.local.json", "agent-files"],
    [".codex/notes.md", "agent-files"],
    [".aider.chat.history.md", "agent-files"],
    ["CLAUDE.md", null],
    ["src/index.ts", null],
  ])("%s → %s", (path, expected) => {
    expect(classifyPath(path)).toBe(expected);
  });

  it("parses plain, binary and renamed entries", () => {
    const out = "3\t1\tsrc/a.ts\0-\t-\tlogo.png\0" + "0\t0\t\0old.ts\0new.ts\0";
    expect(parseNumstatZ(out)).toEqual([
      { path: "src/a.ts", binary: false },
      { path: "logo.png", binary: true },
      { path: "new.ts", oldPath: "old.ts", binary: false },
    ]);
  });
});
