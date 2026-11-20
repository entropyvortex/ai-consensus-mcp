---
name: best-of-n-verdict
description: Use when several attempts at the same coding task exist side by side (best-of-N runs, parallel agent branches or worktrees off one base commit) and the user wants to know which one to keep. Lists the sibling attempts with the ai-consensus-mcp server, has a blind panel compare them, and reports the verdict. Never merges, checks out, resets or deletes anything.
license: MIT
metadata:
  requires: ai-consensus-mcp MCP server (stdio), tools consensus_list_attempts and consensus_compare_attempts
---

# Best-of-N verdict

Pick the best of several attempts at one task, with evidence, without touching any branch.

## When to use

- The user ran the same task more than once (for example Emdash "Best of N") and asks which attempt to keep, which is best, or to compare them.
- You are one of those attempts and are asked how you compare with your siblings.

Do not use it for a single branch, or for attempts at different tasks.

## Steps

1. **Find the attempts.** Call `consensus_list_attempts` (no arguments: it reads the repository you are in). Attempts at one task usually share a base and are each ahead of it; several have their own worktree. Do not assume a branch naming scheme: confirm the set with the user if it is not obvious, and use at most 6.
2. **Restate the task** in one or two sentences, including acceptance criteria the user gave. The jurors judge every attempt against this text.
3. **Compare.** Call `consensus_compare_attempts` with `task` and `attempts: [{ "ref": "<branch>" }, …]`. Leave `base` out unless the user names one. Add `label` only for display. If you already ran checks yourself (tests, build, lint) for every attempt, pass them as `checks: [{ "name", "status": "passed" | "failed" | "unknown", "output" }]`, with the same check names for every attempt. Do not invent check results.
4. **Report** in a few lines:
   - the verdict line exactly as returned: the recommended ref, or "no clear winner" with its reason;
   - agreement (Kendall's W) and how many jurors voted;
   - the two or three most severe verified findings, with file and line;
   - anything the tool says it could not show (files over the budget, skipped files) or a partial stop (deadline, budget).
5. **Stop there.** The decision is the user's. Offer the next step (for example "merge `<ref>`?"), but do not take it.

## Rules

- Never merge, rebase, check out, reset, stash, push or delete branches or worktrees as part of this skill.
- Do not paste diffs into the conversation: the server reads them from git itself so they never pass through your context.
- Do not pass `testCommand` unless the user asks for tests to run. It executes repository code and only works when the server was started with `--allow-test-command`.
- If the verdict is "no clear winner", say so plainly. You may name the leader on points as a tie-breaker hint, not as a recommendation.
- If a tool call fails because a provider key is missing, relay the error: agent hosts can strip environment variables, and the message says how to fix it.
