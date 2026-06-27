#!/usr/bin/env node
/**
 * Preflight for Cloudflare Workers Git deploys on the free plan.
 * Fails the build if any wrangler config sets [limits] / cpu_ms (paid-only).
 * Prints the active commit and config so CI logs are self-diagnosing.
 */
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const configs = [
  join(root, "wrangler.toml"),
  join(root, "wrangler.jsonc"),
  join(root, "examples/cloudflare/wrangler.toml"),
].filter((p) => existsSync(p));

const sha =
  process.env.WORKERS_CI_COMMIT_SHA?.trim() ||
  execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
const branch = process.env.WORKERS_CI_BRANCH?.trim() || "(local)";

console.log(`wrangler preflight: branch=${branch} commit=${sha}`);

if (configs.length === 0) {
  console.error("wrangler preflight: no wrangler.toml found at repo root");
  process.exit(1);
}

function hasActiveLimits(content) {
  return content
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .some((line) => /^\s*\[limits\]/.test(line) || /^\s*cpu_ms\s*=/.test(line));
}

let failed = false;
for (const path of configs) {
  const rel = path.startsWith(root) ? path.slice(root.length + 1) : path;
  const content = readFileSync(path, "utf8");
  console.log(`--- ${rel} ---`);
  console.log(content);
  if (hasActiveLimits(content)) {
    console.error(
      `wrangler preflight: ${rel} sets CPU limits — remove [limits] for free-tier deploys`,
    );
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}
console.log("wrangler preflight: OK (no CPU limits configured)");