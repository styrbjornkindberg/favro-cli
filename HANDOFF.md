# Handoff — ready-for-agent burn-down

Paused at session limit. Main is green: typecheck clean, `check:cycles` clean,
**140 suites / 2502 tests**.

Goal in force: drive `ready-for-agent` to zero. Only issues carrying that label
are in remit.

---

## 1. RESOLVED — the --human regression is fixed and merged

(Kept for the record; #115 merged, main is green at 141 suites / 2514 tests.)

### The trap it leaves behind

`--json` is now a parse error on the eight persona commands. **Do not fix it by
declaring `--json` on the root.** That was tried and reverted: a root `--json`
swallows the leaf `--json` on every *unmigrated* command that still declares one
(`cards update --from-csv`, `cards link`, `cards unlink`, `cards list`) — 6 tests
red. It is the same bug in the other direction. A root `--json` is only safe once
no leaf declares one, i.e. after #119. Until then: per-command, or not at all.

The general rule, now measured twice: **a leaf can own a flag; it cannot shadow
an ancestor's.** `cli.ts` enables neither `positionalOptions` nor
`passThroughOptions`, so the root's `parseOptions` scans the whole argv and
swallows any flag it declared, wherever it appears.

### The original regression, for the record

**`--human` is dead on all eight persona commands** (`next`, `overview`,
`health`, `my-cards`, `workload`, `stale`, `my-standup`, `team`). They print
JSON whatever you pass.

Cause: #114 declared `--human` on the root program. Commander binds a flag to
the ancestor that declared it, so a leaf that *also* declares `--human` gets
`.opts()` back without it. The personas call `resolveFormat(options)` on their
own opts, get `undefined`, and fall through to JSON. Verified directly:

```js
root.option('--human'); const leaf = root.command('next'); leaf.option('--human');
// parse ['next','--human'] →
// leaf.opts()          = {"count":"5"}      ← no human
// root.opts()          = {"human":true}
// leaf.optsWithGlobals = {"count":"5","human":true}
```

#114's handoff asserted the opposite ("commander lets a leaf shadow an
ancestor's option") and that claim is false. It slipped through because #114's
byte-identity harness covered the twelve commands it migrated, not the eight it
broke in passing.

Fixed by #115 (`ab36b0d` + `a211127`), merged. Still open from its review:
`overview`'s human output advises `--json`, which errors; and the `userId not
configured` refusal reports `retryable: true` at three sites (throw
`RefusalError` rather than `Error` — `isRetryable` returns false for one).

---

## 2. Branches waiting to merge

Verify each with `npm run typecheck`, `npx jest`, `npm run check:cycles` **on the
merge result**, not on the branch. Seven branches in this run merged
conflict-free and then failed — a clean `merge-tree` means nothing here.

| Issue | Branch | State |
|---|---|---|
| #83 | `worktree-agent-a19ba83752db3fa9c` | 1 commit + 2 uncommitted files. **Review completed: MERGE WITH FIXES, two items — see below.** Base is 31 commits stale; reviewer merged current main in a scratch worktree, conflict-free, 141 suites / 2513 tests. |
| #84 | `worktree-agent-a6de9c5412acbb85d` | **2 commits — carries #83's commit as its parent.** Reported in full, not reviewed. Self-verified 142 suites / 2527 tests. Reviewing it reviews #83 too; `git diff 86dbeb7..HEAD` isolates #84. |

### #83's two review fixes, in full

The review verified the core fix on the **live** path and reproduced the bug on
current main (`applyFilter(cards,'tag:typoo')` → `[]`, no throw). Two fixes:

1. **The `ponytail:` comment at `src/cli.ts:1097-1102` states something false.**
   It claims settling filter values after the board fetch gives "the same
   refusal either way." It does not. With the board read throwing 403:
   - `cards export <board> --filter tag:typoo` → `✗ Error: Request failed with status code 403`
   - `cards list   <board> --filter tag:typoo` → `✗ Error: No tag matching "typoo" — ... The org's tags: bug`

   Same input, two diagnoses — exactly the sin sibling #82 names, *"a structured
   refusal naming the wrong problem entirely."* Not a fail-open (still exit 1,
   still no file), but a comment asserting parity the code lacks is worse than
   no comment. Also measured: `listCards` runs once on export, zero times on
   list — the CLI's most expensive read, spent before a refusal that needed no
   board data. One-line fix keeps the lazy shape:
   ```ts
   if (filters.length > 0) await applyFilters([], filters, { client, boardId: board });
   ```
   before `api.listCards(board)`. If that is judged not worth it, rewrite the
   comment to say the refusal differs when the board read itself fails.

