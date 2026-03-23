# SPEC-001: Favro CLI MVP

**Project:** Favro CLI
**Status:** Ready for Development
**Priority:** Medium
**Estimated Effort:** 2-3 weeks
**Owner:** CTO / Architect

---

## 📋 OVERVIEW

A command-line interface for Favro task management API that automates routine workflows: bulk card creation, status updates, exports, and filtering. This MVP focuses on the highest-impact features identified in Scout's research.

**Why build this?**
- Square Moon sprints require 30+ minutes of manual data entry per sprint
- No official Favro CLI exists; community gap
- Enables automation hooks (GitHub integration, CI/CD, etc.)
- Repeatable ROI: every sprint uses the same workflows

**Success criteria:**
- Bulk create cards from CSV/JSON
- Update card status (single + batch)
- Export cards to JSON/CSV
- Filter by assignee, status, label
- < 2 hours onboarding time for team

---

## 🎯 USER STORIES

### Story 1: Bulk Card Creation
**As a** sprint planner
**I want to** create 50+ cards from a spreadsheet in seconds
**So that** I don't manually type card titles, descriptions, and assignments

**Definition of Done:**
- [ ] CLI accepts CSV file: `favro cards create --from sprint.csv --board "Q2-Dev"`
- [ ] CSV format supports: title, description, assignee, due_date, label (required: title; optional: rest)
- [ ] Handles API rate limits gracefully (batch size 10, 100ms delay between batches)
- [ ] Error reporting: which rows failed, why (invalid assignee, malformed date, etc.)
- [ ] Success output: "Created 47/50 cards. 3 failed (see errors.log)"

**Test case:**
- Given: CSV with 50 tasks
- When: `favro cards create --from tasks.csv --board test`
- Then: All 50 cards created, assignees set, due dates parsed

---

### Story 2: Batch Card Status Updates
**As a** developer
**I want to** update multiple card statuses with a single command
**So that** I can sync work status without opening Favro UI

**Definition of Done:**
- [ ] CLI supports: `favro cards update --where "status:in-progress" --set "status:done"`
- [ ] Query syntax: `--where "field:value"` (supports: status, assignee, label, due_date_range)
- [ ] Batch update size: max 100 cards per command (show warning if > 100 match)
- [ ] Dry-run mode: `--dry-run` shows which cards would be updated (no changes)
- [ ] Confirmation: "Update 23 cards? (y/n)"

**Test case:**
- Given: 23 cards with status "in-progress"
- When: `favro cards update --where "status:in-progress" --set "status:done" --dry-run`
- Then: Shows list of 23 cards, no actual update

---

### Story 3: Export Cards
**As a** project manager
**I want to** export cards to JSON or CSV for analysis/sharing
**So that** I can generate reports, share with non-Favro stakeholders, or backup data

**Definition of Done:**
- [ ] CLI supports: `favro cards export --board "Q2-Dev" --format json --filter "assignee:me"`
- [ ] Output formats: JSON (nested structure), CSV (flat, all fields)
- [ ] Default output: stdout; optional file output: `--output report.csv`
- [ ] Filter syntax: `--filter "status:done"` or `--filter "assignee:john AND label:urgent"`
- [ ] JSON includes all card properties: id, title, description, assignees, due_date, labels, custom_fields, created_at, updated_at

**Test case:**
- Given: Board with 30 cards
- When: `favro cards export --board test --format csv --filter "status:done" --output done-cards.csv`
- Then: CSV file created with 12 "done" cards

---

### Story 4: Filter & List Cards
**As a** team member
**I want to** quickly see cards matching criteria (my assignments, urgent, due soon)
**So that** I know what to focus on without opening Favro

**Definition of Done:**
- [ ] CLI supports: `favro cards list --board "Q2-Dev" --filter "assignee:me"`
- [ ] Filter operators: `assignee`, `status`, `label`, `due_before`, `due_after`, `created_by`
- [ ] Output: table format (title, assignee, status, due_date, labels)
- [ ] Optional: `--json` for structured output
- [ ] Pagination: `--limit 50` (default 20)

**Test case:**
- Given: Board with 100 cards
- When: `favro cards list --board test --filter "assignee:me" --limit 10`
- Then: Shows 10 cards assigned to me in table format

---

### Story 5: Card Create (Single)
**As a** developer
**I want to** create a single card from the CLI
**So that** I can quickly log ad-hoc work without opening Favro

**Definition of Done:**
- [ ] CLI supports: `favro cards create --board "Q2-Dev" --title "Fix login bug" --description "Users seeing 500 on login" --assignee john --due "2026-03-25"`
- [ ] All flags optional except --title, --board
- [ ] Returns: created card ID and URL to card in Favro

**Test case:**
- Given: No card exists with this title
- When: `favro cards create --board test --title "Test card" --assignee john`
- Then: Card created, output: "Card created: card-123 (https://favro.com/...)"

---

## 🏗️ TECHNICAL DESIGN

### Architecture

