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

**The accepted cost of that:** resolution matches against `GET /widgets`, so a board
id that listing does not return now **refuses instead of reading**. Before #82 the id
went straight to the wire and worked. Most of the surface is safe — `listBoards(100)`
paginates to completion through `getAllPages`, and the pasted-URL path never passes a
URL-derived `widgetCommonId` (`findCardByUrl`, `src/lib/cards-api.ts`). The live
exposure is a board the key can read a card on but cannot list, and archived boards:
`boards-api.ts` passes no `archived` param, and whether `/widgets` includes archived
boards is **unmeasured** — per ADR-0003 this records the open edge rather than
asserting either answer. If it bites, the fix is a classified-not-found escalation on
the id, the same shape `getBoard` already uses.

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
edge, two vocabularies. `depends-on` maps to `isBefore: true`; `blocks` maps to
`isBefore: false`. Those two are the whole of `LINK_TYPES`, and `--type` accepts
nothing else — `blocked-by` names the same direction as `depends-on` in prose and on
the surfaces that publish it (the `cards blocked-by` subcommand, the `blocked-by:`
query predicate, `cards create --blocked-by`), but it is not a `--type` value (#120).
There is no unordered "related to" — Favro cannot store one, so it is not modelled with
an edge or a parent.

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

**`--limit`** — one parser for every cap, `parseLimit`, and three outcomes, no fourth:
whole digits of 1 or more are the cap; an **absent** flag is `undefined`, which each
caller reads as its own thing (no cap when printing, the command's declared default when
fetching); and a **supplied value that does not parse** is a *refusal* naming the value —
`1e9`, `5,000`, `1_000`, `2.7`, `-1`, `0`, `banana` all decline and exit 1. It used to
mean "no cap" on the print path and "the default" on the fetch path, which is a plausible
answer built from input we could not read. `0` is refused by decision, not omission: it
parses, and `capRows` read it as *everything*. **A behaviour change** — anything scripted
against the old silent-ignore now exits 1 (#142/#143). The same parser and the same
wording serve `sprint-plan --budget` on both its spellings — the CLI flag and the skill
step — with the flag name substituted; the skill step kept a `parseInt` through #143 and
planned a one-point sprint for `budget: 1e9`. A `--limit` arriving as a JSON **number**
rather than a flag string — only the dispatch surface can do that — is range-checked at
`dispatch.ts` instead, because there is no string to parse; it declines in the same words.
A ratchet (`limit-fail-closed-coverage.test.ts`) walks the compiled surface and follows the
value one declaration hop, so a local, a destructure or a `Number.parseInt` cannot
reintroduce a second parser. Note what this does **not** claim: on the fetch commands the
cap itself is inert — `ContextAPI.getSnapshot` and `AggregateAPI.getMultiBoardSnapshot`
accept `cardLimit` and never read it, measured — so what #142/#143 fixed is the *number*
each command computes, not the size of the read.

**refusal** — a deterministic decline: nothing was written, and the same call declines
again for the same reason. That is the whole distinction the dispatch table needs, and
it is why a refusal is never reported as retryable. `RefusalError`
(`src/lib/refusal.ts`) is a leaf class every refusal extends; anything raising a bare
`Error` is treated as a failure and unwinds, which is the safe default.

**interactive command** — a command that cannot work without a terminal: it prompts, it
draws an arrow-key picker, it hands a child this process's tty, or it repaints until
Ctrl+C. `favro` is not always the top-level process — `favro shell` and `favro_run` both
run it as a child on pipes — so an interactive command underneath either one *hangs*,
which for an agent is the worst failure there is: the whole timeout budget for no
answer. Both readers therefore ask one list, `src/lib/interactive-commands.ts`, and
refuse before spawning. Non-interactive commands keep their output capture, which is
what a blanket `stdio: 'inherit'` would have cost.
`src/__tests__/interactive-command-coverage.test.ts` is the ratchet: it walks the real
commander surface through the TypeScript checker and fails when a registered command can
reach a prompt without being listed. `confirmAction` is the one barrier cut out of that
walk — it refuses on `!isTTY` before it prompts, so its 48 call sites across 26 files are
safe on a pipe already.

The list is the *outer* guard and it is not the only one, because it cannot be. It keys on
command PATHS, so it cannot see a prompt that depends on a value or on what the wire
answers — `auth login --email … --api-key …` is deliberately allowed through and still
reaches the organization picker whenever an account has more than one org. Every prompt is
therefore fail-closed at the prompt as well: `confirmAction` (`lib/safety.ts`) and
`promptInput` (`commands/auth.ts`) both throw on a non-terminal stdin before they open a
readline interface. Write the guard as `!isTTY`, never `isTTY === false` — node leaves the
property *undefined* on a pipe, measured, so the equality form does not fire on the only
input that matters. The ratchet evaluates the real condition against that input rather than
matching its shape.

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
unguarded-by-oversight. There are nine such writes.
`src/__tests__/scope-lock-coverage.test.ts` holds both lists — debt and decision — and
fails on a stale entry in either.

**org-level guard** — the SECOND guardrail, for the three of those nine that issue an
irreversible org-wide DELETE (`tags delete`, `groups delete`, `webhooks delete`).
`assertOrgScope` in `src/lib/safety.ts` (#125). It keys on the LOCK, not the target,
and that is the design rather than a shortcut: a configured collection lock is the user
saying "my writes stay inside this collection", an org-wide delete provably does not,
and no resolution will make it — so a lock present is sufficient grounds to refuse.
`--force` allows the single write and warns; no lock configured is a no-op that makes no
request. The other six stay on `confirmAction` alone, which `-y` waives: `create` is
additive and `update` is undone by another update. **Irreversibility is the line**, and
the ratchet reads it off the HTTP verb — the `DELETE` call closure — never off the
command's name, so a future `tags purge` cannot slip past by being called something
else. Measured: a new unguarded org-level delete added to `src/commands/` fails
`the org-level guard covers every irreversible org-level write`.

Separately, and below both locks: no mutating request may name a target that URL
resolution widens or moves. `assertBoundedTarget` in `src/lib/http-client.ts` (#125) is
the chokepoint every resource module routes through. Every single-resource write is
`/<resource>/${id}`, so an unset id does not fail safely — `deleteTag('')` sends
`DELETE /tags/`, the organization's whole tag set, measured. `.`, `..`, a bare space and
a traversal are the same hole once axios resolves the path, so the guard compares the
**resolved** path, not the template string. Reads are deliberately unguarded: `GET
/tags/` is the list endpoint and a widened read costs nothing.

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

Places where the code does not yet speak the glossary. **An entry here is a debt, not a
decision** — #120 exists because recording a mismatch had been standing in for resolving
one. Every entry names the issue that will close it; a resolved entry leaves the list
rather than being struck through, because git remembers.

1. **Two `Collection` interfaces.** `src/lib/collections-api.ts` (with `boardCount`,
   `memberCount`) and `src/lib/boards-api.ts` (without). Same name, different shape, and
   the type is only the symptom — `resolveCollectionId`, `listCollections` and
   `getCollection` all exist twice too. **#123** collapses the surface; both declarations
   carry a comment saying so. Structurally harmless meanwhile (the narrow shape is a
   strict subset, so the two are mutually assignable). The live defect in the pair is
   behavioural, and also #123's: one `resolveCollectionId` accepts names, the other does
   not, and the card path calls the one that does not.

The other four entries were discharged by #120 and #122. One was not a mismatch at all
but a bug: `ScopeError` extended bare `Error`, so a scope violation reported
`retryable: true` and told agents to retry a decline only `favro scope set` can change.
See `src/lib/safety.ts` for the trace, and `refusal-drift.test.ts` for the ratchet.