2. **The only end-to-end regression test drives a dead twin.**
   `cards-export.test.ts:558` registers `registerCardsExportCommand`, which is
   genuinely dead — referenced only by its own file and tests, with a malformed
   registration string. The live command is inline at `cli.ts:1041`. Both do
   route through `applyFilters` and the reviewer confirmed the live path
   refuses correctly, but **no committed test drives it**: delete
   `cli.ts:1102`'s `applyFilters` call and the suite still goes green. Add one
   test at `buildProgram()` level asserting `cards export <board> --filter
   tag:typoo` exits 1 and writes nothing.

Two suggestions, not blocking: the ratchet matches text rather than calls (the
reviewer judged this appropriately blunt — keep it, but add a docblock line so
the next person who trips it does not loosen the regex), and `ParseErrorDetail`
has zero production readers anywhere, so the new `unsupported-here` kind joins
five others nothing consumes — pre-existing debt, worth its own issue.

## 3. Work that was in flight and is now dead

The agents are gone; the worktrees survive. Check each before restarting from
scratch.

### #82 finished and committed — needs review, then merge

`worktree-agent-afa54d8a0d15ff264`, `94e8d44` + `63cdfcc` (merge of main @
`906242b`). Self-verified **on the merge result**: typecheck clean, cycles
clean, **142 suites / 2570 tests**. Not independently reviewed.

**Nine entry points forwarded a raw board reference into `widgetCommonId`, not
the two the ticket names** — `listCards`, `getCard`, `createCard`, `updateCard`,
`moveCard`, `findCardBySequentialId`, `resolveCardId`, `resolveCardCommonId`,
and the bare-string `listCards(board)` shorthand. Fixing only the two named
would have left six siblings answering zero rows. One guard at the convergence:
`CardsAPI.boardIdOf` → `BoardsAPI.resolveBoardId`, resolving board **before**
column so the refusal stops naming the wrong problem.

Reused #122's existing refusal wording and `NameResolutionError`'s `ambiguous`
kind rather than inventing a second phrasing. Corrects one claim in this
handoff's earlier record: #122 *provided* criteria 3 and 4 but only met them for
`next` (which goes via `ContextAPI.resolveBoard`); every `CardsAPI` path was
still open, and criteria 1, 2 and 5 entirely so. #91 did not reduce the symptom
— the zero rows were never a page-1 skip.

Cost it names honestly: a board id absent from `GET /widgets` now refuses rather
than reads. Unavoidable if existence is validated at all — a bogus
`widgetCommonId` returns 200, not a classified not-found. Warm path costs no
network.

**Two things it reported rather than absorbed, both worth tickets:**

- **`assertScope` takes a raw board reference** — `GET /widgets/{boardId}` with
  whatever the caller hands it, at six sites (`cards-link.ts:223`,
  `batch.ts:321/465`, `batch-smart.ts:463`, `git.ts:430`, `cli.ts:851`). Under a
  configured lock a board *name* fails there before reaching the new seam. It
  fails **closed and loudly**, never zero rows, and it is pre-existing — but the
  convergent one-line fix belongs in `safety.ts`, which #120 was actively moving.
- **`columns list`, `custom-fields list --board`, `members list --board`** have
  the same 200-empty fail-open through their own API classes. Not card-shaped so
  outside #82's criteria, and their help text honestly says "Board ID".

### #99 finished and committed — needs review, then merge

`worktree-agent-a2309472d2c816a4b`, commits `28f6ad6` → `23cac6c` (merge of
main) → `cf0d5d0`. Clean tree. Self-verified **on the merge result**: typecheck
clean, cycles clean, **142 suites / 2552 tests**. Not independently reviewed —
that is the only thing standing between it and merge.

It enumerated 21 array-emitting sites with a TS-checker detector rather than by
name-guessing: 4 already compliant (3 of which had no `--limit`, so `truncated`
was structurally unreachable), 17 fixed, 1 left to #136, 4 decided out of remit
and recorded (write echoes own their shape via `reportDispatch`; `cards export`
is a serialisation format shared with `--out`, where an envelope would make the
file and the pipe disagree).

Two real bugs found in passing:

- **`activity` was silently cutting rows** — `--limit` was sliced client-side
  inside `getCardActivity` with nothing saying so. `limit` is now gone from
  `CardActivityOptions` entirely, #136's shape, so it cannot return a layer down.
- **Latent NaN bug in `capRows`**: `--limit banana` → `NaN < 1` is false →
  `slice(0, NaN)` → **zero rows, marked `truncated`**. Guard rewritten as
  `!(cap >= 1)`.

