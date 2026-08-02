# CONTEXT — the domain glossary

The nouns this codebase turns on, in Favro's vocabulary. One or two sentences each,
so code, tickets and ADRs can use the same word for the same thing.

**This is not the contract.** `favro help issue-tracker`
(`src/commands/issue-tracker-help.ts`) is the runtime model and remains the single
source of truth for what a write does, what it guarantees and what it leaves behind.
This file names the things; that topic states the rules. Decisions that shaped either
live in [`docs/adr/`](docs/adr/) — [ADR-0001](docs/adr/0001-no-transitive-cycle-detection.md)
(blocking edges are checked per pair) and
[ADR-0002](docs/adr/0002-one-command-runner.md) (one command runner owns the preamble,
output and exit code).

Every entry below names the module that owns the term.

---

## The entities

**card** — one work item. A card exists once per board it sits on, so "the card" and
"this instance of the card" are different things: `delete` removes one board instance
and the others survive. `src/lib/cards-api.ts`.

**card identifiers** — three, all accepted wherever an argument is card-shaped, and
translated to whichever one the endpoint consumes (`src/lib/card-reference.ts`):

- `sequentialId` — the human label, `CLA-1804`. The prefix is derived by Favro from
  the collection name and is not an API field; a bare `8850` is accepted as the same
  thing.
- `cardId` — one board instance. Path segments take this one.
- `cardCommonId` — the card across all its instances. Comments, tasks and tasklists
  take this one, in a query or body, never as a path segment.

`cardId` and `cardCommonId` share one syntax (24-char hex), so detection is
shape-first and escalates only on a classified not-found.

**board** — where cards live and the unit the scope lock checks. Favro's wire calls it
a **widget**: the id is `widgetCommonId`, the endpoint is `/widgets/`, and
`normalizeWidget` renames it to `boardId` for everything above the API layer
(`src/lib/boards-api.ts`). A card with no `widgetCommonId` is a **fork** — the
boardless, columnless entity Favro creates on assignment — and is unactionable by
construction.

