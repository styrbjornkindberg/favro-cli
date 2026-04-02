# AI & Automation Commands

Favro CLI includes AI-powered commands that use LLMs to analyze boards, answer questions, and execute multi-step operations.

---

## Setup

Configure an AI provider before using these commands:

```bash
# Anthropic Claude (recommended)
favro ai setup --provider anthropic --api-key sk-ant-...

# OpenAI GPT
favro ai setup --provider openai --api-key sk-...

# Local Ollama (no API key needed)
favro ai setup --provider ollama

# Auto-detect from environment variables
export ANTHROPIC_API_KEY=sk-ant-...
favro ai setup
```

---

## Commands

### `ask <board> <question>`

Ask a natural language question about a board. Fetches board context and sends it to the LLM.

```bash
favro ask "Sprint 42" "What cards are blocked?"
favro ask "Sprint 42" "Summarize alice's workload" --json
favro ask "Sprint 42" "What changed recently?" --context-only  # Dump context, no LLM
```

| Flag | Description |
|------|-------------|
| `--json` | JSON output |
| `--context-only` | Output board context without calling LLM |
| `--limit <n>` | Max cards in context (default: 1000) |

### `do <board> <goal>` ⚠️ WRITE — HIGH BLAST RADIUS

AI-planned multi-step execution. The LLM analyzes the board, generates a plan, previews it, and executes after confirmation.

```bash
favro do "Sprint 42" "move all overdue cards to Review" --dry-run
favro do "Sprint 42" "assign unassigned bugs to alice" --yes
```

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview plan without executing |
| `-y, --yes` | Skip confirmation |
| `--json` | Output plan as JSON |

### `explain <cardId>`

AI-generated card summary — fetches card details + comments, produces structured analysis.

```bash
favro explain abc123
favro explain abc123 --board "Sprint 42" --json
```

| Flag | Description |
|------|-------------|
| `--json` | JSON output |
| `--board <boardId>` | Board context for richer analysis |

---

## Smart Batch Operations

### `batch-smart <board> --goal "..."` ⚠️ WRITE — HIGH BLAST RADIUS

Natural language batch operations — no LLM required (uses pattern matching).

```bash
favro batch-smart "Sprint 42" --goal "move all overdue cards to Review" --dry-run
favro batch-smart "Sprint 42" --goal "assign all Backlog cards with no owner to alice"
favro batch-smart "Sprint 42" --goal "close all Done cards"
```

Supported patterns:
- `move all <filter> cards to <status>`
- `assign all <filter> cards [with no owner] to <user>`
- `close all <filter> cards`
- `unassign all <filter> cards`

### `propose <board> --action "..."`

Two-step safety: propose generates a preview with a change ID.

```bash
favro propose "Sprint 42" --action "move card 'Fix login' to Review"
# → change-id: ch_abc123

favro execute "Sprint 42" --change-id ch_abc123 --yes
```

---

## Board Analysis

### `context <board>`

Full board snapshot for AI workflows — complete JSON blob with board metadata, columns, custom fields, members, cards, workflow stages, and stats.

```bash
favro context "Sprint 42"
favro context "Sprint 42" --limit 500
```

### `standup --board <board>`

Daily standup view: groups cards into completed, in-progress, blocked, and due-soon categories.

### `sprint-plan --board <board>`

Sprint planning suggestions, sorted by priority × effort score. Optionally cap by effort budget.

### `audit <board> --since 1d`

Board change audit log — who changed what, when.

### `who-changed <cardTitle>`

Card edit history by title search.

### `risks <board>`

Board risk analysis — surfaces blocked, stale, unassigned, and incomplete cards.

### `release-check <board>`

Release readiness check — flags blockers, incomplete cards, and missing assignees.

---

## Skills — Reusable Workflows

Skills are YAML-defined multi-step workflows that chain CLI commands.

```bash
favro skill list                              # List available skills
favro skill run daily-digest --board <id>     # Run a built-in skill
favro skill run triage --board <id> --dry-run # Preview first
favro skill create my-workflow                # Create from template
favro skill edit my-workflow                  # Open in $EDITOR
favro skill export my-workflow                # Output as YAML
favro skill import ./shared-skill.yaml        # Import from file
favro skill record my-recording               # Start recording
favro skill stop                              # Stop and save
```

### Built-in Skills

| Name | Description |
|------|-------------|
| `daily-digest` | Standup + overdue + blocked cards |
| `triage` | Find unassigned cards, suggest owners |
| `sprint-close` | Summarize completed work, audit changes |
| `stale-cleanup` | Flag inactive cards, suggest actions |
| `release-prep` | Changelog from done cards, flag blockers |