It also touched `src/lib/run.ts` — `RowsResult.limit` widened, and one
`noteTruncation` after `writeHuman` so a `human` formatter (which receives rows,
not the envelope, and so cannot see `truncated`) reports the cut. Additive, and
it gives #115's eight persona commands truncation-reporting for free.

Its ratchet `list-envelope-coverage.test.ts` fired unprompted when #136 merged —
the staleness arm caught the stale allowlist line.

**Worth filing, found but not fixed:** the eight persona commands' `--limit`
flags are *fetch* caps of exactly the #44/#91 class (`parseInt(options.limit,10)
|| 1000` fed into the read). The ratchet does not catch them because they emit
report objects rather than arrays. Same for `git todos` (`{total, items}`) and
`git branches` (`{branches, linkedBoard}`).

## 4. Blocked, and why

**[#105](https://github.com/styrbjornkindberg/favro-cli/issues/105) — provision a
scratch board — is labelled `wayfinder:task`, not `ready-for-agent`, so it is
outside remit. It blocks #106, which blocks #107→#111 and #123: seven
ready-for-agent tickets that cannot be finished.**

Unblocking needs a human: either relabel #105 (it creates a board in a live
Favro workspace — get explicit confirmation first), or provision the board and
supply the id. Chain A (#106–#111) measures write primitives against the real
wire; there is no way around a real board.

## 5. Decisions waiting on a human

- **`health` has never exited 1 on an unhealthy report**, but ADR-0002 and two
  tickets assert it does. Only `process.exit(1)` in `health.ts`,
  `release-check.ts` and `diff.ts` is the error boundary's. #115 declined to add
  it — correctly, that is a feature not a migration. **#117 inherits the same
  false premise.**
- **[#135](https://github.com/styrbjornkindberg/favro-cli/issues/135)** —
  `--dry-run` now requires credentials on every migrated write. Decide before
  #116 repeats it across the batch commands.
- **The label set is a moving target.** Started at 29 `ready-for-agent`, closed
  16, filed 12 more from review findings. Reviews keep finding real bugs. Worth
  deciding whether new findings get the label or are triaged separately.

## 6. What the process was, and why

One agent per ticket, each in its own worktree off main. Then, after the author
self-reviews:

1. an **independent** `code-reviewer` agent reads the branch diff cold;
2. blocking findings go back to the author via its still-live context;
3. only then merge, serially, full suite green before the next.

The review gate was added after the first three merges and earned itself
immediately. It caught, among others: a "latent bug fix" that had relocated the
bug rather than fixing it (#89); a scope-lock ratchet that would have silently
emptied itself across five migration steps (#114); the same ratchet's fix being
incomplete in exactly the direction the ticket encourages (#114); a dispatch arm
that printed nothing on success (#113); and a fix that traded one fail-open for
another (#120).

Non-negotiables that kept working: build the merge result, never trust a clean
merge; mutation-test every ratchet (break it, watch it go red, restore); a
refusal names the unresolvable token and lists candidates; unmeasured claims are
marked unmeasured rather than asserted.

## 7. Closed this session (16)

77, 78, 79, 85, 89, 91, 100, 113, 114, 120, 121, 122, 124, 136 — plus 77/78/79
which were already fixed in `32e6b93` and only needed verifying and closing.

Highlights worth knowing:

- **#91** found nine paginated reads that silently skipped page 1. `favro
  members list` on a 150-user org returned 1–50 and 101–150 and dropped 51–100,
  then filtered that partial set. A test had the off-by-one *encoded as an
  assertion*.
- **#120** found `isRetryable('rolled-back', new ScopeError(...)) === true` — a
  scope refusal telling an agent to retry a deterministic decline.
- **#89** found two `isOverdue` copies each broken on the shape the other
  handled; de-duplication is what surfaced it.

## 8. Filed this session (12)

127, 128, 129, 130, 131, 132, 133, 134, 135, 137, 138 — and #136, now closed.

Sharpest: **#138** (`batch move`/`batch assign` carry a third `--filter` grammar
that reads an unknown field as "match nothing" — on a *write* command),
**#133** (a scope refusal writes nothing to stdout under the new JSON default),
**#134** (the runner tells agents to retry a bad flag and a missing API key).

## 9. Housekeeping

A `node_modules` symlink reached a commit once — worktrees need one to run
tests, `.gitignore` had `node_modules/` with a trailing slash, and git sees a
symlink as a blob. Fixed in `dbbfe57`. **Stage explicit paths in a worktree; do
not `git add -A`.**
