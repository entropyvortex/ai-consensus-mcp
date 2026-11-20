// ─────────────────────────────────────────────────────────────
// Keyless panel: detect signed-in-capable CLIs on PATH
// ─────────────────────────────────────────────────────────────
// The config wizard offers a panel built only from the claude, grok and
// codex CLIs found on PATH, so a user with subscriptions needs no API
// keys. Detection only looks for executables; sign-in is checked by each
// driver's readiness probe when the server starts.

import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { RawConfig } from "../config.js";
import { CODEX_DEFAULT_MODEL } from "../cli-backend/drivers/codex.js";

export const KEYLESS_DRIVERS = ["claude", "grok", "codex"] as const;
export type KeylessDriver = (typeof KEYLESS_DRIVERS)[number];

/**
 * Default model per driver: claude's stable "opus" alias; grok and codex
 * get "default", which omits `-m` so the CLI picks its own current model.
 */
export const KEYLESS_DEFAULT_MODEL: Record<KeylessDriver, string> = {
  claude: "opus",
  grok: "default",
  codex: CODEX_DEFAULT_MODEL,
};

export interface DetectedCli {
  driver: KeylessDriver;
  /** Absolute path of the executable found on PATH. */
  path: string;
}

/** CLIs on PATH, in KEYLESS_DRIVERS order. Never runs them. */
export async function detectInstalledClis(
  env: NodeJS.ProcessEnv = process.env,
  accessImpl: (path: string, mode: number) => Promise<void> = access,
): Promise<DetectedCli[]> {
  const dirs = (env["PATH"] ?? "").split(delimiter).filter((d) => d.length > 0);
  const found: DetectedCli[] = [];
  for (const driver of KEYLESS_DRIVERS) {
    for (const dir of dirs) {
      const candidate = join(dir, driver);
      const ok = await accessImpl(candidate, constants.X_OK).then(
        () => true,
        () => false,
      );
      if (ok) {
        found.push({ driver, path: candidate });
        break;
      }
    }
  }
  return found;
}

const PERSONAS = ["domain-expert", "pessimist", "first-principles"] as const;

/**
 * Starter config using only the given CLI drivers. Three seats spread over
 * the drivers (two seats on one driver when it is the only one), and the
 * judge on the first driver.
 */
export function keylessStarterConfig(drivers: readonly KeylessDriver[]): RawConfig {
  if (drivers.length === 0) throw new Error("keylessStarterConfig needs at least one CLI");
  const providers: RawConfig["providers"] = {};
  for (const d of drivers) providers[`${d}-cli`] = { transport: "cli", driver: d };
  const seats = Math.max(3, drivers.length);
  const participants = Array.from({ length: seats }, (_, i) => {
    const d = drivers[i % drivers.length]!;
    return {
      id: `${d}-${i + 1}`,
      provider: `${d}-cli`,
      modelId: KEYLESS_DEFAULT_MODEL[d],
      personaId: PERSONAS[i % PERSONAS.length]!,
    };
  });
  const judgeDriver = drivers[0]!;
  return {
    providers,
    participants,
    judge: { provider: `${judgeDriver}-cli`, modelId: KEYLESS_DEFAULT_MODEL[judgeDriver] },
    defaults: { maxRounds: 2, cliMaxInFlight: 2 },
  };
}
