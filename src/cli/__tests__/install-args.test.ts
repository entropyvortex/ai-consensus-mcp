import { describe, expect, it } from "vitest";
import { buildEntry, parseInstallArgs, type InstallArgs } from "../install.js";

function ok(result: InstallArgs | Error): InstallArgs {
  if (result instanceof Error) throw result;
  return result;
}

describe("parseInstallArgs — basic flags", () => {
  it("returns default values when called with no args", () => {
    const a = ok(parseInstallArgs([]));
    expect(a.help).toBe(false);
    expect(a.yes).toBe(false);
    expect(a.force).toBe(false);
    expect(a.listHosts).toBe(false);
    expect(a.serverName).toBe("consensus");
    expect(a.configPath).toBeUndefined();
    expect(a.hosts).toBeUndefined();
    expect(a.command).toBeUndefined();
  });

  it("parses --help / -h", () => {
    expect(ok(parseInstallArgs(["--help"])).help).toBe(true);
    expect(ok(parseInstallArgs(["-h"])).help).toBe(true);
  });

  it("parses --yes / -y, --force / -f, --list-hosts", () => {
    const a = ok(parseInstallArgs(["--yes", "--force", "--list-hosts"]));
    expect(a.yes).toBe(true);
    expect(a.force).toBe(true);
    expect(a.listHosts).toBe(true);

    const b = ok(parseInstallArgs(["-y", "-f"]));
    expect(b.yes).toBe(true);
    expect(b.force).toBe(true);
  });

  it("rejects unknown flags", () => {
    const r = parseInstallArgs(["--nonsense"]);
    expect(r).toBeInstanceOf(Error);
    if (r instanceof Error) expect(r.message).toMatch(/Unknown argument/);
  });
});

describe("parseInstallArgs — value flags", () => {
  it("--config <path> and --config=<path>", () => {
    expect(ok(parseInstallArgs(["--config", "/a/b.json"])).configPath).toBe("/a/b.json");
    expect(ok(parseInstallArgs(["-c", "/a/b.json"])).configPath).toBe("/a/b.json");
    expect(ok(parseInstallArgs(["--config=/a/b.json"])).configPath).toBe("/a/b.json");
  });

  it("--name and --name=<id>", () => {
    expect(ok(parseInstallArgs(["--name", "my-server"])).serverName).toBe("my-server");
    expect(ok(parseInstallArgs(["--name=alt"])).serverName).toBe("alt");
  });

  it("--command and --command=<cmd>", () => {
    expect(ok(parseInstallArgs(["--command", "ai-consensus-mcp"])).command).toBe(
      "ai-consensus-mcp",
    );
    expect(ok(parseInstallArgs(["--command=local-bin"])).command).toBe("local-bin");
  });

  it("--config without value is an error", () => {
    const r = parseInstallArgs(["--config"]);
    expect(r).toBeInstanceOf(Error);
    if (r instanceof Error) expect(r.message).toMatch(/Missing value/);
  });
});

describe("parseInstallArgs — --hosts list", () => {
  it("parses comma-separated host ids", () => {
    expect(ok(parseInstallArgs(["--hosts", "claude-code,cursor"])).hosts).toEqual([
      "claude-code",
      "cursor",
    ]);
    expect(ok(parseInstallArgs(["--hosts=windsurf"])).hosts).toEqual(["windsurf"]);
  });

  it("trims whitespace and skips empties", () => {
    expect(ok(parseInstallArgs(["--hosts", " cursor , claude-code "])).hosts).toEqual([
      "cursor",
      "claude-code",
    ]);
  });

  it("rejects unknown host ids", () => {
    const r = parseInstallArgs(["--hosts", "vscode"]);
    expect(r).toBeInstanceOf(Error);
    if (r instanceof Error) expect(r.message).toMatch(/Unknown host id "vscode"/);
  });

  it("rejects empty list", () => {
    const r = parseInstallArgs(["--hosts", ","]);
    expect(r).toBeInstanceOf(Error);
    if (r instanceof Error) expect(r.message).toMatch(/no valid host ids/);
  });
});

describe("buildEntry", () => {
  it("defaults to npx invocation when --command is not given", () => {
    const e = buildEntry({ command: undefined, configAbs: "/abs/cfg.json" });
    expect(e.type).toBe("stdio");
    expect(e.command).toBe("npx");
    expect(e.args).toEqual(["-y", "ai-consensus-mcp", "serve", "--config", "/abs/cfg.json"]);
  });

  it("uses the override command + serve args when --command is set", () => {
    const e = buildEntry({ command: "ai-consensus-mcp", configAbs: "/abs/cfg.json" });
    expect(e.command).toBe("ai-consensus-mcp");
    expect(e.args).toEqual(["serve", "--config", "/abs/cfg.json"]);
  });
});
