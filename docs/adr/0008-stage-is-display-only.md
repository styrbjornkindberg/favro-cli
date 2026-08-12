# ADR-0008: `workflow[].stage` is display-only, and the trust rule names it

Status: accepted

## Context

`.favro/context.json` has **zero code readers**. `favro init` writes it and nothing in the CLI
reads it back — `docs/repo-context.md`'s *Using Context in Commands* section says so, and
`lib/tracker-config.ts:13` records that the file was deliberately rejected as the tracker's
store. The file is written for agents, so
**its documentation is its interface**, and a false sentence in `docs/repo-context.md` is a
defect in the artefact and not a typo about it.

`docs/repo-context.md` carried a false sentence and repeated it. It stated that *"every value in
a `context.json` that exists is a measurement"* with exactly **two** announced exceptions
(`notes.team`, `notes.scope`), and rule 5 repeated the count. Three paragraphs above, the same
file described `favro init` mapping column names to stages by Swedish/English keyword match,
called `detectStage` a *guess*, and recorded that a column matching no keyword — and a column
Favro sends with no name at all — still gets a stage. Rule 3 then told agents to key
stage-aware operations off each board's `workflow` array, i.e. off that guess.

So the file that teaches agents the rules violated ADR-0003 — *never declare a shape, or a rule,
you have not measured* — in its own rule list.

**The write surface was walked rather than grepped**, because a survey that enumerates spellings
of "stage" finds only what it already suspects. Every leaf slot the `RepoContext` literal in
`initHandler` writes, and its interfaces above it, was classified against where its value comes
from. The table below is that classification — no slot count is quoted, because the first draft
of this ADR quoted one and a count is not a finding. Three slots that reach the file are not
reads, and a fourth reaches only the interface:

| Slot | Source | Verdict |
|---|---|---|
| `_description`, `_updated` | `path.basename(process.cwd())`, local clock | local, and evidently so |
| `scope.collectionId` | the `--collection` / scope-lock input, echoed | input, not a read; every other read is scoped by it |
| `scope.collectionName` | `getCollection().name`, else a fallback | measurement, **announced** in `notes.scope` |
| **`boards` key** | `slugify(board.name)` — folded, `[^a-z0-9]+`-collapsed, 30 chars | **derived, and the derivation was lossy — see below** |
| `boards.*.{boardId,name,type}` | wire | measurement |
| `workflow` present/absent | `cols.length > 0` | measurement |
| `workflow[].{columnId,name}` | wire | measurement |
| **`workflow[].stage`** | `detectStage(col.name)` | **derived guess, un-announced** |
| **`workflow[].next`** | `cols[i+1].name ?? null` | **derived, un-announced ambiguity** |
| `customFields.*`, key included | wire | measurement |
| `team.*` | wire ∩ `sharedToUsers` | measurement, **announced** in `notes.team` |
| `notes.cardIds`, `notes.moveCards` | string constants | static advice, not a claim about the workspace |
| `ContextBoard.description`, `ContextCustomField.description` | nothing — declared, never written | dead schema; **deleted**, an interface must not promise a slot the file never has |

`next` is the smallest of the three and is real:
`next: i < cols.length - 1 ? cols[i + 1].name ?? null : null`, so `null` means *"last column"*
and *"the next column has no name"* indistinguishably. The test *"a column with no name keeps
the rest of the board's workflow"* in `src/__tests__/commands/init.test.ts` pins that null. It
is a name pointer in a file whose own rule 5 says to key off ids.

**The `boards` key row above was first classified as benign — "derived, and the schema block
says so" — and that was wrong.** Review re-measured it: `slugify` truncates to 30 characters
and collapses every `[^a-z0-9]+` run, and `boards[slug] = {…}` was a bare assignment, so two
board names that slug alike left only the LATER board in the file. `Sprint 42` and `Sprint: 42`
both key to `sprint-42`; the first board was absent from `context.json` with nothing saying so.
That is the same defect as #154 one level up — the artefact's own contract is that an absent
thing is a finding, not a failed read. Fixed here rather than filed: the first board to claim a
slug keeps the bare key and a later collider takes the next free numeric suffix, so a board
that did not collide is never renumbered. This is the lesson the walk was supposed to teach and
did not quite: **a slot is not a measurement just because its input was one.**

`stage` is the one that changes behaviour. Favro has **no stage field** — `tracker-config.ts:6`
records that *"Favro's UI 'status' IS the column — there is no `state` field"* — so `stage` is
not a value that failed to be read. There is nothing to read. It is a keyword match, and one
whose misfires are documented at length in `workflow-stage.ts` and ADR-0005: `Pending Approval`
read `approved`, `Deliverables` read `done`, `Oklar` read `done`, `Godkänt` fell to `queued`.

