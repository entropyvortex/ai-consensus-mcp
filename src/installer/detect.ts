// ─────────────────────────────────────────────────────────────
// Top-level host detection
// ─────────────────────────────────────────────────────────────

import { ALL_HOSTS } from "./hosts/index.js";
import type { DetectedHost } from "./types.js";

/**
 * Probe each known host. `fakeHome` is honoured so installer tests
 * can run against a tmpfs-rooted fake `$HOME` without touching the
 * real one.
 */
export async function detectHosts(args: { fakeHome?: string } = {}): Promise<DetectedHost[]> {
  const out: DetectedHost[] = [];
  for (const host of ALL_HOSTS) {
    const detected = await host.detect({ fakeHome: args.fakeHome });
    out.push({
      id: host.id,
      displayName: host.displayName,
      configPath: host.configPath,
      docsUrl: host.docsUrl,
      detected,
    });
  }
  return out;
}
