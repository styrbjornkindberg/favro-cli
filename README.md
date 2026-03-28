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
  - [auth](#auth)
  - [boards](#boards)
  - [cards](#cards)
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

```bash
npm install -g @square-moon/favro-cli
```

Requires **Node.js 18+**.

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

### auth

Manage your Favro API credentials.

```
favro auth --help
```

#### `favro auth login`

Save your API key to the local config file.

```bash
favro auth login
favro auth login --api-key YOUR_KEY_HERE
```

| Option | Description |
|--------|-------------|
| `--api-key <key>` | API key to save (skips interactive prompt) |

#### `favro auth check`

Verify the currently configured API key is valid.

```bash
favro auth check
favro auth check --api-key YOUR_KEY_HERE
```

| Option | Description |
|--------|-------------|
| `--api-key <key>` | API key to check (overrides config/env) |

---

### boards

Work with Favro boards.

```
favro boards --help
```

#### `favro boards list`

List all boards you have access to. Optionally filter by collection.

```bash
favro boards list
favro boards list --collection "Sprint 42"
favro boards list --json
```

| Option | Description |
|--------|-------------|
| `--collection <name>` | Filter boards by collection name (substring match, case-insensitive) |
| `--json` | Output raw JSON instead of a table |

**Example output:**

```
Found 3 board(s):
┌─────────┬──────────────────────┬────────────────┬───────┬─────────┬────────────┐
│ (index) │ ID                   │ Name           │ Cards │ Columns │ Updated    │
├─────────┼──────────────────────┼────────────────┼───────┼─────────┼────────────┤
│ 0       │ 'abc123'             │ 'Sprint 42'    │ 18    │ 5       │ '2025-03-01'│
└─────────┴──────────────────────┴────────────────┴───────┴─────────┴────────────┘
```

---

### cards

Work with cards on Favro boards.

```
favro cards --help
```

#### `favro cards list`

List cards from a board with optional filters.

```bash
favro cards list --board <boardId>
favro cards list --board <boardId> --status "In Progress" --limit 100
favro cards list --board <boardId> --assignee alice
favro cards list --board <boardId> --tag bug --json
```

| Option | Description |
|--------|-------------|
| `--board <id>` | Board ID to list cards from |
| `--status <status>` | Filter by status (case-insensitive) |
| `--assignee <user>` | Filter by assignee (substring match) |
| `--tag <tag>` | Filter by tag (substring match) |
| `--limit <number>` | Maximum number of cards to return (default: 50) |
| `--json` | Output raw JSON instead of a table |

> **Tip:** Use `favro boards list` to find board IDs.

---

#### `favro cards create`

Create one or more cards. Supports single-card creation, bulk JSON import, and CSV import.

```bash
# Single card
favro cards create "Fix the login bug" --board <boardId>
favro cards create "Add dark mode" --board <boardId> --description "User-requested feature" --status "Backlog"

# Bulk from CSV
favro cards create --csv tasks.csv --board <boardId>

# Bulk from JSON
favro cards create --bulk tasks.json --board <boardId>

# Dry run (preview without creating)
favro cards create "Test card" --board <boardId> --dry-run
favro cards create --csv tasks.csv --board <boardId> --dry-run
```

| Option | Description |
|--------|-------------|
| `--board <id>` | Target board ID |
| `--description <text>` | Card description |
| `--status <status>` | Initial card status |
| `--assignee <user>` | Assignee username or user ID |
| `--csv <file>` | Bulk import from CSV file (columns: `name`, `description`, `status`) |
| `--bulk <file>` | Bulk import from JSON file (array of card objects) |
| `--dry-run` | Print what would be created without making API calls |
| `--json` | Output created card(s) as JSON |

**CSV format for bulk import:**

```csv
name,description,status
"Fix login bug","Users can't log in on Safari","In Progress"
"Add dark mode","Design mockup attached","Backlog"
"Update API docs","Swagger spec needs refresh","Todo"
```

**JSON format for bulk import:**

```json
[
  { "name": "Fix login bug", "description": "Safari issue", "status": "In Progress" },
  { "name": "Add dark mode", "status": "Backlog" }
]
```

---

#### `favro cards update`

Update an existing card by its ID.

```bash
favro cards update <cardId> --status "Done"
favro cards update <cardId> --name "Renamed title" --status "In Progress"
favro cards update <cardId> --assignees "alice,bob"
favro cards update <cardId> --tags "bug,priority" --dry-run
```

| Option | Description |
|--------|-------------|
| `--name <name>` | New card title |
| `--description <desc>` | New card description |
| `--status <status>` | New card status |
| `--assignees <list>` | Comma-separated list of assignees |
| `--tags <list>` | Comma-separated list of tags |
| `--dry-run` | Print what would be updated without making API calls |
| `--json` | Output updated card as JSON |

---

#### `favro cards export`

Export all cards from a board to JSON or CSV. Supports filtering and large datasets (10k+ cards with backpressure-aware streaming).

```bash
# Export to file
favro cards export <boardId> --format csv --out sprint.csv
favro cards export <boardId> --format json --out sprint.json

# Export to stdout (pipe-friendly)
favro cards export <boardId> --format json | jq '.[] | .name'
favro cards export <boardId> --format csv | head -20

# Filter before exporting
favro cards export <boardId> --format csv --filter "assignee:alice" --out alice.csv
favro cards export <boardId> --format json --filter "status:Done" --filter "tag:sprint-42"
```

| Option | Description |
|--------|-------------|
| `--format <format>` | Export format: `json` or `csv` (default: `json`) |
| `--out <file>` | Output file path (defaults to stdout) |
| `--filter <expression>` | Filter expression (repeatable). Format: `field:value`. Supports `assignee`, `status`, `tag`. |
| `--limit <number>` | Maximum cards to fetch (default: 10000) |

**Filter expression examples:**

| Expression | Matches cards where... |
|------------|------------------------|
| `assignee:alice` | `alice` is in the assignee list |
| `status:Done` | status is `Done` |
| `tag:bug` | `bug` tag is applied |

Multiple `--filter` flags are combined with **AND** logic.

---

## Configuration

The config file lives at `~/.favro/config.json` and is created automatically by `favro auth login`.

### Format

```json
{
  "apiKey": "your_api_key_here",
  "defaultBoard": "board-id-optional",
  "defaultCollection": "My Collection",
  "outputFormat": "table"
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `apiKey` | string | Your Favro API key |
| `defaultBoard` | string | Default board ID (for future use) |
| `defaultCollection` | string | Default collection name (for future use) |
| `outputFormat` | `"table"` \| `"json"` \| `"csv"` | Default output format (for future use) |

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
