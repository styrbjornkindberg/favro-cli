# Changelog

This file starts at 3.0.0. Releases up to and including 2.4.1 have no entries — the
history is in `git log`.

Every claim below was measured against two built CLIs: `2.4.1` (built from the commit
that set that version, `a13a02a`) and this release. Commands were driven with
`FAVRO_CONFIG_DIR` pointed at a throwaway config and no real credentials, so exit codes
and streams are real and no request reached a live org.

## 3.1.0 — unreleased

### Changed

- **`cards update` writes through the one dispatch table (#108).** The field writes were a
  private path with no compensation log; they now go through the `update` intent, so they
  inherit the mandatory scope lock, the boardless-write refusal, the 20-write cap and a
  rollback. A failure on the third field unwinds the first two and reports `rolled-back`
  instead of leaving a half-applied card.

- **`cards update <card> --dry-run` now checks the scope lock before it previews.** It
  returned from the preview first, so under a configured lock a dry run printed
  `[dry-run] Would update card …` for a card the real run refuses — misinformation in the
  one flag a careful caller reaches for first. The `--from-csv` path (#103) and the
  `--board` predicate path already ordered it correctly; the single-card path was the
  straggler, which is why neither sibling fix revealed it. Cost: one `GET /cards/<id>` on a
  dry run that previously made no request at all.

- **`--column` is now a second spelling of `--status`, not a second field.** Both mean "put
  the card in this column", and the intent resolves the name against the card's own board,
  so `--board` is no longer required alongside it. What that gives up, stated rather than
  hidden: a name that is not a column of the card's board now refuses and lists that
  board's real columns, where before it PUT `{columnId, boardId}` — a combined cross-board
  move nothing has measured and one with no compensating write. `--status` and `--column`
  naming different columns refuses as ambiguous rather than silently preferring one.

- `--comment` stays outside the table on purpose: a comment has no compensating write, so
  it is not an intent and cannot join the transaction. That is why the hoisted scope check
  still runs when there are no fields to dispatch — it is the only guard on a comment-only
  invocation.

### Fixed

- A whitespace-only `--tags` entry (`--tags "bug, ,urgent"`) reached the tag resolver as a
  blank tag *name*, and an unknown name on a write is a tag creation. It is dropped now.
  The trim was added with a broader justification than it deserved — every downstream
  resolver already trims, so a spaced-but-nonempty ` bug ` always resolved correctly — and
  a mutation run found the real case the trim covers, which is now the case pinned.

## 3.0.0 — 2026-08-12

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

- **`boards get --include stats` reported zero done cards and zero overdue cards for every board
  that exists, and a flat four-week velocity series, all printed as measured fact.** The
  premise the whole computation rested on is false. Probed against a throwaway board on
  2026-08-12, `GET /widgets/{id}?include=cards` answers with exactly these keys — `archived`,
  `collectionIds`, `color`, `columns`, `editRole`, `name`, `organizationId`, `ownerRole`, `type`,
  `widgetCommonId` — and no others. There is **no `cards` array**: not empty, absent, and
  `include=cards` does nothing on that endpoint. No `cardCount` either. So
  `aggregateBoardStats` always took the branch that had been documented as a fallback to board
  metadata, and that branch returned `doneCards: 0`, `overdueCards: 0` and
  `openCards: board.cardCount ?? 0` — which is `0` as well, since the field is absent —
  while `calculateVelocity` was called with `undefined` and answered four weeks of `completed: 0`.
  `boards list --include stats,velocity` printed the same figures in table form, from three
  further call sites that passed no cards at all.

  Every card-derived facet now reports **unknown**, never `0`: `unknown` in `--human`, `null` in
  JSON, on `BoardStats.totalCards/doneCards/openCards/overdueCards` and on
  `VelocityData.completed/added/netChange`. A `null` is not a zero — treat it as unread. Both
  commands print one note under the section naming the measurement and the command that *can*
  count: `favro columns list <boardId>`, where `GET /columns` carries a measured `cardCount` per
  column (excluding archived cards), and the boards carry the same sentence as an `unmeasured`
  string for a `jq` consumer. `openCards` reports unknown rather than the board total for the same
  reason the other two do: a total is not a split, and printing it as "open" asserts that nothing
  on the board is finished.

  **`added` had no source in either branch and was the literal `0`**, which made
  `netChange: completed` a quiet assertion that `added === 0`. Both are `null` now, always.

  Two decisions worth stating. `--include stats` **degrades rather than refuses** — the facet list
  and the pointer to `columns list` are still something a reader can act on (ADR-0002), and a
  refusal would take the whole board detail down with it on a composite read. And the measured
  per-column `cardCount` is **not** summed to recover `totalCards`, because `boards list --include
  stats` would then cost one `/columns` request per board and 322 boards is this repo's measured
  worst case; `estimationSum`/`timeSum` are not a velocity source either, and inferring one is the
  step ADR-0003 refuses.

  All five attach sites are now one function, `withBoardIncludes` — three of the five passed no
  cards, which is how the same question could answer `unknown` on one path and `0` on another. The
  fixture that let this ship was a hand-written widget carrying a three-card `cards` array in
  `boards-api.test.ts`; every counter test agreed with it and the wire agreed with none of it. It
  is deleted, and the regression check is a real `node:http` server serving the measured key set,
  asserting what both commands **print** in both modes across all four paths
  (`src/__tests__/board-stats-wire.test.ts`). ADR-0005 carries the amendment; its #157 amendment
  called this widening "correct and latent, not printed" on the strength of an unmeasured `cards`
  array, and that conclusion is superseded rather than quietly corrected.
- **`favro columns update` refused every column under a scope lock, and `--force` could not
  rescue it.** `Column` declared a required `boardId: string`, but the wire does not send
  that field: `GET /columns?widgetCommonId=<board>` was measured on 2026-08-12 to answer
  with `cardCount, columnId, estimationSum, name, organizationId, position, timeSum,
  widgetCommonId` — the board arrives as `widgetCommonId`. So `col.boardId` was `undefined`
  at every read while the type promised a string, and the use site's `?? ''` handed
  `checkScope` an empty board id, which is refused deliberately and which `--force` is
  documented not to rescue. Reads now normalise both spellings onto `boardId` in one place
  in `ColumnsAPI`, so no caller has to know what the wire calls it. A response carrying
  neither spelling still leaves the field `undefined` and still refuses — the fix is not an
  `?? ''`, because that would trade a false refusal for a lock that cannot see the write.
  The single-column `GET /columns/{columnId}` shape remains unmeasured and is not asserted
  either way (ADR-0003). Pinned against a real socket, including each read path reverted on
  its own.

- **`favro columns list` answered `0` for a count that never arrived.** The human table
  rendered `cardCount ?? 0`, and `timeSum` / `estimationSum` the same way, so a column whose
  count was absent read as a column with no cards. This is the command
  `boards get --include stats` now names as the one that *can* count, which made the
  fabricated zero a defect in the remedy for the same defect. All three fields were measured
  present on `GET /columns`, so an absent one is an anomaly worth reporting rather than
  smoothing: the table reads `—`, the sentinel the boards table already uses. The `--json`
  path is unchanged — an absent field was already absent there rather than zero.

- **`favro git sync` moved finished cards backwards whenever the merge check could not
  run.** `isBranchMerged` answered `false` for a failed `git branch --merged`,
  `analyzeBranches` spelled that as status `'open'`, and `git sync` PATCHes every `'open'`
  card to "In Progress" — so one unreadable repo moved every card-linked Done card back to
  In Progress, in volume. The `false` was classified conservative on the grounds that it
  never advertises a branch as safe to delete; `git sync` deletes nothing, and both
  answers write. The failure now propagates, so `analyzeBranches` throws and `git sync`
  refuses instead of guessing a status. Its trigger went with it: `getDefaultBranch()`
  returned `'main'` unconditionally when it found neither `main` nor `master`, and
  `git branch --merged main` then fails for *every* branch at once in a clone whose
  default is `develop` — it now raises a `RefusalError` naming the remedy
  (`git remote set-head origin <branch>`). Found in review of #153; the swallowed-read
  ratchet's `CATCH_DEBT` list drops from six entries to five. Note the cost, measured on
  the built CLI: a `develop`-default clone with no `origin/HEAD` now exits 1 on `git sync`
  even when it has nothing to sync, where it used to print "No branches with card
  references found." at exit 0 — the remedy is in the refusal.

- A column that is *waiting* was counted as finished work. `detectStage` tested `approv`
  before `pending`, so `Pending Approval` read `approved` — done — and the unanchored `live`
  in the done branch matched inside "de**live**ry", so `Delivery`, `Deliverables` and
  `Livestream` read done too. Both reached `team`'s `doneCount`, `stale`'s skip guard,
  `health`'s flow ratio and, since #98, `standup`'s and `my-standup`'s `completed` group. A
  wait branch (`pending`/`awaiting`/`waiting`/`vänta`) now runs first, `approv`/`godkän`
  narrowed to `approved`/`godkän[dt]` so the gate names `Approval` and `Godkännande` fall to
  `review`, and `live` is `\blive\b` with `delivered` spelled out beside it. The same gate-read-
  as-decision mistake is closed for `Sign-off` and `Acceptance` (`Sign-off` read *done* while
  `Signed Off` matched nothing at all, and `Acceptance Testing` read done too), and `klar` is
  `(?<!o)klar` so the Swedish `Oklar` — *unclear* — stops reading as finished. Measured over 161
  column names: 44 verdicts move, and not one name that was correctly read as done stopped being
  read as done (#158).

- The documented-command ratchet could not see an options **table**, so every option table in
  every doc was unchecked — `command-reference.md` gave a `--json` row to 19 commands that
  have had no `--json` since 3.0.0. It now reads table structure (row → cells → the code
  spans in the first cell) and asks the same question the invocation arm asks. Found and
  swept 38 phantom flags across three docs. A second hole surfaced with it: a fenced command
  written across a trailing `\` was scanned one line at a time, so flags on its continuation
  lines were invisible; 22 such commands are joined now (#156).
- **The last two done judgements are gone; `boards get --include stats,velocity` counts
  through the one judge.** Both counters in `lib/boards-api.ts` decided doneness from an
  **exact** `status === 'done' || status === 'completed'`, while every other reader in the
  tree asks `isDoneStage(detectStage(name))` (ADR-0005), so a closing column named `Klar`,
  `Färdig`, `Avslutad`, `Approved`, `Archived`, `Closed`, `Released`, `Shipped`, `Deployed`
  or `Done ✅` read as *open* to them and as *done* to `favro standup`. Both now route
  through the one judge. Measured over 49 column names: 25 move open → done, **none** moves
  done → open. `overdueCards` narrows correspondingly — the expression is past-due **and**
  not-done — and the old conjunct tested only `!== 'done'`, so a past-due card in a
  `Completed` column used to count as done *and* overdue at once. Given a card in `Klar`,
  past due, updated this week, the judge now answers done, not overdue, and +1 on this
  week's velocity.

  **No printed number changes yet, and this entry claims none.** `status` is not a wire
  field — Favro sends none, the column IS the status — and it is filled in by
  `CardsAPI.hydrateNames` from `columnId`. `getBoardWithIncludes` passes `board.cards`
  straight off the raw `/widgets/{id}` payload, unhydrated, so every card reaches these
  counters with `status: undefined` and both read exactly as they did before. Whether
  `/widgets?include=cards` returns that array at all is **unmeasured** (ADR-0003) — no
  live call was made for this entry. The fix is therefore a consistency fix whose widening
  is correct and **latent**: it prints only once something hands those counters cards with
  column names on them. `boards list --include stats,velocity` remains a separate and
  unfixed zero — `listBoardsByCollection` calls both helpers with no cards at all (#157).

  **Superseded, later in this same unreleased section.** The `include=cards` edge has since been
  measured, and it closed the other way: there is no `cards` array, so `boards get` was printing the
  same unconditional zeros this paragraph attributes only to `boards list`. Both are fixed — see the
  first entry under Fixed. The widening above is dormant, not latent: nothing calls those counters
  with cards at all.

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
  third state in `notes.team` and on stderr — the collection *name* joined it on the same
  terms in the entry below. `docs/repo-context.md` now documents the whole
  absent-vs-empty table, and its File Format block has been corrected — it described a
  different shape on every key.

  **Behaviour change worth knowing:** a key that cannot read every facet now gets exit 1
  and no file, where it used to get a partial one at exit 0. `favro init --refresh` is the
  retry.
- `favro init`'s fourth read — the collection's own name — wrote a plausible fallback with
  nothing saying so. When `GET /collections/:id` failed, `scope.collectionName` became the
  name stored in `~/.favro/config.json`, or the raw `collectionId` when there was none, at
  exit 0 with no marker: in a file whose only readers are later agents, a stale name is
  indistinguishable from the current one. It still falls back rather than refusing — the
  name is display text and `collectionId`, which everything keys off, is always real, so
  refusing would cost a limited key a whole file for a field nothing reads. But the
  fallback now announces itself in `notes.scope` and on stderr, naming **which** of the two
  it took. `notes` is a prose map that already carried `notes.team`, so the schema did not
  grow a state. `docs/repo-context.md`'s table gains a row for each provenance, and the
  "every value is a measurement" claim removed in review of #154 is restored — with the two
  fallbacks named, since both now announce themselves.

  **Fixed in review:** the marker named the wrong fallback for one input. The value was
  picked with `??` and the note's wording with truthiness, so a stored *empty* name kept
  `scope.collectionName: ""` under a note announcing "the raw `collectionId`" — the marker
  added to stop a fallback lying was itself lying about which fallback it was. Both now read
  the same predicate (`||`), which is also what the doc's table already said the id arm was
  for: an empty stored name is "there is none". The two provenance tests also asserted only
  that the note MENTIONS a provenance, so a note carrying both wordings passed — both
  polarities are pinned now.
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

- **`docs/repo-context.md` told agents to trust a guess.** It stated that every value in a
  `.favro/context.json` is a measurement with exactly two announced exceptions (`notes.team`,
  `notes.scope`), and rule 5 repeated the count — while three paragraphs above, the same file
  described `favro init` deriving `workflow[].stage` by Swedish/English keyword match, called
  `detectStage` a *guess*, and recorded that a column matching no keyword (and a column Favro
  sends with no name) still gets one. Rule 3 then told agents to key stage-aware operations off
  that array. `context.json` has zero code readers, so the doc **is** the interface and the
  false sentence was the defect. Walking the write surface rather than grepping for "stage"
  found two derived values, not one: `stage`, and `next`, whose `null` means "last column" and
  "the next column has no name" indistinguishably (`init.ts:250`). Both are now in the table of
  what a value means, rule 3 keys off `columnId` and points at the two human-confirmed ids from
  `favro tracker init`, and rule 5 names them instead of promising two exceptions.
  `docs/adr/0008-stage-is-display-only.md` settles how far the heuristic is trusted — display
  only — and argues down the alternative of announcing `stage` in `notes`: those keys mark a
  facet that fell back *on this run*, and a key that is always present marks nothing.
  `src/__tests__/commands/init.test.ts` gains one assertion holding the doc to it.

  **Review found the walk had stopped one slot short, and the slot it missed was losing data.**
  The `boards` KEY is derived too — `slugify` collapses every `[^a-z0-9]+` run and truncates to
  30 chars — and `boards[slug] = {…}` was a bare assignment, so two board names that slug alike
  left only the LATER board in the file. `Sprint 42` and `Sprint: 42` both key to `sprint-42`,
  and the first board was simply absent, with nothing saying so — the #154 defect one level up,
  in the same artefact. The first board to claim a slug now keeps the bare key and a later
  collider takes the next free numeric suffix, so a board that did not collide is never
  renumbered (`hasOwnProperty`, not `in`, or a board named `Constructor` collides with the
  prototype on a list of one). Three more, same walk: the *Workflow Stage Detection* keyword
  table did not match `detectStage` — it omitted the wait-word branch that runs FIRST and
  printed `klar`, `live`, `approv`, `godkän`, `accept`, `sign-off` for the patterns ADR-0005
  narrowed to `(?<!o)klar`, `\blive\b`, `approved`, `godkän[dt]`, `accept(?!ance)`,
  `signed.?off`, so the branches are now reproduced verbatim as code rather than paraphrased;
  the new prose called `stage` "the one value" that is neither measured nor announced three
  sections below the paragraph that had just called them two; and the premise both the doc and
  ADR-0008 leaned on — *a `notes` entry marks a facet that fell back on this run* — is false of
  `notes.cardIds` and `notes.moveCards`, which are always present, so it is now scoped to the
  conditional keys it was actually about. `ContextBoard.description` and
  `ContextCustomField.description` were declared and never written; deleted.

- `cards export` no longer draws its spinner over its own error message. `Spinner.start()` opens
  an `unref`'d `setInterval` that only `stop()` clears, and the board fetch sat between
  `start()` and `stop()` with no `finally` — so a fetch that threw skipped `stop()` and the
  frames kept drawing over the error the `catch` prints, until the process exited. `src/cli.ts`
  now stops it in a `finally`. It is the only `Spinner` call site in `src/`; `ProgressBar`
  renders synchronously and cannot leak (#97).

### Internal

- **The board-stats regression check stubbed `console.table` to a no-op, so half of the output
  it claimed to assert was thrown away.** Review of the `--include stats` fix above. Both
  tables — `boards get`'s velocity rows and `boards list`'s row per board — reach the reader
  only through `console.table`, and `--json` never runs the formatter at all, so no assertion
  anywhere read the `Open`, `Done`, `Velocity`, `Completed`, `Added` or `Net Change` cells.
  Measured: changing `boards-list.ts`'s renderer to spell `null` as `0` left **all 174 suites
  and 3650 tests passing** — the same defect the fix removed from the counters, reintroduced one
  layer further out in the renderer, and invisible. The spy now records the rows it is handed
  and two arms assert every cell, one per table; the same mutation now fails three tests.

  The renderer was also written twice, identically, in `boards-get.ts` and `boards-list.ts`,
  and only the `boards-get.ts` copy was read by a test — which is how one copy could drift
  alone. It is now one exported `shown` in `lib/boards-api.ts`, beside the `MeasuredCount` type
  it renders.

- Test suite: **63.9 s → 22.6–26.2 s**, and it no longer writes to the real stdout or stderr
  (#97, ADR-0007).

  `http-client.test.ts` alone was 51.2 s of the old wall clock, spent sleeping through real
  exponential backoff — `1+30+1+8+8+1+1+1` seconds across eight retry tests, none of which
  asserted elapsed time. It now uses fake timers and takes 1.2 s. The real sleeping was also
  hiding two things: `delay = delaySecs * 1000 → 0` and the non-429 backoff `→ 0` both
  *survived* the old suite and are killed now, so two tests advance the clock deliberately
  rather than flushing it.

  Direct `process.stdout.write` / `process.stderr.write` is not captured by Jest, so a run
  leaked 821 bytes of `Validating credentials…` onto stdout and 420 spinner frames onto stderr,
  the frames arriving as one unbroken line in front of an unrelated suite's `PASS`. A
  `setupFilesAfterEnv` file now silences the deliberate writes per suite (stdout **821 → 0
  bytes**); the frames were the leaked interval above, and fixing that at the source took them
  from a run-dependent 5–152 to a deterministic **0**.

  Shared fixtures already had a home — `src/test-support/`, build-excluded and recognised by
  four ratchets — so `config-dir.ts` joins it there rather than starting a second one under
  `src/__tests__/`, and `jest.config.js`'s `**/__tests__/**/*.ts` glob is left strict on purpose
  so it stays the only home. Its `tempConfigDir()` is the per-suite, synchronous, module-scope
  counterpart to the existing per-test `useTempConfigDir()`; nine suites now use it instead of
  hand-rolling mkdtemp + `config.json` + `FAVRO_CONFIG_DIR` + a teardown. In `src/__tests__`:
  `mkdtempSync` **55 → 46**, teardown lines **60 → 52**. Six suites still build one by hand for
  lifetime reasons named in ADR-0007; the `entities` wrappers (157) and server-lifecycle blocks
  (38) are untouched on purpose.

  On review: the silencer's teardown was unasserted — deleting the restore left all 172 suites
  green — so `silence-output.test.ts` now checks from a root `afterAll` that both writers are the
  pristine functions again, and the helper stops saving a `.bind()` copy that made that
  uncheckable. `cli.ts`'s `let cardList` under the new `try`/`finally` had become an implicit
  `any` and is annotated `Card[]` again. Two ADR-0007 claims were corrected against measurement:
  per-suite `PASS` header lines *are* lost under `--runInBand` (failure blocks and the summary are
  not, and CI's worker mode is unaffected), and `mkdtempSync` is **55 → 46**, not 45 → 36.

- CI builds, and the unit-test matrix covers the version development runs on (#159).

  `npm run build` had never run in CI, so nothing verified that the published artifact
  compiles — `prepack` was the first place a broken build would have surfaced, at publish
  time. It is now a step in the `TypeScript Check` job rather than a job of its own: `tsc`
  is that job's tool already, so it reuses the checkout and `npm ci`, and it adds no new
  check name for branch protection to pin.

  It is **not** redundant with `npm run typecheck`, and the reason is measured. The file
  sets are a strict subset relation — `tsc --listFilesOnly` gives **449** files for
  `tsconfig.json` and **635** for `tsconfig.test.json`, with no build-only file — so a
  plain type error in `src/` (a deliberate `TS2322` in `src/index.ts`) fails both, exit 2
  either way. But a superset of *files* is not a superset of *errors*: an ambient
  declaration in a build-excluded file widens types program-wide under the test config
  only. Probe — `declare global { interface String { zzProbe(): number } }` in
  `src/test-support/` plus a caller in `src/` — `npm run typecheck` **exit 0**, `npm run
  build` **exit 2** (`TS2339`). No such declaration exists in `src/` today; the step is
  the gate that keeps it that way. Declaration-emit diagnostics are *not* the difference:
  `declaration: true` is inherited by `tsconfig.test.json`, so a `TS4094` fails `--noEmit`
  too (measured).

  The node matrix was `[18.x, 20.x]`; development runs 22. It is now `[18.x, 20.x,
  22.x]`, with 18 and 20 kept because `engines.node` is `">=18.0.0"`. This adds a
  published check, `Unit Tests & Coverage (22.x)`, so the required-status list has to be
  re-pinned — a required check whose name matches no job never fires, and the new job is
  not required until it is named.

  Also measured while there, and deliberately left alone: CI's `npx jest --coverage
  --no-verbose` and the local `npm test` (`jest`) resolve the same `jest.config.js` and
  run the same suite — **172 suites / 3632 tests** both ways. No divergence to fix.

- The test run no longer leaks temp directories, and a run that starts to again fails.

  A green suite had been writing to the developer's `$TMPDIR` and never cleaning up:
  **40,071** entries at the time of the fix, **39,551** of them `favro-*` and **29,242**
  from `cards-link.test.ts` alone — that one called `mkdtempSync` in a `beforeEach` whose
  `afterEach` restored the env var and the console spies but removed nothing. Twelve call
  sites were leaking; all twelve are fixed, nine of them by moving to `tempConfigDir()`
  rather than by adding a bespoke teardown line.

  The check is a `globalSetup`/`globalTeardown` pair. Setup points `TMPDIR`/`TMP`/`TEMP`
  at a fresh private directory, so every `mkdtemp` the run makes — `os.tmpdir()` re-reads
  the env on every call, and workers inherit it at fork — lands somewhere we own; teardown
  then asks only whether that directory is **empty**. That predicate is the point. A
  prefix allowlist would rebuild the defect it is fixing, because it would only ever catch
  the spellings someone remembered to list: `mkdtemp` call sites in `src/` went **69 → 59**
  across **56 → 46** files, under no single naming scheme. Emptiness catches a suite
  written tomorrow under a prefix nobody has typed.

  `ts-jest` pulls in `v8-compile-cache-lib`, which parks a persistent cache at
  `os.tmpdir()`, so the redirect would have read it as a leak; it is switched off with the
  library's own `DISABLE_V8_COMPILE_CACHE`, which costs nothing when a fresh root makes
  the cache cold anyway. `src/test-support/config-dir.ts` moved to `node:fs`, and that is
  load-bearing rather than tidying: `shell-and-tui.test.ts` and `skill.test.ts` both
  `jest.mock('fs')`, and under the bare specifier the helper's `mkdtempSync` is auto-mocked
  to `undefined` (measured — both suites fail with `TypeError: The "path" argument must be
  of type string`).

  RED, measured, with one fix reverted: all **35** tests in `cards-link.test.ts` pass and
  the run still exits **1** with `tmpdir leak: 35 entries survived the test run`. It fires
  the same way under CI's `npx jest --coverage --no-verbose` (exit **1**) and under a
  single-file run, and against a prefix it was never told about.

  On review: nothing pinned the *wiring*. `globalTeardown` guards one way it can inspect
  nothing — it throws when `FAVRO_JEST_TMPROOT` is unset — but it runs after the last
  suite, so no test can observe its effect, and deleting its one line from
  `jest.config.js` deletes the ratchet in silence: measured, a leaking run then exits
  **0**. `tmpdir-leak-ratchet.test.ts` now asserts both keys are wired, that this worker's
  `os.tmpdir()` really is inside the private root, and that the predicate still fails on a
  leaked plain file and a nested directory as well as a leaked directory — the two cases a
  drift back toward "does the name match something we listed" would quietly stop catching.

  Left alone deliberately: three `mkdtemp` sites in `cards-export.test.ts` and
  `filter-fail-closed-coverage.test.ts` build from `process.cwd()`, not `os.tmpdir()`, so
  the redirect cannot see them — they have to be inside cwd because the `--out` guard
  rejects anything outside it, and all three do clean up. `jest.integration.config.js`
  gets no such check: its suites make real API calls, so whether a run leaves anything
  behind cannot be measured here, and ADR-0003 says not to declare a rule that has not
  been.

- **A column move reported success on the strength of its own argument, and `cards claim`
  / `cards resolve` printed a column nobody had observed.** `TxCards.moveColumn` held the
  `PUT /cards/{id} {columnId}` response as its result and never compared it against the
  column it had asked for; `claim` and `resolve` then returned `moved.columnId` — read
  straight off that response — as the column they had reached. Whether Favro echoes
  `columnId` on that PUT is **unmeasured** (ADR-0003), which makes both halves unsound in
  the same direction: on a silent response the write is unverified *and* the CLI prints
  `(column —)` for a card that did move.

  The write is now read back, and the read is a fresh `GET /cards/{cardId}` rather than
  the PUT response. That distinction is the fix rather than an implementation detail:
  `columnId` on a card's GET row is measured
  (`docs/research/tracker-contract-favro-carriers.md` §1.3), so the comparison asserts
  only a shape the wire has been observed to carry — where comparing the unprobed echo,
  the version this ticket's triage declined, would have thrown on every `claim` and every
  `resolve` if the response omits the field. A mismatch raises a `TransientError`
  ("answered 200 but the card did not land there"), the same class `setArchived`'s
  read-back raises: the call is not what is wrong, so the next attempt is allowed to
  behave differently. Nothing is logged for compensation on a mismatch — either the write
  did nothing, or a concurrent editor owns the column now and the facade-wide compare would
  decline to write over their edit — and `claim` / `resolve` report the re-read column.
  This is the second `TransientError` site in the codebase, which pays off ADR-0002's
  "revisit if a second site ever appears"; both sites are read-backs in `TxCards`.

  A confirmation read that FAILS is a different case from one that answers, and it keeps
  the compensation entry. Unlike `setArchived`, whose observation is the PUT's own echo,
  this one is a separate request that can throw on its own — a 4xx, an exhausted 5xx retry,
  a reset — while the write that already answered 200 stands. Only an observation that the
  card is elsewhere skips the entry; "we could not look" does not. Dropping it there
  reported `rolled-back` — the word this facade uses for the world being genuinely back
  where it was — for a card still sitting in the new column, and `claim` compounded it by
  undoing its assignment while leaving its move in place.

  RED, measured, against a `node:http` stand whose PUT answers 200 with **no `columnId`**
  while the card really moves. That arm is the one with teeth, and it is the arm a stand
  answering every PUT with a card row we wrote ourselves cannot express — a read-back
  tested against that verifies our own assumption against itself. With the re-read
  reverted to the echo, `resolve` and `claim` come back `rolled-back` instead of reporting
  the column; with the comparison reverted, all three failure arms come back `ok`.

### Known gaps at release

- The output migration is incomplete — see the caveat under Breaking #1.
- `boards get --include stats` and `boards list --include stats,velocity` report every
  card-derived facet as unknown rather than a number. That is the honest answer on the
  measured wire, not a regression: the endpoint carries no card data to count. Per-column
  counts are available today via `favro columns list <boardId>`.
- `tasks update`, `tasks complete` and `tasks delete` still take `--card` to resolve a
  board, and the taskId is never verified to belong to the card named. `GET /tasks/:taskId`
  is unmeasured and `GET /tasks` requires a `cardCommonId` to call, so no bounded read
  closes it (#126).
- `moveColumn` reports a failed move when a confirmation read lags behind the write it is
  confirming. The two are indistinguishable at the only input the code has, and closing it
  needs either a version carrier on the card or a measured read-after-write; neither
  exists. Recorded as an open edge on ADR-0002 rather than guessed at.
