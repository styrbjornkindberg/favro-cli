# SPEC-003: Task Breakdown — LLM-Optimized Commands

**Spec:** SPEC-003-llm-optimized-commands.md
**Owner:** Backend
**Effort:** 2-3 weeks (~60-80 hours)
**Dependencies:** SPEC-002 fully complete (custom fields, relationships required)

---

## Task Structure

### Phase 1: Core Infrastructure (1 week)

#### T001: Natural Language Action Parser
- **Description:** Build a parser that converts plain English action descriptions into structured Favro API operations
- **Acceptance Criteria:**
  - Parses move/assign/set/link/create/close action verbs
  - Extracts card identifiers (title, partial match, id)
  - Fuzzy card title matching (handles typos, partial names)
  - Returns ambiguity list (top 3) when match is unclear
  - Unit tests covering 200+ action permutations
  - Handles special characters and long titles
- **Effort:** 3 days
- **Owner:** Backend

#### T002: Board Context Snapshot Command
- **Description:** `favro context <board-name|board-id>` — single JSON with complete board state for AI consumption
- **Acceptance Criteria:**
  - Returns board metadata, columns, custom fields with all values, members
  - Returns full card list with status/owner/priority/effort/due/relationships
  - Includes stats (by_status, by_owner counts)
  - Response time < 1s for boards with up to 500 cards
  - Works with board name (fuzzy match) or exact board ID
  - Output is valid JSON, schema documented
- **Effort:** 2 days
- **Owner:** Backend

#### T003: Propose & Execute Change System
- **Description:** `favro propose` and `favro execute` commands for AI-driven dry-run + confirm workflow
- **Acceptance Criteria:**
  - `favro propose <board> --action "..."` returns dry-run preview with change-id
  - `favro execute <board> --change-id <id>` executes confirmed change
  - Change IDs expire after 10 minutes
  - Preview shows exactly what API calls will be made
  - Validates all fields before generating preview
  - Error messages suggest corrections for invalid actions
- **Effort:** 2 days
- **Owner:** Backend

---

### Phase 2: Query & Workflow Commands (1 week)

#### T004: Semantic Query Command
- **Description:** `favro query <board> "<natural language>"` — returns matching cards with human-readable summary
- **Acceptance Criteria:**
  - Handles status queries ("cards in Review assigned to alice")
  - Handles relationship queries ("what's blocking card-123?")
  - Handles priority queries ("what should alice work on next?")
  - Returns structured JSON + human-readable summary
  - No results: explains why (no cards match, wrong board, etc.)
  - Unit tests covering 50+ query patterns
- **Effort:** 2 days
- **Owner:** Backend

#### T005: Standup & Sprint Commands
- **Description:** `favro standup` and `favro sprint-plan` workflow shortcuts
- **Acceptance Criteria:**
  - `favro standup <board> [--date today|yesterday]`: cards completed, in progress, blocked, due soon
  - `favro sprint-plan <board> --effort-budget <n>`: suggests cards from backlog based on priority + effort
  - sprint-plan respects existing in-progress cards (doesn't over-allocate)
  - standup output grouped by status, sorted by owner
  - Unit and integration tests
- **Effort:** 1.5 days
- **Owner:** Backend

#### T006: Release Check & Risk Dashboard Commands
- **Description:** `favro release-check` and `favro risks` commands
- **Acceptance Criteria:**
  - `favro release-check <board>`: verifies Review/Done cards have required fields, flags blockers
  - `favro risks <board>`: overdue, blocked, stale (>7d no update), unassigned, missing required fields
  - Both return structured JSON + human-readable summary
  - Risk thresholds configurable via --stale-days flag
  - Integration tests with real board
- **Effort:** 1.5 days
- **Owner:** Backend

---

### Phase 3: Batch & Audit (4 days)

#### T007: Batch Smart Update Command
- **Description:** `favro batch-smart <board> --goal "..."` — complex updates from plain English goals
- **Acceptance Criteria:**
  - Parses goal into individual card operations
  - Shows preview before execution (number of cards affected, what changes)
  - `--dry-run` flag for preview only
  - Atomic: all changes succeed or all fail
  - Returns summary: success count, failure count, skipped count
  - Edge cases: no cards match, cards already in target state
- **Effort:** 2 days
- **Owner:** Backend

#### T008: Audit & Change Log Commands
- **Description:** `favro audit` and `favro who-changed` commands
- **Acceptance Criteria:**
  - `favro audit <board> [--since 1h|1d|1w]`: all changes to board/cards/assignments/fields
  - `favro who-changed "<card-title>"`: full edit history for a card
  - Timestamp formatting (relative + absolute)
  - Pagination for large audit logs
  - Unit and integration tests
- **Effort:** 1.5 days
- **Owner:** Backend

---

### Phase 4: Testing & Documentation (3 days)

#### T009: Parser Accuracy Test Suite
- **Description:** Comprehensive unit tests for the natural language parser (T001)
- **Acceptance Criteria:**
  - 500+ action permutations tested
  - Fuzzy matching tested with typos, partial names, special characters
  - Ambiguity resolution tested (multiple matching cards)
  - Edge cases: empty board, single card, very long titles
  - Parser accuracy >= 95% on test suite
- **Effort:** 1.5 days
- **Owner:** Backend

#### T010: SPEC-003 Integration Tests & Documentation
- **Description:** End-to-end tests + user docs for all LLM-optimized commands
- **Acceptance Criteria:**
  - Integration tests for all 8 commands against real Favro board
  - Performance tests: context snapshot < 1s, batch operations < 2s
  - User docs: command reference, AI workflow examples (code review, sprint planning, family tasks)
  - Error message guide for AI consumers
  - CI/CD integration
- **Effort:** 1.5 days
- **Owner:** Backend

---

## Task Dependency Graph

```
T001 (NL Parser)
  ↓           ↓
T002          T003 (Propose/Execute)
(Context)       ↓
  ↓           T004 (Query)
  ↓             ↓
T005, T006 (Standup, Release, Risks)
  ↓
T007, T008 (Batch Smart, Audit)
  ↓
T009, T010 (Tests, Docs)
```

---

## Effort Summary

| Phase | Tasks | Effort |
|-------|-------|--------|
| 1. Core Infrastructure | T001-T003 | 7 days |
| 2. Query & Workflow | T004-T006 | 5 days |
| 3. Batch & Audit | T007-T008 | 3.5 days |
| 4. Testing & Docs | T009-T010 | 3 days |
| **Total** | **10** | **~18-20 days** |

---

## Success Criteria

- [ ] All 10 tasks complete and merged
- [ ] Parser accuracy >= 95% on 500+ permutations
- [ ] Context snapshot < 1s for 500-card boards
- [ ] Batch operations complete or fail atomically
- [ ] User documentation covers all AI use cases
- [ ] No breaking changes to SPEC-001 or SPEC-002 APIs
