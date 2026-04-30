import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeMcpServerEntry, readHostConfigForTest } from "../host-utils.js";
import type { HostInfo, ServerEntry } from "../types.js";

function makeFixtureDir(): string {
  return mkdtempSync(join(tmpdir(), "ai-consensus-mcp-host-utils-"));
}

function makeHost(configPath: string): HostInfo {
  return {
    id: "claude-code",
    displayName: "Test Host",
    configPath,
    docsUrl: "https://example.invalid",
  };
}

const ENTRY: ServerEntry = {
  type: "stdio",
  command: "npx",
  args: ["-y", "ai-consensus-mcp", "serve", "--config", "/abs/path"],
  env: { GROK_API_KEY: "xai-..." },
};

describe("mergeMcpServerEntry — fresh writes", () => {
  it("writes a new mcpServers map when the config doesn't exist", async () => {
    const dir = makeFixtureDir();
    try {
      const path = join(dir, "config.json");
      const result = await mergeMcpServerEntry({
        host: makeHost(path),
        target: { serverName: "consensus", entry: ENTRY },
        force: false,
      });
      expect(result.ok).toBe(true);
      expect(result.alreadyPresent).toBe(false);
      const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(written.mcpServers).toEqual({ consensus: ENTRY });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates parent directories as needed", async () => {
    const dir = makeFixtureDir();
    try {
      const path = join(dir, "nested", "deeper", "config.json");
      const result = await mergeMcpServerEntry({
        host: makeHost(path),
        target: { serverName: "consensus", entry: ENTRY },
        force: false,
      });
      expect(result.ok).toBe(true);
      const back = await readHostConfigForTest(path);
      expect(back.mcpServers).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mergeMcpServerEntry — preserves siblings", () => {
  it("does not clobber other top-level fields (Claude Code's .claude.json holds more)", async () => {
    const dir = makeFixtureDir();
    try {
      const path = join(dir, "config.json");
      writeFileSync(
        path,
        JSON.stringify({
          editor: { theme: "dark" },
          telemetry: { enabled: false },
          mcpServers: {
            "other-server": { type: "stdio", command: "other", args: [] },
          },
        }),
      );
      await mergeMcpServerEntry({
        host: makeHost(path),
        target: { serverName: "consensus", entry: ENTRY },
        force: false,
      });
      const back = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      // Sibling top-level fields preserved
      expect(back.editor).toEqual({ theme: "dark" });
      expect(back.telemetry).toEqual({ enabled: false });
      // Both servers in mcpServers
      const servers = back.mcpServers as Record<string, unknown>;
      expect(servers["other-server"]).toEqual({ type: "stdio", command: "other", args: [] });
      expect(servers.consensus).toEqual(ENTRY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mergeMcpServerEntry — idempotency", () => {
  it("reports alreadyPresent and skips the write when the entry is structurally identical", async () => {
    const dir = makeFixtureDir();
    try {
      const path = join(dir, "config.json");
      // First install
      await mergeMcpServerEntry({
        host: makeHost(path),
        target: { serverName: "consensus", entry: ENTRY },
        force: false,
      });
      const firstMtime = readFileSync(path, "utf8");

      // Second install — same entry
      const result = await mergeMcpServerEntry({
        host: makeHost(path),
        target: { serverName: "consensus", entry: ENTRY },
        force: false,
      });
      expect(result.ok).toBe(true);
      expect(result.alreadyPresent).toBe(true);
      // File contents unchanged
      expect(readFileSync(path, "utf8")).toBe(firstMtime);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mergeMcpServerEntry — conflict handling", () => {
  it("refuses to overwrite a different entry without --force", async () => {
    const dir = makeFixtureDir();
    try {
      const path = join(dir, "config.json");
      writeFileSync(
        path,
        JSON.stringify({
          mcpServers: {
            consensus: { type: "stdio", command: "OTHER_BINARY", args: [] },
          },
        }),
      );
      const result = await mergeMcpServerEntry({
        host: makeHost(path),
        target: { serverName: "consensus", entry: ENTRY },
        force: false,
      });
      expect(result.ok).toBe(false);
      expect(result.alreadyPresent).toBe(true);
      expect(result.message).toMatch(/--force/);
      // File untouched
      const back = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const servers = back.mcpServers as Record<string, { command: string }>;
      expect(servers.consensus!.command).toBe("OTHER_BINARY");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("overwrites when --force is set", async () => {
    const dir = makeFixtureDir();
    try {
      const path = join(dir, "config.json");
      writeFileSync(
        path,
        JSON.stringify({
          mcpServers: {
            consensus: { type: "stdio", command: "OLD_BINARY", args: [] },
          },
        }),
      );
      const result = await mergeMcpServerEntry({
        host: makeHost(path),
        target: { serverName: "consensus", entry: ENTRY },
        force: true,
      });
      expect(result.ok).toBe(true);
      const back = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const servers = back.mcpServers as Record<string, ServerEntry>;
      expect(servers.consensus).toEqual(ENTRY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mergeMcpServerEntry — defensive parsing", () => {
  it("rejects a config whose root is not a JSON object", async () => {
    const dir = makeFixtureDir();
    try {
      const path = join(dir, "config.json");
      writeFileSync(path, JSON.stringify(["not", "an", "object"]));
      const result = await mergeMcpServerEntry({
        host: makeHost(path),
        target: { serverName: "consensus", entry: ENTRY },
        force: false,
      });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/not.*JSON object|not valid JSON/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed JSON without clobbering the file", async () => {
    const dir = makeFixtureDir();
    try {
      const path = join(dir, "config.json");
      writeFileSync(path, "{ not valid json");
      const before = readFileSync(path, "utf8");
      const result = await mergeMcpServerEntry({
        host: makeHost(path),
        target: { serverName: "consensus", entry: ENTRY },
        force: false,
      });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/valid JSON/i);
      // Untouched
      expect(readFileSync(path, "utf8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats an empty file as an empty config and writes successfully", async () => {
    const dir = makeFixtureDir();
    try {
      const path = join(dir, "config.json");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, "");
      const result = await mergeMcpServerEntry({
        host: makeHost(path),
        target: { serverName: "consensus", entry: ENTRY },
        force: false,
      });
      expect(result.ok).toBe(true);
      const back = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(back.mcpServers).toEqual({ consensus: ENTRY });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
