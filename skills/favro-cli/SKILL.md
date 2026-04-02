---
name: favro-cli
description: How to use the favro-cli tool to manage Favro project management boards, cards, collections, members, and more via the command line. Use this skill whenever the user asks about Favro cards, boards, sprints, backlogs, standup views, batch card operations, card linking, project planning, or any task involving the Favro workspace. Also use this skill when you need to look up, create, update, move, or query cards on Favro boards — even if the user doesn't explicitly mention "favro" but is clearly talking about their project management workflow. This is the authoritative guide for safe CLI usage with write-safety guardrails.
---

# Favro CLI — Agent Operating Guide

This skill teaches you how to operate the `favro-cli` tool safely and effectively. The CLI provides full CRUD access to a production Favro workspace — treat it with care.

## ⚠️ The Prime Directive: Never Damage Production

You have write access to a real, shared production Favro workspace with real projects, real boards, and real people depending on them. The safety guardrails described below exist specifically to prevent you from:

1. Creating cards/boards in the wrong collection
2. Moving or reassigning cards outside your designated sandbox
3. Bulk-modifying cards without the user's explicit consent

**Your default behavior must be cautious.** When in doubt, use `--dry-run` first, then show the user what would happen, and only execute the real mutation after they confirm.

---

## 1. Before You Do Anything: Set Scope

The `favro scope` command restricts all write operations to a single collection. This is your safety net.

```bash
# Check what collection you're locked to
favro scope show

# Lock to a specific collection (do this FIRST in every session)
favro scope set <collectionId>

# Clear the lock (rarely needed)
favro scope clear
```

**Rule:** At the start of every session that involves writing to Favro, verify the scope with `favro scope show`. If no scope is set, ask the user which collection to work in before proceeding with any writes.

If the scope is already set, confirm with the user: "I see the scope is locked to **[collection name]**. Should I continue working in this collection?"

### How scope enforcement works

Every write command checks the target board's parent collection against the locked scope. If the board doesn't belong to the locked collection, the command exits with a clear error and **no mutation is made**. This protects every other collection in the workspace.

To explicitly bypass (only when the user directs you to), use `--force`.

---

## 2. The Safety Flag Trio

Every write-capable command supports three safety flags. Learn them:

| Flag | Short | Effect |
|------|-------|--------|
| `--dry-run` | — | Preview without executing. No API calls. |
| `--yes` | `-y` | Skip the interactive `[y/N]` confirmation prompt. |
| `--force` | — | Bypass scope check. **Use only when explicitly told to.** |

### Your standard operating procedure for writes

1. **First run:** Always use `--dry-run` to preview the change
2. **Show the user** the dry-run output
3. **Second run:** Execute with `--yes` after the user confirms (or let the prompt appear if running interactively)

**Never combine `--force` with `--yes` unless the user has explicitly instructed you to bypass scope.** This combination removes all safety nets.

---

## 3. Command Reference

The CLI is invoked via the `favro` command.

For the full command reference with all flags and options, read: [📋 Command Reference](./references/command-reference.md)

Here is a quick overview of the most commonly used commands:

### Read Operations (always safe)

```bash
# List & inspect
favro collections list [--json]
favro boards list [collectionId] [--json]
favro cards list --board <boardId> [--json] [--limit N]
favro cards get <cardId> [--json] [--include board,collection]

# Smart views
favro context <board>                    # Full board snapshot for AI workflows
                                         # Includes workflow stages + next-column for each card
favro query <board> "status:done"        # Semantic card search
favro standup --board <board>            # Daily standup view
favro sprint-plan --board <board>        # Sprint planning suggestions
favro audit <board> --since 1d           # Recent changes audit

# Repo context bootstrap
favro init                               # Create .favro/context.json from scoped collection
favro init --refresh                     # Update existing context after board changes
favro init --collection <id>             # Bootstrap from a specific collection

# Inspection
favro custom-fields list <boardId>
favro comments list <cardId>
favro comments get <commentId>           # Get a single comment by ID
favro members list --board <boardId>

# Meta & Structure
favro columns list <boardId>
favro widgets list --card <cardCommonId>
favro tags list
favro tasks list <cardId>
favro tasklists list <cardCommonId>      # List task lists (checklists) on a card
favro tasklists get <taskListId>         # Get a task list by ID
favro dependencies list <cardId>
favro users list
favro groups list
favro groups get <groupId>               # Get a single group by ID
```

