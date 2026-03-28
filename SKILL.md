---
name: favro-cli
description: Use when working with Favro boards, cards, collections, members, or webhooks via the `favro` CLI. Triggers on any request to list, create, update, move, or inspect Favro cards/boards, check sprint health, run release checks, batch-update cards, or interact with Favro data in any way.
---

# Favro CLI Skill

The `favro` CLI lets you interact with Favro boards and cards from the terminal.

## Setup

```bash
favro auth login                  # Interactive setup → saves to ~/.favro/config.json
# or set env vars:
export FAVRO_API_KEY="your-key"
export FAVRO_ORGANIZATION_ID="your-org-id"
```

## Core Commands

### Discovery
```bash
favro boards list                               # List all boards
favro boards list --collection <id>             # Filter by collection
favro collections list                          # List collections
favro members list                              # List org members
```

### Cards
```bash
favro cards list <board-id>                     # List cards
favro cards list <board-id> --filter "status:In Progress"
favro cards get <card-id>                       # Card details
favro cards create "Title" --board <id>
favro cards update <card-id> --status "Done"
favro cards move <card-id> --to-board <id>
favro cards export <board-id> --format csv --out cards.csv
favro cards link <card-id> --to <target-id> --type depends
```

### Custom Fields
```bash
favro custom-fields list <board-id>
favro custom-fields set <card-id> <field-id> "value"
favro custom-fields values <field-id>           # Allowed values for select fields
```

### Comments & Activity
```bash
favro comments list <card-id>
favro comments add <card-id> "text"
favro activity <board-id> --since 1d            # Changes in last day
favro audit <board-id> --since 1w --json
favro who-changed "Card title"                  # Edit history by card title
```

### Webhooks
```bash
favro webhooks list
favro webhooks create --url <url> --events card.created,card.updated
favro webhooks delete <webhook-id>
```

### Sprint Health & Quality
```bash
favro release-check <board-id>                  # Cards in Review/Done missing required fields
favro risks <board-id>                          # Overdue, blocked, stale, unassigned cards
favro risks <board-id> --stale-days 14 --json
```

### Batch Operations
```bash
# Natural language goal (recommended for complex operations)
favro batch-smart <board-id> --goal "move all overdue cards to Review" --dry-run
favro batch-smart <board-id> --goal "assign all Backlog cards with no owner to alice"

# Structured batch
favro batch update --from-csv cards.csv --dry-run
favro batch move --board <src> --to-board <dst> --filter "status:Done"
favro batch assign --board <id> --filter "status:Backlog" --to @me
```

## Output Flags

| Flag | Effect |
|------|--------|
| `--json` | Machine-readable JSON |
| `--dry-run` | Preview changes without applying |
| `--verbose` | Stack traces on errors |

## Common Patterns

**Find board ID then work with it:**
```bash
favro boards list
favro cards list <board-id>
```

**Check sprint before release:**
```bash
favro release-check <board-id>
favro risks <board-id>
```

**Bulk close completed cards:**
```bash
favro batch-smart <board-id> --goal "close all Done cards" --dry-run
favro batch-smart <board-id> --goal "close all Done cards"
```
