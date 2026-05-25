// Premortem F4 contract: project keys are derived from absolute, canonical
// paths so users on the same machine with same-named project dirs (or
// even shared NAS mounts with different homes) never collide. Symlinks
// resolved at store-time make the key stable across topology changes.

import { mkdtemp, symlink, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectKeyForPath, resolveProjectIdentity, resolveProjectPath } from "../project-key.js";

let workdir: string;
beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "memkey-"));
});
afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("projectKeyForPath — deterministic short hash", () => {
  it("returns a stable 12-char lowercase-hex key", () => {
    const k = projectKeyForPath("/home/alice/code/billing");
    expect(k).toMatch(/^[a-f0-9]{12}$/);
    expect(projectKeyForPath("/home/alice/code/billing")).toBe(k);
  });

  it("returns different keys for different absolute paths", () => {
    const a = projectKeyForPath("/home/alice/code/billing");
    const b = projectKeyForPath("/home/bob/code/billing");
    expect(a).not.toBe(b);
  });

  it("returns different keys for trailing-slash variation (absolute path string is the input contract)", () => {
    // projectKeyForPath does NOT normalise — callers are expected to pass the
    // already-canonical path. This test documents the contract.
    const a = projectKeyForPath("/x/y");
    const b = projectKeyForPath("/x/y/");
    expect(a).not.toBe(b);
  });
});

describe("resolveProjectPath — symlink resolution", () => {
  it("returns the absolute resolved path for an existing dir", async () => {
    const real = join(workdir, "real-project");
    await mkdir(real);
    const resolved = await resolveProjectPath(real);
    expect(resolved).toContain("real-project");
  });

  it("follows symlinks to a real directory", async () => {
    const real = join(workdir, "real-project");
    const link = join(workdir, "link-to-project");
    await mkdir(real);
    await symlink(real, link);
    const resolvedReal = await resolveProjectPath(real);
    const resolvedLink = await resolveProjectPath(link);
    expect(resolvedLink).toBe(resolvedReal);
  });

  it("falls back to the absolute-but-not-realpathed form when the path does not exist", async () => {
    const missing = join(workdir, "does-not-exist");
    const resolved = await resolveProjectPath(missing);
    expect(resolved).toContain("does-not-exist");
  });
});

describe("resolveProjectIdentity — convenience wrapper", () => {
  it("returns matching projectPath + projectKey", async () => {
    const real = join(workdir, "p1");
    await mkdir(real);
    const { projectPath, projectKey } = await resolveProjectIdentity(real);
    expect(projectKey).toBe(projectKeyForPath(projectPath));
  });

  it("symlinked and real path resolve to the same identity", async () => {
    const real = join(workdir, "real-p");
    const link = join(workdir, "link-p");
    await mkdir(real);
    await symlink(real, link);
    const a = await resolveProjectIdentity(real);
    const b = await resolveProjectIdentity(link);
    expect(b.projectKey).toBe(a.projectKey);
    expect(b.projectPath).toBe(a.projectPath);
  });
});
