#!/usr/bin/env node
// Capture HTTP listTools evidence for verification (run from repo root after build).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const binPath = join(repoRoot, "dist", "index.js");
const outPath = process.argv[2] ?? join(repoRoot, "http-tools.json");

const tmp = mkdtempSync(join(tmpdir(), "http-evidence-"));
const configPath = join(tmp, "config.json");
writeFileSync(
  configPath,
  JSON.stringify({
    providers: {
      fake: { baseUrl: "https://example.invalid/v1", apiKeyEnv: "EVIDENCE_FAKE_KEY" },
    },
    participants: [
      { id: "a", provider: "fake", modelId: "model-a", personaId: "pessimist" },
      { id: "b", provider: "fake", modelId: "model-b", personaId: "domain-expert" },
    ],
  }),
);

const child = spawn("node", [binPath, "serve", "--http", "--config", configPath, "--port", "0"], {
  env: { ...process.env, EVIDENCE_FAKE_KEY: "fake" },
  stdio: ["ignore", "pipe", "pipe"],
});

let readyUrl;
const stderrChunks = [];
child.stderr.on("data", (chunk) => {
  const text = chunk.toString();
  stderrChunks.push(text);
  const match = text.match(/at (http:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
  if (match) readyUrl = match[1];
});

await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("timeout waiting for http ready")), 10_000);
  const check = setInterval(() => {
    if (readyUrl) {
      clearTimeout(t);
      clearInterval(check);
      resolve();
    }
  }, 50);
});

const client = new Client({ name: "evidence", version: "0.0.0" }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(new URL(readyUrl));
await client.connect(transport);
const tools = await client.listTools();
const names = tools.tools.map((t) => t.name);

const evidence = {
  url: readyUrl,
  toolCount: names.length,
  names,
  presetSample: names.filter((n) => n.startsWith("consensus_")).slice(0, 8),
  stderr: stderrChunks.join(""),
};

writeFileSync(outPath, JSON.stringify(evidence, null, 2));
console.log("captured", outPath, "—", names.length, "tools");

await client.close();
child.kill("SIGTERM");
rmSync(tmp, { recursive: true, force: true });