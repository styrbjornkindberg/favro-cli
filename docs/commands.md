# Command Reference

Complete reference for every `favro` CLI command, flag, and option.

**Tip:** Run `favro <command> --help` for built-in help on any command.

---

## Global Options

| Flag | Description |
|------|-------------|
| `--verbose` | Show detailed error output and stack traces |
| `--help` | Display help for any command |

---

## Auth

```
favro auth login     — Store API token (also resolves userId)
favro auth logout    — Remove stored credentials
favro auth verify    — Test the current token
favro auth check     — Show stored credential info
```

---

## Scope (Write Safety)

| Command | Description |
|---------|-------------|
| `favro scope set <collectionId>` | Lock writes to this collection |
| `favro scope show` | Display current lock |
| `favro scope clear` | Remove lock |

When scope is set, every write command checks the target board's parent collection. Mismatches exit with an error before any mutation.

---

## Init (Repo Context)

| Command | Description |
|---------|-------------|
| `favro init` | Create `.favro/context.json` from scoped collection |
| `favro init --collection <id>` | Bootstrap from a specific collection |
| `favro init --refresh` | Update existing context after board changes |
| `favro init --json` | Print to stdout instead of writing file |

See [Repo Context Guide](./repo-context.md) for the full format.

---

## Collections

### `collections list`
List all collections in the organization.

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON |

### `collections get <id>`
Get a single collection by ID.

### `collections create` ⚠️ WRITE

| Flag | Description |
|------|-------------|
| `--name <name>` | **Required.** Collection name |
| `--description <text>` | Collection description |
| `--dry-run` | Preview only |

### `collections update <id>` ⚠️ WRITE

| Flag | Description |
|------|-------------|
| `--name <name>` | New name |
| `--description <text>` | New description |
| `-y, --yes` | Skip confirmation |
| `--force` | Bypass scope check |

### `collections delete <id>` ⚠️ DESTRUCTIVE

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |
| `--force` | Bypass scope check |

---

## Boards

### `boards list [collectionId]`
List boards, optionally filtered by collection.

### `boards get <id>`
Get board details including columns, members, and stats.

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON |
| `--columns` | Include column definitions |

### `boards create <collectionId>` ⚠️ WRITE

| Flag | Description |
|------|-------------|
| `--name <name>` | **Required.** Board name |
| `--type <type>` | `board` or `backlog` |
| `--dry-run` | Preview only |
| `--force` | Bypass scope check |

### `boards update <id>` ⚠️ WRITE

| Flag | Description |
|------|-------------|
| `--name <name>` | New name |
| `-y, --yes` | Skip confirmation |
| `--force` | Bypass scope check |

### `boards delete <id>` ⚠️ DESTRUCTIVE

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |
| `--force` | Bypass scope check |

---

## Cards

### `cards get <cardId>`

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON |
| `--include <fields>` | Include extra data: `board`, `collection` |
| `--board <boardId>` | Board context for the card |

### `cards list`

| Flag | Description |
|------|-------------|
| `--board <boardId>` | **Required.** Board to list from |
| `--json` | Output raw JSON |
| `--limit <n>` | Max cards (default: 25, max: 100) |
| `--filter <expr>` | Filter expression |
| `--status <status>` | Filter by status |
| `--assignee <user>` | Filter by assignee |
| `--tag <tag>` | Filter by tag |

### `cards create <title>` ⚠️ WRITE

| Flag | Description |
|------|-------------|
| `--board <boardId>` | Target board |
| `--description <text>` | Card description |
| `--status <status>` | Initial status |
| `--assignee <user>` | Assignee |
| `--parent <cardId>` | Parent card (makes this a child) |
| `--csv <file>` | Bulk import from CSV |
| `--bulk <file>` | Bulk import from JSON |
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |
| `--force` | Bypass scope check |

### `cards update <cardId>` ⚠️ WRITE

| Flag | Description |
|------|-------------|
| `--name <name>` | New title |
| `--status <status>` | New status (metadata, not column) |
| `--column <column>` | Move to column by name (requires `--board`) |
| `--assignees <list>` | Comma-separated assignees |
| `--tags <list>` | Comma-separated tags |
| `--parent <cardId>` | Parent card |
| `--board <boardId>` | Board context |
| `--from-csv <file>` | Batch update from CSV |
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |
| `--force` | Bypass scope check |

**Important:** `--column` moves the card on the kanban board. `--status` sets metadata. Use `--column` to move cards through workflow stages.

### `cards export <board>`

| Flag | Description |
|------|-------------|
| `--format <fmt>` | `json` or `csv` |
| `--out <file>` | Output file path |
| `--filter <expr>` | Filter expression (repeatable) |
| `--limit <n>` | Max cards (default: 10000) |

### `cards link <cardId> <toCardId>` ⚠️ WRITE

| Flag | Description |
|------|-------------|
| `--type <type>` | `depends-on`, `blocks`, `relates-to` |

### `cards unlink <cardId> <fromCardId>` ⚠️ WRITE

### `cards move <cardId>` ⚠️ WRITE

| Flag | Description |
|------|-------------|
| `--to-board <boardId>` | Destination board |
| `--position <pos>` | `top` or `bottom` |

---

## Comments

