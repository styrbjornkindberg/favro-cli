# ADR-0002: One command runner owns the preamble, the output and the exit code

Status: accepted (#93, grilled 2026-08-01)

## Context

There is no command seam. Each of **128** commander actions re-derives credential
resolution, config, scope and error handling by importing ambient singletons:
`createFavroClient()` at 114 call sites, `new XxxAPI(client)` at 113 across 18 classes,
`catch { logError; process.exit(1) }` at 119, `process.exit` at **292** (245 × `exit(1)`,
47 × `exit(0)`). `--verbose` is resolved in 15 syntactically distinct forms, two of which
disagree about which commander node holds the flag — that disagreement is bug #85.
Roughly **1 900 of the 10 981 lines** in `src/commands/` are the same twenty lines re-typed.

The repetition is the cheapest of its costs.

- **The top-level catch at `src/cli.ts` is unreachable.** Every action exits before it.
- **Output has six mechanisms**, and the deep one is the least used: bare `console.log`
  ×629, `console.log(JSON.stringify(…))` ×91, `process.stdout.write` ×26, `console.table`
  ×24, `outputResult` ×8, and `writeEnvelope` — the one shape `read-shape.ts` declares
  every list read must hand an agent — at **4**, against roughly 18 list reads.
  `boundedSweep`, which its own header calls "the only way to write a composite read", has
  **1** caller.
- **A command cannot be exercised without restating its whole dependency graph.** The
  quartet `http-client` + `config` + `safety` + `<api-class>` is mocked in 16 command test
  files; `config` alone in 35. `cards-tracker.ts` string-matches `"process.exit"` on an
  error message in three places to survive a mocked exit. The interface is not the test
  surface.
- **`--json` means four things**: 8 persona commands default to JSON with `--human` opting
  out, 48 files opt in with `--json`, 3 use `--pretty`, 4 use `--format table|json`.

## Decision

One `run()` wrapper owns the preamble, the error boundary, the output and the exit code.
Command modules become their flag declarations plus the work.

### Mechanism: a higher-order wrapper, plus `.exitOverride()`

`.action(run(handler))`. Commander 12's `.hook('preAction')` was rejected because hooks have
no return channel to the action — context would be stashed on the command object and read
back untyped. A declarative spec (`{name, args, flags, handler}` compiled to commander) was
rejected because it re-authors 128 flag declarations and commander's own `--help` generation
for no behavioural gain, and because it cannot be migrated a file at a time.

`.exitOverride()` is taken from the hook approach: it stops commander short-circuiting the
process, which is what finally makes the top-level catch reachable.

### What a handler receives

```ts
interface Ctx {
  client: FavroHttpClient;   // built by the runner
  config: FavroConfig;       // read once; carries scopeCollectionId
  verbose: boolean;          // resolved from the ROOT program, one spelling
  api: ApiNamespace;         // lazy memoized getters — ctx.api.cards, ctx.api.boards, …
}
```

The `api` namespace is on `ctx` deliberately: it removes 113 `new XxxAPI(client)` sites, and
— the actual point — a test stubs `ctx.api.cards` instead of mocking `http-client`. Getters
are lazy, so a command needing `CardsAPI` does not construct the other 17.

Client construction is **eager, with an opt-out**: `run({ anonymous: true }, handler)` omits
it and drops `client` from the type, so touching it is a compile error. Four commands declare
it — `auth`, `issue-tracker-help`, `shell`, `skill`. Four declarations instead of 114.

Scope is **not** on `ctx`. `assertScope` already takes `(boardId, client, config, force)`, and
#92 kept `checkScope` as the CLI skin for non-card writes. A scope helper on `ctx` would be a
fourth public spelling of the check that #92 just collapsed to two. `confirmAction` likewise
stays a free function: 48 sites, no dependencies, nothing to inject.

### The runner owns output

The handler **returns**; the runner writes.

```ts
type Result =
  | { rows: T[]; limit?: number; human?: (rows: T[]) => string | void }
  | { item: T;   human?: (item: T) => string | void }
  | { dispatch: DispatchResult }
  | void;
```

`rows` → `capRows` then `writeEnvelope` in JSON mode. `item` → bare, per rule 1 of
`read-shape.ts` ("list reads emit an envelope, singles stay bare"). `dispatch` →
`reportDispatch`, whose returned boolean sets the exit code. `void` is the streaming arm and is
load-bearing, not a hedge: the TUIs (`main-menu`, `board-tui`, `browse`), `auth login`, and
anything driving `ProgressBar` own their stdout and say so in the type.

The formatter may return `void` instead of a string — that is what accommodates the 24
`console.table` sites. The runner guarantees it owns the **machine** path only.

This is the only version of the change that actually fixes the envelope. `writeEnvelope` has 4
call sites because adoption is per-command and opt-in; making it the runner's job means every
list read emits `rows` / `truncated` / `unreachable` whether its author considered it or not.

### JSON is the default; `--human` opts out

Shipped in **3.0.0**, alongside #92's break.

TTY-sniffing (human when interactive, JSON when piped) was rejected. `read-shape.ts` rule 1
refuses a shape that varies with the data; varying it by invocation environment is the same
sin one step removed — the agent's output and the human's output for an identical command
differ, so every "works for me" report costs a round trip to establish which one happened.

`--pretty` becomes a root flag owned by the runner. `--format table|json` is deleted from
`webhooks`, `collections-list` and `activity` — a third spelling of `--human`/`--json`.
`cards export --format json|csv` survives untouched: CSV is a serialization axis, not a view
of the envelope, so that command returns `void` and writes its own file.

The cost, named: `favro boards list` typed by a human returns JSON. That is a regression on
the interactive path, priced at a seven-character flag. Bare `favro` still opens the TUI.

### The runner owns exit codes, via `process.exitCode`

All 292 `process.exit` sites leave the command modules. The 47 `exit(0)` cases become plain
returns.

**`process.exitCode`, never `process.exit()`.** `process.exit()` terminates before pending
async writes flush, and stdout is a **pipe** under MCP (`mcp-server.ts` uses `execFile`). The
dominant pattern today is `console.log(JSON.stringify(…))` immediately followed by
`process.exit(1)` — a truncated-JSON race that a JSON default would extend to every command.

Exit-code-as-answer becomes declared data: `Result` carries an optional `exitCode`, so `health`
returns `{ item: report, exitCode: report.ok ? 0 : 1 }`. Three commands need this —
`release-check`, `health`, `diff` — where "unhealthy" or "drift found" is the finding, not a
failure.

In JSON mode an error is an envelope on **stdout**: `{ error: { message, retryable } }`. Human
mode keeps `logError` on stderr unchanged. The reason it goes to stdout is the product's own
honest-failure thesis: MCP hands an agent stdout first and stderr as an appended blob, so a
failed command currently yields `(no output)` plus a decorated `✗` line, which is unparseable.

### Amendment (#134): two populations of error, one derivation behind a gate

As accepted, `retryable` at the boundary was `isRetryable('rolled-back', error)` — the dispatch
table's derivation, reused whole, so that the CLI and the table could not drift apart on "should
I try again". That reuse was wrong, and the wording above overstated what the two share.

**They were thought to be asked about different populations.** The table only ever sees errors
raised inside a write it instrumented, which was read as making an error it cannot classify a wire
hiccup after a clean unwind — so `retryable: true`. The boundary sees everything any of the 128
commands can throw: argument validation, missing config, file I/O, our own bugs. Reusing one
derivation across both is what made `favro boards list --include bogus` and a `TypeError` of ours
both answer `retryable: true` — an instruction to loop forever on a failure that cannot change.

(The narrow-population reading did not survive either. See "Why `dispatch.ts` stopped being the
exception" below: it is our code in there too. What #134 established and what still stands is the
GATE — everything after this paragraph is current.)

The rule now: **the wire is the gate, the table runs behind it.**

- A failure that came off the wire (`isWireFailure` in `favro-error.ts` — axios raised it, or it
  carries an HTTP response) keeps the one derivation in full. `isRetryable` still decides which
  HTTP failures are deterministic, so the shared question stays shared and #66 stays closed.
- Anything else is `retryable: false` without asking. Unknown means
  deterministic-until-proven-otherwise: a wrong `false` costs one honest failure, a wrong `true`
  costs an infinite loop, and that asymmetry is the whole argument.
- Validation and configuration failures therefore never claim retryable, by falling into the
  second arm rather than by being recognised. A dedicated `ValidationError` type was considered
  and not built: it would classify correctly only at the sites that remembered to raise it, while
  the default already covers every site that does not. `RefusalError` remains the type to reach
  for when a decline wants to be *named* — it is what made the missing API key honest (#118) —
  and **at this boundary** nothing depends on it being reached for.

The discriminator is structural, not a string match on the message: it asks where the error came
from, not what it says.

**The gate is on every population, and it is ONE expression — three sites, no exceptions
(#151, carried forward).** `retryAdvice` in `dispatch.ts` holds it:

```ts
export const retryAdvice = (outcome: TxOutcome, error: unknown): boolean =>
  (isWireFailure(error) || error instanceof TransientError) && isRetryable(outcome, error);
```

- `dispatch.ts` — the table itself. Gated.
- `run.ts` (`retryableFrom`) — the CLI error boundary, everything 128 commands can throw. Gated
  since #134.
- `skill-engine.ts` — `rollback.retryable` at the **end-of-run unwind**, where `abortCause` is
  whatever a step threw *outside* the table's instrumentation: an interpolation typo, an unknown
  intent, a `ParseError`, a `TypeError` of ours. Gated since #151. A skill that writes in step 1
  and mistypes `{{made.nope}}` in step 2 answered `retryable: true` on stdout and printed "safe to
  retry" until then; `skill-capture-wire.test.ts` pinned that answer as intended and now pins the
  opposite, with the reversal recorded on the assertion.

The three used to be three hand-written spellings of one rule, which is #66's failure mode. They
are now one function called three times.

### Why `dispatch.ts` stopped being the exception

#134 and #151 left the table ungated on the reading that its population is *narrow*: everything it
sees was raised inside a write it instrumented, so unclassifiable means a wire hiccup after a clean
unwind. **Narrow is not the same as clean.** `intent.run` is our code, so a `TypeError` of ours —
or any deterministic bare `Error` a future op raises — took the same arm and came back
`retryable: true`. That is #134's `--include bogus` defect wearing the table's clothes, and every
reader of `DispatchResult.retryable` saw it: `reportDispatch` printing "safe to retry", the machine
envelope on stdout, `skill run`'s summary. Nothing in the codebase *loops* on the field — the
reader that acts on it is the agent, which `favro help issue-tracker` tells to obey it.

#151 measured the naive fix and declined it: gating the table breaks the in-process failures that
genuinely ARE transient, and `tx-cards.ts`'s "answered 200 but did not take" is one — the write was
accepted, the state did not change, retrying is correct advice, and `isWireFailure` calls it
`false` because it is a bare `Error` of ours. So the naive gate breaks a legitimately-retryable
case to fix an illegitimate one.

What closed it was **enumerating** that population rather than assuming it was large. The surface is
the import closure of `dispatch.ts` — the intents' `run` bodies live in that file, so its closure
(27 modules by `madge`) is what they can reach, not `TxCards`'s 22; the five extra are `dispatch.ts`
itself, `read-shape.ts`, `safety.ts` and `api/comments.ts` with its types. Across all of it the
genuinely-transient in-process throws number **exactly one**: `TxCards.setArchived`'s read-back.

The rest of the non-`RefusalError` throws in that closure are either deterministic or unreachable
from inside the try, and neither fact is guarded by a test — `refusal-drift.test.ts` covers the
resolver family (`*ResolutionError` / `*LookupError`) plus five irregulars it lists by name, and
says nothing about the bare `Error`s in `cards-api.ts`, `widgets-api.ts`, `config.ts` or
`api/comments.ts`. What the enumeration measured about those, as of this ADR:

- `cards-api.ts`'s `parseCardUrl` throws reach only `findCardByUrl`, which no intent calls.
- `widgets-api.ts`'s "no card found" reaches only `commands/widgets.ts`, which is not an intent.
- `api/comments.ts`'s empty-text throws reach only `run.ts` and `safety.ts`'s `boardOfComment`,
  which calls `getComment` and swallows.
- `config.ts`'s and `tracker-config.ts`'s file-read throws reach an intent only through
  `tx.tracker()`, and `board()` primes that memo OUTSIDE the try.
- `cards-api.ts`'s `mapDescription` throw is on every create/update path, but `CreateCardRequest`
  and `UpdateCardRequest` declare no `descriptionFormat` and `createRequest` is a whitelist, not a
  spread — and it is deterministic anyway, so the fail-closed default is the right answer for it.

A bug of ours is by definition not transient, so one site is cheap to mark: it carries a
`TransientError` (declared beside `RefusalError` in `refusal.ts`, the leaf module that exists so
either marker can be raised without an import cycle) and the default gets to be fail-closed
everywhere: unknown means deterministic-until-proven-otherwise, because a wrong `false` costs one
honest failure and a wrong `true` costs an agent looping on a call that can never succeed.

**Seven tests asserted the old reading. Five now assert the new one**, each carrying a note saying
which way it is pinned and why — `dispatch-tx-wire.test.ts`'s *"a plain in-process failure after a
write is NOT retryable"* and `skill-dispatch-wire.test.ts`'s *"a failure in step 2 undoes what step
1 wrote"* are the two that pinned it deliberately. Of the other two:

- *"the reported 'rolled-back, safe to retry' can no longer be a lie about a deleted card"* was
  **not** flipped: the condition it guards IS `rolled-back AND retryable`, so flipping the
  assertion would have left a test that cannot fail. Its third step now fails off the wire instead
  of in-process, keeping both halves true.
- *"a 200 that did not take is a LOUD failure, not a ✓ about the argument"* was not touched at all.
  It is the one test the `TransientError` marker exists for, and the only one in the suite that
  reaches the exemption — dropping either the marker or the `instanceof` disjunct fails exactly it.

`skill-engine.ts`'s **other** rollback path — a `StepDispatchFailure`, where the table caught the
error, unwound and derived `retryable` itself — is still carried verbatim rather than re-derived.
It now inherits the gate for free, because the table applies it. `skill-dispatch-wire.test.ts` is
that path; #151's issue text named it as pinning the same defect as `skill-capture-wire.test.ts`
and it does not — it reads the table's answer, not the engine's.

Where the first amendment says a decline is `false` only where someone remembered to raise a
`RefusalError`, that cost is no longer paid anywhere: the gate answers first at all three sites.
`RefusalError` still earns its keep as the type that *names* a decline, and `safety.ts` traces
what it was load-bearing for.

**Reach for `TransientError` only with an observation behind it.** It is the one exemption from a
fail-closed default, so a site that raises it without a measurement re-opens the loop for that
path. `setArchived` has #75's probe: `PUT {archive: …}` responds with a card row echoing
`archived`, so a mismatch is an observed non-write, not a guess (ADR-0003).

**That rule is not ratcheted, deliberately.** No test asserts the site count, so a second
`TransientError` would ship unnoticed. Accepted because the drift pressure changed direction: while
the default was fail-OPEN, the loop was re-opened by *omission* — someone forgetting to raise a
`RefusalError` — which is what earned `refusal-drift.test.ts`. Fail-closed means omission is now the
safe outcome, and opening the loop takes a deliberate `import { TransientError }`. A scan blind to
`extends TransientError` would cost more than it buys; revisit if a second site ever appears.

**`retryable` is not "the world is unchanged".** A rollback conveys that by existing, and
`outcome` says how completely. `retryable` answers only "could running this again succeed" — the
two came apart the moment a fully-undone run met a failure that can never succeed. No second field
was added to carry the first claim: the object's presence already does.

## Consequences

- **#99 is re-scoped.** "Route every list read through the envelope" stops being a migration
  and becomes a verification pass, because the runner routes them.
- **#85 dies as a side effect.** One `verbose` spelling, resolved from the root.
- The three `cards-tracker.ts` `"process.exit"` string-matches are deleted.
- **Migration order is constrained by #92.** The runner takes exactly one blocking edge — it
  blocks #109, the step that routes six command files. #107 is types-only and #108 touches one
  file, so neither is gated. Write commands migrate only after #110 deletes `batch`,
  `batch-smart` and `bulk`; migrating 1 117 lines that are about to be deleted is pure waste.
- **A two-way ratcheting contract test is what keeps CI green batch to batch.** It bans five
  patterns in `src/commands/` and `cli.ts` — `createFavroClient(`, `process.exit(`,
  `console.log(JSON.stringify`, `.opts()?.verbose`, `new […]API(` — against an allowlist of
  unmigrated files. A non-allowlisted file with a banned pattern fails; **an allowlisted file
  that is already clean also fails** until struck off. The second direction is what stops the
  allowlist rusting into permanent cover. When it empties, the ban is absolute and command #129
  cannot reintroduce the preamble.

## Revisit when

A handler needs something `Ctx` does not carry. The answer is nearly always a free function
taking `ctx.client`, not a fifth member — `assertScope` and `confirmAction` are the precedent.
Widening `Ctx` is how a seam becomes a god object.
