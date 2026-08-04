# Changelog

This file starts at 3.0.0. Releases up to and including 2.4.1 have no entries — the
history is in `git log`.

Every claim below was measured against two built CLIs: `2.4.1` (built from the commit
that set that version, `a13a02a`) and this release. Commands were driven with
`FAVRO_CONFIG_DIR` pointed at a throwaway config and no real credentials, so exit codes
and streams are real and no request reached a live org.

## 3.0.0 — unreleased

Three breaking changes, all in how the CLI is *called* and how it *answers*. The library
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

### Added

- `--human` and `--pretty` on the root program, resolved in one place for every command.
- Honest print-caps on migrated list reads: `--limit` caps how many rows are *printed*
  after a complete fetch and sets `truncated` in the envelope, so filters always run
  over the whole board. `boards list --limit` is new in this release; `activity` was the
  template.
- A scope lock (`favro scope set <collectionId>`) that refuses writes outside the locked
  collection unless `--force` is passed.

### Fixed

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

### Known gaps at release

- The output migration is incomplete — see the caveat under Breaking #1.
