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
#92 kept `checkScope` as the wrapper for non-card writes — a CLI skin that printed and exited
until #133 made it throw like everything else (amendment below). A scope helper on `ctx` would
be a fourth public spelling of the check that #92 just collapsed to two. `confirmAction` likewise
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

### Amendment (#133): the ban on hard exits reaches every module, not just the commands

The 292 sites above were counted in `src/cli.ts` and `src/commands/`, and the ratchet that holds
them scans only those two. `src/lib/safety.ts` was invisible to it, and its two scope guards —
`checkScope`, `checkCollectionScope` — printed a decorated `✗ Scope violation:` line and called
a hard exit from four call depths down. Measured on the built CLI with a lock configured:

```
$ favro collections delete coll-other --yes
exit=1   stdout: (empty)   stderr: ✗ Scope violation: target collection "coll-other" …
```

That is the exact shape rule 3 was written against, surviving on the one failure a write
guardrail exists to produce. After: `exit=1`, 268 bytes of `{"error":{…,"retryable":false}}` on
stdout, 0 bytes on stderr. `assertScope` and `assertOrgScope`, one function over, already threw.
So the guards now throw `ScopeError` too, and the boundary renders it.

Three things the fix holds that a smaller one would have dropped:

- **Exit 1 stays.** A refusal is a negative finding, and stdout carrying the envelope is not a
  reason to claim success. Both are required: parseable stdout *and* a non-zero code.
- **The human line keeps its heading, and three other lines moved — each measured.**
  `error-handler.ts` heads a `ScopeError` with `Scope violation:` rather than `Error:`, keyed on
  `.name` because `safety.ts` imports that module and the class cannot be imported back without a
  cycle. On the refusal this amendment is about the bytes are identical: `collections delete
  --human`, 224 stderr bytes before and 224 after on a pipe. Three deltas elsewhere, all on
  stderr, none on stdout, and none of them "unchanged" — an earlier draft of this bullet claimed
  the whole human surface was, which the review measured as false:
    - **Colour, on the refusal itself.** The MESSAGE is now plain where three of its lines were
      coloured: JSON is the default even at a TTY, so a coloured message would put escape codes
      inside the value an agent parses. Under `FORCE_COLOR=1`, 273 bytes before against 244 after
      — the 29 are the escape pairs on `'favro scope show'`, `'favro scope set …'` and
      `--force`. The strings stay quoted, so the what-to-do-next survives as text. Stated cost,
      not a regression to fix; a switch that dropped `chalk` to level 0 in machine mode would let
      both back, and belongs to whoever wants it, not to this ticket.
    - **`checkScope`'s 404 reword GAINED a heading**, because it stopped printing for itself:
      `✗ Scope check failed: Board <id> not found.` (52 bytes) is now
      `✗ Error: Scope check failed: …` (59). Correct — a missing board is not a scope violation —
      and the same arm gained 90 bytes of envelope on stdout where it had written none.
    - **`assertOrgScope`'s two legacy callers LOST one.** `tags delete` and `groups delete` said
      `✗ Error: Scope violation: …` from #125 to here and now say `✗ Scope violation: …`: 482
      stderr bytes before, 475 after. That is the unification the `.name` read buys, and it is a
      change to the two most destructive writes in the tool, so it is recorded rather than
      absorbed.
- **A refusal is not a failed write.** `git commit --comment` resolves its board inside a
  best-effort `catch` that reports "(Could not add comment to card)". While the guard EXITED
  that catch could not see it; once it throws, an unfiltered catch downgrades the lock to a
  notice — measured at exit 0 with the violation gone. The catch now rethrows a `RefusalError`.
  It is the only swallowing catch downstream of a scope check (grepped: `catch {` across
  `cli.ts`, `src/commands/`, `src/lib/`).

The ban is scanned over **every non-test file under `src/`**, for the hard exit alone — the other
four preamble spellings are command-shaped and a library has no `run()` to adopt. The unmigrated
commands are excused by the ALLOWLIST they already carry, not by being out of scope, so they lose
the excuse the moment #115–#119 strike them off. It first shipped scoped to `src/lib/`, which left
the identical hole one directory over; both halves were then measured on a green tree at 162 suites
/ 3084 tests:

- `process.exit(1)` added to `src/api/comments.ts` — a module `git.ts`, `comments.ts` and
  `attachments.ts` all import — passed everything. `src/api/`, `src/test-support/` and the two
  server entry points were as invisible as `src/lib/` had been.
- `import { exit } from 'node:process'` and then `exit(1)`, inside `src/lib/read-shape.ts`,
  passed everything. So there are two spellings, the second banning the IMPORT rather than
  enumerating call forms, with a self-check arm on synthetic strings — that pattern has no live
  example in the tree to prove it is not simply misspelled, and the excuse predicate is asserted
  non-vacuous for the same reason.

Two exceptions, argued rather than assumed: `ErrorFormatter.fatal`, whose exit is its declared
`never` and which has no production caller left; and `src/mcp-server.ts`, under
`require.main === module`, where a transport that will not connect has no boundary to report to.

**What throwing does NOT buy — the residual, counted rather than sampled.** The envelope reaches
stdout only where the CALLER is inside `run()`, and most callers are not yet. Measured on the
built CLI under a lock, across all 38 write paths that take a scope guard: **12 put the refusal on
stdout, 26 put it on stderr and write 0 bytes to stdout.** The 12 are `collections
delete`/`update`, `boards create`/`delete`/`update`, `members add`/`remove`, `comments
add`/`update`/`delete`, `webhooks delete`, `tracker init`. The 26 include every `cards`, `columns`,
`dependencies`, `custom-fields`, `git`, `batch`, `batch-smart`, `tasks`, `tasklists`, `widgets` and
`attachments` write, plus `tags delete` and `groups delete`. All 38 exit 1 and all 38 report the
violation somewhere; none is silent on both streams.

So #133 is the necessary half and not the sufficient one, and the acceptance criterion "a scope
violation under the JSON default emits the error envelope on stdout" holds on 12 paths of 38. Both
helpers now throw, which is what no caller could work around; the remaining silence is a property
of the ENTRY POINT — a legacy `catch { logError; exit(1) }` — and is discharged one command at a
time by #115–#119, not by a second change in `safety.ts`. Nine `RefusalError` subclasses exist and
none is silent by virtue of its class.

**And the throw's TYPE is load-bearing at two readers, so `checkScope`'s rethrow is pinned.**
Every board-lock refusal passes through that one `catch`. Rewriting `throw error` as
`throw new Error(error.message)` — same wording, same `retryable: false` — passed 162 suites /
3085 tests while reintroducing this amendment's own third bullet (`git commit --comment` back to
exit 0 with the violation replaced by the notice) and breaking its second (`boards delete --human`
printing `✗ Error: Scope violation: …`). `safety.test.ts` now asserts `instanceof` on what that
funnel rethrows, with the 404 arm as the opposite polarity.

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

### Amendment (#135): a `--dry-run` pays for exactly what its own preview reaches for

As accepted, client construction is eager and first. A `--dry-run` arm lives inside the
handler, so a preview became gated on working auth — **asking a destructive command what it
would do cost a credential check.** Not decided; a side effect.

Decided now, and the measurement is what decided it rather than either stated preference.
Driven against `dist/cli.js` at `874df19` with `FAVRO_CONFIG_DIR` pointed at an empty
directory and `FAVRO_API_*` / `FAVRO_EMAIL` / `FAVRO_ORG_ID` unset.

**The population is twelve migrated commands declaring `--dry-run`, not the six the issue
names** — accurate at filing, stale once #116 migrated `comments`, `webhooks` and `members`.
Enumerated from source (every `.command(` block in `src/commands/` containing `'--dry-run'`,
split by whether it is `.action(run(`), not from a count in a ticket. Eleven are on the eager
arm; `skill run` is `run({ anonymous: true })` and the runner never built it a client, so it
was never gated. Of the eleven:

