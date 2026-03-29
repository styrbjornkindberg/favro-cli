# Favro CLI — Complete Command Reference

This reference documents every command, flag, and option available in the favro-cli.

**CLI invocation:** `node dist/cli.js` (from project root `/Users/styrbjorn/Sites/favro-cli`)  
**Alias:** You can also use `favro` if the bin is linked.

## Table of Contents

1. [Global Options](#global-options)
2. [Auth](#auth)
3. [Scope](#scope)
4. [Collections](#collections)
5. [Boards](#boards)
6. [Cards](#cards)
7. [Comments](#comments)
8. [Custom Fields](#custom-fields)
9. [Members](#members)
10. [Webhooks](#webhooks)
11. [Batch Operations](#batch-operations)
12. [AI / Smart Commands](#ai-smart-commands)

---

## Global Options

| Flag | Description |
|------|-------------|
| `--verbose` | Show detailed error output and debug info |
| `--help` | Display help for any command |

---

## Auth

```
favro auth login     — Store API token
favro auth logout    — Remove stored credentials
favro auth verify    — Test the current token
favro auth check     — Show stored credential info
```

---

## Scope

Controls write-safety scope locking. **READ THIS BEFORE ANY WRITES.**

| Command | Description |
|---------|-------------|
| `favro scope set <collectionId>` | Lock writes to this collection |
| `favro scope show` | Display current lock |
| `favro scope clear` | Remove lock |

When scope is set, every write command checks the target board's parent collection. If it doesn't match, the command **exits with an error** before any API mutation.

---

## Collections

### `collections list`
List all collections in the organization.

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON |

### `collections get <id>`
Get a single collection by ID.

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON |

### `collections create` ⚠️ WRITE
Create a new collection.

| Flag | Description |
|------|-------------|
| `--name <name>` | **Required.** Collection name |
| `--description <text>` | Collection description |
| `--json` | Output raw JSON |
| `--dry-run` | Preview only |

### `collections update <id>` ⚠️ WRITE
Update collection properties.

| Flag | Description |
|------|-------------|
| `--name <name>` | New name |
| `--description <text>` | New description |
| `--json` | Output raw JSON |
| `-y, --yes` | Skip confirmation |
| `--force` | Bypass scope check |

---

## Boards

### `boards list [collectionId]`
List boards, optionally filtered by collection.

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON |

### `boards get <id>`
Get board details including columns, members, and stats.

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON |
| `--columns` | Include column definitions |

### `boards create <collectionId>` ⚠️ WRITE
Create a new board.

| Flag | Description |
|------|-------------|
| `--name <name>` | **Required.** Board name |
| `--type <type>` | Board type: `board` or `backlog` |
| `--json` | Output raw JSON |
| `--dry-run` | Preview only |
| `--force` | Bypass scope check |

### `boards update <id>` ⚠️ WRITE
Update board properties.

| Flag | Description |
|------|-------------|
| `--name <name>` | New name |
| `--json` | Output raw JSON |
| `-y, --yes` | Skip confirmation |
| `--force` | Bypass scope check |

---

## Cards

### `cards get <cardId>`
Retrieve a card by ID.

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON |
| `--include <fields>` | Include extra data: `board`, `collection` |
| `--board <boardId>` | Board context for the card |

### `cards list`
List cards on a board.

| Flag | Description |
|------|-------------|
| `--board <boardId>` | **Required.** Board to list from |
| `--json` | Output raw JSON |
| `--limit <n>` | Max cards (default: 100) |
| `--filter <expr>` | Filter expression (repeatable) |

### `cards create <title>` ⚠️ WRITE
Create a new card.

| Flag | Description |
|------|-------------|
| `--board <boardId>` | **Required.** Target board |
| `--status <status>` | Initial status/column |
| `--assignees <users>` | Comma-separated assignees |
| `--tags <tags>` | Comma-separated tags |
| `--due-date <date>` | Due date (ISO 8601) |
| `--description <text>` | Card description |
| `--json` | Output raw JSON |
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |
| `--force` | Bypass scope check |

Also supports bulk CSV import:
| Flag | Description |
|------|-------------|
| `--from-csv <file>` | Create cards from CSV file |

### `cards update <cardId>` ⚠️ WRITE
Update an existing card.

| Flag | Description |
|------|-------------|
| `--board <boardId>` | Board context |
| `--name <name>` | New title |
| `--status <status>` | New status |
| `--assignees <users>` | New assignees |
| `--tags <tags>` | New tags |
| `--due-date <date>` | New due date |
| `--description <text>` | New description |
| `--json` | Output raw JSON |
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |
| `--force` | Bypass scope check |

### `cards export <board>` 📖 READ
Export all cards from a board.

| Flag | Description |
|------|-------------|
| `--format <fmt>` | `json` or `csv` |
| `--out <file>` | Output file path |
| `--filter <expr>` | Filter expression (repeatable) |

### `cards link <cardId> <toCardId>` ⚠️ WRITE
Create a link between two cards.

| Flag | Description |
|------|-------------|
| `--type <type>` | **Required.** `depends-on`, `blocks`, `relates-to` |
| `--json` | Output raw JSON |
| `-y, --yes` | Skip confirmation |
| `--force` | Bypass scope check |

### `cards unlink <cardId> <fromCardId>` ⚠️ WRITE
Remove a link between two cards.

| Flag | Description |
|------|-------------|
| `-y, --yes` | Skip confirmation |
| `--force` | Bypass scope check |

### `cards move <cardId>` ⚠️ WRITE
Move a card to a different board.

| Flag | Description |
|------|-------------|
| `--to-board <boardId>` | **Required.** Destination board |
| `--position <pos>` | `top` or `bottom` |
| `--json` | Output raw JSON |
| `-y, --yes` | Skip confirmation |
| `--force` | Bypass scope check |

---

## Comments

### `comments list <cardId>` 📖 READ
List all comments on a card.

| Flag | Description |
|------|-------------|
| `--limit <n>` | Max comments (default: 100) |
| `--json` | Output raw JSON |

### `comments add <cardId>` ⚠️ WRITE
Add a comment to a card.

| Flag | Description |
|------|-------------|
| `--text <comment>` | **Required.** Comment body |
| `--json` | Output raw JSON |
| `--dry-run` | Preview only |
| `--force` | Bypass scope check |

---

## Custom Fields

### `custom-fields list <boardId>` 📖 READ
List all custom fields for a board.

### `custom-fields get <fieldId>` 📖 READ
Get field definition and options.

### `custom-fields values <fieldId>` 📖 READ
List allowed values for a select field.

### `custom-fields set <cardId> <fieldId> <value>` ⚠️ WRITE
Set a custom field value on a card.

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON |
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |
| `--force` | Bypass scope check |

---

## Members

### `members list` 📖 READ
List workspace members.

| Flag | Description |
|------|-------------|
| `--board <boardId>` | Filter by board |
| `--collection <collectionId>` | Filter by collection |
| `--json` | Output raw JSON |

### `members add <email>` ⚠️ WRITE
Add a member to a board or collection.

| Flag | Description |
|------|-------------|
| `--to <targetId>` | **Required.** Board or collection ID |
| `--board-target` | Target is a board (default) |
| `--collection-target` | Target is a collection |
| `--json` | Output raw JSON |
| `--dry-run` | Preview only |
| `--force` | Bypass scope check |

### `members remove <memberId>` ⚠️ WRITE
Remove a member.

| Flag | Description |
|------|-------------|
| `--from <targetId>` | **Required.** Board or collection ID |
| `--board-target` | Target is a board (default) |
| `--collection-target` | Target is a collection |
| `-y, --yes` | Skip confirmation |
| `--force` | Bypass scope check |

### `members permissions <memberId>` 📖 READ
Check member's permission level on a board.

| Flag | Description |
|------|-------------|
| `--board <boardId>` | **Required.** Board ID |
| `--json` | Output raw JSON |

---

## Webhooks

### `webhooks list` 📖 READ
List all configured webhooks.

### `webhooks create` ⚠️ WRITE
Create a new webhook.

| Flag | Description |
|------|-------------|
| `--event <event>` | **Required.** `card.created` or `card.updated` |
| `--target <url>` | **Required.** Delivery URL |
| `--dry-run` | Preview only |

### `webhooks delete <webhookId>` ⚠️ WRITE
Delete a webhook.

| Flag | Description |
|------|-------------|
| `-y, --yes` | Skip confirmation |

---

## Batch Operations

### `batch update` ⚠️ WRITE — HIGH BLAST RADIUS
Update cards from a CSV file.

| Flag | Description |
|------|-------------|
| `--from-csv <file>` | **Required.** CSV file |
| `--dry-run` | Preview only |
| `--json` | Output raw JSON |
| `--verbose` | Per-card progress |
| `-y, --yes` | Skip confirmation |
| `--force` | Bypass scope check |

CSV format: `card_id,status,owner,due_date,custom_field_x`

### `batch move` ⚠️ WRITE — HIGH BLAST RADIUS
Move matching cards between boards/statuses.

| Flag | Description |
|------|-------------|
| `--board <id>` | **Required.** Source board |
| `--to-board <id>` | Target board |
| `--status <value>` | Target status |
| `--filter <expr>` | Filter expression (repeatable, AND logic) |
| `--dry-run` | Preview only |
| `--json` | Output raw JSON |
| `--verbose` | Per-card progress |
| `-y, --yes` | Skip confirmation |
| `--force` | Bypass scope check |

### `batch assign` ⚠️ WRITE — HIGH BLAST RADIUS
Assign matching cards to a user.

| Flag | Description |
|------|-------------|
| `--board <id>` | **Required.** Board ID |
| `--to <user>` | **Required.** User to assign (`@me` for yourself) |
| `--filter <expr>` | Filter expression (repeatable) |
| `--dry-run` | Preview only |
| `--json` | Output raw JSON |
| `--verbose` | Per-card progress |
| `-y, --yes` | Skip confirmation |
| `--force` | Bypass scope check |

Filter syntax: `status:<value>`, `assignee:<user>`, `tag:<tag>`

---

## AI / Smart Commands

### `context <board>` 📖 READ
Full board snapshot for AI workflows — returns board metadata, columns, custom fields, members, cards, and stats in one JSON blob.

| Flag | Description |
|------|-------------|
| `--limit <n>` | Max cards (default: 1000) |

### `query <board> <query...>` 📖 READ
Semantic card search with natural language.

Query patterns: `status:done`, `assigned:@alice`, `blocked`, `priority:high`, `tag:bug`, `due:overdue`, free text.

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON |
| `--limit <n>` | Max results |

### `standup` 📖 READ
Daily standup view — groups cards by status category.

| Flag | Description |
|------|-------------|
| `--board <board>` | Board to report on |
| `--json` | Output raw JSON |

### `sprint-plan` 📖 READ
Sprint planning — suggests backlog cards sorted by priority×effort.

| Flag | Description |
|------|-------------|
| `--board <board>` | Board to plan from |
| `--budget <n>` | Max effort budget |
| `--json` | Output raw JSON |

### `batch-smart <board>` ⚠️ WRITE — HIGH BLAST RADIUS
Natural language batch operations.

| Flag | Description |
|------|-------------|
| `--goal <goal>` | **Required.** Plain English goal |
| `--dry-run` | Preview only |
| `--yes` | Skip confirmation |
| `--force` | Bypass scope check |
| `--json` | Output raw JSON |

Supported goal patterns:
- `move all <filter> cards to <status>`
- `assign all <filter> cards [with no owner] to <user>`
- `close all <filter> cards`
- `unassign all <filter> cards`

### `propose <board>` 📖 READ (generates preview)
Propose a change — generates a dry-run preview with a change ID.

| Flag | Description |
|------|-------------|
| `--action <action>` | **Required.** Plain English action |
| `--pretty` | Pretty-print output |

### `execute <board>` ⚠️ WRITE
Execute a proposed change.

| Flag | Description |
|------|-------------|
| `--change-id <id>` | **Required.** From `propose` output |
| `--pretty` | Pretty-print output |
| `-y, --yes` | Skip confirmation |
| `--force` | Bypass scope check |

### `audit <board>` 📖 READ
Board change audit log.

| Flag | Description |
|------|-------------|
| `--since <period>` | Time range: `1h`, `1d`, `1w` |
| `--limit <n>` | Max entries (default: 100) |
| `--json` | Output raw JSON |

### `who-changed <cardTitle>` 📖 READ
Card edit history by title search.

| Flag | Description |
|------|-------------|
| `--board <boardId>` | Narrow search to board |
| `--json` | Output raw JSON |

### `risks <board>` 📖 READ
Board risk analysis — surfaces blocked, stale, unassigned, and incomplete cards.

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON |
| `--stale-days <n>` | Days without update to consider stale |