```
favro-cli/
├── bin/
│   └── favro                      # CLI entry point
├── src/
│   ├── api/
│   │   ├── client.ts              # Favro API HTTP client (auth, rate limiting)
│   │   ├── collections.ts         # Collection endpoints
│   │   ├── boards.ts              # Board endpoints
│   │   └── cards.ts               # Card endpoints
│   ├── commands/
│   │   ├── cards/
│   │   │   ├── create.ts          # Bulk + single create
│   │   │   ├── update.ts          # Batch updates
│   │   │   ├── list.ts            # Filter & list
│   │   │   └── export.ts          # Export JSON/CSV
│   │   ├── boards/
│   │   │   └── list.ts            # List boards in collection
│   │   └── auth/
│   │       └── login.ts           # Set API key
│   ├── utils/
│   │   ├── csv.ts                 # CSV parser (input)
│   │   ├── formatter.ts           # Table/JSON output formatting
│   │   ├── filter.ts              # Query parser (--where, --filter)
│   │   └── errors.ts              # Consistent error handling
│   └── config.ts                  # Config file (~/.favro/config.json)
├── package.json                   # pnpm@9.15.4 required
├── README.md                       # Usage guide
└── tests/
    ├── api/
    │   └── cards.test.ts
    └── commands/
        └── cards.test.ts

```

### Tech Stack
- **Language:** TypeScript
- **CLI Framework:** Commander.js or Yargs (low overhead, widely used)
- **HTTP Client:** axios or node-fetch (retry logic for rate limits)
- **CSV:** csv-parser + csv-stringify (lightweight)
- **Config:** JSON file in `~/.favro/config.json` (API key, default board)
- **Testing:** Jest (unit + integration tests)
- **Package Manager:** pnpm@9.15.4 (required per TOOLS.md)

### Configuration
```json
{
  "apiKey": "YOUR_FAVRO_API_KEY",
  "apiBaseUrl": "https://api.favro.com/v1",
  "defaultCollection": null,
  "defaultBoard": null,
  "defaultFormat": "table"
}
```

### API Client Features
- **Rate limiting:** Queue requests, respect 429 response (typical: 100 req/min)
- **Retry logic:** 3 retries with exponential backoff (500ms, 1s, 2s)
- **Error handling:** Consistent error messages ("Card not found", "Unauthorized", etc.)
- **Logging:** Debug mode with `--verbose` flag

### Error Handling
- **Invalid API key:** "Unauthorized: check your API key"
- **Board not found:** "Board 'Q2-Dev' not found. Available boards: Q2-Marketing, Q2-Dev, Q1-Archive"
- **Malformed CSV:** "Row 5: missing required field 'title'"
- **Rate limit:** "Rate limited. Retrying in 30 seconds..." (auto-retry)
- **Network error:** "Failed to connect to Favro API. Check internet connection."

---

## 📦 DELIVERABLES

### 1. CLI Commands (Installed as `favro` in $PATH)
```bash
favro --version              # Show version
favro --help                 # Show help

# Auth
favro auth login             # Set API key

# Cards
favro cards create [options] # Bulk or single create
favro cards update [options] # Batch update
favro cards list [options]   # Filter & list
favro cards export [options] # Export JSON/CSV
favro cards get <id>         # Get single card details

# Boards
favro boards list            # List boards in collection
```

### 2. Documentation
- [ ] README.md with installation, quickstart, examples
- [ ] Usage guide: each command with examples
- [ ] API rate limits and retry behavior documented
- [ ] Troubleshooting section (common errors, solutions)

### 3. Tests
- [ ] Unit tests for API client (mocked Favro API)
- [ ] Integration tests for each command (create, update, list, export)
- [ ] Error handling tests (malformed input, network errors)
- [ ] CSV parsing tests (valid input, edge cases, errors)

### 4. GitHub Release
- [ ] npm package published: `npm install @square-moon/favro-cli`
- [ ] GitHub releases with binary distribution (optional)
- [ ] CI/CD pipeline: test + publish on tag

---

## 🔄 WORKFLOW INTEGRATION

### After MVP Launch
- **Phase 2:** GitHub integration (auto-create/close cards from PRs)
- **Phase 3:** Slack integration (notifications, card mentions)
- **Phase 3:** Kanban automation (status-based workflows, webhooks)

---

## ✅ ACCEPTANCE CRITERIA

**All of the following must be true for MVP to be "done":**

1. ✅ All 5 user stories have passing tests
2. ✅ CLI is installable via npm: `npm install @square-moon/favro-cli`
3. ✅ All commands have `--help` and examples in README
4. ✅ Rate limiting is handled (tested with large CSV files)
5. ✅ Error messages are user-friendly (not stack traces)
6. ✅ Config file works (~/.favro/config.json)
7. ✅ GitHub repo has CI/CD pipeline (tests on push, publish on tag)
8. ✅ Team tested with real Favro board (no sandbox-only testing)

---

## 📅 TIMELINE

| Phase | Duration | Deliverable |
|-------|----------|-------------|
| Design (CLI structure, API client) | 2-3 days | Code skeleton + test setup |
| Core (Cards commands: create, update, list, export) | 5-7 days | All 5 commands working + tested |
| Polish (Error handling, rate limiting, docs) | 2-3 days | README, troubleshooting, edge cases |
| Testing (Team integration test, real Favro board) | 1-2 days | Verification, feedback |
| **Total MVP** | **10-15 days** | Production-ready CLI |

---

## 🚀 GO/NO-GO DECISION

**Recommendation:** GO (from Scout research CLA-1758)
- Clear pain point (30+ min per sprint on manual work)
- Low technical risk (REST API is straightforward)
- Repeatable ROI (every sprint uses the same workflows)
- Natural expansion path (GitHub, Slack integration later)

**Kill criteria:**
- Favro API changes (breaking changes, deprecated endpoints)
- Team decides Favro is not strategic
- Time to market > 4 weeks (revisit scope)

---

**Status:** ✅ Ready for Architect review and task breakdown

**Next step:** Architect reviews, approves, creates task breakdown (tasks.md)
