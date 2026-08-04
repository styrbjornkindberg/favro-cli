# Changelog

This file starts at 3.0.0. Releases up to and including 2.4.1 have no entries — the
history is in `git log`.

Every claim below was measured against two built CLIs: `2.4.1` (built from the commit
that set that version, `a13a02a`) and this release. Commands were driven with
`FAVRO_CONFIG_DIR` pointed at a throwaway config and no real credentials, so exit codes
and streams are real and no request reached a live org.

## 3.0.0 — unreleased

Four breaking changes, all in how the CLI is *called* and how it *answers*. The library
entry point is untouched: `src/index.ts` still exports `FavroHttpClient`, `CardsAPI` and
`BoardsAPI` with unchanged signatures.

### Breaking

#### 1. JSON is the default output. `--json` is gone; `--human` opts out.

Migrated commands print compact JSON by default and no longer accept `--json`. The root
program grows `--human` (human-readable output) and `--pretty` (indented JSON).

```
# 2.4.1
$ favro boards list --json     # accepted
$ favro boards list --human    # error: unknown option '--human'

# 3.0.0
$ favro boards list            # compact JSON
$ favro boards list --json     # error: unknown option '--json'
$ favro boards list --human    # the old table
```

**Migration:** delete `--json` from your scripts; add `--human` anywhere you were
parsing the table with `awk`/`grep`. If you were piping JSON into `jq`, you now get it
without asking.

**This flip is partial and you must check per command.** 20 of the 57 files in
`src/commands/` still declare their own `--json` and still default to human output;
those are the commands not yet moved onto the single runner. Issues #115–#119 track the
rest. A command that still takes `--json` behaves the 2.4.1 way.

Refusals moved with the output: under the JSON default a refusal is an
`{"error":{"message":…,"retryable":…}}` envelope on **stdout**, exit 1 (ADR-0002).
Unmigrated commands still write `✗ Error: …` to stderr.

#### 2. `--limit` removed from fourteen commands.

`board`, `context`, `diff`, `health`, `my-cards`, `my-standup`, `next`, `overview`,
`query`, `sprint-plan`, `stale`, `standup`, `team`, `workload`.

Measured on all fourteen: exit 1, `error: unknown option '--limit'` on stderr, stdout
empty, for both `--limit 50` and `--limit=50`.

**Why removed rather than fixed:** on these fourteen the flag never capped anything
honestly. All of them return a composite (`{ item: … }`), and the runner's print-cap
machinery only fires on `result.rows`, so there was no seat for a cap. Worse,
`mapConcurrent` appends in *completion* order, so any global cut point was
arrival-order dependent, and `buildStats` turns whatever survived into the
`by_status` / `by_owner` proportions that `health`, `workload`, `team` and `overview`
print as measured — a cap there fabricates a ratio, which no "results are partial"
line repairs. `next` already has `--count`.

**Migration:** drop the flag. If you needed a cap on a plain list, `--limit` still
exists on the migrated list reads (see Added), and `next --count` is unchanged.

#### 3. A malformed `--limit` refuses instead of silently meaning "no cap".

Where `--limit` survives, its value must be a whole number of 1 or more. Previously the
parse read a numeric *prefix* and stopped at the first non-digit, so `--limit 1e9` meant
1, `--limit 5,000` meant 5, `--limit 2.7` meant 2, and `--limit banana` meant **no cap
at all** — the opposite of what was asked for.

```
# 2.4.1
$ favro cards list board-1 --limit banana   # exit 1 only because of the wire; the flag was ignored

# 3.0.0
$ favro cards list board-1 --limit banana
✗ Error: --limit takes a whole number of 1 or more — got "banana"
```

**Migration:** pass digits. `--limit 0` is a refusal too — it used to mean everything.

Issues #142/#143.

#### 4. `favro query` speaks the `--filter` grammar, and refuses what it cannot resolve.

`favro query` ran a second, regex-based parser of its own. It scraped the patterns it
recognised, swept the remainder into a free-text title search, and printed a confident
paragraph explaining why there were no results — so a typo *answered* where
`cards list --filter` refused.

