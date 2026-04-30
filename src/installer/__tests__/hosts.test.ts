import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ALL_HOSTS,
  CLAUDE_CODE_HOST,
  CURSOR_HOST,
  WINDSURF_HOST,
  findHost,
} from "../hosts/index.js";
import { detectHosts } from "../detect.js";
import type { ServerEntry } from "../types.js";

const ENTRY: ServerEntry = {
  type: "stdio",
  command: "npx",
  args: ["-y", "ai-consensus-mcp", "serve", "--config", "/abs/x.json"],
};

function makeFakeHome(): string {
  return mkdtempSync(join(tmpdir(), "ai-consensus-mcp-fakehome-"));
}

describe("ALL_HOSTS — registry", () => {
  it("exposes the three v0.11 hosts", () => {
    expect(ALL_HOSTS).toHaveLength(3);
    const ids = ALL_HOSTS.map((h) => h.id).sort();
    expect(ids).toEqual(["claude-code", "cursor", "windsurf"]);
  });

  it("findHost looks up by id", () => {
    expect(findHost("cursor")?.displayName).toBe("Cursor");
    expect(findHost("nope")).toBeUndefined();
  });

  it("each host has a doc URL set", () => {
    for (const h of ALL_HOSTS) {
      expect(h.docsUrl).toMatch(/^https:\/\//);
    }
  });
});

describe("detect — fake home with no host configs", () => {
  it("reports detected=false for every host when nothing exists", async () => {
    const home = makeFakeHome();
    try {
      const detected = await detectHosts({ fakeHome: home });
      expect(detected).toHaveLength(3);
      for (const h of detected) {
        expect(h.detected, `${h.id} should not be detected`).toBe(false);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("detect — fake home with a host config present", () => {
  it("flags Claude Code as detected when ~/.claude.json exists", async () => {
    const home = makeFakeHome();
    try {
      writeFileSync(join(home, ".claude.json"), "{}");
      const detected = await detectHosts({ fakeHome: home });
      expect(detected.find((h) => h.id === "claude-code")?.detected).toBe(true);
      // The other hosts still not detected
      expect(detected.find((h) => h.id === "cursor")?.detected).toBe(false);
      expect(detected.find((h) => h.id === "windsurf")?.detected).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("flags Cursor as detected when only the parent dir exists", async () => {
    const home = makeFakeHome();
    try {
      mkdirSync(join(home, ".cursor"), { recursive: true });
      // No mcp.json yet
      const detected = await detectHosts({ fakeHome: home });
      expect(detected.find((h) => h.id === "cursor")?.detected).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("flags Windsurf as detected when ~/.codeium/windsurf/ exists", async () => {
    const home = makeFakeHome();
    try {
      mkdirSync(join(home, ".codeium", "windsurf"), { recursive: true });
      const detected = await detectHosts({ fakeHome: home });
      expect(detected.find((h) => h.id === "windsurf")?.detected).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("flags Claude Code as detected when only ~/.claude/ dir exists", async () => {
    const home = makeFakeHome();
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      const detected = await detectHosts({ fakeHome: home });
      expect(detected.find((h) => h.id === "claude-code")?.detected).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("install — per-host registration via fake home", () => {
  it("Claude Code: writes ~/.claude.json with mcpServers entry", async () => {
    const home = makeFakeHome();
    try {
      const result = await CLAUDE_CODE_HOST.install({
        target: { serverName: "consensus", entry: ENTRY },
        force: false,
        fakeHome: home,
      });
      expect(result.ok).toBe(true);
      const path = join(home, ".claude.json");
      expect(existsSync(path)).toBe(true);
      const json = JSON.parse(readFileSync(path, "utf8")) as {
        mcpServers?: Record<string, unknown>;
      };
      expect(json.mcpServers?.consensus).toEqual(ENTRY);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("Cursor: writes ~/.cursor/mcp.json (creates parent dir)", async () => {
    const home = makeFakeHome();
    try {
      const result = await CURSOR_HOST.install({
        target: { serverName: "consensus", entry: ENTRY },
        force: false,
        fakeHome: home,
      });
      expect(result.ok).toBe(true);
      const path = join(home, ".cursor", "mcp.json");
      expect(existsSync(path)).toBe(true);
      const json = JSON.parse(readFileSync(path, "utf8")) as {
        mcpServers?: Record<string, unknown>;
      };
      expect(json.mcpServers?.consensus).toEqual(ENTRY);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("Windsurf: writes ~/.codeium/windsurf/mcp_config.json (creates nested parents)", async () => {
    const home = makeFakeHome();
    try {
      const result = await WINDSURF_HOST.install({
        target: { serverName: "consensus", entry: ENTRY },
        force: false,
        fakeHome: home,
      });
      expect(result.ok).toBe(true);
      const path = join(home, ".codeium", "windsurf", "mcp_config.json");
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("install is idempotent: second run reports alreadyPresent and doesn't rewrite", async () => {
    const home = makeFakeHome();
    try {
      await CLAUDE_CODE_HOST.install({
        target: { serverName: "consensus", entry: ENTRY },
        force: false,
        fakeHome: home,
      });
      const path = join(home, ".claude.json");
      const firstContent = readFileSync(path, "utf8");

      const second = await CLAUDE_CODE_HOST.install({
        target: { serverName: "consensus", entry: ENTRY },
        force: false,
        fakeHome: home,
      });
      expect(second.ok).toBe(true);
      expect(second.alreadyPresent).toBe(true);
      expect(readFileSync(path, "utf8")).toBe(firstContent);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("install preserves an existing pre-populated .claude.json", async () => {
    const home = makeFakeHome();
    try {
      const path = join(home, ".claude.json");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({
          editor: { theme: "dark" },
          mcpServers: { other: { type: "stdio", command: "other", args: [] } },
        }),
      );
      const result = await CLAUDE_CODE_HOST.install({
        target: { serverName: "consensus", entry: ENTRY },
        force: false,
        fakeHome: home,
      });
      expect(result.ok).toBe(true);
      const json = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(json.editor).toEqual({ theme: "dark" });
      const servers = json.mcpServers as Record<string, unknown>;
      expect(servers.other).toBeDefined();
      expect(servers.consensus).toEqual(ENTRY);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
