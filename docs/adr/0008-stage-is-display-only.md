# ADR-0008: `workflow[].stage` is display-only, and the trust rule names it

Status: accepted

## Context

`.favro/context.json` has **zero code readers**. `favro init` writes it and nothing in the CLI
reads it back — `docs/repo-context.md:128` says so, and `lib/tracker-config.ts:13` records that
the file was deliberately rejected as the tracker's store. The file is written for agents, so
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
of "stage" finds only what it already suspects. Every leaf slot in the `RepoContext` literal
(`src/commands/init.ts:353-381`) and its interfaces (`:65-104`) was classified against where its
value comes from. Eighteen slots; two are not reads:

| Slot | Source | Verdict |
|---|---|---|
| `_description`, `_updated` | `path.basename(process.cwd())`, local clock | local, and evidently so |
| `scope.collectionId` | the `--collection` / scope-lock input, echoed | input, not a read; every other read is scoped by it |
| `scope.collectionName` | `getCollection().name`, else a fallback | measurement, **announced** in `notes.scope` |
| `boards` key | `slugify(board.name)` — folded, `[^a-z0-9]+`-collapsed, 30 chars | derived, and the schema block says so |
| `boards.*.{boardId,name,type}` | wire | measurement |
| `workflow` present/absent | `cols.length > 0` | measurement |
| `workflow[].{columnId,name}` | wire | measurement |
| **`workflow[].stage`** | `detectStage(col.name)` | **derived guess, un-announced** |
| **`workflow[].next`** | `cols[i+1].name ?? null` | **derived, un-announced ambiguity** |
| `customFields.*`, key included | wire | measurement |
| `team.*` | wire ∩ `sharedToUsers` | measurement, **announced** in `notes.team` |
| `notes.cardIds`, `notes.moveCards` | string constants | static advice, not a claim about the workspace |

`next` is the smaller of the two and is real: `init.ts:250` is
`next: i < cols.length - 1 ? cols[i + 1].name ?? null : null`, so `null` means *"last column"*
and *"the next column has no name"* indistinguishably. `src/__tests__/commands/init.test.ts:327`
pins that null. It is a name pointer in a file whose own rule 5 says to key off ids.

`stage` is the one that changes behaviour. Favro has **no stage field** — `tracker-config.ts:6`
records that *"Favro's UI 'status' IS the column — there is no `state` field"* — so `stage` is
not a value that failed to be read. There is nothing to read. It is a keyword match, and one
whose misfires are documented at length in `workflow-stage.ts` and ADR-0005: `Pending Approval`
read `approved`, `Deliverables` read `done`, `Oklar` read `done`, `Godkänt` fell to `queued`.

## Decision

**`workflow[].stage` is display-only. It is never a trust axis, and `docs/repo-context.md` names
it in the trust rule rather than promising a count of exceptions.**

Three edits, no code and no schema change:

1. The *"every value … is a measurement"* sentence is scoped to values that were **read**, and
   `stage` and `next` join the table beneath it as derived.
2. **Rule 3 is rewritten to key off `columnId`**, which is the advice rule 5 already gave one
   field over (*"key off `collectionId`, never the name"*). The open/closed axis is the two
   `columnId`s a human confirmed at `favro tracker init`. Where no confirmed mapping exists,
   `stage` is a proposal to put in front of a human — which is what
   `proposeColumnMapping`'s own docstring already calls it.
3. Rule 5 names `stage` and `next` explicitly and drops "the two exceptions".

### Why not make `stage` announce itself in `notes`, like `team` and `scope` do

This was the obvious candidate — it looks consistent with the two existing exceptions and keeps
rule 3 as written. It is rejected on what `notes` *is*.

`notes` is the per-run record of a facet that **fell back on this run**: `init.ts:368` and
`:371` add `notes.scope` and `notes.team` conditionally, and the whole value of those keys is
that their **absence** is what makes the corresponding read a measurement. `stage` is derived on
every run of every file. A key that is always present carries no information; it would be
documentation shipped into every artefact, it would train readers that a `notes` key means
nothing in particular, and it would cost a code change to `init.ts` to say something
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
- `detectStage`, `proposeColumnMapping` and every consumer are untouched. This ADR narrows what
  the artefact's documentation *claims*, not what the code does.
- `src/__tests__/commands/init.test.ts` gains one assertion holding the doc to it, so the
  sentence cannot quietly revert.

## Revisit when

Favro grows a real column-state field, or `context.json` gains its first code reader. Either
makes `stage` something other than a guess and this ADR is the wrong shape for it. What must not
happen in the meantime is a third rule elsewhere in the file quietly keying off `stage` again —
the failure here was not one wrong sentence but a rule list that disagreed with the prose three
sections above it.
