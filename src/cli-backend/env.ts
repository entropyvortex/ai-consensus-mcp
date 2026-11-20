// Child environment for subscription CLI seats.
// An allowlist, not a copy-then-delete. A denylist misses GROK_SANDBOX,
// cloud credentials, GitHub tokens, and LD_PRELOAD.

const EXACT_ALLOWLIST: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "TMPDIR",
  "TMP",
  "TEMP",
  "GROK_HOME",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  // Proxy settings. Without them a CLI behind a corporate proxy cannot
  // reach its backend. Both spellings are in common use.
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
]);

const LOCALE_KEY = /^LC_[A-Z0-9_]+$/;

/**
 * Recursion guard. Every CLI child gets this set to the server's depth + 1;
 * a server that starts with it ≥ 1 refuses to serve (see cli/serve.ts), so
 * a juror CLI that loads MCP servers cannot call this server again.
 */
export const DEPTH_ENV = "AI_CONSENSUS_MCP_DEPTH";

/** This process's nesting depth (0 when unset or malformed). */
export function currentDepth(env: NodeJS.ProcessEnv): number {
  const raw = env[DEPTH_ENV];
  const n = raw === undefined ? 0 : Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function isAllowedChildEnvKey(key: string): boolean {
  return EXACT_ALLOWLIST.has(key) || LOCALE_KEY.test(key);
}

/**
 * Subset of `parent` whose keys are on the allowlist, plus an explicit
 * `GROK_DISABLE_AUTOUPDATER=1` for grok children and the recursion guard
 * `AI_CONSENSUS_MCP_DEPTH`. Never copies API keys and never sets
 * `GROK_SANDBOX`.
 */
export function buildChildEnv(
  parent: NodeJS.ProcessEnv,
  options?: { disableGrokAutoupdater?: boolean },
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (!isAllowedChildEnvKey(key)) continue;
    child[key] = value;
  }
  if (options?.disableGrokAutoupdater) {
    child["GROK_DISABLE_AUTOUPDATER"] = "1";
  }
  child[DEPTH_ENV] = String(currentDepth(parent) + 1);
  return child;
}