### Write Operations (scope-checked, confirmation-required)

```bash
# Cards
favro cards create "Title" --board <boardId> [--dry-run] [-y]
favro cards update <cardId> --name "New Name" --board <boardId> [--dry-run] [-y]
favro cards update <cardId> --column "Developing" --board <boardId> [-y]  # Move card to column

# Card relationships
favro cards link <cardId> <toCardId> --type <type> [-y]
favro cards unlink <cardId> <fromCardId> [-y]
favro cards move <cardId> --to-board <boardId> [-y]

# Boards
favro boards create <collectionId> --name "Name" [--dry-run]
favro boards update <boardId> --name "Name" [-y]
favro boards delete <boardId> [--dry-run] [-y] [--force]

# Collections
favro collections update <collectionId> --name "Name" [-y]
favro collections delete <collectionId> [--dry-run] [-y] [--force]

# Comments
favro comments add <cardId> --text "Comment" [--dry-run]
favro comments update <commentId> --text "New text" [--dry-run] [-y]
favro comments delete <commentId> [-y]

# Custom fields
favro custom-fields set <cardId> <fieldId> "value" [--dry-run] [-y]

# Members
favro members add <email> --to <boardId> [--dry-run]
favro members remove <memberId> --from <boardId> [-y]

# Webhooks
favro webhooks create --event <event> --target <url> [--dry-run]
favro webhooks delete <webhookId> [-y]

# Advanced Structure
favro columns create <boardId> --name "Name" [--dry-run] [-y]
favro columns update <columnId> --name "New Name" [--dry-run] [-y]
favro widgets add <boardId> <cardCommonId> [--dry-run] [-y]  # Commit card to another board

# Meta & Assets
favro tags create --name "Tag" [--dry-run] [-y]
favro tags update <tagId> --name "New Name" --color <color> [--dry-run] [-y]
favro tags delete <tagId> [--dry-run] [-y]
favro tasks add <cardId> "Task Name" [--dry-run] [-y]
favro tasks update <taskId> --name "Name" --completed [--dry-run] [-y]
favro tasks delete <taskId> [--dry-run] [-y]
favro tasklists create <cardCommonId> --name "Checklist" [--dry-run] [-y]
favro tasklists update <taskListId> --name "New Name" [--dry-run] [-y]
favro tasklists delete <taskListId> [-y]
favro dependencies add <sourceId> <targetId> --type blocks [--dry-run] [-y]
favro dependencies delete <cardId> <targetId> [--dry-run] [-y]
favro dependencies delete-all <cardId> [-y]
favro attachments upload <cardId> --file ./path [--dry-run] [-y]
favro attachments upload-to-comment <commentId> --file ./path [--dry-run] [-y]

# User Groups
favro groups create --name "Group" [--members id1,id2] [--dry-run] [-y]
favro groups update <groupId> --name "New Name" [--add-members ids] [--dry-run] [-y]
favro groups delete <groupId> [-y]
```

### Bulk / AI Operations (high blast radius — extra caution)

