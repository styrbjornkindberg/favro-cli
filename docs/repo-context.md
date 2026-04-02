# Repository Context — `.favro/context.json`

The repo context file gives AI tools (and humans) a local snapshot of your Favro workspace — boards, columns, workflow stages, custom fields, and team members — without hitting the API.

---

## Quick Start

```bash
favro init                           # Interactive — pick a collection
favro init --collection <id>         # Non-interactive
favro init --refresh                 # Re-fetch and overwrite
favro init --json                    # Output context as JSON (no file write)
```

This creates `.favro/context.json` in your project root and adds `.favro/` to `.gitignore`.

---

## File Format

```jsonc
{
  "generated": "2025-01-15T10:30:00Z",
  "collection": {
    "collectionId": "abc123",
    "name": "My Product"
  },
  "boards": [
    {
      "boardId": "board-1",
      "name": "Sprint 42",
      "slug": "sprint-42",
      "columns": [
        { "columnId": "col-1", "name": "To Do" },
        { "columnId": "col-2", "name": "In Progress" },
        { "columnId": "col-3", "name": "Review" },
        { "columnId": "col-4", "name": "Done" }
      ],
      "workflow": {
        "backlog": ["To Do"],
        "active": ["In Progress"],
        "review": ["Review"],
        "done": ["Done"]
      }
    }
  ],
  "customFields": [
    {
      "fieldId": "cf-1",
      "name": "Priority",
      "type": "single_select",
      "options": ["Critical", "High", "Medium", "Low"]
    }
  ],
  "members": [
    {
      "userId": "user-1",
      "name": "Alice",
      "email": "alice@example.com"
    }
  ]
}
```

---

## Workflow Stage Detection

`favro init` maps column names to workflow stages using keyword matching:

| Stage | Column name patterns |
|-------|---------------------|
| `backlog` | backlog, to do, todo, icebox, inbox |
| `active` | in progress, doing, development, working |
| `review` | review, testing, qa, verify, staging |
| `done` | done, complete, closed, shipped, released |

Columns that don't match any pattern are omitted from the workflow map.

---

## Using Context in Commands

Several commands auto-detect `.favro/context.json` from your working directory (walking up to 10 parent directories):

```bash
# These resolve board names/slugs via context.json
favro my-cards --board sprint-42
favro overview --board sprint-42
favro health --board sprint-42
```

The context file enables:
- **Board resolution** by slug or name (no need to remember IDs)
- **Workflow-aware queries** (what stage is a card in?)
- **Offline reference** for column names, fields, and members

---

## Rules for AI/LLM Consumers

If you're building tools that read this file:

1. **Always check `generated` timestamp** — if older than 7 days, suggest `favro init --refresh`
2. **Resolve boards by slug first**, then name, then ID
3. **Use `workflow` map** for stage-aware operations (e.g., "active cards" = cards in `workflow.active` columns)
4. **Never modify `context.json` directly** — always use `favro init --refresh`
5. **Custom field types** determine how to set values:
   - `single_select` / `multiple_select` → use option values
   - `text` / `number` / `date` → use raw values
   - `members` → use userId array

---

## Refreshing

```bash
favro init --refresh                 # Re-fetch everything
```

Re-fetches collection, boards, columns, custom fields, and members from the Favro API and overwrites the existing file.
