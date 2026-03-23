# SPEC-001: Favro CLI MVP — Task Breakdown

**Spec:** SPEC-001-mvp.md
**Total Effort:** 10-15 days (estimated 50-75 engineer-hours)
**Recommended Team:** 2 engineers (frontend + backend split possible, or serial)
**Project:** Favro CLI
**Goal:** Work-Life Integration (Favro CLI)

---

## 📐 TASK STRUCTURE

**Format:** Each task is independent, can be assigned to different engineers, built in parallel where dependencies allow.

**Dependencies:**
```
SETUP → API-CLIENT → [CARDS, BOARDS] → INTEGRATION → TESTS → DOCS → PUBLISH
```

---

## 🏗️ SETUP PHASE (1-2 days)

### CLA-FAVRO-001: Project Setup & CI/CD
**Assignee:** Engineer
**Effort:** 2-3 hours
**Dependencies:** None

**Description:**
Set up TypeScript project, GitHub Actions, npm publishing pipeline.

**Acceptance Criteria:**
- [ ] Repository created at `github.com/square-moon/favro-cli` (or internal)
- [ ] TypeScript configured (tsconfig.json, tsc builds to dist/)
- [ ] pnpm@9.15.4 configured (`packageManager` field in package.json)
- [ ] Jest test runner configured (jest.config.js)
- [ ] GitHub Actions workflow created:
  - [ ] On push: run tests
  - [ ] On tag (v*.*.* pattern): build + publish to npm
- [ ] CI passes (initial test skeleton runs)
- [ ] package.json includes:
  - [ ] name: `@square-moon/favro-cli`
  - [ ] bin: `{ "favro": "dist/bin/favro.js" }`
  - [ ] packageManager: `pnpm@9.15.4`

**Definition of Done:**
- GitHub Actions workflow passes all checks
- Local `pnpm test` runs (even if tests are empty)
- Local `pnpm build` creates dist/ with working CLI entry point

---

### CLA-FAVRO-002: CLI Structure & Commander Setup
**Assignee:** Engineer
**Effort:** 2-3 hours
**Dependencies:** CLA-FAVRO-001

**Description:**
Create CLI entry point, install Commander.js, scaffold command structure.

