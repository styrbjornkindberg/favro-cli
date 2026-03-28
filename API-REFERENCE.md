# API Reference — SPEC-002 Endpoints

Comprehensive reference for all SPEC-002 endpoints in `favro-cli`.

> **Quick links:** [README](./README.md) · [Examples & Workflows](./EXAMPLES.md) · [Install Guide](./INSTALL.md)

---

## Table of Contents

- [Overview](#overview)
- [Authentication](#authentication)
- [Global Flags](#global-flags)
- [Collections](#collections)
  - [collections list](#collections-list)
  - [collections get](#collections-get)
  - [collections create](#collections-create)
  - [collections update](#collections-update)
- [Boards](#boards)
  - [boards list](#boards-list)
  - [boards get](#boards-get)
  - [boards create](#boards-create)
  - [boards update](#boards-update)
- [Cards — Advanced](#cards--advanced)
  - [cards list](#cards-list)
  - [cards get](#cards-get)
  - [cards link](#cards-link)
  - [cards unlink](#cards-unlink)
  - [cards move](#cards-move)
  - [cards show](#cards-show)
  - [cards dependencies](#cards-dependencies)
  - [cards blockers](#cards-blockers)
  - [cards blocked-by](#cards-blocked-by)
  - [cards export](#cards-export)
- [Custom Fields](#custom-fields)
  - [custom-fields list](#custom-fields-list)
  - [custom-fields get](#custom-fields-get)
  - [custom-fields set](#custom-fields-set)
  - [custom-fields values](#custom-fields-values)
- [Members](#members)
  - [members list](#members-list)
  - [members add](#members-add)
  - [members remove](#members-remove)
  - [members permissions](#members-permissions)
- [Comments](#comments)
  - [comments list](#comments-list)
  - [comments add](#comments-add)
- [Activity](#activity)
  - [activity log](#activity-log)
- [Webhooks](#webhooks)
  - [webhooks list](#webhooks-list)
  - [webhooks create](#webhooks-create)
  - [webhooks delete](#webhooks-delete)
- [Batch Operations](#batch-operations)
  - [batch update](#batch-update)
  - [batch move](#batch-move)
  - [batch assign](#batch-assign)
  - [batch-smart](#batch-smart)
- [Troubleshooting Guide](#troubleshooting-guide)
- [Performance Tips](#performance-tips)
- [Common Workflows](#common-workflows)

---

## Overview

SPEC-002 extends the base CLI with nine endpoint categories:

| Category | Commands | Description |
|---|---|---|
| **Collections** | list, get, create, update | Manage Favro collections (workspaces) |
| **Boards** | list, get, create, update | Manage boards within collections |
| **Cards Advanced** | list, get, link, unlink, move, export | Card relationships, detailed retrieval, and export |
| **Custom Fields** | list, get, set, values | Define and set custom metadata on cards |
| **Members** | list, add, remove, permissions | Manage board and collection memberships |
| **Comments** | list, add | Card comment management |
| **Activity** | log | Board and card activity history |
| **Webhooks** | list, create, delete | Configure HTTP event notifications |
| **Batch Operations** | update, move, assign, smart-batch | Bulk card mutations with rollback support |

---

## Authentication

All commands require a valid Favro API key. See [README Authentication](./README.md#authentication) for full setup.

**Resolution order (highest to lowest priority):**

1. `--api-key <key>` flag
2. `FAVRO_API_KEY` environment variable
3. `~/.favro/config.json` (`apiKey` field)
4. `FAVRO_API_TOKEN` environment variable _(legacy, still supported)_

```bash
# Recommended: save key to config
favro auth login

# Or export for the session
export FAVRO_API_KEY=your_key_here
```

---

## Global Flags

These flags are available on every command:

| Flag | Description |
|---|---|
| `--verbose` | Show detailed error output (stack traces, raw API errors) |
| `--help`, `-h` | Show help for any command |

---

## Collections

### `collections list`

List all collections in your organization.

**Syntax:**
```
favro collections list [--format table|json] [--json]
```

**Options:**

| Option | Default | Description |
|---|---|---|
| `--format <format>` | `table` | Output format: `table` or `json` |
| `--json` | — | Alias for `--format json` |

**Output (table):**

```
Found 3 collection(s):
┌───┬────────────────────┬──────────────────────┬──────────────┬────────┬─────────┬────────────┐
│   │ ID                 │ Name                 │ Description  │ Boards │ Members │ Updated    │
├───┼────────────────────┼──────────────────────┼──────────────┼────────┼─────────┼────────────┤
│ 0 │ 'coll-abc123'      │ 'Product Development'│ 'Main dev...'│ 5      │ 8       │ '2026-03-01'│
└───┴────────────────────┴──────────────────────┴──────────────┴────────┴─────────┴────────────┘
```

**Examples:**
```bash
favro collections list
favro collections list --json
favro collections list --format json | jq '.[].name'
```

**Error cases:**
- Missing API key → `Error: No API key configured`
- Network error → `Error: <http error>`

---

### `collections get`

Retrieve a single collection by ID, with optional related data.

**Syntax:**
```
favro collections get <id> [--include boards,stats] [--json]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `<id>` | ✓ | Collection ID (from `collections list`) |

**Options:**

| Option | Description |
|---|---|
| `--include <options>` | Comma-separated: `boards`, `stats` |
| `--json` | Output as JSON |

**Include values:**

| Value | Description |
|---|---|
| `boards` | Embed list of boards in the collection |
| `stats` | Include board and member counts |

**Output (default):**
```
Collection: Product Development (coll-abc123)
Description: Main development workspace
Boards: 5
Members: 8
Created: 2025-01-15
Updated: 2026-03-01

Boards:
┌───┬──────────────┬───────────────┬───────┐
│   │ ID           │ Name          │ Cards │
├───┼──────────────┼───────────────┼───────┤
│ 0 │ 'board-001'  │ 'Sprint 42'   │ 18    │
└───┴──────────────┴───────────────┴───────┘
```

**Examples:**
```bash
favro collections get coll-abc123
favro collections get coll-abc123 --include boards,stats
favro collections get coll-abc123 --json
```

**Error cases:**
- Collection not found → `✗ Collection not found: <id>. Use 'favro collections list' to see available collections.`
- Invalid `--include` value → `Error: Invalid --include values: <value>. Valid options: boards, stats`

---

### `collections create`

Create a new collection.

**Syntax:**
```
favro collections create --name "NAME" [--description "DESC"] [--json] [--dry-run]
```

**Options:**

| Option | Required | Description |
|---|---|---|
| `--name <name>` | ✓ | Collection name (cannot be blank) |
| `--description <text>` | — | Collection description |
| `--json` | — | Output created collection as JSON |
| `--dry-run` | — | Preview without making API calls |

**Output:**
```
✓ Collection created: coll-xyz789
  Name: Sprint Q2 2026
  Description: All Q2 sprint boards
```

**Examples:**
```bash
favro collections create --name "Sprint Q2 2026"
favro collections create --name "Sprint Q2 2026" --description "All Q2 sprint boards" --json
favro collections create --name "Draft" --dry-run
```

**Error cases:**
- Missing `--name` → Commander error: `required option '--name <name>' not specified`
- Empty name → `Error: Collection name cannot be empty or whitespace-only`

---

### `collections update`

Update an existing collection's name or description.

**Syntax:**
```
favro collections update <id> [--name "NEW_NAME"] [--description "DESC"] [--json] [--dry-run]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `<id>` | ✓ | Collection ID to update |

**Options:**

| Option | Description |
|---|---|
| `--name <name>` | New collection name |
| `--description <text>` | New collection description |
| `--json` | Output updated collection as JSON |
| `--dry-run` | Preview without making API calls |

**Notes:** At least one of `--name` or `--description` must be provided.

**Examples:**
```bash
favro collections update coll-abc123 --name "Renamed Collection"
favro collections update coll-abc123 --description "Updated description"
favro collections update coll-abc123 --name "New Name" --dry-run
```

**Error cases:**
- No fields provided → `Error: Provide at least one field to update: --name or --description`
- Collection not found → `✗ Collection not found: <id>. Use 'favro collections list' to see available collections.`

---

## Boards

### `boards list`

List boards, optionally filtered by collection.

**Syntax:**
```
favro boards list [collection-id] [--collection <name>] [--include stats,velocity] [--json]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `[collection-id]` | — | Collection ID positional arg (enables extended listing with `--include`) |

**Options:**

| Option | Description |
|---|---|
| `--collection <name>` | Filter boards by collection name (case-insensitive substring match) |
| `--include <options>` | Comma-separated: `stats`, `velocity` |
| `--json` | Output as JSON |

**Include values:**

| Value | Description |
|---|---|
| `stats` | Add open/done card counts per board |
| `velocity` | Add weekly velocity data (cards completed/added per week) |

**Output (default):**
```
Found 2 board(s):
┌───┬───────────┬─────────────┬───────┬─────────┬────────────┐
│   │ ID        │ Name        │ Cards │ Columns │ Updated    │
└───┴───────────┴─────────────┴───────┴─────────┴────────────┘
```

**Output (with `--include stats,velocity`):**
```
┌───┬───────────┬─────────────┬───────┬────────────┬──────┬──────┬──────────┐
│   │ ID        │ Name        │ Cards │ Updated    │ Open │ Done │ Velocity │
└───┴───────────┴─────────────┴───────┴────────────┴──────┴──────┴──────────┘
```

**Examples:**
```bash
favro boards list
favro boards list --collection "Sprint"
favro boards list coll-abc123 --include stats,velocity
favro boards list --json
```

**Error cases:**
- Collection name not found → `✗ No boards found in collection "<name>".`
- Multiple collections match → Warning + uses first match

---

### `boards get`

Get detailed information about a board.

**Syntax:**
```
favro boards get <id> [--include custom-fields,cards,members,stats,velocity] [--json]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `<id>` | ✓ | Board ID |

**Options:**

| Option | Description |
|---|---|
| `--include <options>` | Comma-separated: `custom-fields`, `cards`, `members`, `stats`, `velocity` |
| `--json` | Output as JSON |

**Include values:**

| Value | Description |
|---|---|
| `custom-fields` | List custom fields defined on the board |
| `cards` | Embed cards on the board |
| `members` | List board members with roles |
| `stats` | Card counts: total, open, done, overdue |
| `velocity` | Weekly velocity table |

**Output (with `--include members,stats`):**
```
Board: Sprint 42 (board-001)
Type: board
Collection: coll-abc123
Cards: 18
Columns: 5
Created: 2026-01-10
Updated: 2026-03-01

Members:
┌───┬──────────┬───────────┬───────────────────┬─────────┐
│   │ ID       │ Name      │ Email             │ Role    │
└───┴──────────┴───────────┴───────────────────┴─────────┘

Stats:
  Total cards:   18
  Open cards:    12
  Done cards:    6
  Overdue cards: 2
```

**Examples:**
```bash
favro boards get board-001
favro boards get board-001 --include members,stats
favro boards get board-001 --include custom-fields,cards,members,stats,velocity --json
```

**Error cases:**
- Board not found → `✗ Board not found: <id>`
- Invalid include → `✗ Invalid include option(s): <value>`

---

### `boards create`

Create a new board in a collection.

**Syntax:**
```
favro boards create <collection-id> --name "NAME" [--type board|list|kanban] [--description "DESC"] [--json] [--dry-run]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `<collection-id>` | ✓ | ID of the collection to create the board in |

**Options:**

| Option | Default | Description |
|---|---|---|
| `--name <name>` | — | Board name (required, cannot be blank) |
| `--type <type>` | `board` | Board type: `board`, `list`, or `kanban` |
| `--description <text>` | — | Board description |
| `--json` | — | Output created board as JSON |
| `--dry-run` | — | Preview without making API calls |

**Board types:**

| Type | Description |
|---|---|
| `board` | Standard Kanban-style board with columns |
| `list` | Simple list view |
| `kanban` | Full kanban with WIP limits |

**Output:**
```
✓ Board created: board-xyz789
  Name: Feature Backlog
  Type: board
  Collection: coll-abc123
```

**Examples:**
```bash
favro boards create coll-abc123 --name "Feature Backlog"
favro boards create coll-abc123 --name "Sprint 43" --type kanban
favro boards create coll-abc123 --name "New Board" --dry-run
```

**Error cases:**
- Collection not found → `✗ Collection not found: <id>`
- Invalid type → `✗ Invalid board type: "<type>". Use: board, list, kanban`

---

### `boards update`

Update an existing board's name or description.

**Syntax:**
```
favro boards update <id> [--name "NEW"] [--description "DESC"] [--json] [--dry-run]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `<id>` | ✓ | Board ID to update |

**Options:**

| Option | Description |
|---|---|
| `--name <name>` | New board name |
| `--description <text>` | New board description |
| `--json` | Output updated board as JSON |
| `--dry-run` | Preview without making API calls |

**Notes:** At least one of `--name` or `--description` must be provided.

**Examples:**
```bash
favro boards update board-001 --name "Sprint 42 — Closed"
favro boards update board-001 --description "Q1 2026 sprint"
favro boards update board-001 --name "New Name" --dry-run
```

**Error cases:**
- No update fields → `✗ No update fields provided. Use --name or --description.`
- Board not found → `✗ Board not found: <id>`

---

## Cards — Advanced

### `cards list`

List cards from a board with optional filtering.

**Syntax:**
```
favro cards list [--board <id>] [--status <status>] [--assignee <user>] [--tag <tag>]
                 [--filter <expression>] [--limit <n>] [--json] [--csv]
```

**Options:**

| Option | Default | Description |
|---|---|---|
| `--board <id>` | — | Board ID to list cards from |
| `--status <status>` | — | Filter by status (case-insensitive, legacy) |
| `--assignee <user>` | — | Filter by assignee (substring match, legacy) |
| `--tag <tag>` | — | Filter by tag (substring match, legacy) |
| `--filter <expression>` | — | Enhanced query filter (repeatable); overrides legacy flags |
| `--limit <number>` | `50` | Maximum cards to return |
| `--json` | — | Output as JSON |
| `--csv` | — | Output as CSV |

**Enhanced filter syntax:**

The `--filter` option accepts rich query expressions combining fields and boolean logic:

```
field:value
field:value AND field:value
field:value OR field:value
(field:value OR field:value) AND field:value
```

Supported fields: `status`, `assignee`, `tag`, `due`, `overdue`

Multiple `--filter` flags are combined with AND logic.

**Examples:**
```bash
favro cards list --board abc123
favro cards list --board abc123 --status "In Progress" --limit 100
favro cards list --board abc123 --filter "status:done OR status:in-progress"
favro cards list --board abc123 --filter "assignee:alice" --filter "tag:bug"
favro cards list --board abc123 --json | jq '.[].name'
```

**Error cases:**
- Board not found → Suggests closest board name from available boards
- Invalid filter → `✗ Invalid filter expression: <error>`

---

### `cards get`

Retrieve a single card by ID with optional metadata.

**Syntax:**
```
favro cards get <cardId> [--include board,collection,custom-fields,links,comments,relations] [--json]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `<cardId>` | ✓ | Card ID |

**Options:**

| Option | Description |
|---|---|
| `--include <items>` | Comma-separated metadata: `board`, `collection`, `custom-fields`, `links`, `comments`, `relations` |
| `--json` | Output as JSON (auto-enabled when includes are present) |

**Include values:**

| Value | Description |
|---|---|
| `board` | Embed parent board info |
| `collection` | Embed parent collection info |
| `custom-fields` | Include custom field values on the card |
| `links` | Include card relationship links |
| `comments` | Embed card comments |
| `relations` | Include relation metadata |

**Output (default):**
```
┌───┬──────────┬──────────────┬───────────┬──────────┬───────┬──────────┬────────────┐
│   │ ID       │ Title        │ Status    │ Assignees│ Tags  │ Due Date │ Created    │
└───┴──────────┴──────────────┴───────────┴──────────┴───────┴──────────┴────────────┘
```

When `--include` is used, the output is always JSON.

**Examples:**
```bash
favro cards get card-abc123
favro cards get card-abc123 --include board,collection
favro cards get card-abc123 --include board,collection,custom-fields,links,comments
favro cards get card-abc123 --json
```

**Error cases:**
- Card not found → `Error: Card '<id>' not found.`
- Invalid include → `Error: Invalid include value(s): <value>. Valid: board,collection,...`

---

### `cards link`

Create a relationship link between two cards.

**Syntax:**
```
favro cards link <cardId> <toCardId> --type <type> [--json]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `<cardId>` | ✓ | Source card ID |
| `<toCardId>` | ✓ | Target card ID |

**Options:**

| Option | Required | Description |
|---|---|---|
| `--type <type>` | ✓ | Link type: `depends-on`, `blocks`, `related`, `duplicates` |
| `--json` | — | Output link details as JSON |

**Link types:**

| Type | Meaning |
|---|---|
| `depends-on` | Source card depends on (is blocked by) target card |
| `blocks` | Source card blocks (is a prerequisite for) target card |
| `related` | Cards are related without a blocking relationship |
| `duplicates` | Source card is a duplicate of target card |

**Circular dependency detection:** For `depends-on` links, the CLI performs a BFS graph traversal to detect and prevent circular dependencies before creating the link.

**Output:**
```
✓ Linked card CARD-A → CARD-B (depends-on)
```

**Examples:**
```bash
favro cards link CARD-A CARD-B --type depends-on
favro cards link CARD-A CARD-B --type blocks
favro cards link CARD-A CARD-B --type related --json
```

**Error cases:**
- Self-link → `Error: Cannot link a card to itself.`
- Circular dependency → `Error: Linking would create a circular dependency. Aborting.`
- Invalid type → `Error: Invalid link type '<type>'. Valid: depends-on, blocks, related, duplicates`
- Card not found → `Error: Card '<id>' or target '<id>' not found.`

---

### `cards unlink`

Remove an existing relationship link between two cards.

**Syntax:**
```
favro cards unlink <cardId> <fromCardId>
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `<cardId>` | ✓ | Source card ID |
| `<fromCardId>` | ✓ | Target card ID to unlink from |

**Examples:**
```bash
favro cards unlink CARD-A CARD-B
```

**Error cases:**
- Card or link not found → `Error: Card '<id>' or link to '<id>' not found.`

---

### `cards move`

Move a card to a different board, with optional position.

**Syntax:**
```
favro cards move <cardId> --to-board <boardId> [--position top|bottom] [--json]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `<cardId>` | ✓ | Card ID to move |

**Options:**

| Option | Required | Description |
|---|---|---|
| `--to-board <boardId>` | ✓ | Destination board ID |
| `--position <pos>` | — | Position on board: `top` or `bottom` |
| `--json` | — | Output updated card as JSON |

**Examples:**
```bash
favro cards move card-abc123 --to-board board-456
favro cards move card-abc123 --to-board board-456 --position top
favro cards move card-abc123 --to-board board-456 --position bottom --json
```

**Error cases:**
- Card or board not found → `Error: Card '<id>' or board '<id>' not found.`
- Invalid position → `Error: Invalid position '<pos>'. Valid: top, bottom`

---

### `cards show`

Show card details with optional relationship info.

**Syntax:**
```
favro cards show <cardId> [--relationships] [--json]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `<cardId>` | ✓ | Card ID |

**Options:**

| Option | Description |
|---|---|
| `--relationships` | Include all relationship links for this card |
| `--json` | Output as JSON |

**Examples:**
```bash
favro cards show CARD-ID
favro cards show CARD-ID --relationships
favro cards show CARD-ID --relationships --json
```

---

### `cards dependencies`

List all cards this card depends on (`depends-on` links).

**Syntax:**
```
favro cards dependencies <cardId> [--json]
```

**Output:**
```
Dependencies of card CARD-A:
  → CARD-B (Fix authentication service)
  → CARD-C (Update database schema)
```

**Examples:**
```bash
favro cards dependencies CARD-A
favro cards dependencies CARD-A --json
```

**Error cases:**
- Card not found → `Error: Card '<id>' not found.`

---

### `cards blockers`

List all cards blocked by this card (`blocks` links).

**Syntax:**
```
favro cards blockers <cardId> [--json]
```

**Output:**
```
Cards blocked by CARD-A:
  ⛔ CARD-D (Deploy to production)
```

**Examples:**
```bash
favro cards blockers CARD-A
favro cards blockers CARD-A --json
```

---

### `cards blocked-by`

List all cards that are blocking this card (inferred from `depends-on` links).

**Syntax:**
```
favro cards blocked-by <cardId> [--json]
```

**Output:**
```
Cards blocking CARD-D:
  🚫 CARD-A (Implement feature X)
```

**Examples:**
```bash
favro cards blocked-by CARD-D
favro cards blocked-by CARD-D --json
```

---

### `cards export`

Export all cards from a board to JSON or CSV, with optional filtering and progress display.

**Syntax:**
```
favro cards export <board> [--format json|csv] [--out <file>] [--filter <expression>] [--limit <n>]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `<board>` | ✓ | Board ID to export from |

**Options:**

| Option | Default | Description |
|---|---|---|
| `--format <format>` | `json` | Export format: `json` or `csv` |
| `--out <file>` | stdout | Output file path (must be within current directory) |
| `--filter <expression>` | — | Filter expression (repeatable, AND logic) |
| `--limit <number>` | `10000` | Maximum cards to fetch |

**Filter expression format:**

| Expression | Matches |
|---|---|
| `assignee:alice` | Cards with `alice` in assignee list |
| `status:Done` | Cards with status `Done` (case-insensitive) |
| `tag:bug` | Cards with `bug` in tags |

Multiple `--filter` flags are combined with **AND** logic.

**Security:** `--out` paths must be relative to the current working directory. Absolute paths (e.g., `/tmp/cards.csv`) are rejected.

**Examples:**
```bash
# Export to file
favro cards export abc123 --format csv --out sprint.csv
favro cards export abc123 --format json --out sprint.json

# Export to stdout (pipe-friendly)
favro cards export abc123 --format json | jq '.[].name'
favro cards export abc123 --format csv | head -20

# With filters
favro cards export abc123 --filter "status:Done" --format csv --out done.csv
favro cards export abc123 --filter "assignee:alice" --filter "tag:bug" --format json
```

**Error cases:**
- Board not found → Suggests closest match by name
- Invalid format → `Error: Invalid format "<format>". Use --format json or --format csv`
- Absolute output path → `Error: Output path must be within current directory`
- No cards after filter → `⚠ No cards to export (0 results after filtering).` (exits 0)

---

## Custom Fields

### `custom-fields list`

List all custom field definitions for a board.

**Syntax:**
```
favro custom-fields list <board-id> [--json]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `<board-id>` | ✓ | Board ID to list custom fields for |

**Options:**

| Option | Description |
|---|---|
| `--json` | Output as JSON |

**Output:**
```
Found 3 custom field(s) for board board-001:
┌───┬──────────┬────────────────┬────────────┬──────────┐
│   │ ID       │ Name           │ Type       │ Required │
├───┼──────────┼────────────────┼────────────┼──────────┤
│ 0 │ 'cf-001' │ 'Priority'     │ 'select'   │ 'no'     │
│ 1 │ 'cf-002' │ 'Story Points' │ 'number'   │ 'no'     │
│ 2 │ 'cf-003' │ 'Due Quarter'  │ 'date'     │ 'yes'    │
└───┴──────────┴────────────────┴────────────┴──────────┘
```

**Examples:**
```bash
favro custom-fields list board-001
favro custom-fields list board-001 --json
```

---

### `custom-fields get`

Get detailed definition for a specific custom field, including options for select fields.

**Syntax:**
```
favro custom-fields get <field-id> [--json]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `<field-id>` | ✓ | Custom field ID |

**Output:**
```
ID:       cf-001
Name:     Priority
Type:     select
Required: no
Board:    board-001
Options:
  - Low (id: opt-low)
  - Medium (id: opt-medium)
  - High (id: opt-high)
  - Critical (id: opt-critical)
```

**Examples:**
```bash
favro custom-fields get cf-001
favro custom-fields get cf-001 --json
```

---

### `custom-fields set`

Set a custom field value on a card.

**Syntax:**
```
favro custom-fields set <card-id> <field-id> <value> [--json]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `<card-id>` | ✓ | Card ID |
| `<field-id>` | ✓ | Custom field ID |
| `<value>` | ✓ | Value to set |

**Value formats by field type:**

| Field Type | Value Format | Example |
|---|---|---|
| `select` | Option name (must match exactly) | `"High"` |
| `text` | Any string | `"my note"` |
| `number` | Numeric string | `"13"` |
| `date` | ISO 8601 date | `"2026-12-31"` |
| `user` | User ID or username | `"alice"` |
| `link` | URL string | `"https://example.com"` |

**Output:**
```
✓ Custom field updated successfully.
  Field: cf-001
  Value: High
```

**Examples:**
```bash
favro custom-fields set card-abc123 cf-001 "High"
favro custom-fields set card-abc123 cf-002 "13"
favro custom-fields set card-abc123 cf-003 "2026-06-30"
favro custom-fields set card-abc123 cf-001 "High" --json
```

---

### `custom-fields values`

List all allowed option values for a select-type custom field.

**Syntax:**
```
favro custom-fields values <field-id> [--board <board-id>] [--json]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `<field-id>` | ✓ | Custom field ID |

**Options:**

| Option | Description |
|---|---|
| `--board <board-id>` | Board ID to scope the field lookup |
| `--json` | Output as JSON |

**Output:**
```
Found 4 option(s) for field cf-001:
┌───┬────────────┬────────────┬─────────┐
│   │ ID         │ Name       │ Color   │
├───┼────────────┼────────────┼─────────┤
│ 0 │ 'opt-low'  │ 'Low'      │ 'green' │
│ 1 │ 'opt-med'  │ 'Medium'   │ 'yellow'│
│ 2 │ 'opt-high' │ 'High'     │ 'orange'│
│ 3 │ 'opt-crit' │ 'Critical' │ 'red'   │
└───┴────────────┴────────────┴─────────┘
```

**Examples:**
```bash
favro custom-fields values cf-001
favro custom-fields values cf-001 --board board-001
favro custom-fields values cf-001 --json
```

---

## Members

### `members list`

List all members, optionally filtered by board or collection.

**Syntax:**
```
favro members list [--board <board-id>] [--collection <coll-id>] [--json]
```

**Options:**

| Option | Description |
|---|---|
| `--board <board-id>` | Filter members by board ID |
| `--collection <coll-id>` | Filter members by collection ID |
| `--json` | Output as JSON |

**Notes:** `--board` and `--collection` are mutually exclusive.

**Output:**
```
Found 4 member(s):
┌───┬────────────┬──────────────┬───────────────────────┬─────────┐
│   │ ID         │ Name         │ Email                 │ Role    │
├───┼────────────┼──────────────┼───────────────────────┼─────────┤
│ 0 │ 'user-001' │ 'Alice Smith'│ 'alice@example.com'   │ 'admin' │
│ 1 │ 'user-002' │ 'Bob Jones'  │ 'bob@example.com'     │ 'member'│
└───┴────────────┴──────────────┴───────────────────────┴─────────┘
```

**Examples:**
```bash
favro members list
favro members list --board board-001
favro members list --collection coll-abc123
favro members list --json
```

**Error cases:**
- Both `--board` and `--collection` specified → `Error: cannot specify both --board and --collection`

---

### `members add`

Add a member by email to a board or collection.

**Syntax:**
```
favro members add <email> --to <target-id> [--board-target] [--collection-target] [--json]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `<email>` | ✓ | Member email address |

**Options:**

| Option | Required | Description |
|---|---|---|
| `--to <target-id>` | ✓ | Board or collection ID |
| `--board-target` | — | Target is a board (default) |
| `--collection-target` | — | Target is a collection |
| `--json` | — | Output as JSON |

**Notes:** Defaults to board target. Use `--collection-target` to add to a collection instead.

**Output:**
```
✓ Member added: alice@example.com (user-001)
```

**Examples:**
```bash
favro members add alice@example.com --to board-001
favro members add bob@example.com --to coll-abc123 --collection-target
favro members add alice@example.com --to board-001 --json
```

**Error cases:**
- Invalid email → `Error: Invalid email format: "<email>"`

---

### `members remove`

Remove a member from a board or collection.

**Syntax:**
```
favro members remove <member-id> --from <target-id> [--board-target] [--collection-target]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `<member-id>` | ✓ | Member ID (from `members list`) |

**Options:**

| Option | Required | Description |
|---|---|---|
| `--from <target-id>` | ✓ | Board or collection ID |
| `--board-target` | — | Target is a board (default) |
| `--collection-target` | — | Target is a collection |

**Output:**
```
✓ Member user-001 removed from board-001
```

**Examples:**
```bash
favro members remove user-001 --from board-001
favro members remove user-002 --from coll-abc123 --collection-target
```

---

### `members permissions`

Get the permission level for a member on a board.

**Syntax:**
```
favro members permissions <member-id> --board <board-id> [--json]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `<member-id>` | ✓ | Member ID |

**Options:**

| Option | Required | Description |
|---|---|---|
| `--board <board-id>` | ✓ | Board ID to check permissions on |
| `--json` | — | Output as JSON |

**Permission levels:** `viewer`, `editor`, `admin`

**Output:**
```
Member user-001 on board board-001: admin
```

**JSON output:**
```json
{
  "memberId": "user-001",
  "boardId": "board-001",
  "permissionLevel": "admin"
}
```

**Examples:**
```bash
favro members permissions user-001 --board board-001
favro members permissions user-001 --board board-001 --json
```

---

## Comments

### `comments list`

List all comments on a card.

**Syntax:**
```
favro comments list <cardId> [--limit <n>] [--json]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `<cardId>` | ✓ | Card ID |

**Options:**

| Option | Default | Description |
|---|---|---|
| `--limit <number>` | `100` | Maximum number of comments to fetch |
| `--json` | — | Output as JSON |

**Output:**
```
💬 Comments on card "card-abc123" — 2 comment(s):

  [comment-001] by alice — 2026-03-15 14:32
    Looks good to me, ready for review.

  [comment-002] by bob — 2026-03-14 09:11
    Updated the implementation to handle edge case.
```

**Examples:**
```bash
favro comments list card-abc123
favro comments list card-abc123 --limit 50
favro comments list card-abc123 --json
```

**Tip:** Use `favro cards list --board <id>` to find card IDs.

---

### `comments add`

Add a comment to a card.

**Syntax:**
```
favro comments add <cardId> --text "COMMENT" [--json]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `<cardId>` | ✓ | Card ID |

**Options:**

| Option | Required | Description |
|---|---|---|
| `--text <comment>` | ✓ | Comment text (cannot be empty or whitespace) |
| `--json` | — | Output as JSON |

**Output:**
```
✓ Comment added: comment-001
```

**Examples:**
```bash
favro comments add card-abc123 --text "Looks good to me"
favro comments add card-abc123 --text "Blocked by API issue" --json
```

**Error cases:**
- Empty text → `Error: Comment text cannot be empty.`

---

## Activity

### `activity log`

Show the activity log for a board, aggregated from card-level activity.

**Syntax:**
```
favro activity log <boardId> [--since <time>] [--limit <n>] [--offset <n>] [--format table|json] [--json]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `<boardId>` | ✓ | Board ID |

**Options:**

| Option | Default | Description |
|---|---|---|
| `--since <time>` | — | Only show activity after this time ago (e.g. `2h`, `1d`, `7d`, `1w`) |
| `--limit <n>` | `200` | Maximum entries to return |
| `--offset <n>` | `0` | Number of entries to skip (for pagination) |
| `--format <format>` | `table` | Output format: `table` or `json` |
| `--json` | — | Shorthand for `--format json` |

**Time unit syntax for `--since`:**

| Example | Meaning |
|---|---|
| `2h` | Last 2 hours |
| `1d` | Last 24 hours |
| `7d` | Last 7 days |
| `1w` | Last 1 week |

**Output:**
```
📋 Activity log for board "board-001" (last 1d) — 5 entry/entries:

  [UPDATED] by alice — 2026-03-28 11:45
    Card: Fix login bug (card-abc123)
    Card status changed to "In Progress"

  [CREATED] by bob — 2026-03-28 09:30
    Card: Add dark mode
    Card "Add dark mode" was created
```

**Implementation note:** Favro does not expose a direct board-level activity endpoint. The CLI fetches cards on the board, filters by the `since` cutoff using `updatedAt`, then aggregates card-level activity entries. If card activity is unavailable, it synthesizes entries from card metadata.

**Examples:**
```bash
favro activity log board-001
favro activity log board-001 --since 1d
favro activity log board-001 --since 7d --format json
favro activity log board-001 --limit 50 --offset 10
```

**Pagination:**
```bash
# Page 1
favro activity log board-001 --limit 20 --offset 0
# Page 2
favro activity log board-001 --limit 20 --offset 20
```

**Error cases:**
- Invalid `--since` format → `Error: <parse error message>`
- Invalid format → `Error: Invalid format "<format>". Use --format table or --format json`

---

## Webhooks

### `webhooks list`

List all configured webhooks for the organization.

**Syntax:**
```
favro webhooks list [--format table|json]
```

**Options:**

| Option | Default | Description |
|---|---|---|
| `--format <format>` | `table` | Output format: `table` or `json` |

**Output:**
```
Found 2 webhook(s):
┌───┬──────────────┬───────────────┬──────────────────────────────────┬────────────┐
│   │ ID           │ Event         │ Target URL                       │ Created    │
├───┼──────────────┼───────────────┼──────────────────────────────────┼────────────┤
│ 0 │ 'hook-001'   │ 'card.created'│ 'https://example.com/webhook'    │ '2026-01-15'│
│ 1 │ 'hook-002'   │ 'card.updated'│ 'https://api.example.com/hooks'  │ '2026-02-10'│
└───┴──────────────┴───────────────┴──────────────────────────────────┴────────────┘
```

**Examples:**
```bash
favro webhooks list
favro webhooks list --format json
```

---

### `webhooks create`

Create a new webhook for a specific event.

**Syntax:**
```
favro webhooks create --event <event> --target <url>
```

**Options:**

| Option | Required | Description |
|---|---|---|
| `--event <event>` | ✓ | Event type: `card.created` or `card.updated` |
| `--target <url>` | ✓ | Target HTTP/HTTPS URL for delivery |

**Supported events:**

| Event | Fires when |
|---|---|
| `card.created` | A new card is created |
| `card.updated` | An existing card is updated |

**Duplicate detection:** The CLI checks for an existing webhook with the same event + URL before creating. If a duplicate exists, it returns an error instead of creating a duplicate.

**Output:**
```
✓ Webhook created: hook-003
  Event:  card.created
  Target: https://example.com/webhook
```

**Examples:**
```bash
favro webhooks create --event card.created --target https://example.com/webhook
favro webhooks create --event card.updated --target https://api.example.com/hooks
```

**Error cases:**
- Invalid event → `Invalid event type: "<event>". Must be one of: card.created, card.updated`
- Invalid URL → `Invalid webhook URL: "<url>". Must be a valid HTTP or HTTPS URL.`
- Duplicate → `Duplicate webhook: a webhook for event "<event>" targeting "<url>" already exists (ID: <id>).`

---

### `webhooks delete`

Delete a webhook by ID.

**Syntax:**
```
favro webhooks delete <webhook-id>
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `<webhook-id>` | ✓ | Webhook ID (from `webhooks list`) |

**Output:**
```
✓ Webhook deleted: hook-003
```

**Examples:**
```bash
favro webhooks delete hook-003
```

**Error cases:**
- Webhook not found → `Webhook not found: "<id>". It may have already been deleted.`

---

## Batch Operations

Favro CLI supports **two complementary approaches** for batch operations, each optimized for different use cases:

### Command Variants — Which to Use?

#### 1. Top-Level `favro batch` Commands (Recommended for Complex Operations)

**Best for:**
- Bulk updates from CSV files with precise field mapping
- Complex filtering and multi-board workflows
- Scripting and automation (stable command surface)
- Operations involving 10+ cards

**Commands:**
- `favro batch update --from-csv <file>` — Update from structured data
- `favro batch move --board <id> --filter <expr> [--to-board|--status]` — Bulk move/status
- `favro batch assign --board <id> --filter <expr> --to <user>` — Bulk assign

**Advantages:**
- Explicit CSV format with predictable error messages
- Comprehensive filter syntax (status, assignee, tag)
- Atomic rollback on partial failure
- `--dry-run` shows exact changes before applying

**Example:**
```bash
# Update 50 cards from a CSV with precise field mappings
favro batch update --from-csv cards.csv --dry-run
favro batch update --from-csv cards.csv
```

---

#### 2. `favro cards update` Command (Recommended for Quick/Simple Updates)

**Best for:**
- Single-card updates (name, status, assignee changes)
- Simple same-status changes on a single board
- Interactive workflows (confirmation prompt)
- One-off updates or testing

**Command:**
- `favro cards update <cardId> --status <status> --assignees <list>` — Update single card

**Advantages:**
- Fast for single-card operations
- Familiar `cards` command namespace
- Built-in confirmation prompt (can skip with `--yes`)
- Works well in interactive terminals

**Example:**
```bash
# Quickly update one card
favro cards update card-001 --status Done --assignees alice
```

---

#### Summary Table

| Scenario | Recommended | Why |
|---|---|---|
| Update 5+ cards from CSV | `favro batch update` | Structured data, predictable |
| Move 10+ cards between boards | `favro batch move` | Efficient filtering, rollback |
| Assign 20+ cards to same user | `favro batch assign` | Filter + assign, atomic |
| Complex AI-driven bulk ops | `favro batch-smart` | Plain-English goals |
| Update one specific card | `favro cards update` | Quick, interactive |
| Quick status change on one card | `favro cards update` | Familiar interface |

---

### All Batch Commands

All batch commands support `--dry-run` to preview changes, and `--json` for machine-readable output.

### `batch update`

Update multiple cards at once from a CSV file. Supports atomic rollback on failure.

**Syntax:**
```
favro batch update --from-csv <file> [--dry-run] [--json] [--verbose]
```

**Options:**

| Option | Required | Description |
|---|---|---|
| `--from-csv <file>` | ✓ | CSV file path |
| `--dry-run` | — | Preview changes without applying |
| `--json` | — | Output result as JSON |
| `--verbose` | — | Show per-card progress |

**CSV format:**

```csv
card_id,status,owner,due_date,custom_field_x
card-001,Done,alice,2026-04-01,high
card-002,In Progress,,2026-04-15,
```

Required column: `card_id`. All other columns are optional.

**Rollback:** If any operation fails, all completed operations in the batch are automatically rolled back to their previous state.

**Output:**
```
⚙  Applying 3 update(s)...
✓ 3 operations succeeded (0 failed)
```

**Dry-run output:**
```
Dry-run preview — 3 update(s):
  • [card-001] Fix login bug
    status: Todo → Done
  • [card-002] Add dark mode
    owner: (none) → alice

ℹ  Dry-run mode. No changes were made.
```

**Examples:**
```bash
favro batch update --from-csv updates.csv --dry-run
favro batch update --from-csv updates.csv
favro batch update --from-csv updates.csv --json
favro batch update --from-csv updates.csv --verbose
```

**Error cases:**
- CSV file not found → `✗ Cannot read CSV file "<file>": <error>`
- CSV validation errors → Lists row/field errors and exits
- Empty CSV → `✗ CSV file has no valid data rows`

---

### `batch move`

Move matching cards from a board to a new board or status.

**Syntax:**
```
favro batch move --board <id> [--to-board <id>] [--status <value>]
                 [--filter <expr>] [--dry-run] [--json] [--verbose]
```

**Options:**

| Option | Required | Description |
|---|---|---|
| `--board <id>` | ✓ | Source board ID |
| `--to-board <id>` | — | Destination board ID |
| `--status <value>` | — | Target status to set |
| `--filter <expression>` | — | Filter expression (repeatable, AND logic) |
| `--dry-run` | — | Preview without applying |
| `--json` | — | Output result as JSON |
| `--verbose` | — | Show per-card progress |

**Notes:** At least one of `--to-board` or `--status` must be specified.

**Filter syntax:**

| Expression | Matches |
|---|---|
| `status:<value>` | Cards with this exact status |
| `assignee:<user>` | Cards where user is in assignees list |
| `tag:<tag>` | Cards with this tag |

**Examples:**
```bash
favro batch move --board board-001 --to-board board-002 --filter "status:Completed"
favro batch move --board board-001 --status Done --filter "tag:sprint-42" --dry-run
favro batch move --board board-001 --to-board archive-board --status Archived
```

**Error cases:**
- No `--to-board` or `--status` → `✗ Specify --to-board and/or --status to set the target state`
- Board not found → `✗ Board not found: "<id>"`
- No matching cards → Shows count and exits 0

---

### `batch assign`

Assign matching cards to a user. Automatically skips cards already assigned to that user.

**Syntax:**
```
favro batch assign --board <id> --to <user> [--filter <expr>] [--dry-run] [--json] [--verbose]
```

**Options:**

| Option | Required | Description |
|---|---|---|
| `--board <id>` | ✓ | Board ID |
| `--to <user>` | ✓ | User to assign to (use `@me` for yourself) |
| `--filter <expression>` | — | Filter expression (repeatable, AND logic) |
| `--dry-run` | — | Preview without applying |
| `--json` | — | Output result as JSON |
| `--verbose` | — | Show per-card progress |

**`@me` handling:** `@me` is resolved at runtime. In production it maps to the current user. Cards already assigned to the target user are automatically skipped.

**Examples:**
```bash
favro batch assign --board board-001 --filter "status:Backlog" --to alice
favro batch assign --board board-001 --filter "status:Backlog" --to @me --dry-run
favro batch assign --board board-001 --to bob
```

---

### `batch-smart`

Apply complex bulk updates using plain-English goals. The CLI parses the goal, selects matching cards, and executes atomically.

**Syntax:**
```
favro batch-smart <board> --goal "<goal>" [--dry-run] [--yes] [--json]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `<board>` | ✓ | Board ID |

**Options:**

| Option | Required | Description |
|---|---|---|
| `--goal <goal>` | ✓ | Plain-English goal string |
| `--dry-run` | — | Preview without applying |
| `--yes` | — | Skip confirmation prompt |
| `--json` | — | Output result as JSON |

**Supported goal patterns:**

| Pattern | Example |
|---|---|
| `move all <filter> cards to <status>` | `"move all overdue cards to Review"` |
| `assign all <filter> cards [with no owner] to <user>` | `"assign all Backlog cards with no owner to alice"` |
| `close all <filter> cards` | `"close all Done cards"` |
| `unassign all <filter> cards` | `"unassign all blocked cards"` |

**Filter keywords:**

| Keyword | Matches |
|---|---|
| `overdue` | Cards where `dueDate` is in the past |
| `blocked` | Cards with `blocked` in tags or status |
| `unassigned` | Cards with no assignees |
| `<status-name>` | Cards matching the status (case-insensitive) |
| `all` | All cards |

Filters can be combined: `"overdue and unassigned"`, `"Backlog and blocked"`.

**Atomic execution:** Operations run sequentially. If any operation fails, all previously completed operations are rolled back. The confirmation prompt is shown unless `--yes` is passed.

**Output:**
```
🎯 Goal: Move overdue cards to "Review"

📋 Preview (3 cards affected):

  • [card-001] Fix authentication service
    → status: Review
  • [card-002] Update API documentation
    → status: Review

Apply 3 change(s)? (y/n) y

⚙  Applying 3 changes...

✅ Batch update complete!
   ✓ Success: 3
   ⏭  Skipped (already in target state): 1
   ✗ Failed: 0
```

**Examples:**
```bash
favro batch-smart board-001 --goal "move all overdue cards to Review"
favro batch-smart board-001 --goal "assign all Backlog cards with no owner to alice"
favro batch-smart board-001 --goal "close all Done cards" --dry-run
favro batch-smart board-001 --goal "unassign all blocked cards" --yes --json
```

**Error cases:**
- Unparseable goal → Error with supported patterns and examples
- Board not found → `✗ Board not found: "<board>"` with hint to run `favro boards list`
- No matching cards → Shows message with total card count and exits 0
- Operation failure → Full rollback; exits 1 with error details

---

## Troubleshooting Guide

### Authentication Errors

**`Error: No API key configured`**

You haven't set up authentication.

```bash
favro auth login
# or
export FAVRO_API_KEY=your_key_here
```

**`Error: API key is invalid or unauthorized` (HTTP 401)**

Your key may be revoked or expired.

1. Run `favro auth check` to confirm
2. Go to Favro → **Organization Settings** → **API tokens**
3. Generate a new token
4. Run `favro auth login` with the new key

**`Error: Missing required environment variable: FAVRO_API_TOKEN`**

Some commands fall back to the legacy variable. Use `FAVRO_API_KEY` instead:

```bash
export FAVRO_API_KEY=your_key_here
```

---

### Rate Limit Errors (HTTP 429)

Favro enforces rate limits on the API. When hit:

- The CLI does not automatically retry (retry logic is in the HTTP client)
- Wait a few seconds before retrying
- For bulk operations, use `--dry-run` first to estimate the number of API calls

**Prevention:**
- Use `--limit` flags to reduce request sizes
- Use `favro batch` commands instead of individual API calls in loops
- Avoid running multiple CLI instances in parallel against the same organization

---

### Resource Not Found (HTTP 404)

**`✗ Collection not found: <id>`**
```bash
favro collections list  # Find valid IDs
```

**`✗ Board not found: <id>`**
```bash
favro boards list  # Find valid IDs
```

**`Error: Card '<id>' not found`**
```bash
favro cards list --board <boardId>  # Find valid card IDs
```

**`Webhook not found: "<id>"`**
```bash
favro webhooks list  # The webhook may already be deleted
```

---

### Invalid IDs

IDs are case-sensitive strings from the Favro API. Common mistakes:

- Using a board **name** instead of board **ID** — use `favro boards list` to get the ID column
- Copying IDs with leading/trailing spaces — trim before use
- Using a collection ID where a board ID is expected — they are different resources

---

### CSV Errors

**`✗ CSV validation errors:`**

Your CSV has formatting issues. Ensure:
- First row is the header: `card_id,status,...`
- At least one data row exists
- `card_id` column is present and non-empty for all rows
- Dates are in `YYYY-MM-DD` format

**`✗ Cannot read CSV file "<file>"`**

- Check the file path is correct
- Ensure the file has read permissions

---

### Output Path Errors

**`Error: Output path must be within current directory`**

```bash
# ✓ Relative path (OK)
favro cards export abc123 --format csv --out ./exports/cards.csv

# ✗ Absolute path (rejected)
favro cards export abc123 --format csv --out /tmp/cards.csv
```

---

### Circular Dependency Errors

**`Error: Linking would create a circular dependency. Aborting.`**

You attempted to add a `depends-on` link that would create a cycle. Review your dependency graph:

```bash
favro cards dependencies CARD-A
favro cards blockers CARD-A
favro cards blocked-by CARD-A
```

---

### Network / Timeout Errors

```bash
# Verify Favro API is reachable
curl -s -o /dev/null -w "%{http_code}" https://favro.com/api/v1/organizations

# If behind a proxy
export HTTPS_PROXY=https://your-proxy:8080
```

---

### Verbose Mode

Add `--verbose` (global flag) to see detailed error output:

```bash
favro --verbose collections list
favro --verbose cards get card-abc123
```

---

## Performance Tips

### Pagination Best Practices

**Activity log pagination:** Use `--offset` and `--limit` to page through large result sets:

```bash
# Fetch in pages of 50
favro activity log board-001 --limit 50 --offset 0   # page 1
favro activity log board-001 --limit 50 --offset 50  # page 2
favro activity log board-001 --limit 50 --offset 100 # page 3
```

**Cards export with large datasets:** For boards with thousands of cards, `favro cards export` handles pagination automatically. The default `--limit 10000` covers most boards. For very large boards, pipe to stdout rather than file to avoid memory issues:

```bash
favro cards export big-board --format json | jq '. | length'
```

---

### Query Optimization

**Filter early, not late:** Use `--filter` in export commands to reduce data transferred and processed:

```bash
# Fast: filter at source
favro cards export board-001 --filter "status:Done" --format json

# Slow: export all, filter with jq
favro cards export board-001 --format json | jq '.[] | select(.status == "Done")'
```

**Use `--limit` appropriately:** `cards list` defaults to 50 for quick results. Increase only when needed:

```bash
# Quick check (default 50)
favro cards list --board board-001

# Full board (up to 500)
favro cards list --board board-001 --limit 500
```

**Batch operations over loops:** A single `favro batch` command is far more efficient than a shell loop calling individual `cards update`:

```bash
# Fast: one batch call
favro batch assign --board board-001 --filter "status:Backlog" --to alice

# Slow: N individual calls
favro cards list --board board-001 --status Backlog --json \
  | jq -r '.[].cardId' \
  | while read id; do favro cards update "$id" --assignees alice; done
```

**Use `--include` selectively:** Only request what you need:

```bash
# Faster: just stats
favro boards get board-001 --include stats

# Slower: all includes
favro boards get board-001 --include custom-fields,cards,members,stats,velocity
```

---

### Batch Operation Best Practices

1. **Always dry-run first:**
   ```bash
   favro batch update --from-csv updates.csv --dry-run
   favro batch-smart board-001 --goal "close all Done cards" --dry-run
   ```

2. **Use `--verbose` to track progress on large batches:**
   ```bash
   favro batch update --from-csv big-update.csv --verbose
   ```

3. **CSV batch size:** Keep CSV files under 1,000 rows per batch. For larger datasets, split into multiple files:
   ```bash
   split -l 500 all-updates.csv batch-
   for f in batch-*; do favro batch update --from-csv "$f"; done
   ```

4. **Rollback is automatic:** If a batch fails mid-way, all completed operations are rolled back. You don't need to manually undo changes.

5. **`batch-smart` for ad-hoc operations:** Use `batch-smart` for one-off bulk changes described in plain English. Use `batch update`/`batch move`/`batch assign` for repeatable scripted workflows.

---

### Reducing API Calls

- **Collections/boards rarely change:** Cache IDs locally rather than calling `collections list` or `boards list` on every script run
- **Comment and activity operations are read-heavy:** Batch reads where possible using `--limit`
- **Webhook management is low-frequency:** List webhooks once, manage via IDs stored in scripts

---

## Common Workflows

### Sprint Planning

Set up a new sprint from a planning spreadsheet:

```bash
# 1. Create a new board in the sprint collection
COLLECTION_ID=$(favro collections list --json | jq -r '.[] | select(.name | contains("Sprints")) | .collectionId')
favro boards create $COLLECTION_ID --name "Sprint 43" --type kanban

BOARD_ID=$(favro boards list --json | jq -r '.[] | select(.name == "Sprint 43") | .boardId')

# 2. Import tasks from planning CSV
favro cards create --csv sprint-43-planning.csv --board $BOARD_ID --dry-run
favro cards create --csv sprint-43-planning.csv --board $BOARD_ID

# 3. Assign cards to team
favro batch assign --board $BOARD_ID --filter "status:Todo" --to alice
favro batch assign --board $BOARD_ID --filter "tag:backend" --to bob

# 4. Verify setup
favro boards get $BOARD_ID --include stats
```

---

### Daily Standup Report

Generate a quick board summary:

```bash
BOARD_ID="sprint-43-board-id"

echo "=== Standup Report: $(date +%Y-%m-%d) ==="
echo ""
echo "--- In Progress ---"
favro cards list --board $BOARD_ID --status "In Progress"
echo ""
echo "--- Done Today ---"
favro activity log $BOARD_ID --since 1d --format json \
  | jq -r '.[] | select(.type == "updated") | "  \(.cardName): \(.description)"'
```

---

### Bulk Status Update (Sprint Closeout)

Move all remaining "In Progress" cards to "Review" at end of sprint:

```bash
# Preview first
favro batch-smart board-001 --goal "move all in progress cards to Review" --dry-run

# Apply with confirmation
favro batch-smart board-001 --goal "move all in progress cards to Review"

# Close all done cards
favro batch-smart board-001 --goal "close all Done cards" --yes
```

---

### Dependency Graph for Release Planning

Map out what's blocking what before a release:

```bash
# For each blocking card, see what it blocks
CARD_IDS=$(favro cards list --board board-001 --json | jq -r '.[].cardId')

for id in $CARD_IDS; do
  BLOCKERS=$(favro cards blockers $id --json | jq -r '.[].cardId')
  if [ -n "$BLOCKERS" ]; then
    NAME=$(favro cards get $id --json | jq -r '.name')
    echo "$id ($NAME) blocks: $BLOCKERS"
  fi
done
```

---

### Webhook-Driven Automation

Set up webhooks for CI/CD integration:

```bash
# Create webhook for new cards (triggers CI job creation)
favro webhooks create \
  --event card.created \
  --target https://ci.example.com/api/favro/card-created

# Create webhook for card updates (triggers notification)
favro webhooks create \
  --event card.updated \
  --target https://slack-relay.example.com/favro

# List active webhooks
favro webhooks list

# Remove a stale webhook
favro webhooks delete hook-old-001
```

---

### Custom Field Reporting

Extract custom field values for reporting:

```bash
BOARD_ID="board-001"
PRIORITY_FIELD="cf-priority-id"

# List all priority options
favro custom-fields values $PRIORITY_FIELD

# Get all cards with their priority custom field
favro cards list --board $BOARD_ID --json \
  | jq -r '.[].cardId' \
  | while read id; do
    favro cards get $id --include custom-fields --json \
      | jq -r ". | {id: .cardId, name: .name, priority: (.customFields[]? | select(.fieldId == \"$PRIORITY_FIELD\") | .displayValue)}"
  done
```

---

### CI/CD Integration

Export and archive sprint data in GitHub Actions:

```yaml
name: Weekly Sprint Archive

on:
  schedule:
    - cron: '0 18 * * 5'  # Fridays at 6 PM

jobs:
  archive:
    runs-on: ubuntu-latest
    steps:
      - name: Install favro-cli
        run: npm install -g @square-moon/favro-cli

      - name: Export Done cards
        env:
          FAVRO_API_KEY: ${{ secrets.FAVRO_API_KEY }}
        run: |
          DATE=$(date +%Y-%m-%d)
          favro cards export ${{ vars.SPRINT_BOARD_ID }} \
            --format json \
            --filter "status:Done" \
            --out done-$DATE.json
          echo "Exported $(cat done-$DATE.json | jq length) done cards"

      - name: Activity summary
        env:
          FAVRO_API_KEY: ${{ secrets.FAVRO_API_KEY }}
        run: |
          favro activity log ${{ vars.SPRINT_BOARD_ID }} \
            --since 7d \
            --format json \
            --out activity-week.json

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: sprint-archive-${{ github.run_id }}
          path: "*.json"
```

---

*Generated for CLA-1793 — FAVRO-031: User Documentation (SPEC-002)*
