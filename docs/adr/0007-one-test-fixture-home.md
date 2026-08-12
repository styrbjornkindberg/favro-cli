# ADR-0007: One home for test fixtures; three test seams survive

Status: accepted (#97)

## Context

#97 asked for "one test stand-in module: server lifecycle, client construction, temp config
directory, and card/`entities` factories behind a small interface", and asked which of three
coexisting seams survives.

**The ticket's central premise is wrong, and the correction changes the deliverable.** #97 opens
with "There are zero non-test files under `src/__tests__/`", which is true and reads as "this suite
has no shared fixtures". It has them. They live in **`src/test-support/`**, which already held
`filter-vocabulary.ts` and `scope-passthrough.ts`, is already excluded from the build by
`tsconfig.json`, is already recognised as non-production by four separate ratchets
(`typecheck-covers-tests`, `filter-fail-closed-coverage`, `limit-fail-closed-coverage`,
`command-runner-ratchet`), and is already imported by nine suites. `interactive-command-coverage.ts`
even names it as the destination convention: "both into `src/test-support/` when a third ratchet
needs them".

The reason nothing sits under `src/__tests__/` is mechanical: `testMatch` is
`**/__tests__/**/*.ts`, so **every** `.ts` there is collected as a suite, and a helper module fails
for containing no tests. `src/test-support/` exists precisely as the answer to that.

`src/test-support/filter-vocabulary.ts` also already exported a config-directory helper,
`useTempConfigDir()`.

**The counts in the ticket are also no longer the counts in the tree.** #97 was written around
`8754500`; this branch starts at `a67e657`, some thirty commits later. Every number below was
re-measured, because ADR-0003 applies to a count as much as to an API shape.

| What | #97 said | Measured on `a67e657` |
|---|---|---|
| `{entities:[…]}` wrappers | 165 | **157** |
| `new FavroHttpClient(` | 66 | **86** |
| temp-config-dir setups | 29 | **45** `mkdtempSync` across **36** files |
| byte-identical teardown lines | 11 | **60** lines carrying `recursive: true, force: true` |
| `http-client.test.ts` runtime | 55.6 s | **51.2 s** of a **63.9 s** wall clock |

## Decision

### 1. `src/test-support/` is the one home. Nothing new is created under `src/__tests__/`.

The helpers this branch adds go into the directory that already exists for them. **`testMatch` is
left as `**/__tests__/**/*.ts` deliberately** — tightening it to `*.test.ts` would have been a safe
one-liner (all 171 suites already matched), and an earlier revision of this branch did exactly
that, but it is the wrong move: it *permits* a second fixture home to grow under `src/__tests__/`
alongside the established one. Leaving the glob strict makes "fixtures live in `src/test-support/`"
structural instead of conventional. The glob is the enforcement, not a bug.

### 2. Two config-directory helpers, split by lifetime, and that split is the whole design

`src/test-support/config-dir.ts` adds `tempConfigDir(prefix, config?)`. It does **not** replace
`useTempConfigDir()`; the two cannot be merged, because the difference is *when the redirect exists*:

| | `useTempConfigDir()` (existing) | `tempConfigDir()` (new) |
|---|---|---|
| lifetime | per test (`beforeEach`/`afterEach`) | per suite, callable at module scope |
| sync | async | **synchronous** |
| writes `config.json` | no | yes |
| right when | each test wants a clean slate | the redirect must exist before the module under test is *required* |

The synchronous, module-scope form is not a style preference. `configDir()` resolves per call
(#65), but a module that reads config during its own import reads it before any `beforeEach` could
steer, and would land on the developer's real `~/.favro/config.json` — which on a working machine
carries a live scope lock. All nine migrated suites carry a comment saying exactly that. Being
synchronous is therefore part of the contract and cannot become async.

Deliberately **not** built, because nothing in this branch consumes them:

- **No `entities` factory.** The wrapper is Favro's shape, and the 157 occurrences sit inside
  bespoke request handlers where the surrounding `switch` on path is the actual content. A factory
  would shorten the wrapper and leave the handler.
- **No server-lifecycle helper.** Real duplication (38 `listen(0, …)` calls), but a separate
  mechanical pass; building it unused would be scaffolding.
- **No card factory, no builder API, no seam registry.**

The baseline `FAVRO_CONFIG_DIR` is captured **once per suite and restored from every teardown**,
not per call. Measured: Jest runs `afterAll` hooks in **registration order**, so a per-call
`previous` unwinds forwards — with two calls the first hook restores the original and the second
then reinstates the first call's, by then deleted, directory. One baseline is order-independent for
any number of calls.

### 3. All three seams survive. No helper abstracts over them.

The three seams partition cleanly (measured; the overlap is empty):

| Seam | Suites | Grep |
|---|---|---|
| real socket | 36 | `grep -rl 'http.createServer' src/__tests__` |
| mocked `http-client` | 61 | `grep -rl 'jest\.mock(.*http-client' src/__tests__` |
| neither (pure logic, mocked API class, no I/O) | 74 | remainder of 171 |

**No suite uses both the socket and an `http-client` mock.** The ticket's worry that `cards-api` is
"covered by two seams simultaneously" is true of the *module* — two different files cover it two
ways — not within a file. Two files covering one module from the wire and from the unit side is
coverage, not duplication.

The real-socket seam earns its place for the reason #51 gave: Favro answers 200 to writes it does
not perform, so a client-level mock pins a silent no-op, and three tests here once did exactly
that. That argument is about *writes reaching a server*. It says nothing about a pure-logic module,
where a mocked `http-client` is cheaper and equally sound. So the answer to the ticket's first
question is **all three, on the split above**, and a helper hiding all three behind "a small
interface" would be a **fourth** seam — an interface with two implementations chosen by the caller
is not fewer seams than two seams.

### 4. `http-client.test.ts` uses fake timers. Sleeping through real backoff pinned nothing.

The ticket left this open. The answer is that **no test there asserted elapsed time**. Eight tests
waited out `1 + 30 + 1 + 8 + 8 + 1 + 1 + 1 = 51 s` of real `setTimeout` for assertions about the
retry *happening* and about the seconds named in the user-visible message — and that message is
printed *before* the sleep. The file's measured 51.2 s is exactly that sum.

Worse, the real sleeping actively hid things. Both delay computations were unpinned, and both
mutations **survived** the original suite (M3′/M4′ below):

- `delay = delaySecs * 1000` → `delay = 0` — survived.
- non-429 backoff `Math.min(Math.pow(2, retryCount) * 1000, 30000)` → `0` — survived.

So the conversion is a strengthening, not a trade. Two tests now advance the clock deliberately
instead of flushing it — the 30 s `Retry-After` case, and one new test for the non-429 arm, which
had no test reading its delay at all — and both mutations are now killed. The other six use a
`settle()` helper that flushes pending timers.

`http-client.test.ts`: **52.3 s → 1.2 s** in isolation. Whole suite: **63.9 s → 22.6–26.2 s**.

### 5. The stderr leak was a leaked timer in the product, not a harness problem

`setupFilesAfterEnv` loads `test-support/silence-output.ts`, which swaps `process.stdout.write` and
`process.stderr.write` for sinks in `beforeAll` and restores them in `afterAll` — per **suite**, not
at module scope, because under `--runInBand` the worker *is* the main process and a module-scope
patch would silence Jest's own reporter and print no results. Jest emits a suite's reporter output
after that suite's `afterAll`. Verified by running `--runInBand`.

That closed the stdout half outright: **821 bytes → 0**, deterministic. It did **not** close the
stderr half. Frames went 420 → 135 with per-test scoping → and with per-suite scoping oscillated
between **5 and 152** across runs. A varying residue was the tell: the real cause was not scoping.

`cli.ts`'s `cards export` did this:

```ts
spinner.start();
let cardList = await api.listCards(board);   // throws → stop() is skipped
spinner.stop();
```

`Spinner.start` opens an `unref`'d `setInterval` that only `stop()` clears. On a throwing fetch the
interval survived — in real use drawing frames over the error message the `catch` prints, and under
test, where `process.exit` is stubbed, surviving for the rest of the **worker's** life and
scribbling across however many later suites that worker was handed. Hence the variance.

Fixed at the source with a `finally` (the only `Spinner` site in `src/`; `ProgressBar` renders
synchronously and cannot leak). Frames are now a deterministic **0** across four consecutive full
runs, and `cards export` no longer draws over its own error message — a small user-visible fix.

The silencer is therefore for the *deliberate* writes only. It must not be made to compensate for a
leaked timer, and the comment in it says so.

## Consequences

Nine suites migrated to `tempConfigDir`:

```
batch-filter-fail-closed-wire  batch-smart-goal-fail-closed-wire  cards-get-include-unreachable-wire
cli-cards-create-bulk          cli-cards-intents-wire             help-topic-drift
verbose-coverage               commands/init-clobber              commands/init-gitignore
```

Measured before → after, counting `src/__tests__` only (the helper now lives outside it):
`mkdtempSync` **45 → 36** (36 → 29 files); `recursive: true, force: true` **60 → 52**;
`FAVRO_CONFIG_DIR =` assignments **99 → 90**; `config.json` literals **31 → 24**. `entities: [`
unchanged at **157** and `listen(0,` unchanged at **38**, both deliberately. `new FavroHttpClient(`
went **86 → 87**: the one new non-429 retry test constructs a client.

### The remainder is mechanical follow-through, not a ticket

No follow-up tickets are filed. What is left, with exact counts:

1. **Six suites still build a config dir by hand.** Each is a mechanical swap, and each needs a
   judgement the nine above did not — which is why they were left rather than forced:
   `limit-fail-closed-coverage.test.ts` and `run.test.ts` (per-test dirs in `beforeEach`, so an
   `afterAll` teardown is the wrong lifetime — they want `useTempConfigDir()` or a per-test variant);
   `org-write-containment-wire.test.ts` and `commands/dry-run-scope-order-wire.test.ts` (local
   helpers that create a dir *per case* and push onto a `tmpDirs[]` array);
   `claim-me-wire.test.ts` (writes and deletes `config.json` between tests on purpose, so the file
   is the subject, not the fixture); `favro-error.test.ts` (one line, no `config.json` at all).
2. **38 `listen(0, …)` server-lifecycle blocks** across the 36 real-socket suites. The common part
   is start-on-ephemeral-port → build a client at that `baseURL` → close in teardown; the handler
   bodies are the content and do not move.
3. **157 `entities: [` wrappers.** Only worth touching alongside (2), inside the same handlers.

Anyone doing (1) should re-run the mutations below afterwards. A migration that leaves the suite
green is the exact symptom of a stand too thin to discriminate.

### Mutation record

Every mutation was type-checked before its verdict was recorded: a mutation that breaks TS narrowing
produces a suite-wide cascade that is neither a kill nor a survivor. All below are `tsc:PASS`, so
all verdicts are real. Control: `tsc:PASS`, 3628 passed. Full suite each time, never a subset.

| # | Mutation | Verdict |
|---|---|---|
| M1 | `retryCount < 4` → `< 0` | killed (12 tests, 3 suites) |
| M2 | global `Retry-After` cap `30` → `9999` | killed (1 test) |
| M3 | `delay = delaySecs * 1000` → `0` | killed (1 test) |
| M4 | non-429 backoff → `0` | killed (1 test) |
| M3′ | M3 against the *original* real-timer test file | **survived** — what the conversion fixed |
| M4′ | M4 against the *original* real-timer test file | **survived** — what the conversion fixed |
| M5 | `progress.ts` render drops `current/total` | killed (4 tests) — the silencer does not blind assertions |
| M6a | `config-dir` writes `confg.json` | killed (9 tests, 3 suites) |
| M6b | `config-dir` points env at an empty temp dir | killed (9 tests, 4 suites) |
| M7 | `config-dir`'s `rmSync` removed (cleanup that does nothing) | killed — outer `afterAll` names all four leaked dirs |
| M8 | `config-dir`'s env restore removed | killed — outer `afterAll` |
| M9 | `cli.ts` spinner `finally` removed | killed (1 test) |
| M10 | silencer `beforeAll` made a no-op | **survived at first** — see below; killed after |
| M11 | silencer returns `false` from `write` | killed (1 test) |
| M12 | silencer drops the completion callback | killed (1 test) |

**M10 is the disclosure.** On the first pass the silencer had no assertion behind it at all: its
only evidence was a byte count measured outside the process, so making it a no-op changed nothing
any test could see. The obvious fix — spy on stdout and assert nothing was written — is one of this
repo's catalogued ways to write a test that cannot fail, since an absence assertion also passes when
the code under test never ran. So `__tests__/silence-output.test.ts` asserts the **mechanism**
instead: the writers are not the pristine ones during a suite (captured at module scope, which runs
after `setupFilesAfterEnv` registers but before `beforeAll` fires), and the write contract holds.
That kills M10, M11 and M12.

M7 and M8 fail the *suite* while every individual test passes, because the assertion lives in an
`afterAll` — the only scope from which a self-registering teardown is observable. That is why
`__tests__/temp-config-dir.test.ts` asserts from outside the block that created the fixture.

M6a is killed only by the two migrated suites that pass a non-empty config (`init-clobber`,
`init-gitignore`) plus the helper's own check. The seven passing the default `{}` cannot tell a
missing file from an empty one, so for them the load-bearing property is the env redirect, which
M6b covers.

M6b is written to point at a *different temp directory*, never at the real `~/.favro`. Removing the
assignment outright would have let `init`'s config writes reach a developer's live credentials.
