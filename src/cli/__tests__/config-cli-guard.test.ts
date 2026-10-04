import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runConfig } from "../config.js";
import * as configApi from "../../config.js";

vi.mock("@inquirer/prompts", () => {
  const opened = () => {
    throw new Error("HTTP form opened");
  };
  return {
    checkbox: opened,
    confirm: opened,
    input: opened,
    number: opened,
    select: opened,
    Separator: class Separator {},
  };
});

describe("config wizard CLI guard", () => {
  let dir: string;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("exits 2 and does not call writeRawConfig when the file contains a CLI provider", async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-consensus-mcp-wizard-"));
    const path = join(dir, "consensus.config.json");
    const raw = {
      providers: {
        "grok-sub": { transport: "cli", driver: "grok" },
      },
      participants: [
        { id: "a", provider: "grok-sub", modelId: "grok-4", personaId: "pessimist" },
        { id: "b", provider: "grok-sub", modelId: "grok-4", personaId: "domain-expert" },
      ],
    };
    await writeFile(path, JSON.stringify(raw));
    const before = await readFile(path, "utf8");
    const writeSpy = vi.spyOn(configApi, "writeRawConfig");

    const code = await runConfig(["--config", path]);

    expect(code).toBe(2);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe(before);
  });
});
