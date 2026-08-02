# Handoff — ready-for-agent burn-down

Paused at session limit. Main is green: typecheck clean, `check:cycles` clean,
**140 suites / 2502 tests**.

Goal in force: drive `ready-for-agent` to zero. Only issues carrying that label
are in remit.

---

## 1. READ THIS FIRST — a live regression on main

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

**The fix is written and waiting**: branch `worktree-agent-ae05dbec5d1f993d6`
(#115) deletes all eight leaf declarations and adds `persona-human-flag.test.ts`,
table-driven, one case per command. Its review was in flight when the session
ended — re-run it, then merge. Do not write a competing hotfix.

---

## 2. Branches waiting to merge

Verify each with `npm run typecheck`, `npx jest`, `npm run check:cycles` **on the
merge result**, not on the branch. Seven branches in this run merged
conflict-free and then failed — a clean `merge-tree` means nothing here.

| Issue | Branch | State |
|---|---|---|
| #115 | `worktree-agent-ae05dbec5d1f993d6` | 2 commits. Self-verified 141/2508. **Review was running; redo it.** Fixes the regression above. |
| #83 | `worktree-agent-a19ba83752db3fa9c` | 1 commit + 2 uncommitted files. **Review completed: MERGE WITH FIXES, two items — see below.** Base is 31 commits stale; reviewer merged current main in a scratch worktree, conflict-free, 141 suites / 2513 tests. |
| #84 | `worktree-agent-a6de9c5412acbb85d` | 1 commit. Never reported, never reviewed. Inspect before trusting. |

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

- **#99** (`worktree-agent-a2309472d2c816a4b`) — **29 uncommitted files, 0
  commits.** The largest body of unsaved work. Read it before you decide whether
  to salvage or redo.
- **#82** (`worktree-agent-afa54d8a0d15ff264`) — nothing committed, nothing
  dirty. Restart it.

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
