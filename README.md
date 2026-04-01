# favro-cli

Command-line interface for [Favro](https://favro.com) — manage boards and cards from your terminal.

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
  - **[Installation Guide](./INSTALL.md)** — System requirements, troubleshooting
  - **[Examples & Workflows](./EXAMPLES.md)** — Real-world command patterns
  - **[API Reference](./API-REFERENCE.md)** — Complete SPEC-002 endpoint reference
- [Authentication](#authentication)
- [Command Reference](#command-reference)
  - [Global Options](#global-options)
  - [Scope / Safety](#scope)
  - [Collections & Boards](#collections)
  - [Cards](#cards)
  - [Comments](#comments)
  - [Tasks, Task Lists & Dependencies](#tasks--dependencies)
  - [Tags & Attachments](#tags--attachments)
  - [Members, Users & Groups](#members-users--groups)
  - [Webhooks](#webhooks)
  - [Batch & AI Commands](#batch-operations)
- [Configuration](#configuration)
- [Examples](#examples)
  - [Bulk Create from CSV](#bulk-create-from-csv)
  - [Update with Filtering](#update-with-filtering)
  - [Export for Analysis](#export-for-analysis)
  - [Sprint Planning Workflow](#sprint-planning-workflow)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)

---

## Installation

This CLI is designed for local source installation.

Requires **Node.js 18+**.

```bash
git clone https://github.com/square-moon/favro-cli.git
cd favro-cli
npm install
npm run build
npm link
```

After install, the `favro` command is available globally:

```bash
favro --help
```

---

## Quick Start

Get started in 5 minutes:

```bash
# 1. Authenticate (saves your API key)
favro auth login

# 2. List your boards
favro boards list

# 3. List cards on a board (pick a board ID from step 2)
favro cards list --board <boardId>

# 4. Create your first card
favro cards create "Fix the login bug" --board <boardId>

# 5. Update its status
favro cards update <cardId> --status "In Progress"

# 6. Done! Explore more
favro --help
```

**First time?**
- **[Installation Guide](./INSTALL.md)** — System requirements and troubleshooting
- **[Examples & Workflows](./EXAMPLES.md)** — Real-world command patterns

**Already set up?**
- See [Command Reference](#command-reference) below for full feature docs
- Run `favro <command> --help` for command-specific flags

---

## Authentication

Favro CLI needs an API key to talk to the Favro API.

### Getting your API key

1. Log in to [favro.com](https://favro.com)
2. Go to **Organization Settings** → **API tokens**
3. Generate a new token and copy it

### Setting up your key

**Interactive (recommended):**

```bash
favro auth login
```

This prompts you for your API key and saves it to `~/.favro/config.json` (mode `0600` — only readable by you).

**Non-interactive (for CI/scripts):**

```bash
favro auth login --api-key YOUR_KEY_HERE
```

Or set an environment variable:

```bash
export FAVRO_API_KEY=your_api_key_here
```

### Verifying your key

```bash
favro auth check
```

### Key priority

When multiple sources are configured, the CLI uses this priority order:

1. `--api-key` flag (command-line)
2. `FAVRO_API_KEY` environment variable
3. `~/.favro/config.json` (`apiKey` field)
4. `FAVRO_API_TOKEN` environment variable (legacy, still supported)

---

## Command Reference

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
Update an existing comment's text.

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

## Columns & Widgets

### `columns list <boardId>` 📖 READ
List all columns/workflow states on a board.

### `columns create <boardId>` ⚠️ WRITE
Create a new column on a board.

| Flag | Description |
|------|-------------|
| `--name <name>` | **Required.** Column name |
| `--position <pos>`| Column position (0-indexed) |

### `columns update <columnId>` ⚠️ WRITE
Update an existing column.

### `widgets list` 📖 READ
List all boards a specific card sits on natively.

| Flag | Description |
|------|-------------|
| `--card <cardCommonId>` | **Required.** Card common ID |

### `widgets add <boardId> <cardCommonId>` ⚠️ WRITE
Add an existing card to a new board natively without duplicating it.

---

## Tasks & Dependencies

### `tasks list <cardCommonId>` 📖 READ
List granular checklist items inside a single card.

### `tasks add <cardCommonId> <name>` ⚠️ WRITE
Add a checklist item to a card.

### `tasks update <taskId>` ⚠️ WRITE
Update a task's name, completed state, or position.

| Flag | Description |
|------|-------------|
| `--name <name>` | New task name |
| `--completed` | Mark as completed |
| `--not-completed` | Mark as not completed |
| `--position <n>` | New position (0-based) |
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |

### `tasks delete <taskId>` ⚠️ WRITE
Delete a task.

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |

### `tasklists list <cardCommonId>` 📖 READ
List all task lists (checklists) on a card.

### `tasklists get <taskListId>` 📖 READ
Get a task list by ID.

### `tasklists create <cardCommonId>` ⚠️ WRITE
Create a new task list on a card.

| Flag | Description |
|------|-------------|
| `--name <name>` | **Required.** Task list name |
| `--position <n>` | Position (0-based) |
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |

### `tasklists update <taskListId>` ⚠️ WRITE
Update a task list's name or position.

| Flag | Description |
|------|-------------|
| `--name <name>` | New name |
| `--position <n>` | New position |
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |

### `tasklists delete <taskListId>` ⚠️ WRITE
Delete a task list.

| Flag | Description |
|------|-------------|
| `-y, --yes` | Skip confirmation |

### `dependencies list <cardId>` 📖 READ
List linked blocker/relation dependencies for a card.

### `dependencies add <sourceId> <targetId>` ⚠️ WRITE
Add a dependency link between cards.

| Flag | Description |
|------|-------------|
| `--type <type>` | **Required.** `blocks`, `depends-on`, `relates-to`, `duplicates` |

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

## Tags & Attachments

### `tags list` 📖 READ
List all global workspace tags.

### `tags create` ⚠️ WRITE
Create a new global tag.

| Flag | Description |
|------|-------------|
| `--name <name>` | **Required.** Tag name |
| `--color <color>` | Tag color |

### `tags update <tagId>` ⚠️ WRITE
Update a tag's name and/or color.

| Flag | Description |
|------|-------------|
| `--name <name>` | New tag name |
| `--color <color>` | New tag color |
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |

### `tags delete <tagId>` ⚠️ WRITE
Delete a tag.

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |

### `attachments upload <cardCommonId>` ⚠️ WRITE
Upload an attachment to a card.

| Flag | Description |
|------|-------------|
| `--file <path>` | **Required.** Path to file to upload |

### `attachments upload-to-comment <commentId>` ⚠️ WRITE
Upload a file attachment to a comment.

| Flag | Description |
|------|-------------|
| `--file <path>` | **Required.** File path to upload |
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |

---

## Members, Users & Groups

### `users list` 📖 READ
List workspace users.

### `groups list` 📖 READ
List workspace user groups.

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

### `groups update <groupId>` ⚠️ WRITE
Update a user group.

| Flag | Description |
|------|-------------|
| `--name <name>` | New group name |
| `--add-members <ids>` | Comma-separated user IDs to add |
| `--remove-members <ids>` | Comma-separated user IDs to remove |
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |

### `groups delete <groupId>` ⚠️ WRITE
Delete a user group.

| Flag | Description |
|------|-------------|
| `-y, --yes` | Skip confirmation |

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

---

## LLM-Powered AI Commands

These commands use a configured AI provider (Anthropic Claude, OpenAI GPT, or local Ollama) to analyze boards and generate execution plans.

### Setup

```bash
# Configure with Anthropic (recommended)
favro ai setup --provider anthropic --api-key sk-ant-...

# Or use environment variables
export ANTHROPIC_API_KEY=sk-ant-...
favro ai setup  # auto-detects from env

# Or use local Ollama (no API key needed)
favro ai setup --provider ollama
```

### `ask <board> <question>` 📖 READ
Ask an AI question about a board — fetches board context and sends to the LLM.

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON |
| `--context-only` | Dump context without LLM call |
| `--limit <n>` | Max cards in context (default: 1000) |

### `do <board> <goal>` ⚠️ WRITE — HIGH BLAST RADIUS
AI-planned multi-step execution — the LLM generates an execution plan, previews it, and executes after confirmation.

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview plan without executing |
| `-y, --yes` | Skip confirmation |
| `--json` | Output plan as JSON |

### `explain <cardId>` 📖 READ
AI-generated card summary — fetches card + comments, produces structured analysis.

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON |
| `--board <boardId>` | Board context for richer analysis |


## Configuration

The config file lives at `~/.favro/config.json` and is created automatically by `favro auth login`.

### Format

```json
{
  "apiKey": "your_api_key_here",
  "defaultBoard": "board-id-optional",
  "defaultCollection": "My Collection",
  "outputFormat": "table",
  "ai": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514",
    "apiKey": "sk-ant-..."
  }
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `apiKey` | string | Your Favro API key |
| `defaultBoard` | string | Default board ID (for future use) |
| `defaultCollection` | string | Default collection name (for future use) |
| `outputFormat` | `"table"` \| `"json"` \| `"csv"` | Default output format (for future use) |
| `ai.provider` | `"anthropic"` \| `"openai"` \| `"ollama"` | AI provider for LLM commands |
| `ai.model` | string | Model name (optional, auto-defaults) |
| `ai.apiKey` | string | Provider API key (or use env vars) |
| `ai.ollamaBaseUrl` | string | Ollama URL (default: `http://localhost:11434`) |

### File permissions

The config file is written with `0600` permissions (owner read/write only). Your API key is never exposed to other users on the same machine.

---

## Examples

### Bulk Create from CSV

Create cards in bulk from a spreadsheet export:

```bash
# 1. Export your spreadsheet to CSV with columns: name, description, status
# Example: tasks.csv
# name,description,status
# "Set up CI pipeline","GitHub Actions","Todo"
# "Write unit tests","Coverage target: 80%","Todo"
# "Deploy to staging","Heroku","In Progress"

# 2. Preview (dry-run first — always a good idea)
favro cards create --csv tasks.csv --board abc123 --dry-run

# 3. Create for real
favro cards create --csv tasks.csv --board abc123

# Output: ✓ Created 3 cards from CSV
```

---

### Update with Filtering

Move all cards assigned to a team member to "Done" status (two-step: list then update):

```bash
# 1. Find cards assigned to alice
favro cards list --board abc123 --assignee alice --json > alice-cards.json

# 2. Update each card (example using jq + shell loop)
jq -r '.[].cardId' alice-cards.json | while read id; do
  favro cards update "$id" --status "Done"
done
```

Or use dry-run to check first:

```bash
favro cards update abc-card-123 --status "Done" --assignees "alice,bob" --dry-run
# [dry-run] Would update card abc-card-123 with: {"status":"Done","assignees":["alice","bob"]}
```

---

### Export for Analysis

Export a board to CSV and open in a spreadsheet:

```bash
# Export with filter
favro cards export abc123 --format csv \
  --filter "status:In Progress" \
  --out in-progress.csv

# Pipe to csvkit for quick stats (if installed)
favro cards export abc123 --format csv | csvstat

# Export to JSON and query with jq
favro cards export abc123 --format json | jq 'group_by(.status) | map({status: .[0].status, count: length})'
```

---

### Sprint Planning Workflow

End-to-end example: create sprint cards from a planning doc and export results.

```bash
# 1. Create the sprint board cards from CSV
favro cards create --csv sprint-42-tasks.csv --board sprint-board-id --dry-run
# Review output, then:
favro cards create --csv sprint-42-tasks.csv --board sprint-board-id

# 2. Check what's on the board
favro cards list --board sprint-board-id

# 3. Assign cards to team members
favro cards update card-001 --assignees "alice" --status "In Progress"
favro cards update card-002 --assignees "bob" --status "In Progress"

# 4. Mid-sprint: export current state for the standup
favro cards export sprint-board-id --format csv --out standup-$(date +%Y%m%d).csv

# 5. End of sprint: export "Done" cards for retrospective
favro cards export sprint-board-id --format json \
  --filter "status:Done" \
  --out sprint-42-done.json

# 6. How many cards shipped?
cat sprint-42-done.json | jq length
```

---

## Troubleshooting

### `✗ No API key configured`

You haven't set up authentication yet.

```bash
favro auth login
```

Or set the environment variable:

```bash
export FAVRO_API_KEY=your_key_here
```

---

### `✗ API key is invalid or unauthorized`

Your key may have been revoked or expired.

1. Run `favro auth check` to confirm the key is invalid
2. Go to Favro → **Organization Settings** → **API tokens**
3. Generate a new token
4. Run `favro auth login` again with the new key

---

### `✗ Missing required environment variable: FAVRO_API_TOKEN`

Some commands fall back to the legacy `FAVRO_API_TOKEN` variable. Set `FAVRO_API_KEY` instead (recommended):

```bash
export FAVRO_API_KEY=your_key_here
```

---

### `✗ CSV file is empty or has no data rows`

Your CSV file either has no rows or is missing the required header row. Ensure:

- The first row contains column headers (at minimum: `name`)
- There is at least one data row

```csv
name,description,status
"My card","Description here","Todo"
```

---

### `✗ Output path must be within current directory`

For security, `--out` file paths must be within the current working directory. Use relative paths:

```bash
# ✓ Good
favro cards export abc123 --format csv --out ./exports/cards.csv

# ✗ Bad (absolute path)
favro cards export abc123 --format csv --out /tmp/cards.csv
```

---

### `⚠ Multiple collections match "..."`

Your `--collection` filter matched more than one collection. Make the name more specific:

```bash
# Instead of:
favro boards list --collection "Sprint"

# Use a more specific substring:
favro boards list --collection "Sprint 42"
```

---

### Network / timeout errors

- Check your internet connection
- Verify the Favro API is accessible: `curl https://favro.com/api/v1/organizations`
- If behind a proxy, set `HTTPS_PROXY` or `HTTP_PROXY` environment variables

---

## FAQ

**Can I use this without npm?**

No. `@square-moon/favro-cli` is distributed as an npm package and requires Node.js 18+ and npm (or pnpm/yarn) to install.

---

**Where is my API key stored?**

In `~/.favro/config.json` with permissions `0600` (readable only by you). Never in shell history when using `favro auth login` (the key input is masked).

---

**Can I use multiple API keys / accounts?**

Not natively. Workaround: use the `FAVRO_API_KEY` environment variable to switch between keys per session:

```bash
FAVRO_API_KEY=key1 favro boards list
FAVRO_API_KEY=key2 favro boards list
```

---

**Does `--dry-run` hit the API?**

No. `--dry-run` prints what would happen without making any write API calls. Some list commands may still read data to show what would be affected.

---

**How do I get a board ID?**

```bash
favro boards list
```

The `ID` column shows the board IDs. Use these with `--board`.

---

**Can I script this in CI?**

Yes. Use the `FAVRO_API_KEY` environment variable:

```yaml
# GitHub Actions example
- name: Export sprint cards
  env:
    FAVRO_API_KEY: ${{ secrets.FAVRO_API_KEY }}
  run: favro cards export ${{ vars.SPRINT_BOARD_ID }} --format csv --out sprint.csv
```

---

**Why does `cards list` show at most 50 cards?**

The default `--limit` is 50 for quick output. Increase it:

```bash
favro cards list --board abc123 --limit 500
```

For full exports use `favro cards export` which handles pagination automatically up to `--limit` (default 10,000).

---

**Something's not working — how do I debug?**

1. Check the error message carefully (the CLI prints `✗` for errors)
2. Try `favro auth check` to verify your key is valid
3. Add `--json` to get raw API output
4. Check your board/card IDs are correct with `favro boards list`

---

## License

See [LICENSE](./LICENSE).

---

## Documentation

| Document | Description |
|---|---|
| [README.md](./README.md) | Quick start, base command reference, configuration |
| [API-REFERENCE.md](./API-REFERENCE.md) | Full SPEC-002 endpoint reference (Collections, Boards, Cards, Custom Fields, Members, Comments, Activity, Webhooks, Batch) |
| [EXAMPLES.md](./EXAMPLES.md) | Real-world workflows and patterns |
| [INSTALL.md](./INSTALL.md) | Installation and system requirements |
