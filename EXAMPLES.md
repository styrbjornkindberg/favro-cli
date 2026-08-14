# Examples & Workflows

Real-world patterns for using `favro-cli` in daily work.

---

## Table of Contents

- [Getting Started](#getting-started)
- [Daily Tasks](#daily-tasks)
- [Bulk Operations](#bulk-operations)
- [Data Export & Analysis](#data-export--analysis)
- [Sprint Planning](#sprint-planning)
- [CI/CD Integration](#cicd-integration)
- [Advanced Patterns](#advanced-patterns)

---

## Getting Started

Before running any command, ensure:

1. You're authenticated: `favro auth check`
2. You know your board ID: `favro boards list`

---

## Daily Tasks

### List Cards on a Board

```bash
favro cards list --board abc123
```

Output:

```
Found 15 card(s):
┌─────────┬──────────────┬───────────────────────────┬──────────┬────────────┐
│ (index) │ ID           │ Name                      │ Status   │ Assignee   │
├─────────┼──────────────┼───────────────────────────┼──────────┼────────────┤
│ 0       │ 'xyz789'     │ 'Fix login bug'           │ 'In Prog'│ 'alice'    │
│ 1       │ 'xyz790'     │ 'Add dark mode'           │ 'Todo'   │ (unassign.)│
└─────────┴──────────────┴───────────────────────────┴──────────┴────────────┘
```

### Filter by Status

Show only "In Progress" cards:

```bash
favro cards list --board abc123 --status "In Progress"
```

### Filter by Assignee

Show cards assigned to Alice:

```bash
favro cards list --board abc123 --assignee alice
```

### Filter by Tag

Show all "bug" cards:

```bash
favro cards list --board abc123 --tag bug
```

### Create a Single Card

```bash
favro cards create "Update API documentation" \
  --board abc123 \
  --status "Todo" \
  --description "Swagger spec is out of date"
```

Output:

```
✓ Created card: Update API documentation (ID: new-card-id)
```

### Update a Card

Change a card's status:

```bash
favro cards update xyz789 --status "Done"
```

Update multiple fields:

```bash
favro cards update xyz789 \
  --name "Fixed: login bug on Safari" \
  --status "Done" \
  --assignees "alice,bob"
```

---

## Bulk Operations

### Create Multiple Cards from CSV

Use `favro cards create --csv` to bulk-import cards from a spreadsheet.

**1. Create a CSV file** (`sprint-tasks.csv`):

```csv
name,description,status
"Implement user sign-up","OAuth2 integration","Todo"
"Add password reset flow","Email verification required","Todo"
"Write unit tests","Target: 80% coverage","Backlog"
"Deploy to staging","Heroku","Backlog"
"Code review","Peer review for auth module","Todo"
```

**2. Preview the import (dry-run):**

```bash
favro cards create --csv sprint-tasks.csv --board abc123 --dry-run
```

Output:

```
[dry-run] Would create 5 cards:
1. Implement user sign-up
2. Add password reset flow
3. Write unit tests
4. Deploy to staging
5. Code review
```

**3. Create for real:**

```bash
favro cards create --csv sprint-tasks.csv --board abc123
```

Output:

```
✓ Created 5 cards from CSV
```

### Create Multiple Cards from JSON

Use `favro cards create --bulk` for JSON format.

**Create `tasks.json`:**

```json
[
  {
    "name": "Implement user sign-up",
    "description": "OAuth2 integration with Google and GitHub",
    "status": "Todo",
    "assignees": ["alice"]
  },
  {
    "name": "Add password reset flow",
    "description": "Email verification required",
    "status": "Todo",
    "assignees": ["bob"]
  },
  {
    "name": "Write unit tests",
    "description": "Target: 80% coverage for auth module",
    "status": "Backlog"
  }
]
```

**Import:**

```bash
favro cards create --bulk tasks.json --board abc123
```

### Update Many Cards at Once

Use dry-run to check, then apply:

```bash
# Update a specific card
favro cards update card-001 --status "Done" --dry-run
# [dry-run] Would update card-001 with: {"status":"Done"}

favro cards update card-001 --status "Done"
# ✓ Updated card-001
```

For bulk updates, export the board, modify locally, then create/update:

```bash
# 1. Export current state
favro cards export abc123 --format json > current-state.json

# 2. Modify in your editor (e.g., change all "Todo" to "In Progress")

# 3. Reimport via dry-run first
favro cards create --bulk current-state.json --board abc123 --dry-run

# 4. Actually reimport
favro cards create --bulk current-state.json --board abc123
```

---

## Data Export & Analysis

### Export Board to CSV

Export all cards as CSV for spreadsheet analysis:

```bash
favro cards export abc123 --format csv --out sprint.csv
```

Then open in Excel or Google Sheets:

```bash
open sprint.csv  # macOS
xdg-open sprint.csv  # Linux
start sprint.csv  # Windows
```

### Export to JSON

Export as JSON for programmatic processing:

```bash
favro cards export abc123 --format json --out sprint.json
```

### Export to Stdout (Pipe to Tools)

Pipe directly to other CLI tools:

```bash
# Count total cards
favro cards export abc123 --format json | jq length

# Extract just card names
favro cards export abc123 --format json | jq -r '.[].name'

# Group by status
favro cards export abc123 --format json | jq 'group_by(.status) | map({status: .[0].status, count: length})'
```

### Export with Filters

Export only "Done" cards:

```bash
favro cards export abc123 --format csv --filter "status:Done" --out done.csv
```

Export cards with a specific tag:

```bash
favro cards export abc123 --format json --filter "tag:urgent" --out urgent.json
```

Multiple filters (AND logic):

```bash
favro cards export abc123 --format json \
  --filter "status:Done" \
  --filter "assignee:alice" \
  --out alice-done.json
```

### Count Cards by Status

```bash
favro cards export abc123 --format json | jq 'group_by(.status) | map({status: .[0].status, count: length})'
```

Output:

```json
[
  { "status": "Backlog", "count": 5 },
  { "status": "Todo", "count": 8 },
  { "status": "In Progress", "count": 3 },
  { "status": "Done", "count": 12 }
]
```

---

## Sprint Planning

### End-to-End Sprint Workflow

**Week 1: Create sprint board**

```bash
# Create sprint-42 board in Favro (manual, not supported by CLI yet)
SPRINT_BOARD_ID="sprint-42-board-id"

# Create task list from planning doc
favro cards create --csv sprint-42-planning.csv --board $SPRINT_BOARD_ID --dry-run

# Review, then commit
favro cards create --csv sprint-42-planning.csv --board $SPRINT_BOARD_ID
```

**Mid-sprint: Check progress**

```bash
# How many cards are in progress?
favro cards list --board $SPRINT_BOARD_ID --status "In Progress"

# Which cards are not assigned?
favro cards list --board $SPRINT_BOARD_ID --status "Todo"
```

**Sprint review: Export results**

```bash
# Export cards marked "Done"
favro cards export $SPRINT_BOARD_ID \
  --format json \
  --filter "status:Done" \
  --out sprint-42-done.json

# How many cards shipped?
cat sprint-42-done.json | jq length

# Export for retrospective analysis
favro cards export $SPRINT_BOARD_ID \
  --format csv \
  --out sprint-42-final.csv
```

### Assign Tasks to Team Members

```bash
# Assign to one person
favro cards update card-001 --assignees "alice"

# Assign to multiple people
favro cards update card-002 --assignees "bob,charlie"

# Reassign
favro cards update card-003 --assignees "diana"
```

---

## CI/CD Integration

### Export Board in GitHub Actions

```yaml
name: Export Sprint Cards

on:
  schedule:
    - cron: '0 9 * * 1'  # Every Monday at 9 AM

jobs:
  export:
    runs-on: ubuntu-latest
    steps:
      - name: Export sprint cards
        env:
          FAVRO_API_KEY: ${{ secrets.FAVRO_API_KEY }}
        run: |
          npm install -g @square-moon/favro-cli
          favro cards export ${{ vars.SPRINT_BOARD_ID }} \
            --format csv \
            --out sprint-cards-$(date +%Y-%m-%d).csv

      - name: Upload to artifact
        uses: actions/upload-artifact@v3
        with:
          name: sprint-cards
          path: sprint-cards-*.csv
```

### Verify API Key in CI

```bash
# Before running commands, check the key is valid
export FAVRO_API_KEY=${{ secrets.FAVRO_API_KEY }}
favro auth check

if [ $? -ne 0 ]; then
  echo "Error: FAVRO_API_KEY is invalid"
  exit 1
fi

# Now safe to run other commands
favro cards list --board abc123
```

---

## Advanced Patterns

### Use Environment Variables for Configuration

Set defaults in your shell:

```bash
export FAVRO_API_KEY=your-key-here

# Now commands work without --api-key flag
favro boards list
favro cards list --board abc123
```

### Scripting with CSV/JSON

**Bash script to archive "Done" cards:**

```bash
#!/bin/bash

BOARD_ID="abc123"
ARCHIVE_DIR="./archived-sprints"

# Create archive directory
mkdir -p "$ARCHIVE_DIR"

# Export done cards
favro cards export "$BOARD_ID" \
  --format json \
  --filter "status:Done" \
  --out "$ARCHIVE_DIR/done-$(date +%Y%m%d-%H%M%S).json"

echo "✓ Archived done cards to $ARCHIVE_DIR"
```

**Python script to analyze board health:**

```python
#!/usr/bin/env python3

import json
import subprocess
import sys

BOARD_ID = "abc123"

# Export board
result = subprocess.run(
    ["favro", "cards", "export", BOARD_ID, "--format", "json"],
    capture_output=True,
    text=True
)

if result.returncode != 0:
    print("Error exporting board")
    sys.exit(1)

cards = json.loads(result.stdout)

# Analyze
status_counts = {}
for card in cards:
    status = card.get("status", "Unknown")
    status_counts[status] = status_counts.get(status, 0) + 1

print("Board Health Report:")
print("-" * 40)
for status, count in sorted(status_counts.items()):
    percentage = (count / len(cards)) * 100
    print(f"{status:15} {count:3} ({percentage:5.1f}%)")
```

### Filter and Process Cards Locally

**Get unassigned cards:**

```bash
favro cards export abc123 --format json | jq '.[] | select(.assignee == null)'
```

**Get cards overdue:**

```bash
favro cards export abc123 --format json | jq '.[] | select(.dueDate < now)'
```

**Find high-priority items:**

```bash
favro cards export abc123 --format json | jq '.[] | select(.tag | contains("priority"))'
```

### Dry-Run Before Making Changes

Always use `--dry-run` to preview:

```bash
# Preview bulk create
favro cards create --csv new-tasks.csv --board abc123 --dry-run

# Preview update
favro cards update card-001 --status "Done" --assignees "alice" --dry-run
```

`cards export` is read-only and has no `--dry-run` — run it straight, or send it to a scratch path with `--out` first.

---

## Tips & Tricks

- **JSON is already the output:** read commands print JSON by default; `--human` opts out. The `--json` flag is gone from them — passing one answers `error: unknown option '--json'`
- **Get help on any command:** `favro <command> --help`
- **Export for offline work:** Use `--format json` and process locally
- **Dry-run is free:** Always preview destructive changes with `--dry-run`
- **Combine with shell tools:** Pipe to `jq`, `grep`, `awk`, `csvkit` for powerful workflows

---

## Troubleshooting Examples

### Error: "Board not found"

```bash
# Verify the board exists and you have access
favro boards list
# Find the correct ID in the output, then:
favro cards list --board <correct-id>
```

### Error: "API key is invalid"

```bash
# Verify and fix authentication
favro auth check

# If invalid, re-authenticate
favro auth login
```

### Error: "Output path must be within current directory"

```bash
# Use relative paths, not absolute
favro cards export abc123 --format csv --out ./exports/cards.csv

# Don't use absolute paths like /tmp/cards.csv
```

---

## Performance Tips

### Filter Early

Use `--filter` in export commands rather than filtering the result with `jq` — it reduces data transfer and processing time:

```bash
# Fast: filter at source
favro cards export board-001 --filter "status:Done" --format json

# Slow: export everything, filter after
favro cards export board-001 --format json | jq '.[] | select(.status == "Done")'
```

### Use One CSV Over a Shell Loop

One `cards update --from-csv` beats a loop of single updates, and it is one
transaction — a failure part-way unwinds instead of leaving half the set changed:

```bash
# Fast: one call, one transaction, up to 20 rows
favro cards list --board board-001 --filter "status:Backlog" \
  | jq -r '["card_id,owner"] + [.rows[].cardId + ",alice"] | .[]' > assign.csv
favro cards update --from-csv assign.csv --yes

# Slow: N individual API calls, and no way back from a failure at card 7
favro cards list --board board-001 --status Backlog --human \
  | jq -r '.[].cardId' \
  | while read id; do favro cards update "$id" --assignees alice; done
```

### Narrow Large Activity Logs

Activity is card-scoped and has no offset — narrow the window instead of paging:

```bash
favro activity card-abc123 --since 1d              # last 24 hours
favro activity card-abc123 --since 7d --until 1d   # the six days before that
favro activity card-abc123 --limit 50              # cap the entries returned
```

### Always Dry-Run Batch Operations

Preview before applying — it's free and prevents mistakes:

```bash
favro cards update --from-csv updates.csv --dry-run
```

### Request Only the Includes You Need

Each `--include` value adds API calls. Only request what you need:

```bash
# Faster: just stats
favro boards get board-001 --include stats

# Slower: everything
favro boards get board-001 --include custom-fields,cards,members,stats,velocity
```

### Cache Board and Collection IDs

IDs rarely change. Store them in environment variables to avoid repeated list calls:

```bash
export SPRINT_BOARD=$(favro boards list | jq -r '.rows[] | select(.name == "Sprint 43") | .boardId')
favro cards list --board $SPRINT_BOARD
```

### Split Large CSV Batches

Twenty rows is the cap per file, and over it the whole file refuses rather than
writing the first twenty:

```bash
split -l 20 big-updates.csv batch-part-
for f in batch-part-*; do
  echo "Processing $f..."
  favro cards update --from-csv "$f" --yes
done
```

Each chunk is its own transaction: a failure in chunk 3 unwinds chunk 3 and
leaves chunks 1 and 2 written.

---

## AI-Powered Workflows

These workflows leverage LLM-driven commands to automate complex tasks.

### Workflow: Code Review Assignment

Automatically assign code review cards based on sprint status:

```bash
# 1. Get board context
favro context sprint-42 > board-snapshot.json

# 2. Query for "In Progress" code review cards
favro query sprint-42 "status:\"In Progress\" AND tag:code-review"

# 3. Enumerate the set — the write is over THIS list, not over a predicate
favro cards list --board sprint-42 \
  --filter "status:\"In Progress\" AND tag:code-review" \
  | jq -r '["card_id,owner"] + [.rows[].cardId + ",alice"] | .[]' > review.csv

# 4. Preview, then apply once it reads right
favro cards update --from-csv review.csv --dry-run
favro cards update --from-csv review.csv --yes
```

### Workflow: Sprint Planning & Prioritization

Semi-automatic sprint plan based on priority and capacity:

```bash
# 1. Get sprint suggestions for 40-point capacity
favro sprint-plan --board sprint-42 --budget 40 > sprint-plan.json

# 2. Review suggestions (see cards, priority scores)
cat sprint-plan.json | jq '.suggestions[] | {title, priority_score, cumulative}'

# 3. Turn the suggestions into a CSV and preview the status change
jq -r '"card_id,status", (.suggestions[] | "\(.id),Approved")' sprint-plan.json > approve.csv
favro cards update --from-csv approve.csv --dry-run

# 4. Standup: see what's in progress vs what's due soon
favro standup --board sprint-42
```

### Workflow: Family/Personal Task Management

Use `favro-cli` to manage shared household projects:

```bash
# 1. Initialize a household project board (one-time setup)
collection_id=$(favro collections list | jq -r '.rows[0].collectionId')
board_id=$(favro boards create "$collection_id" --name "2026 Home Projects" | jq -r '.boardId')

# 2. Bulk create tasks from a list
echo "Renovate kitchen,Garden fence repair,Paint basement" | \
  tr ',' '\n' | \
  while read task; do
    favro cards create "$task" --board $board_id --status Backlog
  done

# 3. Semantic search: find overdue tasks
favro query $board_id "due_date<today"

# 4. Batch close done items — enumerate, then write the list
favro cards list --board $board_id --filter "status:Done" \
  | jq -r '["card_id,status"] + [.rows[].cardId + ",Closed"] | .[]' > close.csv
favro cards update --from-csv close.csv --yes

# 5. Standup: summary of what's blocked, due soon, in progress
favro standup --board $board_id
```

### Workflow: Technical Debt & Risk Tracking

Monitor and resolve technical debt semi-automatically:

```bash
# 1. Create a "Technical Debt" board
collection_id=$(favro collections list | jq -r '.rows[0].collectionId')
debt_board=$(favro boards create "$collection_id" --name "Tech Debt Q1 2026" | jq -r '.boardId')

# 2. Get board context for analysis
favro context $debt_board > debt-snapshot.json

# 3. Query for high-priority backlog items
# (customField: is refused — a card stores field/option ids, never names.
#  Read them with: favro custom-fields list $debt_board)
favro query $debt_board "tag:priority-high AND status:Backlog"

# 4. Assign that debt to the platform owner (drop --dry-run to apply)
favro cards list --board $debt_board \
  --filter "status:Backlog AND tag:tech-debt" \
  | jq -r '["card_id,owner"] + [.rows[].cardId + ",platform-team"] | .[]' > debt.csv
favro cards update --from-csv debt.csv --dry-run

# 5. Standup on tech debt progress
favro standup --board $debt_board
```

---

## Error Messages & Troubleshooting Guide

### Authentication Errors

**Error: `Missing API key`**
```
Error: You need to authenticate first. Run: favro auth login
Or set FAVRO_API_KEY environment variable.
```
**Fix:**
```bash
favro auth login  # Interactive setup
# OR
export FAVRO_API_KEY=your_token_here
```

---

**Error: `Invalid API token`**
```
Error: 401 Unauthorized — your API key is invalid or expired.
```
**Fix:**
1. Get a new token from favro.com → Organization Settings → API tokens
2. Update your config: `favro auth login --api-key NEW_KEY`
3. Or set `FAVRO_API_KEY=NEW_KEY` in your shell

---

### Board & Card Errors

**Error: `Board not found`**
```
Error: Board '<board-id>' not found or you don't have access.
```
**Fix:**
```bash
# List your boards to get the correct ID
favro boards list
```

---

**Error: `Card not found`**
```
Error: Card '<card-id>' not found. May have been deleted or is on a different board.
```
**Fix:**
```bash
# Search for the card by name
favro query <board-id> "title~\"partial card name\""
```

---

### Batch Operation Errors

**Error: `CSV format invalid`**
```
Error: CSV file missing required column 'card_id'
Required column: card_id. Optional: status, owner, due_date.
```
**Fix:** Check your CSV header row. Any column outside that set refuses too —
including `custom_field_*`, which 2.x accepted and never sent. Example:
```csv
card_id,status,owner
card-001,In Progress,alice@example.com
card-002,Done,bob@example.com
```

---

**Error: `'favro batch-smart' was removed in 4.0`**
```
✗ Error: 'favro batch-smart' was removed in 4.0.
Decide the operations yourself, then 'favro cards update --from-csv'.
```
That is `--human`. The default is the same message inside `{"error":{"message",
"retryable":false}}` on stdout, so a script reading stdout gets the pointer too.
**Fix:** the plain-English goal parser is gone, along with `batch update`,
`batch move` and `batch assign`. All four derived their write set from a board
read, so what they wrote to appeared neither in the invocation nor in any record.
Enumerate the set, read it, then write the list:
```bash
favro cards list --board board-id --filter "status:Backlog" \
  | jq -r '["card_id,status"] + [.rows[].cardId + ",Review"] | .[]' > move.csv
favro cards update --from-csv move.csv --dry-run
favro cards update --from-csv move.csv --yes
```
Each removed spelling exits 1 with the pointer above rather than
`unknown command`, and they are kept for one major.

---

### Rate Limiting & Timeouts

**Error: `429 Too Many Requests`**
```
Error: Rate limited (429). Retrying in 3 seconds...
Retry 1/3... Retry 2/3... OK
```
**Fix (automatic):** The CLI retries automatically with exponential backoff (max 30s).
**Fix (manual):** Reduce concurrency in batch operations:
```bash
# Writes are sequential by design — split the file to spread them out
favro cards update --from-csv updates.csv --yes
```

---

**Error: `Request timeout (408)`**
```
Error: Request timeout (408). Retrying...
```
**Fix:** This is a temporary network issue. The CLI retries automatically. If it persists:
1. Check your internet connection
2. Try again in a moment
3. For large operations, split into smaller batches

---

### Performance Issues

**Issue: `Context snapshot is slow (> 1s)`**
```
⚠ Board context took 2.3s — consider filtering for a smaller board
```
**Fix:** there is no cap to pass. `context` reads the board to completion, and
always did — the `--limit` it used to accept was discarded downstream, so it
never made a snapshot faster. It is removed rather than left there looking
useful; passing it now exits 1 with `unknown option '--limit'`.
```bash
# Ask for less board, since you cannot ask for less of a board
favro context <board-id> | jq '.stats'    # the summary, not the cards
favro cards list <board-id> --limit 50    # a real cap — on what is PRINTED
```

---

**Issue: `Batch operation is slow`**
```
⚠ Batch update of 500 cards took 4.2s — consider splitting
```
**Fix:**
```bash
# Split large batches — 20 rows is the per-file cap
split -l 20 big-batch.csv batch-part-
for f in batch-part-*; do
  favro cards update --from-csv "$f" --yes
done
```

---

### Network & Connection Errors

**Error: `ECONNREFUSED` / `Cannot reach API`**
```
Error: Failed to connect to favro.com API. Is the API endpoint correct?
```
**Fix:**
1. Check your internet connection: `ping favro.com`
2. Verify your firewall/VPN isn't blocking `https://api.favro.com`
3. Check if Favro API is down: https://status.favro.com

---

**Error: `ENOTFOUND` / `DNS resolution failed`**
```
Error: DNS resolution failed. Cannot resolve api.favro.com
```
**Fix:**
1. Check DNS: `nslookup api.favro.com`
2. Try a different DNS server (e.g., 8.8.8.8)
3. Restart your router/VPN

---

### Getting Help

If you see an error not listed here:

1. **Check the online docs:** https://github.com/square-moon/favro-cli#readme
2. **Run with `--verbose` flag** to see more details:
   ```bash
   favro <command> --verbose
   ```
3. **Enable debug logging:**
   ```bash
   DEBUG=favro:* favro <command>
   ```
4. **Report the issue** with your error message and `--verbose` output

---

## More Help

- **Command reference:** [README.md](./README.md)
- **API Reference (SPEC-002):** [API-REFERENCE.md](./API-REFERENCE.md)
- **Installation & troubleshooting:** [INSTALL.md](./INSTALL.md)
- **Performance guide:** [PERFORMANCE.md](./PERFORMANCE.md)
- **Full documentation:** `favro --help`
