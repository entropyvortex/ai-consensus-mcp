// Temp git repository for attempt-comparison tests.
//
//   main:       base commit (src/sum.ts returns 0), then one later commit
//   attempt-a:  correct sum; also a lockfile, a generated dist file, a binary
//   attempt-b:  wrong sum; also a large file (for the token budget)
//   attempt-c:  committed sum, checked out in a worktree with an uncommitted
//               edit and an untracked file
//   attempt-noisy: 60 vendored files and an agent settings file
//   -evil:      refs/heads/-evil, a ref that looks like an option
//   unrelated:  an orphan commit with no common ancestor

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitFixture {
  root: string;
  worktreeC: string;
  baseSha: string;
  cleanup: () => void;
}

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: tmpdir(),
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: ENV,
    encoding: "utf8",
  }).trim();
}

function write(root: string, path: string, content: string | Buffer): void {
  const full = join(root, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

export function createGitFixture(): GitFixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "acm-fixture-")));
  const root = join(base, "repo");
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  write(root, "README.md", "# fixture\n");
  write(
    root,
    "src/sum.ts",
    "export function sum(a: number, b: number): number {\n  return 0;\n}\n",
  );
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  const baseSha = git(root, "rev-parse", "HEAD");

  git(root, "checkout", "-q", "-b", "attempt-a");
  write(
    root,
    "src/sum.ts",
    "export function sum(a: number, b: number): number {\n  return a + b; // ALPHA\n}\n",
  );
  write(root, "package-lock.json", '{"lockfileVersion": 3}\n');
  write(root, "dist/sum.js", "export const sum = (a, b) => a + b;\n");
  write(root, "logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01, 0x02]));
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "attempt a");

  git(root, "checkout", "-q", "main");
  git(root, "checkout", "-q", "-b", "attempt-b");
  write(
    root,
    "src/sum.ts",
    "export function sum(a: number, b: number): number {\n  return a - b; // BETA\n}\n",
  );
  write(root, "src/big.ts", `// big\n${"export const filler = 'x';\n".repeat(2_000)}`);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "attempt b");

  git(root, "checkout", "-q", "main");
  git(root, "checkout", "-q", "-b", "attempt-c");
  write(
    root,
    "src/sum.ts",
    "export function sum(a: number, b: number): number {\n  return a + b + 0; // GAMMA\n}\n",
  );
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "attempt c");

  git(root, "checkout", "-q", "main");
  git(root, "checkout", "-q", "-b", "attempt-noisy");
  for (let i = 0; i < 60; i++) {
    write(root, `vendor/lib${String(i).padStart(3, "0")}.js`, `module.exports = ${i};\n`);
  }
  write(root, ".claude/settings.local.json", '{"permissions":{"allow":[]}}\n');
  write(
    root,
    "src/sum.ts",
    "export function sum(a: number, b: number): number {\n  return b + a; // DELTA\n}\n",
  );
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "attempt noisy");

  git(root, "checkout", "-q", "main");
  write(root, "CHANGELOG.md", "later work on main\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "main moves on");

  const worktreeC = join(base, "wt-c");
  git(root, "worktree", "add", "-q", worktreeC, "attempt-c");
  write(
    worktreeC,
    "src/sum.ts",
    "export function sum(a: number, b: number): number {\n  return a + b; // GAMMA uncommitted\n}\n",
  );
  write(worktreeC, "src/extra.ts", "export const extra = 1; // GAMMA untracked\n");

  git(root, "update-ref", "refs/heads/-evil", baseSha);
  const tree = git(root, "rev-parse", "HEAD^{tree}");
  const orphan = git(root, "commit-tree", tree, "-m", "orphan");
  git(root, "update-ref", "refs/heads/unrelated", orphan);

  return {
    root,
    worktreeC,
    baseSha,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}
