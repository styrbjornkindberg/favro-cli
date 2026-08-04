# ADR-0005: One judge of "done", one judge of "blocked", one cosmetic reader

Status: accepted (#98, owner's decision recorded on the ticket 2026-08-04)

## Context

#61 fixed the *edge* half of blocking: seven consumers that read `blockedBy` and asserted
"blocked" from the mere existence of a Favro `isBefore` edge. That part is closed.

What it did not touch is the **keyword** half — a predicate that reads a column name, a tag or a
status string and decides from the words in it whether work is finished or stuck. #98's title
counted eight of those. **The count measured at `8754500` is five**, because three had already
been resolved by other tickets before this one started:

| Predicate | Evidence | State at `8754500` |
|---|---|---|
| `judgeBlockers` (`lib/blocking.ts`) | tracker `done` columnId, then `archived` | live — **the real one** |
| `isBlocked` (`api/standup.ts`) | `BLOCKED_STATUSES` list vs column name | live |
| `isBlocked` (`lib/card-predicates.ts`) | a `blocked` tag **or** a status substring | live — was the `risks.ts` copy |
| `isBlocked` (`commands/batch-smart.ts`) | byte-identical copy of the above | **already gone** — #89 |
| `statusIcon` (`lib/board-renderer.ts`) | `'block'` / `'done'` substrings | live |
| `isCompleted` (`api/standup.ts`) | `COMPLETED_STATUSES` list | live |
| `detectStage` (`lib/workflow-stage.ts`) | a regex over column names | live — the existing home |
| `doneCol` (`api/propose.ts`) | a fourth `/done\|closed\|complete\|finished/i` | **already gone** — #124 deleted the whole module (ADR-0004) |

So the byte-identical `risks` / `batch-smart` pair that #98 asked to resolve **was resolved by
#89**, which moved the surviving copy to `lib/card-predicates.ts` and deleted the duplicate.
Nothing was left to delete there and nothing was invented to look busy.

The done-stage **set** was a separate five, and all five were live: `DONE_STAGES` in `team.ts`,
`stale.ts` and `health.ts`; the identical three strings under the name `COMPLETED_STAGES` in
`my-standup.ts`; and the same three inlined into a longer array in `main-menu.ts`.

`lib/workflow-stage.ts` exists *because* three copies of `detectStage` were consolidated into it
once already (#52). The question this ADR answers is therefore not "where should a new home go"
but "why was that job left half-finished", and the answer is that the *stage* was consolidated
while the *verdict about a stage* was not.

## Decision

**Three readers survive. Each has a different right to be believed, and that is the whole point.**

### 1. `judgeBlockers` (`lib/blocking.ts`) is the sole judge of "blocked"

It is the only predicate that reads evidence rather than words: the tracker board's mapped `done`
columnId, then `archived` off that board, and anything it could not read still blocks. It is
wrong in one direction only — over-blocking. Only `cards list --filter unblocked` pays for it.

### 2. `isDoneStage` (`lib/workflow-stage.ts`) is the sole judge of "done"

The five copies of the stage set and `isCompleted`'s `COMPLETED_STATUSES` list all route here.
`isCompleted` now reads `isDoneStage(detectStage(card.status))`, because `status` *is* the column
name after `hydrateNames`, and "what does this column name mean" is exactly what `detectStage`
answers.

This is a keyword guess and it stays labelled as one. What it is trusted with is unchanged from
#52: an init-time proposal, a display, and *summary* grouping — `standup`, `my-standup`, `team`,
`stale`, `health`. What it is not trusted with is unchanged too: `claim` / `resolve` read the two
stored `columnId`s and never consult it.

### 3. `statusIcon` (`lib/board-renderer.ts`) survives as presentation only

A substring match on `'block'` is fine for choosing a glyph and is not fine for deciding
anything. It is labelled cosmetic in the source, with an explicit instruction not to consolidate
it, because a future reader sweeping for duplicate keyword matches will otherwise find it and
"finish the job" — and a renderer taking a real verdict would have to pay for a per-blocker
sweep on every board draw.

### What is *not* a judge, and stays put

- **`isBlocked` in `api/standup.ts` and `lib/card-predicates.ts` are heuristics, not judges.**
  They answer "does a column name or tag contain the word", which is the only question a snapshot
  can answer without a per-blocker sweep. Both already carry comments pointing at
  `judgeBlockers` as the thing with actual evidence, and both are retained: deleting them would
  remove the `blocked` group from `standup`, `my-standup` and `risks` outright, which is a
  product change #98 did not ask for. They were **not** merged with each other either — they take
  different types (`ContextCard` vs `Card`) and read different fields (column name vs tag *or*
  status), so a merge would be a behaviour change dressed as a cleanup.
- **`api/query.ts`'s `/\b(done|finished|completed|closed)\b/i`** matches a word the *user typed
  in a query string*. It judges no card. Left alone.

## Consequences

`isCompleted` changes behaviour in three measured ways, all of them consequences of having one
judge instead of two:

- **Wider.** `Approved` and `Archived` columns now group as `completed` in `standup`. Before,
  they matched no group and the card was dropped from the standup entirely. Swedish (`Klar`,
  `Färdig`, `Avslutad`) and `Shipped` / `Deployed` / `Live` count now as well.
- **Narrower, in one case.** A column named `Unresolved` used to read as completed, because the
  old list tested `status.includes('resolved')`. `detectStage` gained `(?<!un)resolv` — a
  lookbehind rather than a bare `resolv`, because this branch runs first and returns
  immediately, so a false `done` would become `proposeColumnMapping`'s pick for the board's done
  column and `init` would write that guess into `context.json`.
- **`Ready to Deploy` reads as done**, since `detectStage`'s done regex already contained
  `deploy`. That quirk is inherited, not introduced — it has always driven column-mapping
  proposals — and it is recorded here rather than quietly tuned, because tuning the regex to
  suit one consumer is how a shared judge becomes five again.

The five stage-set copies are gone. `done-judge.test.ts` ratchets the count at one definition in
the tree, the same way `detectStage`'s own ratchet has since #52.

**One of the five copies was never tested, and that was found by mutation rather than review.**
The done half of `main-menu.ts`'s queued filter — the copy inlined into a longer array — had no
arm that discriminated it: every existing case in `tui-blocking-labels.test.ts` feeds cards in
stage `queued`, so no card in a done stage ever reached the filter, and deleting the three
strings from it passed all 3334 tests. The gap predates this ADR; it was closed here because the
sibling-site mutation was run at all five call sites instead of the four that already had
coverage. The other four (`team`, `stale`, `health`, `my-standup`) each killed both an inverting
and a neutering mutation.
