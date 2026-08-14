---
name: favro-cli
description: How to use the favro-cli tool to manage Favro project management boards, cards, collections, members, and more via the command line. Use this skill whenever the user asks about Favro cards, boards, sprints, backlogs, standup views, batch card updates from a CSV, card linking, project planning, or any task involving the Favro workspace. Also use this skill when you need to look up, create, update, move, or query cards on Favro boards — even if the user doesn't explicitly mention "favro" but is clearly talking about their project management workflow. This is the authoritative guide for safe CLI usage with write-safety guardrails.
---

# Favro CLI

`--help` is the single source of truth. Anything written here instead would be a
second copy, and MCP `favro_help` shells out to `--help` — so it would never
reach the primary consumer anyway.

Before your first write, run:

```bash
favro help issue-tracker
```

That topic carries the whole contract: the mandatory scope lock, every intent
and its CLI spelling, the two relationships (and the unordered one that does
not exist), the retry contract, and — up front — what a failed multi-step
write may leave behind.

Then: `favro --help`, `favro <command> --help`, `favro skill list`.
