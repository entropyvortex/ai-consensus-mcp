// ─────────────────────────────────────────────────────────────
// Host / Origin helpers — DNS-rebinding defence + bind-address policy
// ─────────────────────────────────────────────────────────────
// Pure string logic (no Node built-ins) so the Web Standard handler can use
// it on any runtime.

/** Loopback addresses the HTTP server may bind without an endpoint key. */
export function isLoopbackHost(host: string): boolean {
  const h = stripBrackets(host.trim().toLowerCase());
  if (h === "localhost") return true;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  const v4 = h.startsWith("::ffff:") ? h.slice("::ffff:".length) : h;
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  if (!octets) return false;
  const nums = octets.slice(1).map(Number);
  return nums[0] === 127 && nums.every((n) => n <= 255);
}

/** Hostnames a loopback-bound server accepts in the Host header by default. */
export const LOOPBACK_HOSTNAMES: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

interface Authority {
  hostname: string;
  port: string | undefined;
}

/** Parse `host[:port]` / `[v6][:port]` / bare IPv6. Undefined if malformed. */
function parseAuthority(value: string): Authority | undefined {
  const v = value.trim().toLowerCase();
  if (v.length === 0) return undefined;
  // Bare IPv6 (more than one colon, no brackets) has no port component.
  if (!v.startsWith("[") && v.indexOf(":") !== v.lastIndexOf(":")) {
    return { hostname: `[${v}]`, port: undefined };
  }
  try {
    const url = new URL(`http://${v}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      return undefined;
    }
    const explicitPort = /:(\d+)$/.exec(v)?.[1];
    return { hostname: url.hostname, port: explicitPort };
  } catch {
    return undefined;
  }
}

/**
 * True when the Host header names an allow-listed host. Entries without a
 * port match any port (DNS rebinding controls the hostname, not the port);
 * entries with a port must match it exactly.
 */
export function isHostAllowed(hostHeader: string | null, allowed: readonly string[]): boolean {
  if (!hostHeader) return false;
  const actual = parseAuthority(hostHeader);
  if (!actual) return false;
  return allowed.some((entry) => {
    const want = parseAuthority(entry);
    if (want?.hostname !== actual.hostname) return false;
    return want.port === undefined || want.port === actual.port;
  });
}

/** Canonical `scheme://host[:port]` for comparison, or undefined if opaque. */
export function normalizeOrigin(origin: string): string | undefined {
  try {
    const parsed = new URL(origin.trim()).origin;
    return parsed === "null" ? undefined : parsed;
  } catch {
    return undefined;
  }
}

/** True when the Origin header is allow-listed. `"null"`/opaque never is. */
export function isOriginAllowed(originHeader: string, allowed: readonly string[]): boolean {
  const actual = normalizeOrigin(originHeader);
  if (!actual) return false;
  return allowed.some((entry) => normalizeOrigin(entry) === actual);
}

/** Split a comma-separated list (CLI flag / env var), dropping empties. */
export function parseList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function stripBrackets(h: string): string {
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}
