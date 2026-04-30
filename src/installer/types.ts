// ─────────────────────────────────────────────────────────────
// Installer types
// ─────────────────────────────────────────────────────────────

export type HostId = "claude-code" | "cursor" | "windsurf";

export interface HostInfo {
  id: HostId;
  displayName: string;
  /** Absolute path to the host's MCP config file. */
  configPath: string;
  /** Marketing-friendly link shown in installer output. */
  docsUrl: string;
}

export interface DetectedHost extends HostInfo {
  /** True if either the config file or its parent dir already exists. */
  detected: boolean;
}

/**
 * The MCP-server entry we'll merge into a host's config. Stdio-only for
 * v0.11; remote (HTTP/SSE) transports are out of scope for this server.
 */
export interface ServerEntry {
  type: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface InstallTarget {
  /** Key written under the host's `mcpServers` map. Default: "consensus". */
  serverName: string;
  entry: ServerEntry;
}

export interface InstallResult {
  host: HostInfo;
  /** True when registration succeeded (or was already in place). */
  ok: boolean;
  /**
   * Human-readable single-line summary. Always set; for failures, expands
   * the underlying error.
   */
  message: string;
  /** True when the entry already existed and we did not modify the file. */
  alreadyPresent: boolean;
  /** Set when `ok=false`. */
  error?: string;
}

export interface InstallerHost extends HostInfo {
  detect(args: { fakeHome?: string }): Promise<boolean>;
  install(args: {
    target: InstallTarget;
    force: boolean;
    fakeHome?: string;
  }): Promise<InstallResult>;
}
