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
  - [cards blocking](#cards-blocking)
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
  - [activity](#activity-1)
- [Webhooks](#webhooks)
  - [webhooks list](#webhooks-list)
  - [webhooks create](#webhooks-create)
  - [webhooks delete](#webhooks-delete)
- [Columns](#columns)
- [Widgets](#widgets)
- [Tags](#tags)
- [Tasks & Tasklists](#tasks--tasklists)
- [Dependencies](#dependencies)
- [Attachments](#attachments)
- [Users & Groups](#users--groups)
- [Batch Operations](#batch-operations)
  - [cards update --from-csv](#cards-update---from-csv)
  - [The removed spellings](#the-removed-spellings)
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
| **Activity** | activity | Card activity history (no board-level feed exists) |
| **Webhooks** | list, create, delete | Configure HTTP event notifications |
| **Columns** | list, create, update | Directly manage board structures |
| **Widgets** | list, add | Map cards to multiple boards natively |
| **Tags** | list, create, delete | Workspace tag management |
| **Tasks** | list, add | Internal card checklists |
| **Dependencies** | list, add | Native API blockers & relates-to |
| **Attachments** | upload | Add files to cards/comments |
| **Users & Groups**| list | Manage identity outside of boards |
| **Batch Operations** | `cards update --from-csv` | Up to 20 enumerated card updates, one transaction |

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
favro collections list [--human]
```

**Options:**

| Option | Default | Description |
|---|---|---|
| `--human` | — | Table instead of the default JSON envelope (root flag) |
| `--pretty` | — | Indent the JSON (root flag) |

**Output (`--human`):**

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
favro collections list                       # {"rows":[…]} — the default
favro collections list --human               # the table above
favro collections list | jq -r '.rows[].name'
```

**Error cases:**
- Missing API key → `Error: No API key configured`
- Network error → `Error: <http error>`

---

### `collections get`

Retrieve a single collection by ID, with optional related data.

**Syntax:**
```
favro collections get <id> [--include boards,stats] [--human]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `<id>` | ✓ | Collection ID (from `collections list`) |

**Options:**

| Option | Description |
|---|---|
| `--include <options>` | Comma-separated: `boards`, `stats` |
| `--human` | Table/detail view instead of the default JSON (root flag) |

**Include values:**

| Value | Description |
|---|---|
| `boards` | Embed list of boards in the collection |
| `stats` | Include board and member counts |

**Output (`--human`):**
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
favro collections get coll-abc123 --human    # the detail view above
```

**Error cases:**
- Collection not found → `✗ Collection not found: <id>. Use 'favro collections list' to see available collections.`
- Invalid `--include` value → `Error: Invalid --include values: <value>. Valid options: boards, stats`

---

### `collections create`

Create a new collection.

**Syntax:**
```
favro collections create --name "NAME" [--description "DESC"] [--human] [--dry-run]
```

**Options:**

| Option | Required | Description |
|---|---|---|
| `--name <name>` | ✓ | Collection name (cannot be blank) |
| `--description <text>` | — | Collection description |
| `--human` | — | Print the `✓ Collection created` lines instead of JSON (root flag) |
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
favro collections create --name "Sprint Q2 2026" --description "All Q2 sprint boards"
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
favro collections update <id> [--name "NEW_NAME"] [--description "DESC"] [--human] [--dry-run]
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
| `--human` | Print the `✓ Collection updated` lines instead of JSON (root flag) |
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
favro boards list [collection-id] [--collection <name>] [--include stats,velocity] [--human]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `[collection-id]` | — | Collection ID positional arg (enables extended listing with `--include`) |

**Options:**

| Option | Description |
|---|---|
| `--collection <collection>` | Filter boards by collection id or exact name (trimmed, case-insensitive; narrowed on the wire). A name matching two collections refuses with both ids |
| `--include <options>` | Comma-separated: `stats`, `velocity` |
| `--human` | Table/detail view instead of the default JSON (root flag) |

**Include values:**

| Value | Description |
|---|---|
| `stats` | Add the open/done card columns. Both read `unknown` — see "Card counts read `unknown`" below |
| `velocity` | Add the weekly velocity column. Reads `unknown` — see "Card counts read `unknown`" below |

**Output (`--human`):**
```
Found 2 board(s):
┌───┬───────────┬─────────────┬───────┬─────────┬────────────┐
│   │ ID        │ Name        │ Cards │ Columns │ Updated    │
└───┴───────────┴─────────────┴───────┴─────────┴────────────┘
```

**Output (`--human --include stats,velocity`):**
```
┌───┬───────────┬─────────────┬───────┬────────────┬─────────┬─────────┬──────────┐
│   │ ID        │ Name        │ Cards │ Updated    │ Open    │ Done    │ Velocity │
└───┴───────────┴─────────────┴───────┴────────────┴─────────┴─────────┴──────────┘
Note: done/open/overdue counts and the velocity figures are unknown, not zero — …
```

**Card counts read `unknown`, and that is the honest answer.** `GET /widgets` sends no cards and no
per-board card count — measured 2026-08-12, see the "boards get" section below — so `Open`, `Done`
and `Velocity` come back `unknown` for every board and the JSON carries `null`, never `0`. The rows
also carry an `unmeasured` string explaining it. `null` is not zero: treat it as unread. For counts
that *are* measured, run `favro columns list <boardId>`, which reports `cardCount` per column
(excluding archived cards) from the same response it already fetches.

**Examples:**
```bash
favro boards list                            # {"rows":[…]} — the default
favro boards list --human                    # the table above
favro boards list --collection "Sprint"
favro boards list coll-abc123 --include stats,velocity
favro columns list board-abc123              # the card counts that ARE measured
```

**Error cases:**
- Collection name not found → `✗ No boards found in collection "<name>".`
- Multiple collections match → Warning + uses first match

---

### `boards get`

Get detailed information about a board.

**Syntax:**
```
favro boards get <id> [--include custom-fields,cards,members,stats,velocity] [--human]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `<id>` | ✓ | Board ID |

**Options:**

| Option | Description |
|---|---|
| `--include <options>` | Comma-separated: `custom-fields`, `cards`, `members`, `stats`, `velocity` |

**Include values:**

| Value | Description |
|---|---|
| `custom-fields` | List custom fields defined on the board |
| `cards` | Forwarded to the API. Favro sends no cards back — see "Card counts read `unknown`" below |
| `members` | List board members with roles |
| `stats` | The card-count section: total, open, done, overdue. All four read `unknown` |
| `velocity` | Weekly velocity table. Every figure reads `unknown` |

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
  Total cards:   unknown
  Open cards:    unknown
  Done cards:    unknown
  Overdue cards: unknown

Note: done/open/overdue counts and the velocity figures are unknown, not zero — GET
/widgets/{id}?include=cards was measured (2026-08-12) to return no cards array at all, and no board
path reads cards. For measured per-column card counts run: favro columns list <boardId>
```

**Card counts read `unknown`, and that is the honest answer.** Probed against a throwaway board on
2026-08-12, `GET /widgets/{id}?include=cards` answers with these keys and no others: `archived`,
`collectionIds`, `color`, `columns`, `editRole`, `name`, `organizationId`, `ownerRole`, `type`,
`widgetCommonId`. There is no `cards` array — not empty, absent — and no `cardCount`, so
`include=cards` does nothing on that endpoint and nothing this command reads can split a board's
cards into done and open. Those four facets therefore report `unknown` in `--human` and `null` in
JSON, and they used to report `0`, which was not a measurement of anything. Same for the velocity
table: `completed`, `added` and `netChange` are all `null`.

`null` is not zero — treat it as unread. For card counts that *are* measured, run `favro columns
list <boardId>`: `GET /columns` carries `cardCount` per column (excluding archived cards), plus
`timeSum` and `estimationSum`.

**Examples:**
```bash
favro boards get board-001
favro boards get board-001 --include members,stats
favro boards get board-001 --include custom-fields,cards,members,stats,velocity
favro columns list board-001                 # the card counts that ARE measured
```

**Error cases:**
- Board not found → `✗ Board not found: <id>`
- Invalid include → `✗ Invalid include option(s): <value>`

---

### `boards create`

Create a new board in a collection.

**Syntax:**
```
favro boards create <collection-id> --name "NAME" [--type board|list|kanban] [--description "DESC"] [--human] [--dry-run]
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
| `--human` | — | Print the `✓ Board created` lines instead of JSON (root flag) |
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
favro boards update <id> [--name "NEW"] [--description "DESC"] [--human] [--dry-run]
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
| `--human` | Print the `✓ Board updated` lines instead of JSON (root flag) |
| `--dry-run` | Preview the update. Reads the board first to check the scope lock |

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
                 [--filter <expression>] [--limit <n>] [--human]
```

**Options:**

| Option | Default | Description |
|---|---|---|
| `--board <id>` | — | Board ID to list cards from |
| `--status <status>` | — | Filter by status (case-insensitive, legacy) |
| `--assignee <user>` | — | Filter by assignee (substring match, legacy) |
| `--tag <tag>` | — | Filter by tag (substring match, legacy) |
| `--filter <expression>` | — | Enhanced query filter (repeatable); overrides legacy flags |
| `--limit <number>` | `25` | Cap how many cards are **printed**; sets `truncated`. The board is always fetched to completion. Whole digits of 1 or more — anything else is refused, exit 1 |

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
favro cards list --board abc123 | jq '.rows[].name'
```

**Error cases:**
- Board not found → Suggests closest board name from available boards
- Invalid filter → `✗ Invalid filter expression: <error>`

---

### `cards get`

Retrieve a single card by ID with optional metadata.

**Syntax:**
```
favro cards get <cardId> [--include board,collection,custom-fields,links,comments,relations] [--human]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `<cardId>` | ✓ | Card ID |

**Options:**

| Option | Description |
|---|---|
| `--include <items>` | Comma-separated metadata: `board`, `collection`, `custom-fields`, `links`, `comments`, `relations` |
| `--human` | One-row summary instead of JSON; ignored when `--include` is present (root flag) |

**Include values:**

| Value | Description |
|---|---|
| `board` | Embed parent board info |
| `collection` | Embed parent collection info |
| `custom-fields` | Include custom field values on the card |
| `links` | Include card relationship links |
| `comments` | Embed card comments |
| `relations` | Include relation metadata |

**Output (`--human`):**
```
┌───┬──────────┬──────────────┬───────────┬──────────┬───────┬──────────┬────────────┐
│   │ ID       │ Title        │ Status    │ Assignees│ Tags  │ Due Date │ Created    │
└───┴──────────┴──────────────┴───────────┴──────────┴───────┴──────────┴────────────┘
```

When `--include` is used the output is JSON even under `--human`: the one-row
summary would hide most of what was fetched.

**Examples:**
```bash
favro cards get card-abc123                  # the card, bare JSON
favro cards get card-abc123 --human          # the row above
favro cards get card-abc123 --include board,collection
favro cards get card-abc123 --include board,collection,custom-fields,links,comments
```

**Error cases:**
- Card not found → `Error: Card '<id>' not found.`
- Invalid include → `Error: Invalid include value(s): <value>. Valid: board,collection,...`

---

### `cards link`

Create a relationship link between two cards.

**Syntax:**
```
favro cards link <cardId> <toCardId> --type <type> [--human]
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
favro cards link CARD-A CARD-B --type related --human
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

**Examples:**
```bash
favro cards move card-abc123 --to-board board-456
favro cards move card-abc123 --to-board board-456 --position top
favro cards move card-abc123 --to-board board-456 --position bottom --human
```

**Error cases:**
- Card or board not found → `Error: Card '<id>' or board '<id>' not found.`
- Invalid position → `Error: Invalid position '<pos>'. Valid: top, bottom`

---

### `cards show`

Show card details with optional relationship info.

**Syntax:**
```
favro cards show <cardId> [--relationships] [--human]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `<cardId>` | ✓ | Card ID |

**Options:**

| Option | Description |
|---|---|
| `--relationships` | Include all relationship links for this card |

**Examples:**
```bash
favro cards show CARD-ID
favro cards show CARD-ID --relationships
favro cards show CARD-ID --relationships --human
```

---

### `cards dependencies`

List all cards this card depends on (`depends-on` links).

**Syntax:**
```
favro cards dependencies <cardId> [--limit <n>] [--human]
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
favro cards dependencies CARD-A --human
```

**Error cases:**
- Card not found → `Error: Card '<id>' not found.`

---

### `cards blocking`

List all cards blocked by this card (`blocks` links).

**Syntax:**
```
favro cards blocking <cardId> [--limit <n>] [--human]
```

**Output:**
```
Cards blocked by CARD-A:
  ⛔ CARD-D (Deploy to production)
```

**Examples:**
```bash
favro cards blocking CARD-A
favro cards blocking CARD-A --human
```

---

### `cards blocked-by`

List all cards that are blocking this card (inferred from `depends-on` links).

**Syntax:**
```
favro cards blocked-by <cardId> [--limit <n>] [--human]
```

**Output:**
```
Cards blocking CARD-D:
  🚫 CARD-A (Implement feature X)
```

**Examples:**
```bash
favro cards blocked-by CARD-D
favro cards blocked-by CARD-D --human
```

---

### `cards export`

Export all cards from a board to JSON or CSV, with optional filtering and progress display.

**Syntax:**
```
favro cards export <board> [--format json|csv] [--out <file>] [--filter <expression>]
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

There is no `--limit`. It was removed in #44 because it capped the **fetch**, so an
export could silently be a partial export of a board — the same defect as the old
`cards list --limit`. Passing it exits 1 with `unknown option '--limit'`. Narrow with
`--filter` instead.

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
favro custom-fields list <board-id> [--limit <n>] [--human]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `<board-id>` | ✓ | Board ID to list custom fields for |

**Options:**

| Option | Description |
|---|---|

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
favro custom-fields list board-001 --human
```

---

### `custom-fields get`

Get detailed definition for a specific custom field, including options for select fields.

**Syntax:**
```
favro custom-fields get <field-id> [--human]
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
favro custom-fields get cf-001 --human
```

---

### `custom-fields set`

Set a custom field value on a card.

**Syntax:**
```
favro custom-fields set <card-id> <field-id> <value> [--human]
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
favro custom-fields set card-abc123 cf-001 "High" --human
```

---

### `custom-fields values`

List all allowed option values for a select-type custom field.

**Syntax:**
```
favro custom-fields values <field-id> [--board <board-id>] [--limit <n>] [--human]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `<field-id>` | ✓ | Custom field ID |

**Options:**

| Option | Description |
|---|---|
| `--board <board-id>` | Board ID to scope the field lookup |

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
favro custom-fields values cf-001 --human
```

---

## Members

### `members list`

List all members, optionally filtered by board or collection.

**Syntax:**
```
favro members list [--board <board-id>] [--collection <coll-id>] [--limit <n>] [--human]
```

**Options:**

| Option | Description |
|---|---|
| `--board <board-id>` | Filter members by board ID |
| `--collection <coll-id>` | Filter members by collection ID |
| `--limit <n>` | Cap how many rows are printed; sets `truncated` |
| `--human` | Table instead of the default JSON envelope (root flag) |

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
favro members list --human
```

**Error cases:**
- Both `--board` and `--collection` specified → `Error: cannot specify both --board and --collection`

---

### `members add`

Add a member by email to a board or collection.

**Syntax:**
```
favro members add <email> --to <target-id> [--board-target] [--collection-target] [--human]
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

**Notes:** Defaults to board target. Use `--collection-target` to add to a collection instead.

**Output:**
```
✓ Member added: alice@example.com (user-001)
```

**Examples:**
```bash
favro members add alice@example.com --to board-001
favro members add bob@example.com --to coll-abc123 --collection-target
favro members add alice@example.com --to board-001 --human
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
favro members permissions <member-id> --board <board-id> [--human]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `<member-id>` | ✓ | Member ID |

**Options:**

| Option | Required | Description |
|---|---|---|
| `--board <board-id>` | ✓ | Board ID to check permissions on |

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
favro members permissions user-001 --board board-001 --human
```

---

## Comments

### `comments list`

List all comments on a card.

**Syntax:**
```
favro comments list <cardId> [--limit <n>] [--human]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `<cardId>` | ✓ | Card ID |

**Options:**

| Option | Default | Description |
|---|---|---|
| `--limit <number>` | `100` | Maximum number of comments to **print**. The fetch always runs to completion; when the cap cuts rows the output says so |

**Output:**
```
💬 Comments on card "card-abc123" — 2 comment(s):

  [comment-001] by alice — 2026-03-15 14:32
    Looks good to me, ready for review.

  [comment-002] by bob — 2026-03-14 09:11
    Updated the implementation to handle edge case.
```

Over the cap, the header names both numbers rather than presenting the capped
count as the total:
```
💬 Comments on card "card-abc123" — showing 100 of 150 comment(s):
```

`--json` emits the list envelope every list read emits, not a bare array —
`truncated: true` is present only when `--limit` cut rows off a complete fetch:
```json
{"rows":[{"commentId":"comment-001","...":"..."}],"truncated":true}
```

**Examples:**
```bash
favro comments list card-abc123
favro comments list card-abc123 --limit 50
favro comments list card-abc123 --human
```

**Tip:** Use `favro cards list --board <id>` to find card IDs.

---

### `comments add`

Add a comment to a card.

**Syntax:**
```
favro comments add <cardId> --text "COMMENT" [--human]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `<cardId>` | ✓ | Card ID |

**Options:**

| Option | Required | Description |
|---|---|---|
| `--text <comment>` | ✓ | Comment text (cannot be empty or whitespace) |

**Output:**
```
✓ Comment added: comment-001
```

**Examples:**
```bash
favro comments add card-abc123 --text "Looks good to me"
favro comments add card-abc123 --text "Blocked by API issue" --human
```

**Error cases:**
- Empty text → `Error: Comment text cannot be empty.`

---

## Activity

### `activity`

Show the activity log for a card.

**Syntax:**
```
favro activity <card> [--since <time>] [--until <time>] [--limit <n>]
```

**Arguments:**

| Argument | Required | Description |
|---|---|---|
| `<card>` | ✓ | Card ID (use `favro cards find` to get one) |

**Options:**

| Option | Default | Description |
|---|---|---|
| `--since <time>` | — | Only show activity after this time ago (e.g. `2h`, `1d`, `7d`, `1w`) |
| `--until <time>` | — | Only show activity before this time ago |
| `--limit <n>` | `200` | Maximum entries to **print**; the fetch is uncapped |
| `--human` | — | Human-readable output (root flag). JSON is the default |

**Time unit syntax for `--since` and `--until`:**

| Example | Meaning |
|---|---|
| `2h` | Last 2 hours |
| `1d` | Last 24 hours |
| `7d` | Last 7 days |
| `1w` | Last 1 week |

**Output:**
```
📋 Activity for Fix login bug (card-abc123) (last 1d) — 2 entry/entries:

  [UPDATED] by alice — 2026-03-28 11:45
    Sprint 42 / In Progress

  [CREATED] by bob — 2026-03-28 09:30
    Sprint 42 / Backlog
```

The header count is what was **printed**. When `--limit` cut the list, a
`(truncated to N of M — raise --limit to see the rest)` line closes the output,
and the default JSON carries the same fact as `truncated: true` on the envelope.
There is no `--json` flag on this command — JSON is the default and `--human` is
the only way out (#116). Passing one is `error: unknown option '--json'`.

**Scope note:** Favro has no board-level activity feed, so there is no board form of this command. The feed is also scoped to what the API-key user follows or has news for, so it is card history for humans — never a source of truth for a card's state.

**Examples:**
```bash
favro activity card-abc123
favro activity card-abc123 --since 1d
favro activity card-abc123 --since 7d
favro activity card-abc123 --until 1d --limit 50
```

**Error cases:**
- Invalid `--since` format → `Error: <parse error message>`

---

## Webhooks

### `webhooks list`

List all configured webhooks for the organization.

**Syntax:**
```
favro webhooks list [--limit <n>] [--human]
```

**Options:**

| Option | Default | Description |
|---|---|---|
| `--limit <n>` | — | Cap how many rows are printed; sets `truncated` |
| `--human` | — | Table instead of the default JSON envelope (root flag) |

**Output (`--human`):**
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
favro webhooks list --human
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

## Columns

Allows direct inspection and management of board workflows without full context payloads.

- `favro columns list <boardId>`
- `favro columns create <boardId> --name "New State"`
- `favro columns update <columnId> --name "Updated State"`

---

## Widgets

The Widget API is how Favro technically places the same `card` onto multiple different `boards` (e.g. from a Backlog board to a Kanban board). 

- `favro widgets list --card <cardCommonId>` (See all boards a card sits on)
- `favro widgets add <boardId> <cardCommonId>` (Adds an existing card to a new board without duplicating the underlying card)

---

## Tags

- `favro tags list` (Shows all global workspace tags)
- `favro tags create --name "Bug" --color red`

---

## Tasks & Tasklists

Allows management of the granular checklists inside a single card.

- `favro tasks list <cardId>`
- `favro tasks add <cardId> "Create new DB schema"`

---

## Dependencies

Directly uses Favro's native Dependency API for strict blockers instead of generic link mapping.

- `favro dependencies list`
- `favro dependencies add <sourceId> <targetId> --type blocks`

---

## Attachments

- `favro attachments upload <cardId> --file ./error.log`

---

## Users & Groups

- `favro users list`
- `favro groups list`

---

## Batch Operations

`batch update`, `batch move`, `batch assign` and `batch-smart` were **removed in
4.0**. Each is still a registered command, exits 1, and names its replacement, so
a script calling one gets a next move rather than `unknown command`. They are
kept for one major.

There is one bulk write, and it takes an **enumerated** list:

### `cards update --from-csv`

Update up to twenty cards from a CSV file, in one transaction.

**Syntax:**
```
favro cards update --from-csv <file> [--dry-run] [--yes] [--force] [--human]
```

**Options:**

| Option | Required | Description |
|---|---|---|
| `--from-csv <file>` | ✓ | CSV file path |
| `--dry-run` | — | Preview changes without applying |
| `--yes` | — | Skip the confirmation prompt |
| `--force` | — | Bypass the scope check |

**CSV format:**

```csv
card_id,status,owner,due_date
card-001,Done,alice,2026-04-01
card-002,In Progress,,2026-04-15
```

Required column: `card_id`. Optional: `status`, `owner`, `due_date` — with
`cardId`, `assignee` and `dueDate` accepted as aliases. **Every other column
refuses**, naming itself and listing the columns that exist. That includes
`custom_field_*`, which the 2.x parser accepted, stored, and never sent: a run
naming a custom field reported success having written none of it.

An empty cell means "leave this field alone". A row naming nothing but `card_id`
refuses rather than being skipped — inside a batch, skipping it would report
success for a card that was never written.

**Bounded:** over twenty rows the whole file refuses, naming the cap. Writing the
first twenty and dropping the rest would report success for rows nobody touched.

**Scope lock:** every distinct board the file touches is checked before the first
write, and a file straddling the lock refuses as a whole. The check runs ahead of
`--dry-run`, so a preview is never a way around it.

**Rollback:** the file is one transaction over one compensation log. A failure on
row 12 unwinds rows 1–11 field by field and reports `rolled-back`. Where the
2.x `BulkTransaction` re-PUT the whole previous state best-effort and printed
`ROLLBACK FAILED` to stderr, an incomplete unwind is now reported in the result,
with what it left behind.

**Example:**
```bash
favro cards update --from-csv cards.csv --dry-run
favro cards update --from-csv cards.csv --yes
```

---

### The removed spellings

| Removed | What to run |
|---|---|
| `favro batch update` | `favro cards update --from-csv <file>` |
| `favro batch move` | `favro cards list --filter …`, then `--from-csv` |
| `favro batch assign` | `favro cards list --filter …`, then `--from-csv` |
| `favro batch-smart` | Decide the operations yourself, then `--from-csv` |
| `favro cards update --board <board>` (no card id) | `favro cards list --filter …`, then `--from-csv` |

All five DERIVED their write set from a board read — a filter, a label or a
plain-English goal chose the cards — so what was written appeared neither in the
invocation nor in any record afterwards. There is no deprecation cycle: a warning
that still performed the write would keep alive exactly the behaviour the removal
is for.


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
- Narrow the *scope*, not the output: `--board`, `--collection`, `--since`/`--until`.
  `--limit` will not help — it caps what is **printed** and every fetch runs to
  completion regardless
- Use `favro cards update --from-csv` instead of a shell loop of single updates
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
favro cards blocking CARD-A
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

**Activity has no pagination:** `favro activity <card>` takes `--limit` and a
`--since`/`--until` window; there is no offset, so narrow the window rather than
paging.

**Cards export with large datasets:** For boards with thousands of cards, `favro cards export` handles pagination automatically and has no cap — `--limit` was removed in #44 precisely so an export cannot be a silent partial. For very large boards, pipe to stdout rather than file to avoid memory issues:

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

**Use `--limit` appropriately:** `cards list` prints 25 rows by default. It caps the
**print**, never the fetch — the board is paged to completion either way — so raising it
costs nothing on the wire and lowering it saves nothing:

```bash
# Quick check (25 rows printed, whole board fetched)
favro cards list --board board-001

# Every row, marked `truncated` if you cap it below the total
favro cards list --board board-001 --limit 500
```

**Batch operations over loops:** One `favro cards update --from-csv` is far more efficient than a shell loop calling `cards update` per card — and it is one transaction, so a failure part-way unwinds instead of leaving half the set changed:

```bash
# Fast: one call, one transaction, up to 20 rows
favro cards update --from-csv reassign.csv --yes

# Slow: N individual calls
favro cards list --board board-001 --status Backlog --human \
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
   favro cards update --from-csv updates.csv --dry-run
   ```

2. **CSV batch size:** twenty rows is the cap, and over it the whole file refuses
   rather than writing the first twenty. Split larger sets:
   ```bash
   split -l 20 all-updates.csv batch-
   for f in batch-*; do favro cards update --from-csv "$f" --yes; done
   ```
   Each chunk is its own transaction: a failure in chunk 3 unwinds chunk 3 and
   leaves chunks 1 and 2 written.

3. **Rollback is automatic within a file:** a failure part-way unwinds the rows
   already written, field by field, and reports `rolled-back`. If the unwind
   itself fails the result says so and lists what was left behind — do not retry
   that one blind.

4. **Decide the set yourself.** There is no predicate batch: enumerate with
   `favro cards list --filter …`, check the list, then write it.

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
COLLECTION_ID=$(favro collections list | jq -r '.rows[] | select(.name | contains("Sprints")) | .collectionId')
favro boards create $COLLECTION_ID --name "Sprint 43" --type kanban

BOARD_ID=$(favro boards list | jq -r '.rows[] | select(.name == "Sprint 43") | .boardId')

# 2. Import tasks from planning CSV
favro cards create --csv sprint-43-planning.csv --board $BOARD_ID --dry-run
favro cards create --csv sprint-43-planning.csv --board $BOARD_ID

# 3. Assign cards to team — enumerate, then write the enumerated list
favro cards list --board $BOARD_ID --filter "status:Todo" \
  | jq -r '["card_id,owner"] + [.rows[].cardId + ",alice"] | .[]' > assign.csv
favro cards update --from-csv assign.csv --yes

# 4. Verify setup — per-column card counts, the ones Favro actually measures
favro columns list $BOARD_ID
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
echo "--- Done ---"
favro cards list --board $BOARD_ID --status "Done"
```

There is no board-level activity feed to diff a day against — `favro activity`
is card-scoped. For per-card history, pass a cardId: `favro activity <card> --since 1d`.

---

### Bulk Status Update (Sprint Closeout)

Move all remaining "In Progress" cards to "Review" at end of sprint:

```bash
# 1. Enumerate the set, and read it before writing to it
favro cards list --board board-001 --filter "status:\"In Progress\"" \
  | jq -r '["card_id,status"] + [.rows[].cardId + ",Review"] | .[]' > closeout.csv

# 2. Preview
favro cards update --from-csv closeout.csv --dry-run

# 3. Apply
favro cards update --from-csv closeout.csv --yes
```

---

### Dependency Graph for Release Planning

Map out what's blocking what before a release:

```bash
# For each blocking card, see what it blocks
CARD_IDS=$(favro cards list --board board-001 | jq -r '.rows[].cardId')

for id in $CARD_IDS; do
  BLOCKERS=$(favro cards blocking $id | jq -r '.rows[].cardId')
  if [ -n "$BLOCKERS" ]; then
    NAME=$(favro cards get $id | jq -r '.name')
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
favro cards list --board $BOARD_ID \
  | jq -r '.[].cardId' \
  | while read id; do
    favro cards get $id --include custom-fields \
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

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: sprint-archive-${{ github.run_id }}
          path: "*.json"
```

---

## Error Message Reference

### Authentication & Authorization

| Error | Cause | Solution |
|-------|-------|----------|
| `Missing API key` | No FAVRO_API_KEY set and no saved config | Run `favro auth login` |
| `Invalid API token` | Token is expired or malformed | Get a new token from favro.com |
| `401 Unauthorized` | Authentication failed (wrong token) | Verify token: `favro auth check` |
| `403 Forbidden` | You lack permission for this action | Check your org/board permissions |

### Board & Card Operations

| Error | Cause | Solution |
|-------|-------|----------|
| `Board '<id>' not found` | Board ID is invalid or inaccessible | Run `favro boards list` to find correct ID |
| `Card '<id>' not found` | Card was deleted or ID is wrong | Search by name: `favro query <board> 'title~"part of the name"'` |
| `Status '<status>' not found` | Status name doesn't exist on board | List valid statuses: `favro boards get <id> \| jq '.columns'` |
| `User '<email>' not found` | Email doesn't match any board member | List members: `favro members list --board <id>` |

### Batch Operations

| Error | Cause | Solution |
|-------|-------|----------|
| `CSV file not found` | File path is invalid | Check file exists: `ls -la <path>` |
| `CSV missing required column` | Required 'card_id' column missing | Ensure CSV has: card_id, and one of: status, assignees, tags |
| `Cannot parse goal` | Goal syntax not supported | Use patterns like "move all overdue cards to Review" |
| `Goal returned 0 cards` | No cards matched the filter | Verify filter keywords and card state on board |

### Rate Limiting & Timeouts

| Error | Cause | Solution |
|-------|-------|----------|
| `429 Too Many Requests` | API rate limit exceeded | Automatic retry with backoff; if persists, split operations |
| `408 Request Timeout` | Request took too long | Automatic retry; split large batches (< 250 cards) |
| `503 Service Unavailable` | Favro API is down | Check https://status.favro.com and try again |

### Network & Connectivity

| Error | Cause | Solution |
|-------|-------|----------|
| `ECONNREFUSED` | Cannot connect to API | Check internet connection; verify firewall |
| `ENOTFOUND` | DNS resolution failed | Check DNS: `nslookup api.favro.com` |
| `ETIMEDOUT` | Network timeout | Check connection quality; try again later |

### Custom Fields

| Error | Cause | Solution |
|-------|-------|----------|
| `Field '<name>' not found` | Field ID or name is invalid | List fields: `favro custom-fields list <board-id>` |
| `Invalid value for select field` | Value not in field's options | List options: `favro custom-fields values <field-id>` |
| `Cannot set field without permissions` | Insufficient permissions on field | Ask board admin for write access |

### Webhooks

| Error | Cause | Solution |
|-------|-------|----------|
| `Invalid webhook URL` | URL format is wrong | Use HTTP or HTTPS; must be reachable |
| `Duplicate webhook` | Same URL + event already exists | Delete old webhook first: `favro webhooks delete <id>` |
| `Invalid event type` | Event name not recognized | Valid: card.created, card.updated, card.deleted |

---

## Common Issues & Debugging

### Slow Performance

**Problem:** `favro context` takes > 1s

**Debug:**
```bash
DEBUG=favro:* favro context <board-id> 2>&1 | grep -E "^favro|ms$"
```

**Solutions:**
- Reduce board size (archive old cards)
- Ask for less of the answer, not less of the board: `favro context <board> | jq '.stats'`.
  There is no cap to pass — the snapshot reads the board to completion and always
  did, and the `--limit` this used to suggest was discarded downstream. It is
  removed; passing it exits 1 with `unknown option '--limit'`
- Split into smaller queries

---

**Problem:** Batch operations are slow

**Debug:**
```bash
favro --verbose cards update --from-csv big.csv --dry-run
```

**Solutions:**
- Split the CSV into chunks; twenty rows is the hard cap per file
- Writes are sequential by design — a parallel batch would make "which fields are
  written now" a race with the compensation log
- Run at off-peak times

---

### Authentication Token Issues

**Problem:** Token works locally but not in CI/CD

**Debug:**
```bash
echo $FAVRO_API_KEY | wc -c  # Should be 32+ chars
```

**Solutions:**
1. Verify token is correctly set in CI secrets (not visible in logs)
2. Token must not have leading/trailing whitespace
3. Regenerate token in favro.com if uncertain

---

### High Memory Usage

**Problem:** Large batch operation uses > 500 MB RAM

**Solutions:**
```bash
# Process in smaller chunks — 20 rows is the per-file cap
split -l 20 large.csv batch-
for f in batch-*; do
  favro cards update --from-csv "$f" --yes
done
```

---

*Generated for CLA-1804 — FAVRO-042: SPEC-003 Integration Tests & Documentation*
