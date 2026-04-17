import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";

let dir: string;

async function writeConfig(
  obj: unknown,
  name = "consensus.config.json",
): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(obj));
  return path;
}

type ValidConfig = {
  providers: Record<string, { baseUrl: string; apiKeyEnv: string }>;
  participants: Array<{
    id: string;
    provider: string;
    modelId: string;
    personaId: string;
  }>;
  judge?: { provider: string; modelId: string };
  defaults?: Record<string, unknown>;
};

const VALID_CONFIG: ValidConfig = {
  providers: {
    anthropic: {
      baseUrl: "https://api.anthropic.com/v1/",
      apiKeyEnv: "TEST_ANTHROPIC_KEY",
    },
    openai: {
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "TEST_OPENAI_KEY",
    },
  },
  participants: [
    {
      id: "risk",
      provider: "anthropic",
      modelId: "claude-opus-4-5",
      personaId: "pessimist",
    },
    {
      id: "engineer",
      provider: "openai",
      modelId: "gpt-4o",
      personaId: "first-principles",
    },
  ],
  judge: { provider: "anthropic", modelId: "claude-opus-4-5" },
};

describe("loadConfig", () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-consensus-mcp-test-"));
    vi.stubEnv("TEST_ANTHROPIC_KEY", "test-anthropic");
    vi.stubEnv("TEST_OPENAI_KEY", "test-openai");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it("loads a valid config with resolved providers and participants", async () => {
    const path = await writeConfig(VALID_CONFIG);
    const cfg = await loadConfig(path);

    expect(cfg.providers.anthropic?.apiKey).toBe("test-anthropic");
    expect(cfg.providers.openai?.apiKey).toBe("test-openai");
    expect(cfg.participants).toHaveLength(2);
    expect(cfg.participants[0]?.persona.id).toBe("pessimist");
    expect(cfg.providerByParticipant).toMatchObject({
      risk: "anthropic",
      engineer: "openai",
      judge: "anthropic",
    });
    expect(cfg.judge?.modelId).toBe("claude-opus-4-5");
    expect(cfg.defaults.useJudge).toBe(true);
    expect(cfg.sourcePath).toBe(path);
  });

  it("strips trailing slashes from provider baseUrl", async () => {
    const path = await writeConfig(VALID_CONFIG);
    const cfg = await loadConfig(path);
    expect(cfg.providers.anthropic?.baseUrl).toBe("https://api.anthropic.com/v1");
    expect(cfg.providers.openai?.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("defaults useJudge to false when no judge is declared", async () => {
    const { judge: _, ...noJudge } = VALID_CONFIG;
    const path = await writeConfig(noJudge);
    const cfg = await loadConfig(path);
    expect(cfg.judge).toBeUndefined();
    expect(cfg.defaults.useJudge).toBe(false);
    expect(cfg.providerByParticipant).not.toHaveProperty("judge");
  });

  it("preserves useJudge=false even when judge is declared (explicit opt-out)", async () => {
    const cfg = {
      ...VALID_CONFIG,
      defaults: { useJudge: false },
    };
    const path = await writeConfig(cfg);
    const loaded = await loadConfig(path);
    expect(loaded.defaults.useJudge).toBe(false);
    expect(loaded.judge).toBeDefined(); // still present, just not used by default
  });

  it("rejects a missing config file with a clear error", async () => {
    const path = join(dir, "does-not-exist.json");
    await expect(loadConfig(path)).rejects.toThrow(/could not read/);
  });

  it("rejects malformed JSON", async () => {
    const path = join(dir, "bad.json");
    await writeFile(path, "{ not json");
    await expect(loadConfig(path)).rejects.toThrow(/not valid JSON/);
  });

  it("rejects a missing env var for a declared provider", async () => {
    vi.unstubAllEnvs();
    const path = await writeConfig(VALID_CONFIG);
    // Should name the missing env var so operators can diagnose.
    await expect(loadConfig(path)).rejects.toThrow(/TEST_ANTHROPIC_KEY/);
  });

  it("rejects an unknown persona id", async () => {
    const bad = structuredClone(VALID_CONFIG);
    bad.participants[0]!.personaId = "not-a-real-persona";
    const path = await writeConfig(bad);
    await expect(loadConfig(path)).rejects.toThrow(/unknown persona/);
  });

  it("rejects duplicate participant ids", async () => {
    const bad = structuredClone(VALID_CONFIG);
    bad.participants[1]!.id = bad.participants[0]!.id;
    const path = await writeConfig(bad);
    await expect(loadConfig(path)).rejects.toThrow(/duplicate participant id/);
  });

  it("rejects a participant referencing an unknown provider", async () => {
    const bad = structuredClone(VALID_CONFIG);
    bad.participants[0]!.provider = "nonexistent";
    const path = await writeConfig(bad);
    await expect(loadConfig(path)).rejects.toThrow(/unknown provider/);
  });

  it("rejects a judge referencing an unknown provider", async () => {
    const bad = structuredClone(VALID_CONFIG);
    bad.judge!.provider = "nope";
    const path = await writeConfig(bad);
    await expect(loadConfig(path)).rejects.toThrow(/unknown provider/);
  });

  it("rejects unknown top-level fields (strict schema)", async () => {
    // Unknown fields are usually typos. Failing loudly here beats silently
    // ignoring the fact that `defualts` never applied.
    const bad = { ...VALID_CONFIG, accidentalTypo: true };
    const path = await writeConfig(bad);
    await expect(loadConfig(path)).rejects.toThrow();
  });

  it("rejects configs with fewer than 2 participants", async () => {
    const bad = {
      ...VALID_CONFIG,
      participants: [VALID_CONFIG.participants[0]!],
    };
    const path = await writeConfig(bad);
    await expect(loadConfig(path)).rejects.toThrow();
  });

  it("resolves participant personas to full Persona objects", async () => {
    const path = await writeConfig(VALID_CONFIG);
    const cfg = await loadConfig(path);
    const risk = cfg.participants.find((p) => p.id === "risk");
    expect(risk?.persona.name).toBe("Risk Analyst");
    expect(risk?.persona.systemPrompt.length).toBeGreaterThan(50);
  });
});
