// Shared parsing for boolean env switches such as CONSENSUS_DISABLE_CLI.
// The caller and the startup probe must agree on what "set" means.

const TRUTHY_FLAGS = new Set(["1", "true", "yes", "on"]);

export function isTruthyFlag(value: string | undefined): boolean {
  return value !== undefined && TRUTHY_FLAGS.has(value.trim().toLowerCase());
}