```bash
# AI-Powered Commands (requires `favro ai setup` or env vars)
favro ai setup --provider anthropic --api-key sk-ant-...  # Configure AI provider
favro ai setup --provider openai --api-key sk-...         # Or use OpenAI
favro ai setup --provider ollama                          # Or use local Ollama

favro ask <board> "What cards are blocked?"               # Ask questions about a board
favro ask <board> "Summarize alice workload" --json       # JSON output
favro ask <board> "What changed recently?" --context-only # Dump context without LLM call

favro do <board> "move all overdue cards to Review"       # AI-planned multi-step execution
favro do <board> "assign unassigned bugs to alice" --dry-run  # Preview without executing
favro do <board> "triage new cards" --yes                 # Skip confirmation

favro explain <cardId>                                    # AI summary of a card
favro explain <cardId> --json                             # JSON output

# Skills — Reusable Workflows
favro skill list                                          # List available skills (builtin + user)
favro skill run <name> --board <boardId>                  # Execute a skill
favro skill run daily-digest --board <boardId>            # Built-in: standup + overdue + blocked
favro skill run triage --board <boardId>                  # Built-in: find & assign unowned cards
favro skill run sprint-close --board <boardId>            # Built-in: summarize & archive done
favro skill run stale-cleanup --board <boardId>           # Built-in: flag stale cards
favro skill run release-prep --board <boardId>            # Built-in: changelog + readiness check
favro skill create <name>                                 # Create a new skill from template
favro skill edit <name>                                   # Open skill in $EDITOR
favro skill export <name>                                 # Output skill YAML to stdout
favro skill import <path>                                 # Import from YAML file
favro skill delete <name>                                 # Delete a user skill
favro skill record <name>                                 # Start recording commands as a skill
favro skill stop                                          # Stop recording and save

# Git ↔ Cards Bridge
favro git link --board <boardId>                          # Connect repo to a Favro board (creates .favro.json)
favro git link --board <boardId> --prefix CARD            # With card prefix pattern
favro git branch <cardId>                                 # Create feature branch, move card to In Progress
favro git branch <cardId> --no-move                       # Create branch without moving card
favro git commit -m "fix bug"                             # Smart commit with auto card ref from branch
favro git commit -m "fix bug" --comment                   # Also post commit as Favro comment
favro git commit -m "fix bug" --card <cardId>             # Explicit card override
favro git sync                                            # Sync branch status to cards (merged→Done)
favro git sync --dry-run                                  # Preview sync without changes
favro git todos                                           # Scan codebase for TODO/FIXME/HACK/XXX
favro git todos --create --board <boardId>                # Create Favro cards from TODOs
favro git todos --json                                    # JSON output

# Interactive Shell & TUI
favro shell                                               # Start interactive shell with tab completion
favro shell --board <boardId>                             # Start with board pre-selected
favro board <boardRef>                                    # Render kanban board in terminal
favro board <boardRef> --compact                          # One line per card
favro board <boardRef> --watch                            # Auto-refresh every 30s
favro board <boardRef> --watch 10                         # Custom refresh interval
favro board <boardRef> --ids                              # Show card IDs
favro board <boardRef> --json                             # JSON output
favro diff <boardRef> --since 1d                          # Board changes in last 24h
favro diff <boardRef> --since 1w                          # Board changes in last week
favro diff <boardRef> --since 1h --json                   # JSON diff output

# Interactive Menu & Browse (no IDs needed)
favro                                                     # Launch persistent interactive menu
favro browse                                              # Browse: Collections → Boards → Board view → Cards

# Batch from CSV
favro batch update --from-csv cards.csv [--dry-run] [-y]
favro batch move --board <srcId> --to-board <dstId> --filter "status:Done" [--dry-run] [-y]
favro batch assign --board <boardId> --filter "status:Backlog" --to @me [--dry-run] [-y]

# Natural language batch
favro batch-smart <board> --goal "move all overdue cards to Review" [--dry-run] [--yes]

# Propose → Execute (two-step safety)
favro propose <board> --action "move card 'Fix login' to Review"
favro execute <board> --change-id <ch_xxx> [-y]
```

---

## 4. Common Workflows

### Getting oriented in a new session

