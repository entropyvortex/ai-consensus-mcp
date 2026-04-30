#!/usr/bin/env node
// Smoke test: spawn the built binary, perform an MCP handshake over stdio,
// and assert it advertises the `consensus` tool. Runs in CI without API keys —
// the fake provider config never gets used because we don't call `consensus`.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const binPath = join(repoRoot, "dist", "index.js");

if (!existsSync(binPath)) {
  console.error(`smoke FAILED: ${binPath} not found. Run \`npm run build\` first.`);
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "ai-consensus-mcp-smoke-"));
const configPath = join(tmp, "config.json");

writeFileSync(
  configPath,
  JSON.stringify(
    {
      providers: {
        fake: { baseUrl: "https://example.invalid/v1", apiKeyEnv: "SMOKE_FAKE_KEY" },
      },
      participants: [
        { id: "a", provider: "fake", modelId: "model-a", personaId: "pessimist" },
        { id: "b", provider: "fake", modelId: "model-b", personaId: "domain-expert" },
      ],
    },
    null,
    2,
  ),
);

const transport = new StdioClientTransport({
  command: "node",
  args: [binPath, "--config", configPath],
  env: { ...process.env, SMOKE_FAKE_KEY: "fake" },
  stderr: "pipe",
});

const client = new Client({ name: "smoke-test", version: "0.0.0" }, { capabilities: {} });

const cleanup = () => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
};

const timeoutId = setTimeout(() => {
  console.error("smoke FAILED: handshake timed out after 10s");
  cleanup();
  process.exit(1);
}, 10_000);

try {
  await client.connect(transport);

  const info = client.getServerVersion();
  if (info?.name !== "ai-consensus-mcp") {
    throw new Error(`unexpected server name: ${JSON.stringify(info)}`);
  }

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  if (!names.includes("consensus")) {
    throw new Error(`expected 'consensus' tool, got [${names.join(", ")}]`);
  }

  console.log(`smoke ok — server=${info.name}@${info.version}, tools=[${names.join(", ")}]`);

  await client.close();
  clearTimeout(timeoutId);
  cleanup();
  process.exit(0);
} catch (err) {
  clearTimeout(timeoutId);
  console.error("smoke FAILED:", err instanceof Error ? err.message : String(err));
  try {
    await client.close();
  } catch {
    /* ignore */
  }
  cleanup();
  process.exit(1);
}
