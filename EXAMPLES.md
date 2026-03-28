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

# Preview export filter
favro cards export abc123 --filter "status:Todo" --dry-run
```

---

## Tips & Tricks

- **Use `--json` for scripting:** Append `--json` to any command to get JSON output
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

### Use Batch Commands Over Shell Loops

A single `batch` command is far more efficient than looping `cards update`:

```bash
# Fast: one batch call
favro batch assign --board board-001 --filter "status:Backlog" --to alice

# Slow: N individual API calls
favro cards list --board board-001 --status Backlog --json \
  | jq -r '.[].cardId' \
  | while read id; do favro cards update "$id" --assignees alice; done
```

### Paginate Large Activity Logs

For boards with many cards, paginate the activity log to avoid large responses:

```bash
# Fetch in pages of 50
favro activity log board-001 --limit 50 --offset 0    # page 1
favro activity log board-001 --limit 50 --offset 50   # page 2
favro activity log board-001 --limit 50 --offset 100  # page 3
```

### Always Dry-Run Batch Operations

Preview before applying — it's free and prevents mistakes:

```bash
favro batch update --from-csv updates.csv --dry-run
favro batch-smart board-001 --goal "close all Done cards" --dry-run
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
export SPRINT_BOARD=$(favro boards list --json | jq -r '.[] | select(.name == "Sprint 43") | .boardId')
favro cards list --board $SPRINT_BOARD
favro activity log $SPRINT_BOARD --since 1d
```

### Split Large CSV Batches

Keep batch CSV files under ~500 rows to avoid long-running operations:

```bash
split -l 500 big-updates.csv batch-part-
for f in batch-part-*; do
  echo "Processing $f..."
  favro batch update --from-csv "$f" --verbose
done
```

---

## AI-Powered Workflows (SPEC-003)

These workflows leverage LLM-driven commands to automate complex tasks.

### Workflow: Code Review Assignment

Automatically assign code review cards based on sprint status:

```bash
# 1. Get board context
favro context sprint-42 > board-snapshot.json

# 2. Query for "In Progress" code review cards
favro query sprint-42 "status:In Progress label:code-review"

# 3. Propose auto-assignment of unassigned code reviews to alice
favro propose sprint-42 'assign all code-review cards with no owner to alice' \
  > proposal-$(date +%s).json

# 4. Review and execute the proposal
change_id=$(jq -r '.changeId' proposal-*.json)
favro execute $change_id
```

### Workflow: Sprint Planning & Prioritization

Semi-automatic sprint plan based on priority and capacity:

```bash
# 1. Get sprint suggestions for 40-point capacity
favro sprint-plan sprint-42 --budget 40 > sprint-plan.json

# 2. Review suggestions (see cards, priority scores)
cat sprint-plan.json | jq '.suggestions[] | {title, priority_score, cumulative}'

# 3. Move suggested cards to "Approved" status
for card_id in $(jq -r '.suggestions[].id' sprint-plan.json); do
  favro propose sprint-42 "move card $card_id to Approved" | \
    jq -r '.changeId' | \
    xargs -I {} favro execute {}
done

# 4. Standup: see what's in progress vs what's due soon
favro standup sprint-42
```

### Workflow: Family/Personal Task Management

Use `favro-cli` to manage shared household projects:

```bash
# 1. Initialize a household project board (one-time setup)
board_id=$(favro boards create "2026 Home Projects" --json | jq -r '.boardId')

# 2. Bulk create tasks from a list
echo "Renovate kitchen,Garden fence repair,Paint basement" | \
  tr ',' '\n' | \
  while read task; do
    favro cards create "$task" --board $board_id --status Backlog
  done

# 3. Parse natural language actions: "assign kitchen to alice"
favro parse 'assign "Renovate kitchen" to alice'

# 4. Semantic search: find overdue tasks
favro query $board_id "due:<today"

# 5. Batch close done items
favro batch-smart $board_id --goal "close all Done cards"

# 6. Standup: summary of what's blocked, due soon, in progress
favro standup $board_id
```

### Workflow: Technical Debt & Risk Tracking

Monitor and resolve technical debt semi-automatically:

```bash
# 1. Create a "Technical Debt" board
debt_board=$(favro boards create "Tech Debt Q1 2026" --json | jq -r '.boardId')

# 2. Get board context for analysis
favro context $debt_board > debt-snapshot.json

# 3. Query for high-priority items without owners
favro query $debt_board "priority:high status:Backlog owner:none"

# 4. Propose assignment of unassigned tech debt to the platform team
favro propose $debt_board 'assign all high-priority tech debt with no owner to platform-team'

# 5. Standup on tech debt progress
favro standup $debt_board

# 6. Archive resolved items
favro batch-smart $debt_board --goal "close all Done cards"
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
favro query <board-id> "title:partial card name"
```

---

### Parsing & Action Errors

**Error: `Cannot parse action`**
```
Cannot parse move action. Expected: move card "<title>" from <status> to <status>
```
**Fix:** Check syntax. Examples:
```bash
# Correct
favro propose board-id 'move "Fix bug" from Backlog to In Progress'
favro propose board-id 'assign "Review PR" to alice'
favro propose board-id 'close "Complete task"'

# Incorrect (missing required parts)
favro propose board-id 'move "Fix bug"'  # missing target status
favro propose board-id 'assign "task"'    # missing assignee
```

---

**Error: `Ambiguous card name`**
```
Ambiguous: Found multiple cards matching "fix". Did you mean:
  1. Fix login bug (card-001)
  2. Fix API timeout (card-002)
  3. Fix CI pipeline (card-003)
```
**Fix:** Be more specific with the card name:
```bash
favro propose board-id 'move "Fix login bug" to Done'
```

---

### Batch Operation Errors

**Error: `CSV format invalid`**
```
Error: CSV file missing required column 'card_id'
Required columns: card_id, (optional) status, assignees, tags
```
**Fix:** Check your CSV header row. Example:
```csv
card_id,status,assignees
card-001,In Progress,alice@example.com
card-002,Done,bob@example.com
```

---

**Error: `Goal parsing failed`**
```
Cannot parse goal: "add urgent tag to all backlog cards"

Supported patterns:
  move all <filter> cards to <status>
  assign all <filter> cards to <user>
  close all <filter> cards
  unassign all <filter> cards

Filter keywords: overdue, blocked, unassigned, <status-name>
```
**Fix:** Use a supported goal pattern:
```bash
# ✓ Correct
favro batch-smart board-id --goal "move all overdue cards to Review"
favro batch-smart board-id --goal "assign all Backlog cards with no owner to alice"
favro batch-smart board-id --goal "close all Done cards"

# ✗ Unsupported
favro batch-smart board-id --goal "add urgent tag to backlog"  # tags not supported yet
```

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
# Use sequential mode (slower, but less likely to rate-limit)
favro batch update --from-csv updates.csv  # default concurrency=1
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
**Fix:**
```bash
# Filter by collection first
favro context <board-id> --collection <collection-id>
# Or use a simpler board with fewer cards
```

---

**Issue: `Batch operation is slow`**
```
⚠ Batch update of 500 cards took 4.2s — consider splitting
```
**Fix:**
```bash
# Split large batches
split -l 250 big-batch.csv batch-part-
for f in batch-part-*; do
  favro batch update --from-csv "$f"
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
