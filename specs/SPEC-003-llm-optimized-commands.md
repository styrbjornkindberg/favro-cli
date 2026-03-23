# SPEC-003: Favro CLI — LLM-Optimized Commands

**Status:** In Design (Start After SPEC-002)
**Priority:** High
**Effort:** 2-3 weeks
**Owner:** CTO / Architect

---

## Overview

Design and implement CLI shortcuts and commands optimized for LLM/AI workflows. These commands allow AI assistants and agents to efficiently manage Favro boards without navigating full query syntax or multi-step workflows.

**Goal:** Enable AI to understand board state, propose changes, and execute updates with minimal ambiguity.

---

## The Problem

Standard Favro CLI requires:
1. **Multiple commands** — List boards, get board config, query cards, etc.
2. **Complex queries** — AI must parse custom syntax, handle edge cases
3. **Manual context building** — AI gathers info in separate calls
4. **Uncertain semantics** — "Update priority" without context risks wrong card

**Solution:** High-level commands that bundle common AI workflows into single, unambiguous operations.

---

## LLM-Optimized Commands

### 1. Board Context Snapshot

```bash
favro context <board-name|board-id>
```

**Output:** Single JSON with everything AI needs to understand board state:
```json
{
  "board": {
    "id": "board-123",
    "name": "Sprint 42",
    "collection": "Development",
    "members": ["alice@ex.com", "bob@ex.com"]
  },
  "columns": ["Backlog", "In Progress", "Review", "Done"],
  "customFields": [
    { "id": "cf-1", "name": "Priority", "type": "select", "values": ["High", "Medium", "Low"] },
    { "id": "cf-2", "name": "Effort", "type": "select", "values": ["1", "2", "3", "5", "8"] }
  ],
  "cards": [
    {
      "id": "card-1",
      "title": "Fix login bug",
      "status": "In Progress",
      "owner": "alice@ex.com",
      "priority": "High",
      "effort": "3",
      "due": "2026-03-25",
      "blockedBy": ["card-2"],
      "blocking": []
    },
    ...
  ],
  "stats": {
    "total": 24,
    "by_status": {"Backlog": 8, "In Progress": 6, "Review": 4, "Done": 6},
    "by_owner": {"alice@ex.com": 10, "bob@ex.com": 14}
  }
}
```

**Why:** AI gets complete context in one call. No guessing about field types, missing cards, or workflow steps.

---

### 2. Propose & Execute Changes

```bash
favro propose <board-name> --action "move card 'Fix login' from In Progress to Review"
# Returns: dry-run preview + confirmation

favro execute <board-name> --change-id <id>
# Executes confirmed change
```

**Parsed Actions:**
```
move card "<title>" from <status> to <status>
assign "<title>" to <owner>
set priority of "<title>" to <priority>
add "<title>" to <date>
link "<title>" blocks "<other-title>"
create card "<title>" in <status> [with priority <p>, owner <o>, effort <e>]
close "<title>"
```

**Why:** AI describes intent in natural language. CLI parses, validates, shows preview. AI confirms or adjusts.

---

### 3. Query with Explanation

```bash
favro query <board-name> "cards in Review assigned to alice"
# Returns: matching cards + human-readable summary
# Output: "[4 cards in Review assigned to alice] Card-123, Card-456, ..."

favro query <board-name> "what's blocking card-123?"
# Returns: dependencies + blocking relationships with context

favro query <board-name> "what should alice work on next?"
# Returns: prioritized backlog for alice based on board rules
```

**Why:** AI gets semantic answers, not raw data. Reduces parsing errors.

---

### 4. Batch Smart Update

```bash
favro batch-smart <board-name> --goal "move all overdue cards to Review"
# Shows preview of changes, AI confirms

favro batch-smart <board-name> --goal "assign all Backlog cards with no owner to alice"
# Validates rules before execution
```

**Why:** Complex updates described in plain English. CLI handles edge cases (no cards match, already in status, etc.).

---

### 5. Workflow Shortcuts

Pre-built workflows for common AI tasks:

```bash
# Daily standup data
favro standup <board-name> [--date today|yesterday]
# Output: cards completed, in progress, blocked, due soon

# Sprint planning
favro sprint-plan <board-name> --effort-budget 40 [--from backlog]
# Suggests cards to pull into sprint based on priority + effort

# Release checklist
favro release-check <board-name>
# Verifies all cards in Review/Done have required fields, no blockers

# Risk dashboard
favro risks <board-name>
# Cards overdue, blocked, stale, unassigned, missing custom fields
```

**Why:** AI doesn't need to manually construct these queries. Predefined, tested, reliable.

---

### 6. Change Log & Audit

```bash
favro audit <board-name> [--since 1h|1d|1w]
# All changes to board, cards, assignments, custom fields

favro who-changed "<card-title>"
# History of edits to specific card
```

**Why:** AI can understand what changed, who changed it, when. Useful for reconciliation, debugging.

---

## Implementation Details

### Parser Strategy
```
Input: "move card 'Fix login' from In Progress to Review"

1. Extract action verb: move
2. Extract subject: card 'Fix login' → find card-id via fuzzy match
3. Extract parameters: from=In Progress, to=Review
4. Validate: card exists, is in In Progress, Review is valid status
5. Generate API call: PATCH /api/cards/card-123 {status: "Review"}
6. Show preview: "Will move [card-123] Fix login from In Progress to Review"
7. Execute on confirmation
```

### Error Handling
- **Ambiguous card name?** Return top 3 matches, ask AI to clarify
- **Invalid status?** Show valid statuses, suggest closest match
- **Missing field?** Show what's required, ask AI to provide
- **No matching cards?** Explain why (no cards in that status, wrong board, etc.)

### Rate Limiting
- Batch operations automatically chunk requests
- Show progress for multi-step updates
- Implement exponential backoff for Favro API

---

## Commands for Different AI Use Cases

### For Code Review Agents
```bash
favro context board:code-review  # Get PR cards, reviewers, status
favro propose board:code-review --action "assign <pr> to alice"
favro query board:code-review "which PRs need review?"
```

### For Sprint Planning Agents
```bash
favro sprint-plan board:dev --effort-budget 40
favro propose board:dev --action "move top 5 backlog cards to Sprint"
favro standup board:dev --date today
```

### For Release Automation
```bash
favro release-check board:main
favro query board:main "all cards in Done with no blockers?"
favro batch-smart board:main --goal "mark release-ready cards"
```

### For Family Task Management (Like Styrbjörn's use case)
```bash
favro context board:family-projects
favro query board:family-projects "tasks for otto's science experiments"
favro propose board:family-projects --action "create card 'Volcano experiment' with owner:styrbjorn due:saturday"
```

---

## Success Criteria

- [ ] All proposed actions result in correct Favro API calls
- [ ] Error messages guide AI toward valid actions
- [ ] Dry-run mode 100% accurate
- [ ] Batch operations complete fully or fail atomically
- [ ] Context snapshot includes everything AI needs (no follow-up queries)
- [ ] LLM can parse 95%+ of plain English action descriptions
- [ ] Response time < 1s for context queries, < 2s for batch operations

---

## Testing

- Unit tests for parser (500+ action permutations)
- Integration tests with real Favro board
- Fuzzy matching accuracy (test with typos, partial names)
- Edge cases: duplicate card names, special characters, very long titles
- Performance: 1000+ cards on board, still < 2s response

---

## Dependencies

- SPEC-002: Enhanced API endpoints (custom fields, relationships)
- Natural language parser library (or custom NLP)
- Favro API documentation

---

## Questions for Research

1. **What are the most common AI workflows in Favro?**
   - Backlog grooming?
   - Sprint planning?
   - Risk tracking?
   - Status automation?

2. **What edge cases break current AI integrations?**
   - Duplicate card titles?
   - Complex relationships?
   - Custom field constraints?

3. **What custom field types does Favro support?**
   - Text, Select, Date, User, Link, Checkbox?
   - Custom validation rules?

---

## Future Enhancements

1. **Learning:** AI agent learns which workflows are most effective, recommends them
2. **Undo:** Automatic undo stack for proposed changes
3. **Templates:** Save common workflows as reusable templates
4. **Webhooks:** Real-time notifications when board changes
5. **Multi-board:** Commands that work across multiple boards/collections
