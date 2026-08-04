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
- `--dry-run` no longer demands credentials for a preview that never touches the wire.
  Eight of the twelve migrated write commands now preview credential-free; the four whose
  preview *is* a wire-derived scope verdict (`comments add/update/delete`,
  `members add --board-target`) still require them, deliberately — a credential-free
  preview there would print a plan the lock was never asked about (#135).

### Known gaps at release

- `boards update/delete` and `collections update/delete` return from their `--dry-run`
  preview *before* checking the scope lock, so a target outside the lock previews
  cheerfully while the real run refuses (#152).
- The output migration is incomplete — see the caveat under Breaking #1.
