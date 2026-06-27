# Deploy ai-consensus-mcp on Cloudflare Workers

Stateless Streamable HTTP MCP endpoint suitable for [Grok custom connectors](https://grok.com/connectors).

## Quick start

From the **consensus-mcp repo root** (not this subdirectory):

```bash
npm install
npm run build
npx wrangler secret put CONSENSUS_CONFIG_JSON   # paste full JSON
npx wrangler secret put CONSENSUS_HTTP_API_KEY  # openssl rand -base64 32
npx wrangler secret put GROK_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY      # if your config uses Anthropic
npm run deploy:cloudflare
```

Wrangler reads **`wrangler.toml` at the repo root** (`main = "examples/cloudflare/worker.ts"`). There is intentionally no second config in this folder.

## Cloudflare Workers Git CI

In **Workers & Pages → your Worker → Settings → Build**:

| Setting | Value |
| -------- | ----- |
| Git branch | `main` (after merge) or `feat/streamable-http-remote` until then |
| Root directory | `/` (repo root — **not** `examples/cloudflare`) |
| Build command | `npm run build` |
| Deploy command | `npm run deploy:cloudflare` |

`deploy:cloudflare` runs a preflight that prints the commit SHA and `wrangler.toml`, and **fails the build** if `[limits] cpu_ms` is present (paid-plan only). If you still see Cloudflare API error `100328` after a green preflight, delete the Worker in the dashboard and reconnect Git — stale dashboard metadata can retain limits from an earlier failed deploy.

## Limits

- **CPU time**: consensus runs multiple sequential model calls. Free-tier Workers may time out on heavy panels. On a **paid** plan you can add `[limits] cpu_ms = 300_000` to the repo-root `wrangler.toml`; otherwise use a Node host for production load.
- **Memory layer**: not available on Workers (no local disk). Omit `"memory"` from config.
- **Secrets**: provider keys live in Worker secrets — never embed them in `wrangler.toml` or the config JSON body committed to git.

## Health check

`GET /health` and `GET /mcp/health` return JSON status for deploy probes.