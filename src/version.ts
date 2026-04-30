// Single source of truth for the server's name + version. These flow into
// MCP server identity, CLI banners, smoke-test asserts, and the registry
// manifest. Bump `SERVER_VERSION` here when cutting a release; the
// pre-publish workflow asserts it matches the git tag.

export const SERVER_NAME = "ai-consensus-mcp";
export const SERVER_VERSION = "0.10.0";