```bash
favro scope show                                    # Verify scope
favro collections list                              # See all collections
favro boards list <scopedCollectionId>               # Boards in your sandbox
favro cards list --board <boardId> --json | head -50  # Peek at cards
favro context <boardId>                              # Full snapshot
```

### Creating a card safely

```bash
# Step 1: Dry-run preview
favro cards create "Implement user auth" --board <boardId> --dry-run

# Step 2: Execute after user confirms
favro cards create "Implement user auth" --board <boardId> --yes
```

### Updating multiple cards

```bash
# Step 1: Preview the batch operation
favro batch-smart <boardId> --goal "assign all Backlog cards with no owner to alice" --dry-run

# Step 2: Execute (will prompt for confirmation)
favro batch-smart <boardId> --goal "assign all Backlog cards with no owner to alice"
```

### Investigating card history

```bash
favro who-changed "Fix login bug"
favro audit <boardId> --since 1w
favro comments list <cardId>
```

---

## 5. Understanding Favro's Data Model

```
Organization
  └── Collection (e.g. "Product Team Q1")
       └── Board (e.g. "Sprint 42", "Feature Backlog")
            └── Column (e.g. "Todo", "In Progress", "Done")
                 └── Card (the actual work item)
```

Key relationships:
- A **collection** contains multiple **boards**
- A **board** has **columns** representing workflow stages
- A **card** lives on a board in a specific column
- Cards can be **linked** (depends-on, blocks, relates-to)
- Cards have **assignees**, **tags**, **custom fields**, and **due dates**

**IDs are hex strings** (e.g. `a82adb26b63df3bbaeb39e7c`). You'll get them from list/get commands.

### Workflow Stages

The `favro context` snapshot includes a `workflow` array that maps each column to a semantic stage:

| Stage | Meaning | Example columns |
|-------|---------|----------------|
| `backlog` | Not yet prioritized | Backlog, Inbox, Ideas |
| `queued` | Selected for work | Selected, Ready, Next, Sprint |
| `active` | Being worked on | Developing, In Progress, Doing |
| `review` | Awaiting review | Review, Feedback |
| `testing` | Being tested/QA | Test, QA, Testbar |
| `approved` | Passed testing | Approved, Godkänd, Verified |
| `done` | Completed | Done, Closed, Released |
| `archived` | Archived | Archived |

Each card in the snapshot carries `column` (name), `stage`, and `nextColumn` — so you always know where a card is and where it should go next.

**When starting work on a card:** check its `stage` and `nextColumn`. If `stage` is `queued` and `nextColumn` is `Developing`, move the card to `Developing`.

**When finishing work on a card:** check its `nextColumn` and move it forward.

### Moving Cards Through the Workflow

Use `--column` to move a card to a named column (requires `--board`):

```bash
# Move a card to "Developing" on a specific board
favro cards update <cardId> --column "Developing" --board <boardId> -y

# Combined: rename + move in one command
favro cards update <cardId> --name "New title" --column "Review" --board <boardId> -y
```

**⚠️ IMPORTANT: `--column` vs `--status` — these are DIFFERENT things.**
- `--column "Developing"` → Moves the card to the "Developing" column on the kanban board. **This is what you want.**
- `--status` → Sets the card's completion status (a metadata field). **Do NOT use --status to move cards between columns. It will NOT work.**

**LLM workflow for moving a card:**
1. Run `favro context "<boardName>"` to get the board snapshot
2. Find the card — note its `cardId`, `stage`, and `nextColumn`
3. Run `favro cards update <cardId> --column "<nextColumn>" --board <boardId> -y`

The `--column` flag accepts the column name (case-insensitive). If the name doesn't match any column on the board, the command lists available columns and exits.

---

## 6. Error Recovery

### "Scope violation" error
You tried to write to a board outside the locked collection. This is the safety system working correctly.
- Run `favro scope show` to verify what you're locked to
- Run `favro boards list <scopedCollectionId>` to find boards you CAN write to
- If the user explicitly wants to work in a different collection, use `favro scope set <newCollectionId>`