Every board-shaped argument accepts a **name or an id**, settled by `resolveBoardId`
before the value reaches the wire. That is not convenience: Favro answers **200 with
an empty page** for a `widgetCommonId` nobody has, and a write to one lands nowhere —
so an unsettled name is zero rows rather than an error, and there is no classified
not-found to escalate on (#82). A one-word board name is id-shaped, so shape never
decides which of the two it is (`ID_SHAPES.boardId` declares no shape at all).

**column-as-status** — a card's status *is* its column. There is no `state` field on
the wire, so the open/closed axis is two `columnId`s and nothing else
(`src/lib/tracker-config.ts`). Columns are resolved by id or by name through
`ColumnDirectory` (`src/lib/column-directory.ts`); a name requires a board, because a
column name is only unique within one.

**collection** — the container boards belong to (`collectionIds` on a board). It is
what the scope lock locks. `src/lib/collections-api.ts`.

**tag** — an org-wide label, written **by name**. Names are the vocabulary: an unknown
name is refused client-side, because on a tag write Favro reads an unknown name as a
tag *creation*. `retag` allows exactly one category role (`bug`, `enhancement`) and
one state role (`needs-triage`, `needs-info`, …) — the triage vocabulary rides tags
because the column already carries open/closed and cannot carry both.
`src/lib/tags-api.ts`, `src/lib/tracker-config.ts`.

**tracker** — the mapping that says which board is the issue tracker: a
`collectionId`, a `boardId`, and the two `columnId`s for the active/done axis. Stored
in `docs/agents/issue-tracker.md` (authoritative) with `~/.favro/config.json` as the
repo-less fallback, and verified against the live board before anything is written
against it. `src/lib/tracker-config.ts`.

**blocking edge** — the only ordering relationship Favro can store. One edge per card
pair, carrying a single flag `isBefore` that describes the linked card relative to the
card you queried; reading from the far end returns the same edge with `isBefore`
inverted. Undirected identity, directed semantics — so a pair holding the reverse edge
can never take the forward one, and reversing is delete-then-add.
`src/lib/dependency-direction.ts`, `src/lib/tx-cards.ts`.

**edge direction** — Favro says before/after; this CLI says blocks/blocked-by. One
edge, two vocabularies. `depends-on` / `blocked-by` map to `isBefore: true`; `blocks`
maps to `isBefore: false`. There is no unordered "related to" — Favro cannot store one,
so it is not modelled with an edge or a parent.

## The mechanics

**intent** — one named tracker operation, registered once against the shared dispatch
table so the CLI, `skill run` and MCP all get the same guardrails. Nine exist:
`create`, `read`, `delete`, `archive`, `claim`, `resolve`, `retag`,
`add-blocking-edge`, `remove-blocking-edge`. An intent's `run` receives only `TxCards`
— no client, no `CardsAPI` — so an uninstrumented write is unconstructible.
`src/lib/dispatch.ts`.

**envelope** — the shape every list read returns: `{ rows, truncated?, unreachable? }`.
Always an envelope, never "an array unless something went wrong". A single read stays
bare. `truncated` means `--limit` cut a complete fetch; `unreachable` means a composite
read could not reach part of its input, so an empty `rows` with no `unreachable`
unambiguously means true-empty. `src/lib/read-shape.ts`.

**refusal** — a deterministic decline: nothing was written, and the same call declines
again for the same reason. That is the whole distinction the dispatch table needs, and
it is why a refusal is never reported as retryable. `RefusalError`
(`src/lib/refusal.ts`) is a leaf class every refusal extends; anything raising a bare
`Error` is treated as a failure and unwinds, which is the safe default.

**scope lock** — the mandatory guardrail on every write that *lands on a board*. Such a
write resolves its board and checks it against the locked collection before anything
happens; a batch that straddles the lock refuses as a whole, and a write that names a
board it cannot resolve is *uncheckable*, not exempt. `--force` is the only escape
hatch, and it does not rescue the no-board case. `--dry-run` is a preview, never a
safety wall — and the lock runs *before* the preview, so a preview is not a way around
it. `assertScope` in `src/lib/safety.ts`.

Its remit has an edge, decided rather than implied (#104): a write to an **org-scoped**
entity — a tag, a group, a webhook, a collection being created — lands on no board at
all, so there is nothing for a collection lock to resolve and it is *out of remit*, not
unguarded-by-oversight. Guarding those would need an org-level lock, which does not
exist. `src/__tests__/scope-lock-coverage.test.ts` holds both lists — debt and
decision — and fails on a stale entry in either.

**compensation log** — the ordered record of reversible writes a transaction has made,
which the dispatch table unwinds LIFO on failure. Each entry carries what the write did
in the shape it did it (`scalar`, `delta`, `edge`, `exempt`), because that shape is the
only thing that decides how it compares. The transaction boundary is one dispatch
invocation, or one whole skill run when the caller threads its own log through.
`src/lib/tx-cards.ts`.

**compare-before-restore** — always on, no opt-out. There is no version carrier on this
wire (no `updatedAt`, no `ETag`), so a compensating write is *skipped* when the field
changed underneath us. Concurrent edits are detected, never prevented.
`compareBeforeRestore` in `src/lib/tx-cards.ts`.

**orphan** — what an unwind left behind, with its cause: `compensation-failed` (the
compensating write itself failed) or `compensation-skipped` (a concurrent editor now
owns that field). The two stay distinct because they are different problems.

**transaction outcomes** — three, no fourth (`TxOutcome`, `src/lib/tx-cards.ts`):

- `ok` — the write applied.
- `rolled-back` — it failed and every compensating write landed.
- `rollback-incomplete` — the unwind left orphans behind. Never retryable.

A pre-write refusal is deliberately *not* an outcome: it throws, so there is nothing to
roll back. And the outcome does not settle retry — `DispatchResult.retryable` is the one
derivation, and a clean `rolled-back` is still not retryable when the wire named the
failure.

---

## Known mismatches

Places where the code does not yet speak the glossary. Recorded, not fixed — file as
follow-ups.

1. **Two `Collection` interfaces.** `src/lib/collections-api.ts:12` (with `boardCount`,
   `memberCount`) and `src/lib/boards-api.ts:91` (without). Same name, different shape.

2. **`ScopeError` is not a `RefusalError`.** Every identifier resolver now raises one
   (see #81), but `ScopeError` (`src/lib/safety.ts:46`) still extends bare `Error`.
   A scope refusal is a deterministic decline by the definition above — retrying it
   cannot change the answer — so the concept and the class still cover different sets
   at this one site.

3. **`blocked-by` is accepted but not declared.** `LINK_TYPES` lists two labels
   (`depends-on`, `blocks`) while `linkTypeToIsBefore` accepts three — `blocked-by`
   maps to `isBefore: true` but never appears in the exported vocabulary
   (`src/lib/dependency-direction.ts:14` vs `:22`).

4. **`boardId` vs `widgetCommonId`.** The board id is renamed at the API layer but the
   wire name resurfaces above it — `assertScope` GETs `/widgets/${boardId}`, and
   `Intent.board` documents `widgetCommonId` semantics under the name `boardId`. An
   alias, not a bug, but two names for one keyspace.

5. **`tagId` is not one keyspace.** Two measured shapes inside one organization —
   hex-24 and base62-17 (`src/lib/tags-api.ts:20`). Any classifier that assumes one
   misses ~11% of tags.
