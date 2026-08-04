# Favro CLI — Complete Command Reference

This reference documents every command, flag, and option available in the favro-cli.

**CLI invocation:** `favro` command (if installed/linked globally) or `node dist/cli.js` (from source).

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
11. [Columns](#columns)
12. [Widgets](#widgets)
13. [Tags](#tags)
14. [Tasks](#tasks)
15. [Task Lists](#task-lists)
16. [Dependencies](#dependencies)
17. [Attachments](#attachments)
18. [Users & Groups](#users--groups)
19. [Batch Operations](#batch-operations)
20. [AI / Smart Commands](#ai-smart-commands)
22. [Skills — Reusable Workflows](#skills--reusable-workflows)

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

### Unconfirmed writes

Four writes read their own result back out of the PUT/POST response: `cards move`,
`widgets add`, `custom-fields set`, `dependencies add`. When the response carries the
field, they print `✓` naming the **observed** value and exit 0. When it does not, they
print `UNCONFIRMED`, name what was sent, point at a command that can check, and **exit
1** — the write was accepted with a 200, and nothing observed its effect.

Exit 1 here reports a finding, not a failure: the report (including `--json`) is still
on stdout, and the API error path is what raises an actual error. So
`favro custom-fields set … && next-step` will correctly **not** proceed on a write
nothing confirmed. Re-run or verify with the named command; do not treat an
`UNCONFIRMED` line plus a non-zero code as a crash.

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
| `--limit <n>` | Cap how many cards are **printed** (default: 25); sets `truncated`. The board is always fetched to completion |
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
| `--description <text>` | Card description (literal `\n` converted to newlines) |
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
| `--description <text>` | New description (literal `\n` converted to newlines) |
| `--append-description <text>` | Append to description (literal `\n` → newlines). **⚠️ Lossy if card has checklists** |
| `--comment <text>` | Add a comment to the card (non-destructive, literal `\n` → newlines) |
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

### `collections delete <id>` ⚠️ DESTRUCTIVE
Delete a collection permanently.

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview only |
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

### `boards delete <id>` ⚠️ DESTRUCTIVE
Delete a board permanently.

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |
| `--force` | Bypass scope check |

---

## Comments

### `comments list <cardId>` 📖 READ
List all comments on a card.

| Flag | Description |
|------|-------------|
| `--limit <n>` | Max comments **printed** (default: 100). The fetch always runs to completion, so a filter never sees a partial set |
| `--json` | Output the list envelope — `{"rows":[...]}`, plus `"truncated":true` when `--limit` cut rows. Check `truncated` before treating `rows.length` as the total |

### `comments get <commentId>` 📖 READ
Get a single comment by ID.

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON |

### `comments add <cardId>` ⚠️ WRITE
Add a comment to a card.

| Flag | Description |
|------|-------------|
| `--text <comment>` | **Required.** Comment body |
| `--json` | Output raw JSON |
| `--dry-run` | Preview only |
| `--force` | Bypass scope check |

### `comments update <commentId>` ⚠️ WRITE
Update an existing comment.

| Flag | Description |
|------|-------------|
| `--text <text>` | **Required.** New comment body |
| `--json` | Output raw JSON |
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |

### `comments delete <commentId>` ⚠️ WRITE
Delete a comment.

| Flag | Description |
|------|-------------|
| `-y, --yes` | Skip confirmation |

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

## Columns

Manage board columns/workflow states.

### `columns list <boardId>` 📖 READ

List all columns on a board.

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON |

### `columns create <boardId>` ⚠️ WRITE

Create a new column on a board.

| Flag | Description |
|------|-------------|
| `--name <name>` | **Required.** Column name |
| `--position <n>` | Column position (0-based) |
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |
| `--json` | Output raw JSON |

### `columns update <columnId>` ⚠️ WRITE

Update an existing column.

| Flag | Description |
|------|-------------|
| `--name <name>` | New column name |
| `--position <n>` | New position |
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |
| `--json` | Output raw JSON |

---

## Widgets

Manage card instances across boards. In Favro, a card can exist on multiple boards — each instance is a "widget".

### `widgets list` 📖 READ

List all board instances of a specific card.

| Flag | Description |
|------|-------------|
| `--card <cardCommonId>` | **Required.** The cardCommonId to trace |
| `--json` | Output raw JSON |

### `widgets add <boardId> <cardCommonId>` ⚠️ WRITE

Commit an existing card to another board. The card remains on its current board(s) and a new instance is created on the target board.

| Flag | Description |
|------|-------------|
| `--column <columnId>` | Place the card in a specific column |
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |
| `--force` | Bypass scope check |
| `--json` | Output raw JSON |

---

## Tags

Manage global workspace tags.

### `tags list` 📖 READ

List all tags in the workspace.

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON |

### `tags create` ⚠️ WRITE

Create a new global tag.

| Flag | Description |
|------|-------------|
| `--name <name>` | **Required.** Tag name |
| `--color <color>` | Tag color |
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |
| `--json` | Output raw JSON |

### `tags update <tagId>` ⚠️ WRITE

Update a tag's name and/or color.

| Flag | Description |
|------|-------------|
| `--name <name>` | New tag name |
| `--color <color>` | New tag color |
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |
| `--json` | Output raw JSON |

### `tags delete <tagId>` ⚠️ WRITE

Delete a tag.

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |

---

## Tasks

Manage checklist items inside a card.

### `tasks list <cardCommonId>` 📖 READ

List all tasks (checklist items) on a card.

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON |

### `tasks add <cardCommonId> <name>` ⚠️ WRITE

Create a new task on a card.

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |
| `--json` | Output raw JSON |

### `tasks complete <taskId>` ⚠️ WRITE

Mark a task as completed.

| Flag | Description |
|------|-------------|
| `--card <cardCommonId>` | The card the task belongs to. **Required under a scope lock** — a taskId names no board, so the lock has nothing to check without it |
| `-y, --yes` | Skip confirmation |
| `--json` | Output raw JSON |

### `tasks update <taskId>` ⚠️ WRITE

Update a task's name, completed state, or position.

| Flag | Description |
|------|-------------|
| `--name <name>` | New task name |
| `--completed` | Mark as completed |
| `--not-completed` | Mark as not completed |
| `--position <n>` | New position (0-based) |
| `--card <cardCommonId>` | The card the task belongs to. **Required under a scope lock** — a taskId names no board, so the lock has nothing to check without it |
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |
| `--json` | Output raw JSON |

### `tasks delete <taskId>` ⚠️ WRITE

Delete a task.

| Flag | Description |
|------|-------------|
| `--card <cardCommonId>` | The card the task belongs to. **Required under a scope lock** — a taskId names no board, so the lock has nothing to check without it |
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |

---

## Task Lists

Manage task lists (checklists) on cards.

### `tasklists list <cardCommonId>` 📖 READ

List all task lists on a card.

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON |

### `tasklists get <taskListId>` 📖 READ

Get a task list by ID.

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON |

### `tasklists create <cardCommonId>` ⚠️ WRITE

Create a new task list on a card.

| Flag | Description |
|------|-------------|
| `--name <name>` | **Required.** Task list name |
| `--position <n>` | Position (0-based) |
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |
| `--json` | Output raw JSON |

### `tasklists update <taskListId>` ⚠️ WRITE

Update a task list.

| Flag | Description |
|------|-------------|
| `--name <name>` | New name |
| `--position <n>` | New position |
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |
| `--json` | Output raw JSON |

### `tasklists delete <taskListId>` ⚠️ WRITE

Delete a task list.

| Flag | Description |
|------|-------------|
| `-y, --yes` | Skip confirmation |

---

## Dependencies

Manage card dependency links (blockers/related).

### `dependencies list <cardId>` 📖 READ

List dependencies for a card.

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON |

### `dependencies add <sourceId> <targetId>` ⚠️ WRITE

Add a dependency link between two cards.

| Flag | Description |
|------|-------------|
| `--type <type>` | **Required.** Dependency type: `blocks`, `depends-on`, `related` |
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |
| `--json` | Output raw JSON |

### `dependencies delete <cardId> <targetId>` ⚠️ WRITE

Remove a single dependency link between two cards.

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |

### `dependencies delete-all <cardId>` ⚠️ DESTRUCTIVE

Remove ALL dependencies from a card.

| Flag | Description |
|------|-------------|
| `-y, --yes` | Skip confirmation |

---

## Attachments

Manage card file attachments.

### `attachments upload <cardCommonId>` ⚠️ WRITE

Upload a file attachment to a card.

| Flag | Description |
|------|-------------|
| `--file <path>` | **Required.** File path to upload |
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |
| `--json` | Output raw JSON |

### `attachments upload-to-comment <commentId>` ⚠️ WRITE

Upload a file attachment to a comment.

| Flag | Description |
|------|-------------|
| `--file <path>` | **Required.** File path to upload |
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |
| `--json` | Output raw JSON |

---

## Users & Groups

### `users list` 📖 READ
List all workspace members.

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON |

### `groups list` 📖 READ
List all user groups.

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON |

### `groups get <groupId>` 📖 READ
Get a group by ID.

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON |

### `groups create` ⚠️ WRITE
Create a new user group.

| Flag | Description |
|------|-------------|
| `--name <name>` | **Required.** Group name |
| `--members <ids>` | Comma-separated user IDs to add |
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |
| `--json` | Output raw JSON |

### `groups update <groupId>` ⚠️ WRITE
Update a user group.

| Flag | Description |
|------|-------------|
| `--name <name>` | New group name |
| `--add-members <ids>` | Comma-separated user IDs to add |
| `--remove-members <ids>` | Comma-separated user IDs to remove |
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |
| `--json` | Output raw JSON |

### `groups delete <groupId>` ⚠️ WRITE
Delete a user group.

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

`--status` must name a column on the **destination** board (`--to-board` when
given, else `--board`). It is settled before anything is read or written, like
`status:` in `--filter`: a value naming no column refuses and lists that board's
columns, under `--dry-run` and `--yes` alike, rather than previewing a plan that
fails card by card at the wire.

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

No flags. The board is read to completion; the `--limit` this used to accept was
discarded downstream and is removed, so passing it exits 1.

### `query <board> <query...>` 📖 READ
Semantic card search with natural language.

Query patterns: `status:done`, `assigned:@alice`, `blocked`, `priority:high`, `tag:bug`, `due:overdue`, free text.

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON |

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

`<board>` is a board id or an exact board name.

Supported goal patterns:
- `move all <filter> cards to <status>`
- `assign all <filter> cards [with no owner] to <user>`
- `close all <filter> cards`
- `unassign all <filter> cards`

Filter words: `overdue`, `blocked`, `unassigned`, `assigned`, `all` — or a COLUMN
name on that board. A word that is neither refuses, naming the word and listing
the board's columns, and writes nothing; it never selects zero cards silently.
The refusal fires under `--dry-run` and `--yes` alike. A goal that resolves and
matches nothing is different: it reports zero and exits 0.

### `risks <board>` 📖 READ
Board risk analysis — surfaces overdue, blocked, unassigned, and incomplete cards.

JSON by default; `--human` renders the dashboard. Exit code is the answer: 0 when
`riskLevel` is `healthy`, 1 otherwise. A wire failure also exits 1 but writes
`{"error": …}` instead of a report.

Staleness is reported under `unreachable`, not as a risk list: Favro sends no
last-modified field on a card, so days-since-update cannot be computed. There is
no `--stale-days` flag — the command never had one.

This command takes no flags of its own.

---

## Skills — Reusable Workflows

Skills are YAML-defined multi-step workflows that chain CLI commands together. Stored in `~/.favro/skills/` (user) and shipped built-in.

### `skill list` 📖 READ
List all available skills (builtin + user). JSON is the default; `--human` opts out.

| Flag | Description |
|------|-------------|
| `--limit <n>` | Cap how many rows are printed; sets `truncated` |

### `skill run <name>` ⚠️ WRITE (may execute write steps)
Execute a skill by name. JSON is the default and carries the whole run result;
`--human` gets the per-step trail and the tally instead.

| Flag | Description |
|------|-------------|
| `--board <board>` | Board ID or name (overrides skill default) |
| `--dry-run` | Preview steps without executing |
| `-y, --yes` | Skip confirmation prompts |
| `--var <key=value...>` | Set skill variables |
| `--force` | Bypass the scope lock on write steps |

### `skill create <name>` 🔧 CONFIG
Create a new skill from a starter template.

| Flag | Description |
|------|-------------|
| `--description <desc>` | Skill description |

### `skill edit <name>` 🔧 CONFIG
Open a skill YAML file in `$EDITOR` (or `$VISUAL`), attached to the terminal, and wait for it to close. Fails if neither is set — there is no fallback editor. `$EDITOR` may carry arguments (`code --wait`); it is split on whitespace and run without a shell.

### `skill export <name>` 📖 READ
Output a skill as YAML to stdout.

### `skill import <path>` 🔧 CONFIG
Import a skill from a YAML file.

### `skill delete <name>` ⚠️ WRITE
Delete a user skill (cannot delete builtin skills).

### `skill record <name>` 🔧 CONFIG
Start recording CLI commands as a skill.

| Flag | Description |
|------|-------------|
| `--description <desc>` | Skill description |

### `skill stop` 🔧 CONFIG
Stop recording and save the skill.

### Built-in Skills

| Name | Description |
|------|-------------|
| `daily-digest` | Standup + overdue + blocked cards in one view |
| `pick-up` | Read a ticket, then claim it |
| `file-blocked` | Create a ticket and record what blocks it, atomically |
| `unblock` | Drop a blocking edge and re-triage the card it freed |

### Skill YAML Format

```yaml
name: my-workflow
description: "What this skill does"
triggers:
  - manual
steps:
  - command: standup
    args:
      board: "{{board}}"
  - command: ask
    args:
      board: "{{board}}"
      question: "What cards need attention?"
  - command: do
    args:
      board: "{{board}}"
      goal: "{{goal}}"
    confirm: true        # Always prompt before execution
    continueOnError: true # Continue even if this step fails
variables:
  board:
    prompt: "Which board?"
    default: "{{scope.board}}"
  goal:
    prompt: "What action?"
    default: "assign unassigned bugs"
```
