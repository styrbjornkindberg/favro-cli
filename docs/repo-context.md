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
    "sprint-42": {                              // slug of the board name, max 30 chars;
                                                // `-2`, `-3`, … if two names slug alike
      "boardId": "board-1",
      "name": "Sprint 42",
      "type": "backlog",                        // omitted when Favro sends none
      "workflow": [                             // omitted when the board has NO columns
        // `columnId` and `name` are read; `stage` and `next` are DERIVED — see rule 5
        { "columnId": "col-1", "name": "To Do",       "stage": "backlog", "next": "In Progress" },
        { "columnId": "col-2", "name": "In Progress", "stage": "active",  "next": "Done" },
        { "columnId": "col-3", "name": "Done",        "stage": "done",    "next": null }
      ]
    }
  },
  "customFields": {
    "Priority": {                               // keyed by field NAME;
                                                // `-2`, `-3`, … if two boards share a field name
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

So every value in a `context.json` that was **read** is a measurement, and the
two facets that can fall back instead of refusing say so in `notes`.

Two values in the file are not reads at all, and neither announces itself in
`notes`. That is deliberate. The two **conditional** `notes` keys — `team` and
`scope` — are present only on a run where that facet fell back, and their
*absence* is what makes the corresponding read a measurement. (The other two,
`notes.cardIds` and `notes.moveCards`, are always present: they are static usage
advice, not fallback markers, and nothing should be read into them.) `stage` and
`next` are derived on *every* run, so a key that is always there would mark
nothing. They are listed in the table below with the rest, and settled in
`docs/adr/0008-stage-is-display-only.md`.

| You see | It means |
|---------|----------|
| no `workflow` key on a board | `/columns` answered, and that board has none |
| `"customFields": {}` | `/customfields` answered, and no board-local field belongs to these boards |
| `"team": {}` **and no** `notes.team` | the membership filter ran, and matched nobody |
| `"team": {}` **with** `notes.team` | the collection's `sharedToUsers` could not be read, so `team` fails closed to nobody rather than opening to the whole org. It is stated in the file because a privacy filter that cannot run must not be skipped. |
| `scope.collectionName` **and no** `notes.scope` | `GET /collections/:id` answered, and that is the collection's name |
| `scope.collectionName` **with** `notes.scope` | that read failed, so the name is a fallback and NOT a measurement. The note says which of the two: the name in your local `~/.favro/config.json`, which may be stale, or the raw `collectionId` when there is none. Like `team` above, this facet falls back rather than refusing — the name is display text and `collectionId` is always the real one — but the fallback announces itself, so it is never mistaken for a measurement. |
| `workflow[].stage` | **derived, never read.** It is `detectStage`'s keyword guess at what the column's NAME means — see *Workflow Stage Detection*. Favro has no stage field to read, so there is no measurement this could be. Display only: it is not the open/closed axis, and nothing in the CLI consults it. |
| `workflow[].next` | **derived, never read.** The next column's `name` in board order. `null` means either "this is the last column" or "the next column has no name" — the two are not distinguishable, so walk `workflow` by position and key off `columnId`, not off `next`. |
| a `boards` key ending `-2`, `-3`, … | **the key is derived too** — `slugify` folds the board's name, collapses every non-`[a-z0-9]` run and truncates to 30 chars, so two different board names can produce one key. The first board to claim a slug keeps the bare one; a later collider takes the next free numeric suffix. Every board is still present, and `boardId` inside the entry is always the real one. |
| a `customFields` key ending `-2`, `-3`, … | **the same collision, one map over.** A field's key is its name verbatim, and a name is unique to a BOARD, not to the collection — two of your boards can each own a `Priority`. Same rule: the first keeps the bare key, a later collider takes the next free suffix, both entries are present, and `fieldId` inside the entry is always the real one. The suffix does NOT mean the two fields are related — they are two independent fields that happen to share a name, and they may differ in `type` and `options`. |

The one thing this costs: a partially-readable workspace produces no file until
the key can read every facet. `favro init --refresh` is the retry.

---

## Workflow Stage Detection

`favro init` maps column names to workflow stages using keyword matching, in
Swedish and English. `detectStage` in `src/lib/workflow-stage.ts` is the one
implementation. Its branches are reproduced **verbatim** below, in the order it
tests them — first match wins and returns immediately, so the order is
load-bearing and a paraphrase of these patterns is not the rule:

```js
const n = foldName(name);   // NFC-folds and lowercases; tolerates a null name
if (/pending|awaiting|await|waiting|vänta/i.test(n)) return 'review';
if (/done|(?<!o)klar|färdig|complete|closed|released|shipped|deploy|\blive\b|delivered|finished|avslut|(?<!un)resolv/i.test(n)) return 'done';
if (/archived?|arkiver/i.test(n)) return 'archived';
if (/approved|godkän[dt]|accept(?!ance)|verified|signed.?off/i.test(n)) return 'approved';
if (/progress|develop|pågå|aktiv|doing|working|implement|bygg|coding|current/i.test(n)) return 'active';
if (/test|qa|kvalit|verif/i.test(n)) return 'testing';
if (/review|gransk|feedback|pending|approval|godkännande|sign.?off/i.test(n)) return 'review';
if (/select|vald|ready|next|sprint|priorit|planned|schedul|redo/i.test(n)) return 'queued';
if (/backlog|inbox|new|ny|todo|to.do|icke|idea|wish|önskelista|triage|incoming/i.test(n)) return 'backlog';
return 'queued';
```

Three things in there are decisions rather than accidents, and ADR-0005 plus the
comments in `workflow-stage.ts` carry the reasoning:

- **The wait-word branch runs FIRST**, ahead of `done` and `approved`. The names
  it exists for pair a wait word with a finished word: `Pending Approval` read
  `approved` and `Awaiting Deploy` read `done`, and both are work parked until a
  human acts.
- **`review` is reachable at two separate branches** — the wait words above, and
  the gate NAMES (`approval`, `godkännande`, `sign.?off`) that the `approved`
  branch deliberately does not claim. A column named for the gate holds work
  waiting for a decision, not work that got one.
- **Four patterns are narrowed, and the narrowing is the point:** `(?<!o)klar`
  (Swedish `Oklar` is *unclear*), `(?<!un)resolv` (`Unresolved`), `\blive\b`
  (`Deliverables` contains `live`), and `accept(?!ance)` (`Acceptance Testing` is
  a testing column). `godkän[dt]` matches both Swedish participle genders,
  `Godkänd` and `Godkänt`.

**Every column gets a stage.** A name matching nothing — and a column Favro sends
with no name at all — falls through to `queued`; no column is ever dropped from
`workflow`. The stage is a keyword *guess*, so treat it as a display hint, never
as the open/closed axis: `favro tracker init` stores two `columnId`s for that.
`stage` is one of the two values in the file that are neither a measurement nor
an announced fallback — `workflow[].next` is the other — which is why rule 5
names them instead of promising there are only two exceptions.
`docs/adr/0008-stage-is-display-only.md` settles how far `stage` may be trusted.

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
2. **Resolve boards by the slug key first**, then `name`, then `boardId` — but the slug is DERIVED from the name and a collision suffixes it (see the table), so `boardId` is the stable identifier and the one to store
3. **Key column operations off `columnId`**, never off `name` and never off `stage`. Each board's `workflow` array gives you the columns and their order; `stage` on each entry is a guess at the column's name, not a reading of it (rule 5). For the open/closed axis — "active cards", "done cards" — use the two `columnId`s a human confirmed at `favro tracker init`, stored in `docs/agents/issue-tracker.md`. Where no confirmed mapping exists, `stage` is a proposal to put in front of a human, not a verdict to act on
4. **Never modify `context.json` directly** — always use `favro init --refresh`
5. **Trust every value that was READ as a measurement** — see *What the File Says About a Facet It Could Not Read*. A missing or empty facet is a finding, not a failed read; the two facets that can fall back announce themselves in `notes.team` and `notes.scope`, so read `notes` before trusting `team` or `scope.collectionName`, and key off `collectionId`, never the name. **`workflow[].stage` and `workflow[].next` are derived, not read, and they do NOT announce themselves in `notes`** — they are derived on every run, so there is no per-run marker to look for. `stage` in particular is a keyword guess; treat it as display (rule 3)
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
