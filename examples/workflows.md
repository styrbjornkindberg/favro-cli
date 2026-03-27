# Favro CLI — Common Workflows

A collection of real-world CLI workflows for common Favro tasks.

---

## 1. Getting Started (First-Time Setup)

```bash
# Install
npm install -g favro-cli

# Authenticate (saves to ~/.favro/config.json)
favro auth login --api-key YOUR_API_KEY

# Verify your API key works
favro auth check

# List your boards to find board IDs
favro boards list
```

---

## 2. Sprint Planning — Bulk Import Tasks

Use a CSV file to create a sprint's worth of tasks in one command.

```bash
# Preview what would be created (dry run)
favro cards create --csv examples/sprint-tasks.csv --board <boardId> --dry-run

# Create all tasks from CSV
favro cards create --csv examples/sprint-tasks.csv --board <boardId>

# The CSV format:
# name,description,status
# "Fix login bug","Affects Safari users","In Progress"
# "Add dark mode","User request","Backlog"
```

---

## 3. Update Cards in Bulk with Filtering

```bash
# List all "In Progress" cards on a board
favro cards list --board <boardId> --status "In Progress"

# Update a specific card's status
favro cards update <cardId> --status "Done"

# Reassign a card to a new owner
favro cards update <cardId> --assignees "alice"

# Add tags and update status at once
favro cards update <cardId> --tags "bug,sprint-42" --status "In Progress"

# Preview update without saving (dry run)
favro cards update <cardId> --status "Done" --dry-run
```

---

## 4. Export Cards for Reporting

```bash
# Export all cards from a board to CSV
favro cards export <boardId> --format csv --out sprint-report.csv

# Export as JSON for scripting
favro cards export <boardId> --format json --out sprint.json

# Filter by assignee before exporting
favro cards export <boardId> --format csv --filter "assignee:alice" --out alice-cards.csv

# Filter by status
favro cards export <boardId> --format csv --filter "status:Done" --out completed.csv

# Chain multiple filters (AND logic)
favro cards export <boardId> --format json \
  --filter "assignee:alice" \
  --filter "status:In Progress" \
  | jq '.[].name'

# Stream JSON to stdout and pipe to jq
favro cards export <boardId> --format json | jq '.[].name'
```

---

## 5. Sprint Review — Find All Done Cards

```bash
# Find all done cards by alice this sprint
favro cards export <boardId> --format json \
  --filter "assignee:alice" \
  --filter "status:Done" \
  --filter "tag:sprint-42" \
  --out alice-done-sprint42.json

# Count how many cards were completed
favro cards export <boardId> --format json \
  --filter "status:Done" \
  | jq 'length'
```

---

## 6. Scripting with JSON Output

```bash
# Get card IDs in a machine-readable format
favro cards list --board <boardId> --json | jq '.[].cardId'

# Create a card and capture its ID
CARD_ID=$(favro cards create "New task" --board <boardId> --json | jq -r '.cardId')
echo "Created card: $CARD_ID"

# Update it immediately
favro cards update "$CARD_ID" --status "In Progress" --assignees "alice"
```

---

## 7. Bulk Create from JSON

```bash
# Create cards from a JSON array
cat tasks.json
# [
#   { "name": "Task 1", "status": "Todo", "boardId": "<boardId>" },
#   { "name": "Task 2", "status": "Backlog", "boardId": "<boardId>" }
# ]

favro cards create --bulk tasks.json --board <boardId> --dry-run
favro cards create --bulk tasks.json --board <boardId>
```

---

## Tips

- Use `--dry-run` to preview any create/update before committing.
- Use `--json` flag on any command to get machine-readable output for scripting.
- Run `favro <command> --help` for full option reference.
- Set `FAVRO_API_KEY` env var for CI/CD pipelines (no config file needed).
