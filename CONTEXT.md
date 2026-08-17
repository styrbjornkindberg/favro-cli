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
unambiguously means true-empty. A composite read that answers with a SINGLE entity has
no envelope to carry the marker, so it rides on the entity instead — `context`'s
snapshot and `cards get --include` both do this, same key, same `{id, reason}` shape.
A read feeding a durable artefact has neither, so it propagates instead and writes
nothing (`favro init`'s three list reads) — unless the artefact has a prose field for
the reason, which `context.json`'s `notes` is: `notes.team` and `notes.scope` mark the
two facets that fall back rather than refuse, and the rule is that a fallback is never
SILENT, not that it never happens. `src/lib/read-shape.ts`.

**`--limit`** — a **print** cap and only a print cap, with one parser, `parseLimit`, and
three outcomes, no fourth: whole digits of 1 or more are the cap; an **absent** flag is
`undefined`, which every remaining caller reads as *no cap*; and a **supplied value that
does not parse** is a *refusal* naming the value — `1e9`, `5,000`, `1_000`, `2.7`, `-1`,
`0`, `banana` all decline and exit 1. It used to mean "no cap" on the print path and "the
command's declared default" on the fetch path, which is a plausible answer built from input
we could not read. `0` is refused by decision, not omission: it parses, and `capRows` read
it as *everything*. **A behaviour change** — anything scripted against the old
silent-ignore now exits 1 (#142/#143). The same parser and the same wording serve
`sprint-plan --budget` on both its spellings — the CLI flag and the skill step — with the
flag name substituted; the skill step kept a `parseInt` through #143 and planned a
one-point sprint for `budget: 1e9`. A `--limit` arriving as a JSON **number** rather than a
flag string — only the dispatch surface can do that — is range-checked at `dispatch.ts`
instead, because there is no string to parse; it declines in the same words. A ratchet
(`limit-fail-closed-coverage.test.ts`) walks the compiled surface and follows the value one
declaration hop, so a local, a destructure or a `Number.parseInt` cannot reintroduce a
second parser.

There is **no fetch cap anywhere**, and that is the second half of the story. Reviewing
#142/#143 measured six `cardLimit` parameters with **zero** reads between them:
`ContextAPI.getSnapshot` and `AggregateAPI.getMultiBoardSnapshot` declared one and never
touched it, and `QueryAPI.execute`, `SprintPlanAPI.getSuggestions`, `StandupAPI.getStandup`
and `getCollectionSnapshot` existed to pass it down. Fourteen commands computed a correct
number for a signature that discarded it. All six parameters and all fourteen flags are
**deleted** — `context`, `standup`, `sprint-plan`, `query`, `board`, `diff`, `health`,
`my-cards`, `my-standup`, `next`, `overview`, `stale`, `team`, `workload` — so passing
`--limit` to one of them exits 1 with `unknown option '--limit'` rather than being accepted
and ignored. Deleted rather than wired, on two measurements: `getMultiBoardSnapshot` sweeps
collections through `mapConcurrent(…, 3, …)` and each worker appends to the shared card
list as its call lands, so a global cut point is decided by wire arrival order (the same
command answering differently run to run), while a per-collection cap would make
`--limit 50` mean 50 × N collections; and `buildStats` turns whatever survives into the
`by_status` / `by_owner` proportions that `health`, `workload`, `team` and `overview` print
as measured, so a subsampled sweep is a fabricated ratio — the conversion of unread data
into a plausible answer that ADR-0002 forbids, and one a "results are partial" line does
not repair. **The read is unbounded and stays unbounded**: a 422-board workspace measured
at 10 601 cards is paged in full (#132). An honest cap is still available as a later
ticket, and it has a price of admission — a `capped` marker on the snapshot that every one
of the fourteen renders on the human path *and* in `--json`.

**refusal** — a deterministic decline: nothing was written, and the same call declines
again for the same reason. That is the whole distinction the dispatch table needs, and
it is why a refusal is never reported as retryable. `RefusalError`
(`src/lib/refusal.ts`) is a leaf class every refusal extends; anything raising a bare
`Error` is treated as a failure and unwinds, which is the safe default.

`TransientError`, beside it in the same leaf module, is the mirror and the rarer type: a
failure the raising site **measured** transient, so retry advice may survive the wire gate
for it. Two sites raise it, both read-backs in `TxCards` — `setArchived`'s (the PUT echo
#75 probed) and `moveColumn`'s (a fresh GET of the card, because that PUT's echo is
unprobed, #101) — and reaching for it without an observation behind it re-opens the retry
loop for that path.

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
hatch, and it does not rescue the no-board case. `assertScope` in `src/lib/safety.ts`.

**Where the lock comes from, since #174: `FAVRO_SCOPE_COLLECTION_ID` first, then
`~/.favro/config.json`.** It was the file alone, and the file is one file that every
reader loads fresh per invocation — so two shells, or two agents driving the CLI in
parallel, *could not hold different locks*, and `favro scope set X` in one silently
retargeted the other's next write. An env var **is** session state (per-shell, inherited
by children, dies with the window), which is the whole of the mechanism: no session id,
no lockfile, no registry, no TTL. It also joins the lock to the priority order every
other config field already used — flag > `FAVRO_*` env > file.

Four consequences, each a decision rather than a side effect:

- **The merge is in `readConfig`, not `loadConfig`.** `loadConfig` is the function that
  looks like the merge point and it is dead outside tests; every real reader — all 26
  guarded registrations included — calls `readConfig`. An override merged in `loadConfig`
  is one no scope guard ever sees.
- **Empty or whitespace-only THROWS.** Falling through to the file value would make a typo
  silently name another collection, and resolving to "no lock" would silently unlock every
  board in the organization. Mirrors `resolveApiKey`'s empty-`FAVRO_API_KEY` throw, a bare
  `Error` for the same reason: a malformed environment is not a refusal, and `withClient`'s
  dry-run deferral only swallows `RefusalError`, so this stays loud on the preview path too.
- **The env value must not reach disk, and the guard for that is in `writeConfig`.**
  `readConfig()` feeds `writeConfig()` at six call sites, every one spreading a
  readConfig-derived object — so merged naively, the next `auth login`, or any
  `resolveUserId` auto-resolve (which fires on `next`, `my-cards`, `my-standup` and `@me`),
  would persist the session lock as the GLOBAL one: this same bug, arriving later and
  harder to see. `writeConfig` preserves the file's own `scopeCollectionId` /
  `scopeCollectionName` whenever the variable is set. One guard in the shared writer, not
  six at the callers, so a seventh caller inherits it.
- **`scopeCollectionName` is unknown on the env path**, so refusals print the raw id. Every
  consumer already read `scopeCollectionName ?? scopeCollectionId`. `scope set` and `scope
  clear` **refuse** under an active override rather than writing a value nothing in that
  shell reads, and `scope show` names the SOURCE of the effective lock — without that the
  two disagree and no output explains why. Every scope refusal's remediation line names the
  source as well (#175): under the override it says to re-export the variable, because `Run
  'favro scope set …'` is advice that refuses. The wordings are `commands/scope.ts`'s own,
  exported from `config.ts` — one string per instruction, and one module that knows where the
  lock came from. The ORG-WIDE guard's line names two steps, not one: unsetting the variable
  drops only the session lock, and the file's lock then refuses the same write again, so
  `unset …` alone would have been the very second refusal #175 exists to remove.

The override's reach is **wider than the write guard**, and that is worth knowing before
exporting it: ten commands read `config.scopeCollectionId` as their DEFAULT READ SCOPE when
no `--collection` is given — `health`, `next`, `my-cards`, `my-standup`, `overview`, `team`,
`stale`, `workload`, the interactive menu, and `init`'s default collection. Same field, same
override, so those reads retarget too. Consistent with "the effective lock" rather than a
surprise, but stated because "an override for the write guard" would be too narrow a
reading. Measured against a request-logging stand with `coll-file` in the file: `favro
health` asked `GET /collections/coll-file` unset and `GET /collections/coll-env` exported.

Deliberately NOT done: the general lost-update race in `writeConfig` (read-modify-write
with no lock) is untouched. The env path sidesteps it for scope because it writes nothing;
`userId` and `apiKey` still clobber, and that is its own ticket. Nor is the env-supplied
id verified against the wire — `scope set` verifies, the env path does not, and a bad id
fails closed: every board mismatches and every write refuses.

Measured on `dist/cli.js` against a local stand, both shells and both polarities: with
`coll-a` exported, `brd-a` previews at exit 0 and `brd-b` refuses; with `coll-b` exported
the two swap; the FILE's collection refuses under either, so the two locks do not union.
`--force` still overrides, an unresolvable board is still uncheckable under `--force`, an
empty variable refuses instead of falling back, and with the variable unset every arm is
byte-identical — including the credential-free `--dry-run` with nothing locked.

`--dry-run` is a preview, never a safety wall, and it is not a way around the lock —
because a preview writes nothing for the lock to guard. The lock runs **before** the
preview, so a preview carries the verdict rather than contradicting it. Migrated writes
(the `.action(run(…))` ones): `boards create`, `members add` and `comments
add/update/delete` always did, and `boards update/delete` and `collections update/delete`
joined them in #152. Unmigrated ones (still `catch { logError; process.exit(1) }`):
`dependencies delete`, `dependencies delete-all`, `custom-fields set`, `git todos` and
`git sync` joined in #155. All nine returned from the preview first, so a target outside
the lock previewed at exit 0 while the real run refused. (`collections create` and
`webhooks create` are org-scoped, below — there is no lock to run.)

Measured on a built CLI against a local stand, not assumed, in both directions for all
nine: a target outside the lock exits 1 with the refusal, a target inside it still
previews at exit 0, and with no lock configured the preview is unchanged and asks for no
credential. The **shape** of the refusal still differs by migration state, and that is
#119's half, not the lock's: the four migrated ones put the
`{"error":{"message",…}}` envelope on stdout, the five unmigrated ones write
`✗ Scope violation: …` to stderr with stdout empty.

Stated as a whole-CLI rule this time, because it is now **checkable** rather than
generalised: `dry-run-scope-order-wire.test.ts` scans every `.command(…)` registration in
`src/commands` that calls a scope guard — **26 of them, 23 with an `if (options.dryRun)`
preview** — and fails on any whose preview precedes its guard. (Those counts read 38/33
here until #111 re-measured them: #109 routed eight of the commands through the dispatch
table, so their `checkScope(` text is gone from the command file, and #110 deleted
`batch`/`batch-smart` with four guarded, previewing blocks between them. The test's own
assertion is the arbiter and has carried 26/23 since #110.) Falsifiable in both
polarities: the same predicate run against `src/commands` at `8754500` reports exactly the
five gaps #155 closed, at the five lines the ticket named. It is a text scan, and its
ceiling is measured against constructed bypasses rather than guessed at: a preview hoisted
into a helper, one gated on a differently spelled flag, a guard reached through an alias,
and a condition a formatter wrapped across lines all still slip past. That is why the nine
behavioural subjects sit beside it rather than being replaced by it. (The counts were
33/29 as first written, because the guard list enumerated five names and missed this
repo's own `checkTaskScope` and `checkTargetScope` — so `members add` and `tasks
update/complete/delete`, four of the nine, were skipped whole. Matching the shape rather
than a name list fixed it without changing either polarity.)

This paragraph has claimed something false twice — that the lock always ran first (#135
corrected it for four commands), then that those four were permanently different (#152
made it true for them) — and generalised once off four commands' evidence over five that
still had the bug (#155 is those five). The ratchet is there so a fourth version does not
have to be trusted.

The ORDER has a price, paid deliberately, on every command whose guard resolves its target
over the wire: `boards update/delete`, `dependencies delete/delete-all`, `custom-fields
set`, `git todos` and `git sync` need a credential for `--dry-run` *when a lock is
configured*, and refuse without one. Every one of those call sites therefore gates on
`config.scopeCollectionId` — with nothing locked there is no verdict to produce, the client
is never constructed, and the credential-free preview #135 measured is unchanged. Since
#174 that field carries the env override too, so exporting `FAVRO_SCOPE_COLLECTION_ID` is
a lock for this purpose exactly as a file lock is: the same seven commands then want a
credential for `--dry-run`, measured. The gate
is not tidiness: `ctx.client` / `createFavroClient()` is evaluated before the guard can
decide it has nothing to do, and `checkResolvedScope` cannot absorb it because its own
`client` parameter is eager too. `collections update/delete` pay nothing either way:
`checkCollectionScope` is a comparison against local config.

Two consequences of the gate on the five unmigrated sites, stated rather than discovered
later. With **no lock configured**, `dependencies delete/delete-all` and `custom-fields
set` no longer read the card on the REAL run either — that GET only ever fed a check that
returns immediately, which is the waste `checkResolvedScope`'s own docstring calls out. And
`git sync`/`git todos` still print their local report (the branch → card mapping, the TODO
listing) before refusing: that output describes the repo, not the write, and it is printed
identically on the real run.

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
roll back. And the outcome does not settle retry — `retryAdvice` (`src/lib/dispatch.ts`) is
the one derivation, read from `DispatchResult.retryable`. A clean `rolled-back` is still not
retryable when the wire named the failure, nor when the failure never reached the wire at
all: unknown means deterministic-until-proven-otherwise at all three of its callers, and
`TransientError` is the one exemption.

---

## Known mismatches

Places where the code does not yet speak the glossary. **An entry here is a debt, not a
decision** — #120 exists because recording a mismatch had been standing in for resolving
one. Every entry names the issue that will close it; a resolved entry leaves the list
rather than being struck through, because git remembers.

The list is **empty**. Four entries were discharged by #120 and #122, and the fifth —
two `Collection` interfaces, with `resolveCollectionId`, `listCollections` and
`getCollection` all declared twice — by #123. One of the four was not a mismatch at all
but a bug: `ScopeError` extended bare `Error`, so a scope violation reported
`retryable: true` and told agents to retry a decline only `favro scope set` can change.
See `src/lib/safety.ts` for the trace, and `refusal-drift.test.ts` for the ratchet.

One correction the fifth entry earned on its way out, recorded because the entry stated
it as fact for three tickets: **the behavioural half of it named the wrong function.**
It said "one `resolveCollectionId` accepts names, the other does not". Measured on HEAD
before #123 touched anything, the two `resolveCollectionId` bodies were byte-identical
and BOTH resolved names — the divergent pair was `getCollection`, where
`collections-api`'s escalated an id to a name lookup on a classified not-found and
`boards-api`'s did not. The rest of the entry held: the card path
(`cards get --include collection`) did call the one without the escalation, and now
calls the one with it.