### "Request failed with status code 403"
The API key doesn't have permission for this operation. Check with the user.

### "Request failed with status code 404"
The entity doesn't exist. Double-check the ID by listing the parent resource.

### Batch operation failures
Batch operations use atomic rollback — if any card in a batch fails, all changes are rolled back automatically. Check the error output for which card failed and why.

---

## 7. Configuration

Auth credentials and scope are stored in `~/.favro/config.json`:

```json
{
  "apiKey": "...",
  "email": "user@example.com",
  "organizationId": "...",
  "userId": "...",
  "scopeCollectionId": "...",
  "scopeCollectionName": "..."
}
```

To authenticate: `favro auth login <apiToken>` (also resolves and caches your userId)
To verify: `favro auth verify`

---

## 8. Golden Rules for AI Agents

1. **Scope first.** Always verify `favro scope show` before writing. No scope = ask the user.
2. **Dry-run first.** Every write gets a `--dry-run` preview before the real call.
3. **Show, don't surprise.** Present dry-run output to the user before executing.
4. **Never `--force` unprompted.** The `--force` flag exists for the user's convenience, not yours.
5. **List before you act.** Looking up IDs with read commands is free and safe. Don't guess.
6. **Batch with care.** Bulk operations affect many cards. Always `--dry-run` first.
7. **One collection at a time.** Work within the scoped collection. If you need to switch, tell the user and set the new scope explicitly.
8. **Clean up test data.** If you create test cards, track their IDs and offer to clean them up.
9. **Use v2 persona commands for cross-board queries.** `my-cards`, `workload`, `health` etc. work across collections — no board ID needed.

---

## 9. v2 Persona Commands (LLM-First, Cross-Board)

v2 commands output JSON by default (use `--human` for formatted output). They work cross-board via `--collection <name>` or the scoped collection. No board IDs needed.

### Developer Persona

```bash
# My cards across all boards — grouped by collection/board/stage
favro my-cards [--collection <name>] [--status <filter>] [--limit <n>]
# Returns: { scope, cards[], suggestedNext, stats, generatedAt }

# Personal standup — completed/inProgress/blocked/dueSoon
favro my-standup [--collection <name>] [--days <n>]
# Returns: { scope, completed[], inProgress[], blocked[], dueSoon[], generatedAt }

# "What should I work on next?" — AI-scored suggestions
favro next [--collection <name>] [--top <n>]
# Returns: { scope, suggestions[{ card, score, reasons[] }], generatedAt }
# Scoring: priority×4 + due urgency×3 − blockers×5 + low effort bonus + active stage bonus
```

### PM/PO Persona

```bash
# Per-member card distribution with overload detection (>8 active = alert)
favro workload [--collection <name>] [--board <boardId>]
# Returns: { scope, members[{ name, activeCards, totalCards, blockedCards, overloaded }], generatedAt }

# Find inactive cards (default: >14 days stale)
favro stale [--collection <name>] [--days <n>]
# Returns: { scope, assignedStale[], unassignedStale[], staleDays, generatedAt }

# Collection-level dashboard
favro overview [--collection <name>]
# Returns: { scope, boards[], topBlockers[], dueSummary, stats, generatedAt }
```

### CTO Persona

```bash
# Per-board health scores (0-100) with traffic-light signals
favro health [--collection <name>]
# Returns: { scope, boards[{ name, score, signal, breakdown }], overallScore, generatedAt }
# Score: flow 40% + stale 25% + blocked 20% + overdue 15%
# Signal: green >75, yellow 50-75, red <50

# Cross-board team utilization
favro team [--collection <name>]
# Returns: { scope, members[{ name, wipCount, doneCount, completionRate, bottleneck }], avgWip, generatedAt }
```

### v2 Output Flags

| Flag | Effect |
|------|--------|
| `--json` | JSON output (default for v2 commands) |
| `--human` | Human-readable formatted output |
| `--collection <name>` | Filter to a specific collection |
| `--limit <n>` | Max cards to fetch (default 1000) |

