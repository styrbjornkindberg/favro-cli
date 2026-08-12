# Repository Context — `.favro/context.json`

The repo context file gives AI tools (and humans) a local snapshot of your Favro workspace — boards, columns, workflow stages, custom fields, and team members — without hitting the API.

---

## Quick Start

```bash
favro init                           # Uses the locked scope collection
favro init --collection <id>         # Overrides the lock
favro init --refresh                 # Re-fetch and overwrite
favro init --json                    # Print the context to stdout, write nothing
```

There is no interactive picker: with no `--collection` and no scope locked,
`favro init` refuses and points at `favro scope set`. Without `--refresh` it also
refuses to overwrite an existing `context.json`.

This creates `.favro/context.json` in your project root and adds `.favro/` to `.gitignore`.

---

## File Format

`boards`, `customFields` and `team` are **maps, not arrays** — keyed by board
slug, custom-field name and userId respectively.

```jsonc
{
  "_description": "Favro context for <repo> repo. …",
  "_updated": "2025-01-15",                     // date only, not a timestamp
  "scope": {
    "collectionId": "abc123",
    "collectionName": "My Product"
  },
  "boards": {
    "sprint-42": {                              // slug of the board name, max 30 chars
      "boardId": "board-1",
      "name": "Sprint 42",
      "type": "backlog",                        // omitted when Favro sends none
      "workflow": [                             // omitted when the board has NO columns
        { "columnId": "col-1", "name": "To Do",       "stage": "backlog", "next": "In Progress" },
        { "columnId": "col-2", "name": "In Progress", "stage": "active",  "next": "Done" },
        { "columnId": "col-3", "name": "Done",        "stage": "done",    "next": null }
      ]
    }
  },
  "customFields": {
    "Priority": {                               // keyed by field NAME
      "fieldId": "cf-1",
      "type": "<Favro's own type string, passed through verbatim>",
      "options": { "Critical": "opt-1", "High": "opt-2" }   // name → optionId
    }
  },
  "team": {
    "user-1": { "name": "Alice", "email": "alice@example.com", "role": "member" }
  },
  "notes": {
    "cardIds": "…",
    "moveCards": "…",
    "scope": "…",                               // present ONLY when the collection's name could not be read
    "team": "…"                                 // present ONLY when the membership filter could not run
  }
}
```

Only board-local custom fields belonging to a board in `boards` are kept;
org-wide shared fields are dropped as noise.

---

## What the File Says About a Facet It Could Not Read

**Nothing — the file is not written.** The maps have no "unread" state in the
schema, and `favro init` does not invent one (#154). The two facets that DO fall
back carry the reason in `notes`, which is prose and needs no new schema.

If `/columns`, `/customfields` or `/users` fails, the command reports the error,
exits non-zero, and writes no `context.json` at all. An earlier version turned
each of those failures into an empty value, which is indistinguishable from the
real finding — a failed `/users` read produced `"team": {}`, and every agent
reading the file afterwards concluded the collection had no members.

So every value in a `context.json` that exists is a measurement, and the two
facets that can hold a fallback instead say so in `notes`:

| You see | It means |
|---------|----------|
| no `workflow` key on a board | `/columns` answered, and that board has none |
| `"customFields": {}` | `/customfields` answered, and no board-local field belongs to these boards |
| `"team": {}` **and no** `notes.team` | the membership filter ran, and matched nobody |
| `"team": {}` **with** `notes.team` | the collection's `sharedToUsers` could not be read, so `team` fails closed to nobody rather than opening to the whole org. It is stated in the file because a privacy filter that cannot run must not be skipped. |
| `scope.collectionName` **and no** `notes.scope` | `GET /collections/:id` answered, and that is the collection's name |
| `scope.collectionName` **with** `notes.scope` | that read failed, so the name is a fallback and NOT a measurement. The note says which of the two: the name in your local `~/.favro/config.json`, which may be stale, or the raw `collectionId` when there is none. This one facet falls back rather than refusing, because the name is display text and `collectionId` is always the real one — but the fallback announces itself, so it is never mistaken for the name. |

The one thing this costs: a partially-readable workspace produces no file until
the key can read every facet. `favro init --refresh` is the retry.

---

## Workflow Stage Detection

`favro init` maps column names to workflow stages using keyword matching, in
Swedish and English (`detectStage` in `src/lib/workflow-stage.ts` is the one
implementation — these are its branches, in the order it tests them):

| Stage | Column name patterns |
|-------|---------------------|
| `done` | done, klar, färdig, complete, closed, released, shipped, deploy, live, finished, avslut |
| `archived` | archive, archived, arkiver |
| `approved` | approv, godkän, accept, verified, sign-off |
| `active` | progress, develop, pågå, aktiv, doing, working, implement, bygg, coding, current |
| `testing` | test, qa, kvalit, verif |
| `review` | review, gransk, feedback, pending |
| `queued` | select, vald, ready, next, sprint, priorit, planned, schedul, redo |
| `backlog` | backlog, inbox, new, ny, todo, to do, icke, idea, wish, önskelista, triage, incoming |

**Every column gets a stage.** A name matching nothing — and a column Favro sends
with no name at all — falls through to `queued`; no column is ever dropped from
`workflow`. The stage is a keyword *guess*, so treat it as a display hint, never
as the open/closed axis: `favro tracker init` stores two `columnId`s for that.

---

## Using Context in Commands

Nothing in the CLI reads `.favro/context.json`. It is written for **agents and
humans** to read directly; there is no auto-detection and no walk-up of parent
directories. Commands that need a collection take `--collection` or use the
scope lock (`favro scope set`), and the tracker mapping lives in
`docs/agents/issue-tracker.md` with `~/.favro/config.json` as the fallback —
`context.json` was deliberately rejected for that, because a cwd walk-up answers
by whatever directory the process happens to sit in.

The file enables, for whoever is reading it:
- **Board resolution** by slug or name (no need to remember IDs)
- **Column and stage reference** without a `/columns` call
- **Offline reference** for custom fields, their option ids, and members

---

## Rules for AI/LLM Consumers

If you're building tools that read this file:

1. **Check `_updated`** — a date, not a timestamp. Older than 7 days, suggest `favro init --refresh`
2. **Resolve boards by the slug key first**, then `name`, then `boardId`
3. **Use each board's `workflow` array** for stage-aware operations (e.g. "active cards" = cards in the columns whose `stage` is `active`)
4. **Never modify `context.json` directly** — always use `favro init --refresh`
5. **Trust every value as a measurement** — see *What the File Says About a Facet It Could Not Read*. A missing or empty facet is a finding, not a failed read; the two exceptions announce themselves in `notes.team` and `notes.scope`. Read `notes` before trusting `team` or `scope.collectionName`, and key off `collectionId`, never the name
6. **Custom field types** determine how to set values:
   - `single_select` / `multiple_select` → use option values
   - `text` / `number` / `date` → use raw values
   - `members` → use userId array

---

## Refreshing

```bash
favro init --refresh                 # Re-fetch everything
```

Re-fetches collection, boards, columns, custom fields, and members from the Favro API and overwrites the existing file.