## Decision

**`workflow[].stage` is display-only. It is never a trust axis, and `docs/repo-context.md` names
it in the trust rule rather than promising a count of exceptions.**

The `stage` decision itself costs no code. Three doc edits:

1. The *"every value … is a measurement"* sentence is scoped to values that were **read**, and
   `stage` and `next` join the table beneath it as derived.
2. **Rule 3 is rewritten to key off `columnId`**, which is the advice rule 5 already gave one
   field over (*"key off `collectionId`, never the name"*). The open/closed axis is the two
   `columnId`s a human confirmed at `favro tracker init`. Where no confirmed mapping exists,
   `stage` is a proposal to put in front of a human — which is what
   `proposeColumnMapping`'s own docstring already calls it.
3. Rule 5 names `stage` and `next` explicitly and drops "the two exceptions".

The walk that produced those three, however, turned up work that is **not** doc-only, and it is
recorded here because the walk is what found it:

4. The `boards` key collision above is a code fix in `initHandler`, with a test.
5. The *Workflow Stage Detection* keyword table did not match `detectStage`. It listed eight
   stages where the function has nine branches, omitted the wait-word branch that runs FIRST,
   and printed `klar`, `live`, `approv`, `godkän`, `accept` and `sign-off` for patterns ADR-0005
   deliberately narrowed to `(?<!o)klar`, `\blive\b`, `approved`, `godkän[dt]`,
   `accept(?!ance)` and `signed.?off`. A table of keywords cannot express a first-match-wins
   order in which `review` is reachable twice, so the branches are now reproduced **verbatim**
   as code. Approximately right is what produced the defect.
6. The two dead `description?` slots are deleted.

### Why not make `stage` announce itself in `notes`, like `team` and `scope` do

This was the obvious candidate — it looks consistent with the two existing exceptions and keeps
rule 3 as written. It is rejected on what `notes` *is*.

`notes` holds two kinds of key, and only one kind is a marker. `notes.cardIds` and
`notes.moveCards` are string constants written on every run — static usage advice, and they
claim nothing about the workspace. The other two, `notes.scope` and `notes.team`, are added
**conditionally**, and the whole value of those keys is that their **absence** is what makes
the corresponding read a measurement. It is that second, conditional kind `stage` would have to
join, and it cannot: `stage` is derived on every run of every file, so its key would never be
absent and its presence would carry no information. It would be documentation shipped into
every artefact, it would blur the one distinction that makes `notes.team` and `notes.scope`
worth reading, and it would cost a code change to `init.ts` to say something
`docs/repo-context.md` can say once. Rejected: it is more machinery for a weaker signal.

### Why not delete `stage` from `context.json`

It is not noise. `proposeColumnMapping` uses `detectStage` to propose the tracker's two columns
for a human to confirm, and a reader skimming a board's columns is helped by the label. The
defect was never the field; it was a rule list that told agents to act on it.

## Consequences

- **An agent asking "which cards are active" on a board with no confirmed tracker mapping now
  has no measured answer.** That is the honest state and it was already the state — the previous
  rule 3 did not create an axis, it dressed a guess as one. The remedy is `favro tracker init`,
  which is one command and stores ids.
- `docs/repo-context.md` is the only file that carried the claim. `CONTEXT.md:119` states the
  neighbouring rule — *"`notes.team` and `notes.scope` mark the two facets that fall back rather
  than refuse"* — and is left as-is: it is scoped to **fallbacks after a failed read**, which is
  a different set, and `stage` is not a member of it.
- `detectStage`, `proposeColumnMapping` and every consumer of the stage are untouched. On
  `stage` itself this ADR narrows what the documentation *claims*, not what the code does.
- The `boards` key is now unique per run. An existing `context.json` regenerated by
  `favro init --refresh` on a collection with colliding board names gains a key that was not
  there before — the board that used to be missing. Nothing is renamed for a board that did not
  collide, because these keys are an interface agents resolve boards by.
- `src/__tests__/commands/init.test.ts` gains two tests: one holding the trust rule to this ADR
  so the sentence cannot quietly revert, and one that fails on the pre-fix `boards[slug]` write.

## Revisit when

Favro grows a real column-state field, or `context.json` gains its first code reader. Either
makes `stage` something other than a guess and this ADR is the wrong shape for it. What must not
happen in the meantime is a third rule elsewhere in the file quietly keying off `stage` again —
the failure here was not one wrong sentence but a rule list that disagreed with the prose three
sections above it.
