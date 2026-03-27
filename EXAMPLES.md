# Favro CLI Examples

Real-world workflows and command examples for common tasks.

---

## Table of Contents

1. [Quick Start (5 Minutes)](#quick-start-5-minutes)
2. [Fetch Tasks for Today](#fetch-tasks-for-today)
3. [Update Task Status](#update-task-status)
4. [Create New Tasks](#create-new-tasks)
5. [Export for Reporting](#export-for-reporting)
6. [Bulk Operations](#bulk-operations)
7. [Scripting & Automation](#scripting--automation)

---

## Quick Start (5 Minutes)

Get up and running with your first Favro CLI commands:

```bash
# 1. Authenticate (takes 30 seconds)
favro auth login

# 2. List your boards to find the board ID
favro boards list

# 3. Copy a board ID from the output
# Example: "abc123def456" for "Q1 Planning"

# 4. List tasks on that board
favro cards list --board abc123def456

# 5. Create your first task
favro cards create "My first task" --board abc123def456

# 6. Done! Explore more commands below
favro --help
```

**Time investment:** ~2–3 minutes once you have your API key.
**Success:** You can list and create tasks without errors.

---

## Fetch Tasks for Today

Get an overview of your current workload.

### List all tasks on a board

```bash
favro cards list --board <boardId>
```

Output:
```
ID        Name                    Status        Assignee
abc123    Fix login bug           In Progress   alice
def456    Add dark mode           Backlog       bob
ghi789    Update docs             Done          alice
```

### Filter by status

```bash
# Show only "In Progress" tasks
favro cards list --board <boardId> --status "In Progress"

# Show only "Done" tasks
favro cards list --board <boardId> --status "Done"
```

### Filter by assignee (if supported)

```bash
# Show tasks assigned to you
favro cards list --board <boardId> --assignee "your-name"
```

### Export to file for review

```bash
# Save today's tasks to a text file
favro cards export <boardId> --format json > today-tasks.json

# Then view with jq (if installed)
cat today-tasks.json | jq '.[].name'
```

---

## Update Task Status

Move tasks through your workflow.

### Update a single task

```bash
# Mark a task as "In Progress"
favro cards update <cardId> --status "In Progress"

# Mark it "Done"
favro cards update <cardId> --status "Done"

# Change status AND assignee
favro cards update <cardId> --status "In Review" --assignees "alice"
```

### Preview before updating (dry run)

```bash
# See what would change without saving
favro cards update <cardId> --status "Done" --dry-run
```

### Verify the change

```bash
# List the task again to confirm
favro cards list --board <boardId> --status "Done"
```

---

## Create New Tasks

Add work to your board.

### Create a single task

```bash
# Simple task creation
favro cards create "Write deployment guide" --board <boardId>

# With status and description
favro cards create "Write deployment guide" \
  --board <boardId> \
  --status "Backlog" \
  --description "Document the new deployment process"

# With tags
favro cards create "Refactor auth module" \
  --board <boardId> \
  --tags "refactor,tech-debt"
```

### Create from a CSV file

Useful for bulk task import from a spreadsheet.

```bash
# CSV format: name, description, status
# Example: examples/sprint-tasks.csv
cat examples/sprint-tasks.csv
# name,description,status
# "Fix login bug","Affects Safari users","In Progress"
# "Add dark mode","User request","Backlog"

# Preview what will be created
favro cards create --csv examples/sprint-tasks.csv --board <boardId> --dry-run

# Create all tasks
favro cards create --csv examples/sprint-tasks.csv --board <boardId>

# Verify
favro cards list --board <boardId> | grep "Fix login bug"
```

### Create from JSON (for scripting)

```bash
# JSON format: array of card objects
cat tasks.json
# [
#   { "name": "Task 1", "status": "Todo", "description": "Do this" },
#   { "name": "Task 2", "status": "Backlog", "description": "Do that" }
# ]

favro cards create --bulk tasks.json --board <boardId> --dry-run
favro cards create --bulk tasks.json --board <boardId>
```

---

## Export for Reporting

Generate reports and backups of your boards.

### Export a board to CSV

Useful for spreadsheets, sharing with non-CLI users, or backup.

```bash
# Export all tasks from a board
favro cards export <boardId> --format csv --out board-backup.csv

# View the exported file
cat board-backup.csv
# id,name,description,status,assignees,tags,...
# abc123,"Fix login bug","Affects Safari","In Progress","alice","bug",...
```

### Export to JSON for scripting

```bash
# Export as JSON for machine processing
favro cards export <boardId> --format json --out board.json

# Use jq to filter and transform
cat board.json | jq '.[] | select(.status == "Done") | .name'
```

### Filter before exporting

```bash
# Export only "In Progress" tasks
favro cards export <boardId> --format csv \
  --filter "status:In Progress" \
  --out in-progress.csv

# Export tasks assigned to a specific person
favro cards export <boardId> --format csv \
  --filter "assignee:alice" \
  --out alice-tasks.csv

# Multiple filters (AND logic)
favro cards export <boardId> --format csv \
  --filter "assignee:alice" \
  --filter "status:Done" \
  --out alice-done-tasks.csv
```

---

## Bulk Operations

Manage multiple tasks efficiently.

### Update multiple tasks by status

```bash
# List all "In Progress" tasks
favro cards list --board <boardId> --status "In Progress"

# Manually update each via cardId
for cardId in abc123 def456 ghi789; do
  favro cards update "$cardId" --status "Done"
done
```

### Bulk import from spreadsheet

```bash
# 1. Prepare a CSV file
cat my-tasks.csv
# name,description,status
# "Design new UI","Figma specs ready","In Progress"
# "Code review","PR #42","In Review"

# 2. Preview
favro cards create --csv my-tasks.csv --board <boardId> --dry-run

# 3. Create all at once
favro cards create --csv my-tasks.csv --board <boardId>
```

### Count tasks by status

```bash
# Export and count with jq
favro cards export <boardId> --format json | \
  jq 'group_by(.status) | map({status: .[0].status, count: length})'

# Output:
# [
#   { "status": "Done", "count": 12 },
#   { "status": "In Progress", "count": 5 },
#   { "status": "Backlog", "count": 8 }
# ]
```

---

## Scripting & Automation

Use Favro CLI in shell scripts and automation.

### Get JSON output for programmatic use

```bash
# List tasks as JSON
favro cards list --board <boardId> --json > tasks.json

# Create a card and capture its ID
CARD_ID=$(favro cards create "New task" --board <boardId> --json | jq -r '.cardId')
echo "Created card: $CARD_ID"

# Update the newly created card
favro cards update "$CARD_ID" --status "In Progress" --assignees "alice"
```

### Fetch data for external systems

```bash
# Export all cards and pipe to another tool
favro cards export <boardId> --format json | \
  jq '.[] | {title: .name, owner: .assignees[0], status: .status}' | \
  curl -X POST -d @- https://your-webhook-receiver.com/cards
```

### Automation in CI/CD

```bash
# In a GitHub Actions workflow:
env:
  FAVRO_API_KEY: ${{ secrets.FAVRO_API_KEY }}

run: |
  # Create a deployment task
  favro cards create "Deploy v1.2.3" \
    --board abc123def456 \
    --status "In Progress" \
    --tags "deployment,v1.2.3"
```

### Scheduled updates (with cron)

```bash
# In crontab: Update status of stale tasks daily at 9am
# 0 9 * * * /usr/local/bin/favro cards update <cardId> --status "Done"
```

---

## Tips & Tricks

- **Use `--help` on any command** to see all available options:
  ```bash
  favro cards create --help
  favro boards list --help
  ```

- **Use `--dry-run` to preview** before creating or updating:
  ```bash
  favro cards create --csv tasks.csv --board <id> --dry-run
  ```

- **Use `--json` for scripting output:**
  ```bash
  favro cards list --board <id> --json | jq '.[].cardId'
  ```

- **Set `FAVRO_API_KEY` for CI/CD** (no config file needed):
  ```bash
  export FAVRO_API_KEY=your_key_here
  favro boards list
  ```

- **Verbose mode for debugging:**
  ```bash
  favro boards list --verbose
  ```

---

## Need Help?

- **Installation issues?** See [INSTALL.md](./INSTALL.md)
- **Full feature reference?** See [README.md](./README.md)
- **Commands not working?** Run with `--verbose` for stack traces:
  ```bash
  favro boards list --verbose
  ```

Happy tasking! 🎯
