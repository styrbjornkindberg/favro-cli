# Favro CLI — Agent Skills

**Version:** tracks `package.json` version
**Binary:** `favro`
**Auth:** `FAVRO_API_KEY` env var or `favro auth login` (saves to `~/.favro/config.json`)

---

## Core Concepts

| Term | Description |
|------|-------------|
| Organization | Your Favro org — set via `FAVRO_ORGANIZATION_ID` or config |
| Collection | Group of boards (like a project/team space) |
| Board | A Kanban board with columns/statuses |
| Card | A task/issue on a board |
| Custom Field | Metadata on cards (select, text, number, date) |

---

## Commands

### Auth
```bash
favro auth login                          # Interactive setup, saves to ~/.favro/config.json
favro auth status                         # Check current auth
```

### Boards
```bash
favro boards list                         # List all boards
favro boards list --collection <id>       # Filter by collection
```

### Cards
```bash
favro cards list <board-id>               # List cards on a board
favro cards list <board-id> --filter "status:In Progress"
favro cards get <card-id>                 # Get card details
favro cards create "Title" --board <id>  # Create a card
favro cards update <card-id> --status "Done"
favro cards move <card-id> --to-board <id>
favro cards export <board-id> --format csv --out cards.csv
favro cards link <card-id> --to <target-id> --type depends
```

### Collections
```bash
favro collections list
```

### Custom Fields
```bash
favro custom-fields list <board-id>
favro custom-fields set <card-id> <field-id> "value"
favro custom-fields values <field-id>     # List allowed values for select fields
```

### Comments & Activity
```bash
favro comments list <card-id>
favro comments add <card-id> "Comment text"
favro activity <board-id>                 # Board activity log
```

### Members & Webhooks
```bash
favro members list
favro webhooks list
favro webhooks create --url <url> --events card.created,card.updated
favro webhooks delete <webhook-id>
```

### Analytics / Quality
```bash
favro release-check <board-id>            # Check cards in Review/Done for required fields
favro risks <board-id>                    # Find overdue, blocked, stale, unassigned cards
favro audit <board-id> --since 1d         # All changes in last day
favro who-changed "Card title"            # Edit history for a specific card
```

### Batch Operations
```bash
favro batch-smart <board-id> --goal "move all overdue cards to Review"
favro batch update --from-csv cards.csv --dry-run
favro batch move --board <src> --to-board <dst> --filter "status:Done"
favro batch assign --board <id> --filter "status:Backlog" --to @me
```

---

## Common Patterns

### Find a board and list its cards
```bash
favro boards list
favro cards list <board-id>
```

### Create a card with details
```bash
favro cards create "Fix login bug" --board <id> --status "In Progress"
```

### Check sprint health
```bash
favro risks <board-id>
favro release-check <board-id>
```

### Bulk move completed cards
```bash
favro batch-smart <board-id> --goal "close all Done cards" --dry-run
favro batch-smart <board-id> --goal "close all Done cards"
```

---

## Output Flags
- `--json` — machine-readable JSON output (supported by most commands)
- `--verbose` — show stack traces on errors
- `--dry-run` — preview batch changes without applying

---

## Evolution
This file should be updated when new commands are added or behaviour changes.
Current spec: `specs/` directory. Current version tracked in `package.json`.
