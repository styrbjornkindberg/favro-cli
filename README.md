<p align="center">
  <img src="https://img.shields.io/badge/version-2.0.0-blue" alt="version">
  <img src="https://img.shields.io/badge/node-18%2B-brightgreen" alt="node">
  <img src="https://img.shields.io/badge/license-MIT-lightgrey" alt="license">
</p>

<h1 align="center">favro-cli</h1>
<p align="center">
  Manage your <a href="https://favro.com">Favro</a> boards, cards, and workflows from the terminal.<br>
  Built for developers, PMs, and AI agents.
</p>

---

## What is this?

A full-featured CLI for Favro that lets you:

- **Browse & manage** — collections, boards, cards, comments, tags, custom fields
- **Automate** — batch operations, CSV import/export, AI-powered commands
- **Integrate** — git branch↔card linking, interactive shell, kanban TUI
- **Query across boards** — v2 persona commands for developers, PMs, and CTOs

---

## Install

Requires **Node.js 18+**.

```bash
git clone https://github.com/styrbjornkindberg/favro-cli.git
cd favro-cli
npm install && npm run build && npm link
```

Need help? See the **[Installation Guide](./INSTALL.md)**.

---

## Quick Start

```bash
# 1. Authenticate
favro auth login

# 2. Launch the interactive menu
favro
```

That's it. The menu gives you:

| Entry | What it does |
|-------|-------------|
| **My Work** | Your cards across all boards, with suggested next action |
| **Team Dashboard** | Team workload and bottleneck overview |
| **Browse** | Collections → Boards → Kanban view → Card detail |

Or use commands directly:

```bash
# List boards
favro boards list

# See a board as a kanban
favro board "Sprint 42"

# Create a card
favro cards create "Fix login bug" --board <boardId>

# Move a card to a column
favro cards update <cardId> --column "Developing" --board <boardId>
```

---

## Safety First

Every write command has safety guardrails:

```bash
# Lock writes to one collection (do this first)
favro scope set <collectionId>

# Preview any write before it runs
favro cards create "Test card" --board <id> --dry-run

# Execute after confirming
favro cards create "Test card" --board <id> --yes
```

The flags `--dry-run`, `--yes`, and `--force` give you full control. Scope locking prevents accidental cross-collection writes.

---

## Feature Overview

### Core Commands

| Command | Description |
|---------|-------------|
| `favro boards list` | List all boards |
| `favro cards list --board <id>` | List cards on a board |
| `favro cards create "Title" --board <id>` | Create a card |
| `favro cards update <id> --column "Done" --board <id>` | Move a card |
| `favro cards export <board> --format csv` | Export to CSV/JSON |
| `favro context <board>` | Full board snapshot (JSON) |

### Cross-Board Intelligence (v2)

Commands that work across boards — no board ID needed. Output JSON by default (use `--human` for tables).

| Command | Persona | What it does |
|---------|---------|-------------|
| `favro my-cards` | Developer | Your cards across all boards, grouped by stage |
| `favro my-standup` | Developer | Personal standup: done / in-progress / blocked |
| `favro next` | Developer | AI-scored "what should I work on next?" |
| `favro workload` | PM | Per-member card distribution, overload alerts |
| `favro stale` | PM | Cards inactive >14 days |
| `favro overview` | PM | Collection dashboard with blockers and due dates |
| `favro health` | CTO | Per-board health scores (0-100) with traffic lights |
| `favro team` | CTO | Team utilization and bottleneck analysis |

### AI & Automation

```bash
favro ask <board> "What cards are blocked?"     # Ask questions about a board
favro do <board> "move overdue cards to Review"  # AI-planned execution
favro batch-smart <board> --goal "assign bugs"   # Natural language batch ops
favro explain <cardId>                           # AI card summary
```

Requires AI setup: `favro ai setup --provider anthropic --api-key sk-ant-...`

### Git Integration

```bash
favro git link --board <id>          # Connect repo to board
favro git branch <cardId>           # Create branch, move card to In Progress
favro git commit -m "fix bug"       # Smart commit with card ref
favro git sync                      # Sync merged branches → Done
favro git todos --create            # Create cards from TODO comments
```

### Interactive TUI

```bash
favro                               # Full interactive menu
favro board "Sprint 42"            # Kanban view in terminal
favro board "Sprint 42" --watch    # Auto-refresh every 30s
favro shell                        # Interactive REPL with tab completion
favro diff <board> --since 1d      # What changed today
```

---

## Repo Context: `favro init`

Bootstrap a `.favro/context.json` in your repo so AI agents get instant context — board IDs, workflow columns, team members, custom fields — without API lookups.

```bash
favro init                          # Create from scoped collection
favro init --refresh                # Update after board changes
```

See **[Repo Context Guide](./docs/repo-context.md)** for details.

---

## Configuration

Config lives at `~/.favro/config.json` (mode `0600`):

```json
{
  "apiKey": "...",
  "email": "you@example.com",
  "organizationId": "...",
  "userId": "...",
  "scopeCollectionId": "...",
  "scopeCollectionName": "..."
}
```

Created automatically by `favro auth login`. The login also resolves your Favro userId for cross-board commands.

---

## Documentation

| Document | Description |
|----------|-------------|
| **[Installation Guide](./INSTALL.md)** | System requirements, npm link, troubleshooting |
| **[Command Reference](./docs/commands.md)** | Every command, flag, and option |
| **[AI & Automation](./docs/ai-commands.md)** | AI setup, ask/do/explain, skills, batch-smart |
| **[Git Integration](./docs/git-integration.md)** | Branch↔card linking, smart commits, sync |
| **[Repo Context](./docs/repo-context.md)** | `.favro/context.json` format and `favro init` |
| **[Examples & Workflows](./EXAMPLES.md)** | Real-world command patterns |
| **[API Reference](./API-REFERENCE.md)** | Full Favro API endpoint reference |
| **[Performance](./PERFORMANCE.md)** | Benchmarks and rate limit handling |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `No API key configured` | Run `favro auth login` |
| `API key is invalid` | Regenerate at Favro → Organization Settings → API tokens |
| `Scope violation` | Run `favro scope show` — you're writing outside the locked collection |
| Network errors | Check connection; verify `curl https://favro.com/api/v1/organizations` works |
| `--column` not working | Make sure you pass `--board <id>` alongside `--column` |

Add `--verbose` to any command for full stack traces.

---

## License

See [LICENSE](./LICENSE).
