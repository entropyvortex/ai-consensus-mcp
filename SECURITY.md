# Security Policy

## Supported versions

`ai-consensus-mcp` is pre-1.0. Only the latest published `0.x` minor receives
security fixes — older minors are not patched.

| Version | Supported          |
| ------- | ------------------ |
| 0.11.x  | :white_check_mark: |
| < 0.11  | :x:                |

## Reporting a vulnerability

Please **do not open a public GitHub issue** for security reports.

Use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository:
<https://github.com/entropyvortex/ai-consensus-mcp/security/advisories/new>

When reporting, please include:

- A description of the issue and the impact you believe it has.
- Steps to reproduce, ideally with a minimal config or repro repo.
- The version (`ai-consensus-mcp` and `ai-consensus-core`) and Node.js version
  you observed it on.

## What you can expect

- Acknowledgement within **5 business days**.
- A triage decision (accepted / not-a-vuln / needs-more-info) within
  **10 business days**.
- For accepted reports: a fix or mitigation plan, a coordinated disclosure
  window, and credit in the release notes (unless you ask to stay anonymous).

## Scope

In scope:

- The `ai-consensus-mcp` server, CLI, and installer in this repo.
- The published npm package `ai-consensus-mcp`.

Out of scope (report upstream):

- Vulnerabilities in [`ai-consensus-core`](https://github.com/entropyvortex/ai-consensus-core/security)
  or in third-party MCP hosts (Claude Code, Cursor, Windsurf, …).
- Vulnerabilities in upstream LLM providers reached through user-configured
  `baseUrl` endpoints.
- Issues that require an attacker to already control the user's
  `consensus.config.json`, environment variables, or local filesystem.