| Command | Description |
|---------|-------------|
| `comments list <cardId>` | List comments on a card |
| `comments get <commentId>` | Get a single comment |
| `comments add <cardId> --text "..."` | Add a comment ⚠️ |
| `comments update <commentId> --text "..."` | Update a comment ⚠️ |
| `comments delete <commentId>` | Delete a comment ⚠️ |

---

## Custom Fields

| Command | Description |
|---------|-------------|
| `custom-fields list <boardId>` | List fields for a board |
| `custom-fields get <fieldId>` | Get field definition |
| `custom-fields values <fieldId>` | List allowed select values |
| `custom-fields set <cardId> <fieldId> <value>` | Set a field value ⚠️ |

---

## Columns & Widgets

| Command | Description |
|---------|-------------|
| `columns list <boardId>` | List columns on a board |
| `columns create <boardId> --name "..."` | Create a column ⚠️ |
| `columns update <columnId>` | Update a column ⚠️ |
| `widgets list --card <cardCommonId>` | List boards a card sits on |
| `widgets add <boardId> <cardCommonId>` | Add card to a board ⚠️ |

---

## Tasks, Task Lists & Dependencies

| Command | Description |
|---------|-------------|
| `tasks list <cardCommonId>` | List checklist items |
| `tasks add <cardCommonId> <name>` | Add a task ⚠️ |
| `tasks update <taskId>` | Update a task ⚠️ |
| `tasks delete <taskId>` | Delete a task ⚠️ |
| `tasklists list <cardCommonId>` | List task lists |
| `tasklists get <taskListId>` | Get a task list |
| `tasklists create <cardCommonId> --name "..."` | Create a task list ⚠️ |
| `tasklists update <taskListId>` | Update a task list ⚠️ |
| `tasklists delete <taskListId>` | Delete a task list ⚠️ |
| `dependencies list <cardId>` | List dependencies |
| `dependencies add <sourceId> <targetId> --type blocks` | Add dependency ⚠️ |
| `dependencies delete <cardId> <targetId>` | Remove dependency ⚠️ |
| `dependencies delete-all <cardId>` | Remove all dependencies ⚠️⚠️ |

---

## Tags & Attachments

| Command | Description |
|---------|-------------|
| `tags list` | List all workspace tags |
| `tags create --name "..." [--color ...]` | Create a tag ⚠️ |
| `tags update <tagId>` | Update a tag ⚠️ |
| `tags delete <tagId>` | Delete a tag ⚠️ |
| `attachments upload <cardCommonId> --file ./path` | Upload to card ⚠️ |
| `attachments upload-to-comment <commentId> --file ./path` | Upload to comment ⚠️ |

---

## Members, Users & Groups

| Command | Description |
|---------|-------------|
| `users list` | List workspace users |
| `groups list` | List user groups |
| `groups get <groupId>` | Get a group |
| `groups create --name "..."` | Create a group ⚠️ |
| `groups update <groupId>` | Update a group ⚠️ |
| `groups delete <groupId>` | Delete a group ⚠️ |
| `members list [--board <id>] [--collection <id>]` | List members |
| `members add <email> --to <targetId>` | Add a member ⚠️ |
| `members remove <memberId> --from <targetId>` | Remove a member ⚠️ |
| `members permissions <memberId> --board <id>` | Check permissions |

---

## Webhooks

| Command | Description |
|---------|-------------|
| `webhooks list` | List webhooks |
| `webhooks create --event <event> --target <url>` | Create webhook ⚠️ |
| `webhooks delete <webhookId>` | Delete webhook ⚠️ |

---

## Batch Operations

### `batch update --from-csv <file>` ⚠️ HIGH BLAST RADIUS

CSV format: `card_id,status,owner,due_date`

### `batch move --board <id> --filter <expr>` ⚠️ HIGH BLAST RADIUS

### `batch assign --board <id> --to <user> --filter <expr>` ⚠️ HIGH BLAST RADIUS

All batch commands support: `--dry-run`, `--yes`, `--force`, `--json`, `--verbose`

Filter syntax: `status:<value>`, `assignee:<user>`, `tag:<tag>`

---

## v2 Cross-Board Commands

These commands work across boards via `--collection <name>` or the scoped collection. JSON output by default.

| Command | Persona | Description |
|---------|---------|-------------|
| `my-cards` | Developer | Your cards grouped by collection/board/stage |
| `my-standup` | Developer | Personal standup: done/active/blocked/due |
| `next` | Developer | AI-scored "what should I work on next?" |
| `workload` | PM | Per-member card distribution + overload alerts |
| `stale` | PM | Cards inactive >N days |
| `overview` | PM | Collection dashboard with blockers |
| `health` | CTO | Per-board health scores 0-100 |
| `team` | CTO | Team utilization + bottleneck analysis |

Common flags: `--collection <name>`, `--limit <n>`, `--human` (formatted output), `--json` (default)

---

## Interactive TUI

| Command | Description |
|---------|-------------|
| `favro` | Launch interactive menu |
| `board <boardRef>` | Kanban view (`--compact`, `--watch`, `--ids`) |
| `diff <boardRef> --since 1d` | Board change diff |
| `shell` | Interactive REPL with tab completion |
| `browse` | Collection → Board → Card browser |