- **Eight preview arms are derived entirely from argv and `ctx.config` and consume nothing
  off the wire**: `boards create/update/delete`, `collections create/update/delete`,
  `webhooks create`, and `members add --collection-target`. Proven rather than read: the
  pre-#114 CLI (`6db4e36^`, built and driven) prints the same previews with no credentials in
  the environment at all. `[dry-run] Would delete board board-1` is an echo of argv.
  **Byte-identical for six of the eight**, re-measured on review: `webhooks create` and
  `members add --collection-target` differ, because #116 moved them to the `item:` arm and
  JSON is the default — `{"dryRun":true,"event":…}` against the old prose line. Under
  `--human` those two are byte-identical too, which is where the claim holds. The evidence is
  about the WIRE, and the shape change is #116's and intended; an earlier draft of this
  bullet said "byte-identical" of all eight, which is false in the default mode (ADR-0003).
- **Four reach for the wire before their preview exists**: `comments add/update/delete` call
  `checkResolvedScope(ctx.client, () => boardOfCard/boardOfComment(…))`, and on a target
  they cannot read the preview is *replaced* by a scope refusal — measured, off a 403. Their
  dry run has never been credential-free, including before #116 migrated them, so it is not
  a #114 regression. `members add --board-target` (the default) is the fourth, via
  `checkScope`.

`members add` is therefore **one command that answers both ways depending on a flag**, which
is the strongest argument against any per-command list: no allowlist can express it, and
"does this preview touch the client" expresses it exactly.

So the issue's decisive argument — *"a dry-run that skips scope resolution can no longer
tell the user their target is outside the lock"* — is true for exactly those four and false
for the other eight, four of which already return from the preview **before** their scope
check and therefore have no verdict to lose. Any single global answer is wrong about one
group.

**The rule: credential resolution stays eager and first, but on a `--dry-run` invocation the
REFUSAL for a missing credential is deferred to the first touch of `ctx.client` or
`ctx.api`.** `withClient` in `run.ts` catches, and hands back a context whose two members
re-throw the same error at the same boundary with the same wording.

- It holds **uniformly across all 128 actions by construction**, which is the acceptance
  criterion: the mechanism names no command and keys on no list, so there is nothing for
  #116–#118 to remember or for an allowlist to rust into. A migrated write inherits it.
- It is **not a safety regression**, measured rather than argued. The scope verdict the
  seven can produce is config-derived, and it survives: under a lock, `boards create
  <foreign-collection> --dry-run` still refuses with exit 1 and no credentials. The four
  that produce no verdict produced none before either. The three that need the wire still
  pay for it. Nothing that previously refused now proceeds.
- Skipping construction outright — the issue's literal suggestion, "move the dry-run arm
  ahead of client construction" — was rejected on the same measurement: it hands the
  comments trio an absent `ctx.client` and breaks them, so it would need a per-command
  exception, which is the shape this ADR exists to delete.
- Flag validation reaches the user credential-free as a consequence, which is the
  concern #114's ticket anticipated: `boards create col-1 --type bogus --dry-run` now
  answers `Invalid board type: "bogus"` instead of `API key not found`.

**Narrowed to `RefusalError`, on review.** The first draft was not, on the reading that
`readConfig()` had already run and thrown in `run()` so the only failures reaching the catch
were the two missing-credential declines. `readConfig()` is right, but the enumeration was
not: `resolveApiKey` throws a bare `Error` for a `FAVRO_API_KEY` that is **set but empty**,
which is a malformed environment, not an absent credential, and is the one thing that throw
exists to be loud about. Measured on the built CLI before the narrowing —

```
$ FAVRO_API_KEY= favro boards delete board-1 --dry-run
exit=0   stdout: [dry-run] Would delete board board-1          # 57f503d: exit=1, envelope
$ FAVRO_API_KEY= favro boards delete board-1 --yes
exit=1   stdout: {"error":{"message":"FAVRO_API_KEY is set but empty. …","retryable":false}}
```

— so a preview swallowed a misconfiguration the real run refuses on, and the bullet above
("nothing that previously refused now proceeds") was false by one case. The deferral now
carries `error instanceof RefusalError`; everything else refuses up front, which is the
fail-closed side and keeps a bug of ours from ever surfacing as a successful preview.