**Acceptance Criteria:**
- [ ] `bin/favro` entry point created (#!/usr/bin/env node)
- [ ] Commander.js installed and configured
- [ ] Commands scaffold created:
  - [ ] `favro --version`
  - [ ] `favro --help`
  - [ ] `favro auth login`
  - [ ] `favro cards create`
  - [ ] `favro cards update`
  - [ ] `favro cards list`
  - [ ] `favro cards export`
  - [ ] `favro boards list`
- [ ] Each command has basic help text (`--help` works on each)
- [ ] Config file loading implemented (~/.favro/config.json)
- [ ] Error handling wrapper (all commands catch + format errors)

**Definition of Done:**
- `favro --help` shows all commands
- `favro cards --help` shows card subcommands
- `favro --version` outputs version from package.json
- Running any command without API key shows: "API key not found. Run `favro auth login` first."

---

## 🔌 API CLIENT PHASE (2-3 days)

### CLA-FAVRO-003: Favro HTTP Client & Authentication
**Assignee:** Engineer
**Effort:** 3-4 hours
**Dependencies:** CLA-FAVRO-002

**Description:**
Build HTTP client with rate limiting, retry logic, and error handling.

**Acceptance Criteria:**
- [ ] src/api/client.ts created with:
  - [ ] BaseClient class wrapping axios
  - [ ] Authentication: Bearer token from config
  - [ ] Rate limiting: queue requests, respect 429 responses
  - [ ] Retry logic: 3 retries with exponential backoff (500ms, 1s, 2s)
  - [ ] Error handling: transform Favro API errors to user-friendly messages
  - [ ] Debug mode: `--verbose` logs HTTP requests
- [ ] Test suite (mocked API):
  - [ ] Successful request returns data
  - [ ] 429 rate limit retries automatically
  - [ ] 401 Unauthorized shows "API key invalid"
  - [ ] Network error shows "Failed to connect to Favro API"
- [ ] Types defined: `FavroCard`, `FavroBoard`, `FavroCollection` (from Favro docs)

**Definition of Done:**
- Unit tests pass (mocked Favro API)
- BaseClient can make requests with auth header
- Rate limiting works (queue implemented)
- Error messages are user-friendly (no stack traces in CLI output)

---

### CLA-FAVRO-004: Favro API Endpoints — Cards
**Assignee:** Engineer
**Effort:** 3-4 hours
**Dependencies:** CLA-FAVRO-003

**Description:**
Implement Favro Cards API methods (list, get, create, update, delete).

**Acceptance Criteria:**
- [ ] src/api/cards.ts created with methods:
  - [ ] `listCards(boardId: string): Promise<Card[]>`
  - [ ] `getCard(cardId: string): Promise<Card>`
  - [ ] `createCard(boardId: string, data: CardInput): Promise<Card>`
  - [ ] `updateCard(cardId: string, data: Partial<CardInput>): Promise<Card>`
  - [ ] `deleteCard(cardId: string): Promise<void>`
  - [ ] `copyCardToBoard(cardId: string, targetBoardId: string): Promise<Card>`
- [ ] Type definitions:
  - [ ] Card interface (all Favro properties)
  - [ ] CardInput interface (for create/update)
  - [ ] FilterQuery interface (for list operations)
- [ ] Tests (mocked API):
  - [ ] listCards returns array of cards
  - [ ] createCard creates card with correct fields
  - [ ] updateCard changes fields without affecting others
  - [ ] copyCardToBoard mirrors card to another board

**Definition of Done:**
- All card methods implemented and tested
- Types match Favro API schema
- Error cases tested (board not found, invalid data, etc.)

---

### CLA-FAVRO-005: Favro API Endpoints — Boards & Collections
**Assignee:** Engineer
**Effort:** 2-3 hours
**Dependencies:** CLA-FAVRO-003

**Description:**
Implement Favro Boards and Collections API methods (list, get).

**Acceptance Criteria:**
- [ ] src/api/boards.ts with methods:
  - [ ] `listBoards(collectionId?: string): Promise<Board[]>`
  - [ ] `getBoard(boardId: string): Promise<Board>`
- [ ] src/api/collections.ts with methods:
  - [ ] `listCollections(): Promise<Collection[]>`
  - [ ] `getCollection(collectionId: string): Promise<Collection>`
- [ ] Type definitions: Board, Collection interfaces
- [ ] Tests (mocked API):
  - [ ] listBoards returns boards
  - [ ] getBoard returns single board with cards

**Definition of Done:**
- Boards and collections queries work
- Types defined
- Tests pass

---

## 🛠️ COMMANDS PHASE (4-6 days)

### CLA-FAVRO-006: Cards Create Command (Bulk + Single)
**Assignee:** Engineer
**Effort:** 4-5 hours
**Dependencies:** CLA-FAVRO-004

**Description:**
Implement `favro cards create` command for bulk (from CSV) and single card creation.

**Acceptance Criteria:**
- [ ] Command syntax:
  - [ ] Single: `favro cards create --board "Q2-Dev" --title "Fix bug" --assignee john`
  - [ ] Bulk: `favro cards create --from tasks.csv --board "Q2-Dev"`
- [ ] CSV parsing:
  - [ ] Support columns: title (required), description, assignee, due_date, label
  - [ ] Handle date formats: YYYY-MM-DD
  - [ ] Validate required fields (title)
  - [ ] Report errors per row: "Row 5: missing 'title'"
- [ ] Rate limiting:
  - [ ] Batch size: 10 cards per request
  - [ ] Delay between batches: 100ms
  - [ ] Show progress: "Creating cards... 10/50"
- [ ] Error handling:
  - [ ] Invalid board: suggest available boards
  - [ ] Invalid assignee: show available assignees
  - [ ] Malformed date: show expected format
- [ ] Output:
  - [ ] Success: "Created 47/50 cards" with list of failed rows
  - [ ] Dry-run mode: `--dry-run` shows what would be created (no changes)

**Tests:**
- [ ] Single card creation works
- [ ] Bulk create with 50 cards works
- [ ] CSV with missing values is rejected
- [ ] Rate limiting batches correctly
- [ ] Error messages are helpful

**Definition of Done:**
- All command syntax works
- CSV parsing handles edge cases (quotes, commas, newlines)
- Rate limiting is implemented and tested
- Error messages guide user to fix problems

---

### CLA-FAVRO-007: Cards Update Command
**Assignee:** Engineer
**Effort:** 3-4 hours
**Dependencies:** CLA-FAVRO-004

**Description:**
Implement `favro cards update` command for batch card updates.

**Acceptance Criteria:**
- [ ] Command syntax:
  - [ ] `favro cards update --where "status:in-progress" --set "status:done"`
  - [ ] `favro cards update --where "label:urgent" --set "priority:high"`
- [ ] Query engine:
  - [ ] Support fields: status, assignee, label, due_before, due_after
  - [ ] Operators: exact match (status:done), partial match (assignee:john)
  - [ ] Multiple conditions: `--where "status:in-progress AND label:urgent"`
- [ ] Batch updates:
  - [ ] Max 100 cards per command (warn if > 100 match)
  - [ ] Dry-run mode: show what would be updated
  - [ ] Confirmation: "Update 23 cards? (y/n)"
- [ ] Error handling:
  - [ ] Invalid field: suggest valid fields
  - [ ] Invalid value: show valid options for enum fields
  - [ ] Ambiguous query: "Did you mean status:done or due_date:..."

**Tests:**
- [ ] Query parser works (parsing --where syntax)
- [ ] Batch update updates all matching cards
- [ ] Dry-run shows correct cards without updating
- [ ] Confirmation prompt works
- [ ] Error cases handled

**Definition of Done:**
- Query syntax is intuitive and well-tested
- Batch updates work correctly
- Dry-run prevents accidents
- Error messages guide user

---

### CLA-FAVRO-008: Cards List Command
**Assignee:** Engineer
**Effort:** 3-4 hours
**Dependencies:** CLA-FAVRO-004

**Description:**
Implement `favro cards list` command with filtering and table output.

**Acceptance Criteria:**
- [ ] Command syntax:
  - [ ] `favro cards list --board "Q2-Dev"`
  - [ ] `favro cards list --board "Q2-Dev" --filter "assignee:me"`
  - [ ] `favro cards list --board "Q2-Dev" --filter "status:done" --limit 50`
- [ ] Filtering (same query engine as update):
  - [ ] Support fields: assignee, status, label, due_before, due_after
  - [ ] Multiple conditions: AND logic
- [ ] Output formats:
  - [ ] Default: table (columns: title, assignee, status, due_date, labels)
  - [ ] Optional: `--json` for structured output
  - [ ] Optional: `--csv` for comma-separated
- [ ] Pagination:
  - [ ] Default limit: 20 cards
  - [ ] `--limit N` to show N cards
  - [ ] Show: "Showing 20 of 47 cards"
- [ ] Table formatting:
  - [ ] Columns fit terminal width (truncate long titles)
  - [ ] Colors for status (done: green, in-progress: yellow, blocked: red)

**Tests:**
- [ ] List without filter shows all cards
- [ ] List with filter shows only matching cards
- [ ] Table format renders correctly
- [ ] JSON format is valid and parseable
- [ ] Pagination works

**Definition of Done:**
- List command shows cards with correct filtering
- Table output is readable and pretty
- All output formats work (table, JSON, CSV)
- No visual artifacts or broken formatting

---

### CLA-FAVRO-009: Cards Export Command
**Assignee:** Engineer
**Effort:** 3-4 hours
**Dependencies:** CLA-FAVRO-004

**Description:**
Implement `favro cards export` command for exporting cards to JSON/CSV.

**Acceptance Criteria:**
- [ ] Command syntax:
  - [ ] `favro cards export --board "Q2-Dev" --format json --output report.json`
  - [ ] `favro cards export --board "Q2-Dev" --format csv --filter "status:done" --output done.csv`
  - [ ] Default output: stdout (if no --output file)
- [ ] Export formats:
  - [ ] JSON: nested structure with all card properties
  - [ ] CSV: flat structure, all columns
- [ ] Filtering (same query engine as list/update):
  - [ ] `--filter "assignee:me"`
  - [ ] Multiple conditions
- [ ] Error handling:
  - [ ] Invalid board: suggest available boards
  - [ ] Cannot write file: "Permission denied: report.json"
  - [ ] Invalid format: "Use --format json or --format csv"

**Tests:**
- [ ] JSON export is valid JSON
- [ ] CSV export is valid CSV (quote-escaped strings)
- [ ] Filtering works on export
- [ ] File write works correctly
- [ ] Stdout output works (no file specified)

**Definition of Done:**
- Export command works for both JSON and CSV
- Output is valid and can be parsed by other tools
- Filtering applies correctly
- Error handling is user-friendly

---

### CLA-FAVRO-010: Boards List Command
**Assignee:** Engineer
**Effort:** 2 hours
**Dependencies:** CLA-FAVRO-005

**Description:**
Implement `favro boards list` command to show available boards.

**Acceptance Criteria:**
- [ ] Command syntax:
  - [ ] `favro boards list` (show all boards in default/current collection)
  - [ ] `favro boards list --collection "Marketing"` (specify collection)
- [ ] Output:
  - [ ] Table format: name, card count, columns, last updated
  - [ ] Optional: `--json` for structured output
- [ ] Filtering:
  - [ ] Show only boards user has access to

**Tests:**
- [ ] List boards returns all boards
- [ ] Table format is readable
- [ ] Collection filter works

**Definition of Done:**
- Boards list command works
- Output shows useful info (name, card count)
- Helps user find board IDs for other commands

---

## 🧪 INTEGRATION & POLISH PHASE (2-3 days)

### CLA-FAVRO-011: Error Handling & User Feedback
**Assignee:** Engineer
**Effort:** 2-3 hours
**Dependencies:** CLA-FAVRO-006 to CLA-FAVRO-010

**Description:**
Unified error handling, helpful messages, and progress indicators across all commands.

**Acceptance Criteria:**
- [ ] Consistent error format:
  - [ ] `Error: [message]` (no stack traces in normal mode)
  - [ ] Stack trace only in `--verbose` mode
- [ ] Helpful error messages:
  - [ ] "Board 'Q2-Dev' not found. Available: Q2-Marketing, Q2-Dev, Q1-Archive"
  - [ ] "Invalid date format. Use YYYY-MM-DD"
  - [ ] "Rate limited. Retrying in 30 seconds..."
- [ ] Progress indicators:
  - [ ] For bulk operations: "Creating cards... 10/50"
  - [ ] For long operations: spinner or progress bar
- [ ] Configuration errors:
  - [ ] "API key not found. Run `favro auth login` first"
  - [ ] Guide user to fix issues

**Tests:**
- [ ] Error messages are consistent
- [ ] Help text guides user to resolution
- [ ] Progress indicators appear for long operations

**Definition of Done:**
- All commands have consistent error handling
- Error messages are helpful (not cryptic)
- CLI is user-friendly (not just for engineers)

---

### CLA-FAVRO-012: Documentation & README
**Assignee:** Engineer
**Effort:** 2-3 hours
**Dependencies:** All commands complete

**Description:**
Write comprehensive README and inline help for all commands.

**Acceptance Criteria:**
- [ ] README.md includes:
  - [ ] Installation: `npm install @square-moon/favro-cli`
  - [ ] Quick start: basic example of each command type
  - [ ] Authentication: how to get API key, set it up
  - [ ] Command reference: all commands with examples
  - [ ] Configuration: ~/.favro/config.json format
  - [ ] Troubleshooting: common errors and solutions
  - [ ] FAQ: e.g., "Can I use this without npm?" (no)
- [ ] Inline help:
  - [ ] `favro --help`: list all commands
  - [ ] `favro cards --help`: list card subcommands
  - [ ] `favro cards create --help`: detailed help with examples
- [ ] Examples:
  - [ ] Bulk create from CSV
  - [ ] Update with filtering
  - [ ] Export for analysis
  - [ ] Real-world use case (Sprint Planning example)

**Definition of Done:**
- README is complete and clear
- Every command has `--help` with examples
- New user can follow README to get started
- No "how do I...?" questions left unanswered

---

### CLA-FAVRO-013: Configuration & Auth Setup
**Assignee:** Engineer
**Effort:** 2 hours
**Dependencies:** CLA-FAVRO-002

**Description:**
Implement `favro auth login` command and config file management.

**Acceptance Criteria:**
- [ ] `favro auth login` command:
  - [ ] Prompts for API key (interactive input)
  - [ ] Saves to ~/.favro/config.json
  - [ ] Confirms: "✓ API key saved"
  - [ ] Test: `favro auth check` confirms key is valid
- [ ] Config file (~/.favro/config.json):
  - [ ] Store: API key, default board, default collection, output format
  - [ ] Load on every command
  - [ ] Support `--api-key` flag to override config
  - [ ] Support environment variable: `FAVRO_API_KEY`
- [ ] Error handling:
  - [ ] Invalid API key: reject with helpful message
  - [ ] Config file permissions: handle read/write errors

**Tests:**
- [ ] Login saves config
- [ ] Config is loaded correctly
- [ ] Overrides work (--api-key flag, env var)
- [ ] Invalid key is rejected

**Definition of Done:**
- Users can set up CLI with `favro auth login`
- Config persists across sessions
- Supports multiple config sources (file, env, flag)

---

## ✅ TESTING PHASE (2-3 days)

### CLA-FAVRO-014: Unit Tests — All Commands
**Assignee:** Engineer
**Effort:** 4-5 hours
**Dependencies:** All commands complete

**Description:**
Write comprehensive unit tests for all commands (mocked API).

**Acceptance Criteria:**
- [ ] Test coverage: > 80% line coverage
- [ ] Tests for each command:
  - [ ] CLA-FAVRO-006: create (single, bulk, CSV parsing, errors)
  - [ ] CLA-FAVRO-007: update (filtering, batch size, dry-run)
  - [ ] CLA-FAVRO-008: list (filtering, pagination, output formats)
  - [ ] CLA-FAVRO-009: export (JSON, CSV, filtering)
  - [ ] CLA-FAVRO-010: boards list
  - [ ] CLA-FAVRO-013: auth (login, config)
- [ ] Edge cases:
  - [ ] Empty results (list with no matches)
  - [ ] Large batches (100+ cards)
  - [ ] Rate limiting (429 retry)
  - [ ] Network error (connection timeout)
  - [ ] Invalid input (malformed CSV, bad dates)
- [ ] Mock Favro API responses

**Definition of Done:**
- All tests pass
- CI/CD runs tests on push
- No untested code paths
- Coverage > 80%

---

### CLA-FAVRO-015: Integration Tests — Real Favro Board
**Assignee:** Engineer
**Effort:** 3-4 hours
**Dependencies:** CLA-FAVRO-014

**Description:**
Test CLI against real Favro test board (no sandbox).

**Acceptance Criteria:**
- [ ] Create test board in Favro (e.g., "CLI Test Board")
- [ ] Test each command against real board:
  - [ ] Create card from CLI, verify in UI
  - [ ] Bulk create 10 cards from CSV, verify all created
  - [ ] Update card status, verify in UI
  - [ ] List cards, verify matches UI
  - [ ] Export cards, verify data correctness
- [ ] Test rate limiting (create 50 cards, verify batch delays work)
- [ ] Test error cases:
  - [ ] Create card with invalid assignee → error
  - [ ] Update non-existent card → error
  - [ ] Invalid board name → error with suggestions

**Definition of Done:**
- All commands tested against real Favro board
- No surprises when real users test
- Rate limiting works as expected

---

## 📦 DEPLOYMENT PHASE (1-2 days)

### CLA-FAVRO-016: Publish to npm & GitHub Release
**Assignee:** Engineer
**Effort:** 2-3 hours
**Dependencies:** CLA-FAVRO-015

**Description:**
Publish CLI to npm registry and create GitHub release.

**Acceptance Criteria:**
- [ ] Package published to npm: `npm install @square-moon/favro-cli`
- [ ] Package metadata correct:
  - [ ] name: `@square-moon/favro-cli`
  - [ ] version: `1.0.0`
  - [ ] bin entry point works
  - [ ] homepage, repository links correct
- [ ] GitHub release created:
  - [ ] Release notes with feature list
  - [ ] Installation instructions
  - [ ] Binary distribution (optional)
- [ ] CI/CD pipeline:
  - [ ] Tests run on push
  - [ ] Publish to npm on git tag `v1.0.0`
- [ ] Verification:
  - [ ] `npm install @square-moon/favro-cli` works
  - [ ] `favro --version` shows 1.0.0

**Definition of Done:**
- CLI is installable from npm
- Team can use: `npm install -g @square-moon/favro-cli`
- GitHub release documents the launch

---

### CLA-FAVRO-017: Team Onboarding & Docs Review
**Assignee:** Engineer + CTO
**Effort:** 2-3 hours
**Dependencies:** CLA-FAVRO-016

**Description:**
Onboard team, gather feedback, update docs based on real usage.

**Acceptance Criteria:**
- [ ] Team tested CLI:
  - [ ] 2+ team members successfully created cards via CLI
  - [ ] 2+ team members used bulk create with CSV
  - [ ] Feedback collected (what was hard? what was easy?)
- [ ] Documentation updated:
  - [ ] Based on team feedback
  - [ ] Common gotchas documented
  - [ ] Quick reference card (cheat sheet) created
- [ ] Issues tracked:
  - [ ] Bugs found during testing
  - [ ] Feature requests for Phase 2 (GitHub, Slack, automation)

**Definition of Done:**
- Team can use CLI productively
- Documentation is accurate and complete
- Feedback collected for Phase 2 planning

---

## 📊 SUMMARY

**Total Tasks:** 17 tasks
**Estimated Effort:** 50-75 engineer-hours (10-15 days)
**Team Size:** 1-2 engineers (can be parallelized)

**Critical Path:**
```
SETUP (CLA-FAVRO-001, 002)
  ↓
API CLIENT (CLA-FAVRO-003, 004, 005)
  ↓
COMMANDS (CLA-FAVRO-006-010 in parallel)
  ↓
POLISH (CLA-FAVRO-011, 012, 013)
  ↓
TESTING (CLA-FAVRO-014, 015)
  ↓
DEPLOY (CLA-FAVRO-016, 017)
```

**Next Step:**
1. Architect reviews spec + task breakdown
2. CTO approves and creates Paperclip issues
3. Engineer picks up CLA-FAVRO-001 (Project Setup)

---

**Status:** ✅ Ready for task creation in Paperclip