```
# 2.4.1
$ favro query <board> "statuz:done"     # 0 rows, plus "No cards match …"

# 3.0.0
$ favro query <board> "statuz:done"
{"error":{"message":"Unknown filter field 'statuz' at position 0 — refusing to run a query that cannot mean what you asked. Known fields: …","retryable":false}}
```

Every pattern that parser invented refuses now, and free text is `title~"…"` and nothing
else:

| Was | Say |
|-----|-----|
| `assigned:@alice`, `owner:bob` | `assignee:alice` |
| `priority:high`, `high priority` | `customField:Priority=high` |
| `due:overdue` | `due_date:overdue` |
| `pricing page` (bare words) | `title~"pricing page"` |

`unblocked` is refused and points at `cards list <board> --filter "unblocked"`, which
judges each blocker and reports the ones it could not read. `blocks:<ref>` and
`blocked-by:<ref>` are answered. An empty query refuses instead of widening to the whole
board.

The result shape changed with the parser: `matches` is a flat card list (the per-row
`matchReason` was the old matcher's running commentary), `filter` is the parsed query with
its values already settled, and `noResultsExplanation` is gone — the explanation is now a
refusal, raised before any card is read.

**Migration:** nothing that now refuses used to answer *correctly*. Re-spell it from the
table above, or run `favro cards list --help` for the whole grammar.

Issue #95, ADR-0006.

### Added

- `--human` and `--pretty` on the root program, resolved in one place for every command.
- Honest print-caps on migrated list reads: `--limit` caps how many rows are *printed*
  after a complete fetch and sets `truncated` in the envelope, so filters always run
  over the whole board. `boards list --limit` is new in this release; `activity` was the
  template.
- A scope lock (`favro scope set <collectionId>`) that refuses writes outside the locked
  collection unless `--force` is passed.

### Fixed

- `cards get --include` lost facets silently. Each of `board`, `collection`, `links` and
  `comments` was read inside `catch { /* best effort */ }`, so a failed sub-fetch handed
  back a card missing the facet the caller had asked for — indistinguishable from "this
  card has none". All four now record an `unreachable` entry on the card they return, so
  an empty facet and an unreadable one are two different answers (#153).
- A column that is *waiting* was counted as finished work. `detectStage` tested `approv`
  before `pending`, so `Pending Approval` read `approved` — done — and the unanchored `live`
  in the done branch matched inside "de**live**ry", so `Delivery`, `Deliverables` and
  `Livestream` read done too. Both reached `team`'s `doneCount`, `stale`'s skip guard,
  `health`'s flow ratio and, since #98, `standup`'s and `my-standup`'s `completed` group. A
  wait branch (`pending`/`awaiting`/`waiting`/`vänta`) now runs first; `approv`/`godkän`
  narrowed to `approved`/`godkän[dt]` so the gate names `Approval` and `Godkännande` fall to
  `review`; `live` is `\blive\b` with `delivered` spelled out beside it; `sign.?off` names a
  gate and moved to `review` while `signed.?off` names the decision and stays `approved`;
  `accept(?!ance)` keeps `Accepted` without claiming `Acceptance Testing`; and `(?<!o)klar`
  stops Swedish `Oklar` — *unclear* — reading as done, the same shape as the `(?<!un)resolv`
  lookbehind already beside it. Measured over 161 column names: **44 verdicts move**, 41
  losing a `done` that was a gate, a negation or a "de**live**ry" false positive, and three
  gaining one they never had (`Signed Off` and its spellings, which read `queued` before).
  **Not one name that was correctly read as done stopped being read as done** (#158).

- The documented-command ratchet could not see an options **table**, so every option table in
  every doc was unchecked — `command-reference.md` gave a `--json` row to 19 commands that
  have had no `--json` since 3.0.0. It now reads table structure (row → cells → the code
  spans in the first cell) and asks the same question the invocation arm asks. Found and
  swept 38 phantom flags across three docs. A second hole surfaced with it: a fenced command
  written across a trailing `\` was scanned one line at a time, so flags on its continuation
  lines were invisible; 22 such commands are joined now (#156).

- `favro standup --help` pointed at an `unblocked` command — a top-level command that has
  never existed. Its help now says `favro cards list <board> --filter "unblocked"`. The
  drift test covered help *topics* and tracked `.md` files, not `.description()` strings;
  it now walks the live command tree's descriptions, summaries and option help too, so the
  class is closed and not just the instance (#95).

- Date filters compared the wrong things. Three defects in one predicate, all in
  `lib/query-parser.ts`, so all four `--filter` surfaces plus `favro query` carried them:

  - `due_date:overdue` matched **no card on any board, ever**. `:` is `=`, and the keyword
    resolves to today, so the filter every doc describes as "past their due date" asked for
    "due exactly today" — and did not answer that either (see below). The keyword now
    carries its own `<`.
  - Every ordering operator on a date compared **years**. `compareValues` routes `<`, `<=`,
    `>`, `>=` through `parseFloat`, and `parseFloat('2026-08-07')` is `2026`, so
    `due_date<today` admitted nothing due earlier in the current year while `due_date<=today`
    admitted everything due later in it. Date predicates now compare the ISO day strings
    they already build.
  - The target day was off by one east of UTC. The keyword resolves to *local* midnight and
    was read back with `toISOString()`, which names the previous calendar day at any positive
    offset — so `due_date:today` matched no card due today.

  `skills/builtin/daily-digest.yaml` ships a `due_date:overdue` step, so the shipped digest
  reported no overdue cards on any board. Found reviewing #95, which is what introduced that
  spelling into the skill and into the migration table above.

- A scope violation under the JSON default wrote **nothing** to stdout. It now writes the
  refusal envelope, exit 1. `checkScope` / `checkCollectionScope` used to swallow their
  own throw and call `process.exit(1)` directly, which made the refusal invisible to
  every caller (#133). Acceptance holds on 12 of 38 guarded write paths; the remaining 26
  need the #115–#119 migration first.
- `tasks update/complete/delete` under a scope lock, with `--card` omitted, refused with a
  remedy that could not be run. The message was `assertScope`'s generic boardless one:
  it offered two causes that are both false in this case (nothing was read, so no card
  failed to read and none was found forkless) and told the user to run `favro cards get
  <cardCommonId>`, which needs the cardCommonId they do not have — the id in hand is a
  taskId. It never named `--card`. It now does, and says why the CLI cannot infer the card
  and why `--force` does not stand in for the flag (#126). Measured on all three: exit 1,
  stderr, stdout empty, before and after. The generic wording is unchanged wherever it is
  true — `--card` given but unreadable, or given for a card with no board instance.
- An empty board argument no longer reads the whole organisation. `favro release-check ""`
  and `favro risks ""` passed the empty id straight to `GET /cards`, which omits
  `widgetCommonId` when the board is falsy — so both paginated every card in the org to
  completion and then scored a verdict over all of them, with no refusal and no truncation
  marker. `CardsAPI.listCards` now refuses an id that was *provided* and empty; an absent
  board stays legal, because a collection-scoped read names no board on purpose. Measured
  on a `node:http` stand rather than the two built CLIs — reaching this code needs
  credentials, and the whole-org read is the failure being deleted: three board-less
  paginated requests before, zero and a `retryable: false` refusal after (#107).
- `--dry-run` no longer demands credentials for a preview that never touches the wire.
  Commands whose preview *is* a wire-derived scope verdict (`comments add/update/delete`,
  `members add --board-target`, and `boards update/delete` under a lock — see below) still
  require them, deliberately: a credential-free preview there would print a plan the lock
  was never asked about (#135, #152). Everything else previews credential-free.
- A board whose `/columns` read fails leaves every card on it with no workflow stage, and
  four more commands were reading that absence as a stage. Each now states its own answer
  rather than inventing one (#149):
  - `my-standup` put those cards in `inProgress` — so a card **finished** weeks ago on
    such a board was read out as work in flight. They now go in a new `stageUnknown`
    group and stay counted in `total`; the cards are never dropped, because they are the
    caller's own cards.
  - `next` and `my-cards` never ranked them (a recommendation has to know a card is not
    already done), but shrank their pool in silence. Both now carry `unreachable`, so an
    empty `suggestions` / absent `suggestedNext` is distinguishable from "nothing queued".
  - `overview` already bucketed them under stage `unknown`, honestly, but its
    `unreachable` key carried only blocker holes — so an absent marker claimed nothing was
    missed while `unknown` held a whole board. The two lists are now merged, snapshot
    holes first. Its human header reads `Not covered — N item(s) this report could not
    reach` in place of `N blocker(s) outside this scope`.
- `favro stale --board <board>` and `favro workload --board <board>` fabricated on the same
  failure. Those two arms read a single-board snapshot, whose columns hole is recorded as
  a bare `columns` rather than `columns:<boardId>`, so the exclusion added in #148 matched
  nothing on them: `stale --board` listed the board's finished cards as stale and
  `workload --board` reported its whole team at zero WIP with every overload alert
  suppressed. The exclusion now understands both hole shapes, and drops only the cards the
  failure actually left stageless — a hole the board-metadata column fallback repaired
  costs no cards (#149).
- A ratchet now walks every promise rejection handler in `src/` through the TypeScript
  checker and fails on one that both ignores its error and answers with emptiness, which
  is the substitution behind #116, #148 and #149. Five live sites remain, all in `favro
  init`, all listed with a reason — three as debt and two as decisions the caller already
  reports.
- `boards update/delete` and `collections update/delete` checked the scope lock *after*
  returning from their `--dry-run` preview, so a target outside the locked collection
  previewed at exit 0 while the real run refused — the preview promised an action the
  guardrail would not allow. All four now take the lock **before** the preview, so
  `--dry-run` refuses exactly where the real run does: exit 1 with the refusal envelope on
  stdout. A target *inside* the lock previews as before (#152).

  **Behaviour change worth knowing:** the two `boards` commands resolve the board over the
  wire to check it, so `boards update --dry-run` and `boards delete --dry-run` now need
  working credentials **when a scope lock is configured**. With no lock configured they are
  unchanged and still preview with no credentials at all. The `collections` pair needs
  nothing either way — its check is a comparison against local config. `--force` on a
  `--dry-run` now warns on stderr and previews anyway, where before it did nothing.
- `favro init` wrote a confident, wrong `.favro/context.json` when a read failed. Three of
  its four API reads answered a rejection with an empty value, and the schema has no field
  for "unread" — so a failed `/customfields` read wrote `"customFields": {}`, a failed
  `/users` read wrote `"team": {}`, and a failed `/columns` read left a board with no
  `workflow` key, each
  indistinguishable from the real finding in a file agents read later with no memory of the
  failure. All three now propagate: the error is reported, exit 1, and **no file is
  written** (#154).

  The schema is unchanged — deliberately, rather than growing an "unread" marker. Every
  other consumer of a failed read in this codebase records one (#116, #148, #149), but
  those answer a *query* and hand back what they did read; `init` produces a durable
  artefact that outlives the warning, and it is cheap and idempotent to re-run. The
  membership read is the one facet that still falls back, because it already states its
  third state in `notes.team` and on stderr. `docs/repo-context.md` now documents the whole
  absent-vs-empty table, and its File Format block has been corrected — it described a
  different shape on every key.

  **Behaviour change worth knowing:** a key that cannot read every facet now gets exit 1
  and no file, where it used to get a partial one at exit 0. `favro init --refresh` is the
  retry.
- The same preview-before-lock defect as #152's four, at five more commands — the ones #152
  generalised its fix over instead of fixing: `dependencies delete`, `dependencies
  delete-all`, `custom-fields set`, `git todos` and `git sync` all returned from their
  `--dry-run` preview before consulting the lock. `git todos --board <outside-the-lock> --dry-run` was the worst — it named a board
  the lock forbids and listed every card it would create there, at exit 0. All five now
  take the lock **before** the preview, so `--dry-run` refuses exactly where the real run
  does; a target *inside* the lock previews as before, and `--force` warns and previews
  anyway (#155).

  **Behaviour change worth knowing:** all five resolve their target over the wire, so their
  `--dry-run` now needs working credentials **when a scope lock is configured**, and refuses
  without them rather than previewing. With no lock configured all five are unchanged and
  still preview with no credentials and no requests. One further saving on that path: with
  no lock, `dependencies delete/delete-all` and `custom-fields set` no longer read the card
  on the real run either, since that read only ever fed a check that returns immediately —
  so on that path a mistyped card id is now reported by the write's 404 rather than by the
  read's, same message class and same exit 1. These five are unmigrated, so their refusal
  goes to **stderr** as `✗ Scope violation: …` rather than into the stdout envelope — #119
  moves the shape, not this fix.
- A ratchet now scans every `.command(…)` registration that calls a scope guard and fails on
  one whose `--dry-run` preview precedes it. `scope-lock-coverage.test.ts` only ever checked
  *whether* a guard exists, never its order, which is why the same defect shipped three
  times (#135, #152, #155). It is a text scan with a named ceiling, not an AST walk — four
  constructed bypasses still evade it and are listed in the test's own header.
- That swallowed-read ratchet only walked promise callbacks, and shipped stating the
  `try`/`catch` population was zero. It is not zero: 19 of the 160 `catch` clauses in
  non-test `src/` both decline to bind their error and answer with emptiness. A second
  seed over `ts.CatchClause` now walks them with the same two predicates, and the
  emptiness test learned the statement form (`catch { cards = [] }`), which no `return`
  test could see. All 19 are listed with a measured reason — ten as debt, nine as
  decisions where the throw is the answer (a URL validator, a cache miss, a
  fail-closed refusal). No swallow was fixed here; the ratchet is what stops the count
  growing while they are (#153).
  Review of #153 moved one line across that split and closed five more spellings: a
  failed `git branch --merged` reads as "not merged", and `favro git sync` then moves
  every affected card to "In Progress" — finished work walked backwards, so that
  swallow is debt and not a decision. The five spellings that got past the scan
  (`??=`/`||=`, `Array()`, `undefined!`, an empty template literal, and a `catch ({})`
  that binds nothing) are now caught in both seeds.

- One judge of "done" (#98, ADR-0005). The set `['done','approved','archived']` had five
  copies — three named `DONE_STAGES`, one named `COMPLETED_STAGES`, one inlined — and
  `standup`'s `isCompleted` asked the same question of a *column name* with a separate
  keyword list. All six now route through `isDoneStage` in `lib/workflow-stage.ts`, the
  module that already held `detectStage` for the same reason. `judgeBlockers` remains the
  only judge of *blocked*; `board-renderer`'s `statusIcon` is labelled cosmetic in source so
  it is not swept into the merge later. Scope: `isDoneStage` is the one judge of what a
  *workflow stage* means. `boards get --include stats,velocity` still counts done cards with
  its own exact `status === 'done' || 'completed'` in `lib/boards-api.ts` — found in review,
  left alone deliberately, and recorded in ADR-0005 because rerouting it would move a printed
  count.

  **Behaviour change in `standup`:** a card in an `Approved` or `Archived` column now groups
  as `completed`, where before it matched no group and was dropped from the output entirely.
  Swedish (`Klar`, `Färdig`, `Avslutad`) and `Shipped`/`Deployed`/`Live` count as completed
  now too. In the other direction, a column named `Unresolved` no longer reads as completed —
  the old list tested `status.includes('resolved')`.

- Two comments claiming `next` pays the per-blocker sweep (`my-standup.ts`, `docs/commands.md`)
  said the opposite of the code: `next` dropped its blocking term in #47 and does not import
  `judgeBlockers`. Only `cards list --filter unblocked` pays it (#98).

### Known gaps at release

- The output migration is incomplete — see the caveat under Breaking #1.