**The deferred throw's TYPE is pinned, for #133's reason at a second site.** `unresolved()` in
`withClient` is a funnel that re-throws a captured error, which is exactly the shape #133's
last bullet pinned in `checkScope`. The same mutation lands here: rewriting `throw error` as
`throw new Error((error as Error).message)` — same wording, and `retryable: false` either way
because `retryAdvice` gates on `isWireFailure` first — passed 163 suites / 3132 tests on the
first draft. `run.test.ts` now asserts `instanceof RefusalError` on what a handler catches off
`ctx.client`, with the malformed-environment arm as the opposite polarity.

Three documentation claims the measurement falsified, corrected with it: `CONTEXT.md` said the
lock always runs before the preview (false for four commands); `comments`' three `--dry-run`
help strings said "without making API calls" (false for all three — they issue the resolving
GET); and `members add`'s said the same, which is false for its DEFAULT `--board-target` arm
and was missed in the first draft even though it is the fourth wire-touching preview this
amendment names.

### Amendment (#152): the four that checked after their preview now check before it

The amendment above measured that `boards update/delete` and `collections update/delete`
"already return from the preview **before** their scope check and therefore have no verdict
to lose". True as a measurement, and the wrong thing to leave standing: a preview that
promises a delete the real run refuses is not a missing verdict, it is a **wrong** one.
#152 moves the guard above the preview in all four. `--dry-run` help text is unchanged for
the `collections` pair and remains accurate; the `boards` pair's is not (see below).

**This does not contradict the #135 rule, it is priced by it.** The rule is that a dry run
pays for exactly what its own preview reaches for. Under #152 the two `boards` previews
genuinely reach for the wire — `checkScope` resolves the board's collection through
`GET /widgets/{id}` — so they now pay, and they move from #135's eight-command
"derived entirely from argv and `ctx.config`" group into its four-command wire-touching
group, alongside `comments add/update/delete` and `members add --board-target`. The
mechanism that charges them is the one already in `withClient`: nothing keys on a command
name, and the deferred refusal fires on the first touch of `ctx.client`. The `collections`
pair does not move, because `checkCollectionScope` is a comparison against local config —
which is what made it the decisive half of the ticket: the refusal was free and the preview
still declined to make it.

**Both `boards` call sites gate on a configured lock, and that gate is load-bearing.**
`ctx.client` is an ARGUMENT to `checkScope`, so it is evaluated before the guard can decide
it has nothing to do. Ungated, a user with no lock would be charged a credential check for a
verdict there is no lock to produce, and the measured example above —
`FAVRO_API_KEY= favro boards delete board-1 --dry-run` → `exit=0` — would become false,
taking #102/#104's "no behaviour change when no lock is configured, and no extra requests on
that path" with it. `checkResolvedScope` exists for this same evaluation-order reason and
cannot be reused here: its `client` parameter is eager too. So the honest statement is
narrower than "credential-gated": **`boards update/delete --dry-run` is credential- and
wire-gated exactly when a scope lock is configured, and unchanged otherwise.**

Measured against `dist/cli.js`, `FAVRO_CONFIG_DIR` on a throwaway config, no real
credential, and the wire served by a local stand rather than a live org:

```
# lock configured; brd-other sits outside it
$ favro boards delete brd-other --dry-run
before: exit=0   stdout: [dry-run] Would delete board brd-other
after:  exit=1   stdout: {"error":{"message":"Scope violation: board \"Board brd-other\" …","retryable":false}}

# lock configured; brd-inside sits inside it — the omit arm
$ favro boards delete brd-inside --dry-run
before: exit=0   stdout: [dry-run] Would delete board brd-inside
after:  exit=0   stdout: [dry-run] Would delete board brd-inside      # unchanged

# lock configured, credential absent
$ favro boards delete brd-other --dry-run
before: exit=0   stdout: [dry-run] Would delete board brd-other
after:  exit=1   stdout: {"error":{"message":"✗ API key not found. …","retryable":false}}

# NO lock, credential absent — #135's measured example, deliberately unchanged
$ favro boards delete brd-other --dry-run
before: exit=0   stdout: [dry-run] Would delete board brd-other
after:  exit=0   stdout: [dry-run] Would delete board brd-other       # unchanged
```

