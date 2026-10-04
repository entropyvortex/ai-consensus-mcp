# Deploy ai-consensus-mcp on Cloudflare Workers

Stateless Streamable HTTP MCP endpoint suitable for [Grok custom connectors](https://grok.com/connectors).

## Quick start

From the **consensus-mcp repo root** (not this subdirectory):

```bash
npm install
npx -y wrangler@4 secret put CONSENSUS_CONFIG_JSON   # paste full JSON
npx -y wrangler@4 secret put CONSENSUS_HTTP_API_KEY  # openssl rand -base64 32
npx -y wrangler@4 secret put GROK_API_KEY
npx -y wrangler@4 secret put ANTHROPIC_API_KEY      # if your config uses Anthropic
npm run deploy:cloudflare
```

Wrangler reads **`wrangler.toml` at the repo root** (`main = "examples/cloudflare/worker.ts"`). There is intentionally no second config in this folder. Wrangler is not a project dependency — `npm run deploy:cloudflare` / `preview:cloudflare` fetch `wrangler@4` via `npx`. The worker imports the TypeScript sources directly, so no `npm run build` is needed.

## Optional vars

Set with `npx -y wrangler@4 secret put <NAME>` or as `[vars]` in `wrangler.toml`:

| Var                                        | Default                    | Effect                                                                                                        |
| ------------------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `MCP_PATH`                                 | `/mcp`                     | Endpoint path.                                                                                                |
| `CONSENSUS_HTTP_ALLOWED_HOSTS`             | unset (no Host check)      | Comma-separated `Host` allow-list, e.g. `mcp.example.com,ai-consensus-mcp.acct.workers.dev`.                  |
| `CONSENSUS_HTTP_ALLOWED_ORIGINS`           | unset (any `Origin` → 403) | Comma-separated browser origins to accept. Server-side clients (Grok) send no `Origin` and need nothing here. |
| `CONSENSUS_HTTP_MAX_CONCURRENT_TOOL_CALLS` | `4`                        | In-flight tool calls per isolate; extra calls get HTTP 429.                                                   |
| `CONSENSUS_HTTP_MAX_PROMPT_CHARS`          | `100000`                   | Longest `prompt` accepted.                                                                                    |
| `CONSENSUS_HTTP_MAX_OUTPUT_TOKENS`         | `8192`                     | Highest `maxOutputTokens` a caller may request.                                                               |

The in-flight cap is per isolate: Cloudflare may run several isolates, so the global ceiling is the cap × the number of isolates. Pair it with provider-side spend alerts.

## Cloudflare Workers Git CI

In **Workers & Pages → your Worker → Settings → Build**:

| Setting        | Value                                                            |
| -------------- | ---------------------------------------------------------------- |
| Git branch     | `main` (after merge) or `feat/streamable-http-remote` until then |
| Root directory | `/` (repo root — **not** `examples/cloudflare`)                  |
| Build command  | `npm install`                                                    |
| Deploy command | `npm run deploy:cloudflare`                                      |

`deploy:cloudflare` runs a preflight that prints the commit SHA and `wrangler.toml`, and **fails the build** if `[limits] cpu_ms` is present (paid-plan only). If you still see Cloudflare API error `100328` after a green preflight, delete the Worker in the dashboard and reconnect Git — stale dashboard metadata can retain limits from an earlier failed deploy.

## Limits

- **CPU time**: consensus runs multiple sequential model calls. Free-tier Workers may time out on heavy panels. On a **paid** plan you can add `[limits] cpu_ms = 300_000` to the repo-root `wrangler.toml`; otherwise use a Node host for production load.
- **Memory layer**: not available on Workers (no local disk). Omit `"memory"` from config.
- **Secrets**: provider keys live in Worker secrets — never embed them in `wrangler.toml` or the config JSON body committed to git.

## Health check

`GET /health` and `GET /mcp/health` return `{"status":"ok"}` for deploy probes (no auth, no configuration details).

## Error logs

Startup problems (missing `CONSENSUS_HTTP_API_KEY`, invalid `CONSENSUS_CONFIG_JSON`, malformed limit vars) return a generic 500 to callers and log `ai-consensus-mcp worker error: <message>` — view with `npx -y wrangler@4 tail`.