### Interactive Menu Integration

When `favro` is run with no arguments, the interactive menu now includes:
- **My Work** — Personal card overview across all boards (first entry)
- **Team Dashboard** — Team workload summary with overload detection

---

## 10. Repo Context: `.favro/context.json`

A repo can have a `.favro/context.json` file that gives LLMs instant context about the Favro workspace associated with this codebase — no API calls needed to learn the board structure, workflow columns, team members, or custom fields.

### Bootstrapping

```bash
# Create .favro/context.json from the scoped collection (auto-fetches everything)
favro init

# Specify a collection explicitly
favro init --collection <collectionId>

# Update an existing context.json after board changes
favro init --refresh

# Print to stdout instead of writing file
favro init --json
```

`favro init` fetches boards, columns/workflow, custom fields, and team members from the Favro API and writes a complete context file. It also adds `.favro/` to `.gitignore` (the file may contain team emails and IDs).

### File Structure

```json
{
  "_description": "Favro context for my-repo. Used by AI agents to bootstrap Favro operations.",
  "_updated": "2026-04-02",
  "scope": {
    "collectionId": "f37003d6b64b8f229de2fed8",
    "collectionName": "_MKON Developer"
  },
  "boards": {
    "kanban": {
      "boardId": "4d9c710e9bb7d381b2a39060",
      "name": "Kanban MKON",
      "type": "board",
      "workflow": [
        { "columnId": "d3f046db31423f55fd58477b", "name": "Selected", "stage": "queued", "next": "Developing" },
        { "columnId": "6c75246add8912b05c62ed97", "name": "Developing", "stage": "active", "next": "Done" }
      ]
    }
  },
  "customFields": {
    "*Delsystem": {
      "fieldId": "57gNTepfXQnzeE4Xm",
      "type": "Single select",
      "options": { "Hydra": "vgZJWFaDFz4WEn85E", "PageBuilder": "uJLxgwbyh7J358NMC" }
    }
  },
  "team": {
    "pk3qK36WHjnJt5jwr": { "name": "Styrbjörn Kindberg", "email": "styrbjorn@squaremoon.se", "role": "PO/PM" }
  },
  "notes": {
    "cardIds": "Use cardCommonId for cross-board ops. Use board-specific cardId for column moves.",
    "moveCards": "Use --column (not --status) to move cards between columns."
  }
}
```

### Rules for LLMs Using context.json

**At the start of every session:**
1. Check if `.favro/context.json` exists in the repo root
2. If it does, **read it first** — use the IDs, board slugs, workflow steps, and team info directly instead of making discovery API calls
3. Use `boards.<slug>.boardId` for `--board` flags
4. Use `boards.<slug>.workflow` to know which columns exist and their flow order
5. Use `customFields` to look up field IDs and valid option IDs for `--custom-field` operations
6. Use `team` to resolve user IDs and names without calling `/users`

**When making changes to boards:**
- After creating/renaming/deleting boards, columns, or custom fields, update `.favro/context.json` to reflect the new state
- Update `_updated` date when modifying the file
- Use `favro init --refresh` for a full re-sync
- Add `description` fields to boards and custom fields to explain their purpose

**Updating the file:**
- You MAY add `description` fields to boards, custom fields, or team members as you learn what they're for
- You MAY add entries to `notes` with useful context you discover (e.g., "this repo maps to the 'hydra.mkon.se' subsystem")
- You MUST NOT remove existing entries unless they are confirmed stale/deleted
- You MUST keep `_updated` current when editing

**Board slug conventions:**
- Slugs are lowercase, ASCII-only, hyphenated (e.g., "kanban-mkon", "felrapporter", "backlog")
- Use human-friendly slugs — the LLM uses them as shorthand (e.g., `context.boards.kanban` instead of remembering a hex ID)