Two consequences stated rather than discovered later:

- **`--force` on a `--dry-run` now means "warn and preview anyway", exit 0.** It previously
  meant nothing at all on these four, since the guard it bypasses never ran. Same wording as
  the real run, on stderr, so a parsed stdout is still just the preview line. On the `boards`
  pair `--force` still pays for the wire, because `assertScope` resolves before it consults
  `force`. Pinned in `dry-run-scope-order-wire.test.ts`.
- **A bad id under a lock now answers `Scope check failed: Board <id> not found.`** rather
  than previewing, because the guard's resolving GET is what 404s and `checkScope` rewords it
  (#133). That is a different refusal from the scope violation and the test pins which one
  fired; asserting only "exit 1" would have hidden it. Argument validation still runs first
  and still answers credential-free — `boards update <id> --name '' --dry-run` says
  `Board name cannot be empty or whitespace-only`, not a scope or credential error.

The `boards update/delete` `--dry-run` help strings said `Preview without making API calls` /
`Print what would be updated without making API calls`. Under a lock that is now false, for
the same reason #135 corrected the `comments` trio's, so both are reworded rather than left to
mislead. The `collections` pair's are untouched and still true.

### Amendment (#155): the five UNMIGRATED sites, and what each one's preview now pays

The amendment above was reviewed and its `CONTEXT.md` paragraph found to have generalised
#152's four-command fix into a whole-CLI rule that five more commands falsified. #155 is
those five: `dependencies delete`, `dependencies delete-all`, `custom-fields set`,
`git todos` and `git sync`. Measured on the built CLI at `8754500` against a local stand
(no request left the machine), `FAVRO_CONFIG_DIR` on a throwaway config with
`scopeCollectionId: coll-locked`, target outside it:

```
dependencies delete card-1 card-2 --dry-run    exit=0   55 B     0 requests
dependencies delete-all card-1 --dry-run       exit=0   61 B     0 requests
custom-fields set card-1 field-1 v --dry-run   exit=0   64 B     0 requests
git todos --board brd-other --dry-run          exit=0   `Would create N cards on board brd-other`
git sync --dry-run                             exit=0   4678 B   0 requests
```

`git sync` is the one #155 filed as "stated unverified"; it is driven here and it has the
defect, ending `dry-run Would move cards "56 card(s) to \"Done\""` at exit 0 with the lock
never consulted. After the fix each of the five exits 1 with the refusal and no preview.

**The #135 pricing decision, per command, because it is not a blanket one.** The rule is
that a dry run pays for exactly what its own preview reaches for. All five previews now
reach for the wire, so all five pay — but they pay differently, and each is a decision:

| command | what its guard resolves | `--dry-run` under a lock costs |
|---|---|---|
| `dependencies delete` | the source card → its board | credential + `GET /cards/{id}` + `GET /widgets/{board}` |
| `dependencies delete-all` | the card → its board | credential + `GET /cards/{id}` + `GET /widgets/{board}` |
| `custom-fields set` | the card → its board | credential + `GET /cards/{id}` + `GET /widgets/{board}` |
| `git todos` | a `--board` name-or-id → a boardId | credential + `GET /widgets/{board}` (plus one `GET /widgets` list on a cold name cache) |
| `git sync` | every DISTINCT branch-mapped card → its board | credential + one `GET /cards/{id}` per distinct card + one `GET /widgets/{board}` per distinct board |

`git sync` is the expensive one and deliberately so: its preview claims a sweep across N
cards, and a verdict on a sweep is a verdict on all of it. The guard is gated on there
being targets as well as on the lock, so a repo with nothing to move still costs nothing.

**Each of the five gates on `config.scopeCollectionId`, and the gate is load-bearing.**
Same reason as the `boards` pair above, in a different shape: these are unmigrated, so
there is no lazy `ctx.client` getter — `createFavroClient()` resolves credentials eagerly
and rejects without them, and the card/board read is a request. Neither can be deferred
behind `checkScope`'s own "no lock, no-op" return, and `checkResolvedScope` cannot absorb
it because its `client` parameter is eager too. Ungated, a `--dry-run` for a user with **no
lock** would be charged a credential and a GET for a verdict there is no lock to produce.
Measured, with no lock configured, all five: exit 0, the same preview byte-for-byte, zero
requests, and no credential resolvable in the environment at all.

**They FAIL CLOSED on a missing credential — this is #135's fail-open, not repeated.**
Measured under a lock, two distinct absences, because `resolveApiKey` treats them
differently and only one of them is a `RefusalError`:

```
# FAVRO_API_KEY set but EMPTY — a bare `Error` from resolveApiKey
$ favro dependencies delete card-1 card-2 --dry-run
exit=1   stderr: ✗ Error: FAVRO_API_KEY is set but empty. Unset it or provide a valid key.
stdout: 0 B — no preview

# no credential resolvable at all — a RefusalError from createFavroClient
$ favro custom-fields set card-1 field-1 v --dry-run
exit=1   stderr: ✗ Error: ✗ API key not found. Run 'favro auth login' first
stdout: 0 B — no preview
```

Both are exit 1 at all five sites. The distinction matters because #135's own reviewer
caught the opposite: deferring every credential error behind a lazy getter turned
`FAVRO_API_KEY= favro boards delete board-1 --dry-run` from exit 1 into exit 0 previewing
the delete. Note for the measured example in the #135 amendment above, which writes
`FAVRO_API_KEY=` and reports `exit=0`: that holds for a credential that is **absent**, and
not for one that is set-and-empty, which is exit 1 today at every site including the
`boards` pair. With **no lock** and an absent credential, all five preview at exit 0 —
that is the arm ADR-0002's example is about, and it is unchanged.

**The refusal reaches the wrong stream, knowingly.** These five end in
`catch { logError; process.exit(1) }`, so the refusal lands on stderr as
`✗ Scope violation: …` and stdout carries no envelope. Fixing the ordering here gives a
correct refusal in the wrong shape; #119 owns the shape. The tests therefore assert the
stderr render exactly rather than an envelope — and exactly, because `logError` renders a
bare `Error` carrying the identical message as `✗ Error: Scope violation: …`, so a
`toContain('Scope violation:')` cannot tell the two apart. That is the assertion shape
#152's own test used, and #155 does not copy it: the thrown object is recorded off the
reader and pinned `instanceof ScopeError` with `.name === 'ScopeError'` and the full
message by `toBe`.

**What is NOT hoisted, decided rather than left implicit.** `git todos` prints its TODO
listing and `git sync` prints its branch → card mapping before the guard. Both describe the
local repository rather than the write, both are printed identically on the real run, and
`git todos` with neither `--create` nor `--dry-run` is purely that listing. The same
reasoning keeps argument validation ahead of the guard on `boards update` above. What moved
is the part that plans a write: `Would create N cards on board X` and
`Would move cards "N card(s) to \"Done\""`.

**And the rule is now checkable instead of generalised.** The same paragraph of
`CONTEXT.md` has been false twice and over-general once, and `scope-lock-coverage.test.ts`
ratchets only *whether* a guard exists. `dry-run-scope-order-wire.test.ts` now scans every
`.command(…)` registration in `src/commands` that calls a scope guard — 33, of which 29
have an `if (options.dryRun)` preview — and fails on any whose preview precedes its guard.
Falsifiable rather than asserted: the same predicate run against `src/commands` at
`8754500` reports exactly five gaps at `dependencies.ts:129`, `:162`,
`custom-fields.ts:174`, `git.ts:302` and `:436` — the five lines #155 named.

The three `--dry-run` help strings that said "without making API calls" on
`dependencies delete/delete-all` and `custom-fields set` are false under a lock for exactly
the reason #135 corrected the `comments` trio's and #152 the `boards` pair's, and are
reworded with the behaviour. `git todos`' and `git sync`' strings never made the claim and
are untouched.

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
