# Contributing

Thanks for considering a contribution. This project is solo-maintained, so
expect async review and a preference for small, focused PRs.

## Quickstart

```bash
git clone https://github.com/entropyvortex/ai-consensus-mcp.git
cd ai-consensus-mcp
npm install
npm run check    # typecheck + lint + format:check + tests with coverage
```

`npm run check` is the same gate CI runs. If it passes locally, CI will
almost certainly pass too.

Useful subset commands:

| Command                 | What it does                             |
| ----------------------- | ---------------------------------------- |
| `npm run typecheck`     | `tsc --noEmit` against `tsconfig.json`   |
| `npm run lint`          | ESLint over `src/`                       |
| `npm run format`        | Prettier write (use before committing)   |
| `npm run test`          | Vitest, single run                       |
| `npm run test:watch`    | Vitest in watch mode                     |
| `npm run test:coverage` | Vitest with coverage thresholds enforced |
| `npm run build`         | Compile to `dist/`                       |
| `npm run test:smoke`    | Stdio handshake smoke test (needs build) |

## Pull requests

- Branch off `main`. Keep PRs scoped to one concern.
- Add or update tests for any behaviour change. The coverage thresholds in
  `vitest.config.ts` ratchet upward — if you add tested code that lifts a
  metric, bump the threshold in the same PR.
- Update `CHANGELOG.md` under the `## [Unreleased]` heading. Follow the
  existing [Keep a Changelog](https://keepachangelog.com) style.
- Run `npm run check` before pushing.
- Don't bump `package.json` version in PRs; releases are cut separately.

## Reporting bugs

Open an issue with:

- What you ran (command + relevant config snippet, with secrets redacted).
- What you expected vs. what happened.
- Versions: `ai-consensus-mcp`, Node.js, and the MCP host (Claude Code,
  Cursor, …) if relevant.

For security issues, follow [`SECURITY.md`](./SECURITY.md) instead — please
don't open a public issue.

## Proposing larger changes

If you're planning something non-trivial (new preset, protocol change,
provider adapter rewrite), open an issue to discuss the shape first. Saves
both of us the rework if I'd have asked for changes anyway.

## Code style

Prettier and ESLint are the source of truth. Don't hand-format around them.
TypeScript is strict; prefer narrowing over `any`.
