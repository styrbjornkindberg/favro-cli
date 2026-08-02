# Handoff

State as of main after the #141/#144/#145 batch merge. **151 suites / 2834 tests**,
typecheck clean, no cycles.

## 0. START HERE — one branch is finished and unreviewed

`worktree-agent-acc40fa3f1ec6585b`, commit `e0ea5b4` — **issue #117**, step 5 of the
runner migration (`release-check`, `risks`, `diff`). Self-verified at 150 suites /
2819 tests against main `52f3bed`, but **no independent review has run**. Every
branch this run has had a real defect found at review, so do not merge it on the
implementer's report. Review it first, then merge, then close #117.

What its review most needs to check:
- `diff` had #116's fail-open shape and now spreads `snapshot.unreachable`; verify the
  hole genuinely forbids exit 0 and that the human notice prints *above* the verdict,
  not as a footnote under "No changes detected".
- **The exit-code change is new behaviour, not a migration.** #117's premise is
  factually wrong — it cites lines that were the error boundary's exit, and none of
  these commands ever carried a finding code. The ticket's acceptance criterion still
  demands it, so it was implemented, but a CI job running `favro risks <board>` that
  passed yesterday now fails whenever anything is at risk, and `release-check` is
  noisy because `missing-due-date` counts toward `totalIssues`. Worth a human call.
- `health` was deliberately left without an exit code (its cut is a score, not a
  finding list), so the answer-code family is inconsistent until that is decided.
- `suggestBoard` was deleted as unreachable — verify that.

Always re-query counts rather than trusting a number written here — a stale tally
that reads as current has already caused one wrong report this run.

```bash
gh issue list --state open --limit 200 --json number | grep -c '"number"'
gh issue list --state open --label ready-for-agent --limit 200 --json number | grep -c '"number"'
```

## 1. How the work runs

One agent per ticket, always — including sequential chains, where each step gets a
fresh agent launched off updated main after the prior step merges. The point is
avoiding context rot, not saving agents.

Every branch gets an **independent review** before merge. This has found a real
defect on **every single branch** this run, several times where the implementer's
own summary was confidently wrong about what its code did. A sample of what would
otherwise have shipped:

- **#82** — the fix enumerated nine entry points and missed a tenth (`widgets add`),
  which printed `✓ Widget added to board` for a write that never landed. The same
  diff advertised board names on five flags whose first wire call was `checkScope`,
  which 404s on a name.
- **#84** — the ratchet built to stop substring matching was blind to the exact code
  the branch deleted: the regex spanned `[^\n]` and the removed filter was wrapped
  at the arrow. Proven by running the shipped regex against the pre-fix file.
- **#99** — `capRows` accepted a numeric *prefix*, so `--limit 1e9` returned **one
  row** marked `truncated`, inside the helper the ticket was named after.
- **#127** — the phantom-command ratchet had a proven bypass: two brand-new bogus
  commands appended under existing allowlist keys, suite stayed green.
- **#130** — the sibling `health` was left broken on a justification refuted by code
  four lines below the comment stating it.
- **#131** — the implementer's own first test passed with the guard deleted.

### Prompt rules that are load-bearing

Every agent prompt must carry all of these. Each exists because its absence cost
something measurable.

1. **The ponytail ruleset, verbatim.** Subagents do not inherit SessionStart hooks,
   so ponytail is absent unless pasted. Source:
   `~/.claude/plugins/cache/ponytail/ponytail/<version>/AGENTS.md`. Re-read it rather
   than reciting — the version moves. Where it collides with this repo: a ticket
   demanding a multi-arm ratchet **wins** (a ratchet is the deliverable, not
   scaffolding), and "deletion over addition" means delete what your change made
   dead, not hunt adjacent code.
2. **Stale-worktree warning.** Worktrees are NOT reliably created off current main.
   One arrived 48 commits behind; another had no `node_modules` symlink. State the
   current main SHA and require `git log --oneline -1 main` vs `HEAD` before reading
   any code.
3. **Fix, do not file.** Reviewers fix small findings on the branch and commit;
   implementers absorb small adjacent bugs in the same file or class. Escalate only
   for a product decision, a change broad enough to need its own verification, or a
   security issue wanting separate tracking. Subagents never open issues themselves.
   *This reversed a rule that grew the backlog faster than the work shrank it — see
   §5.*
4. **Build the merge result.** A clean `git merge-tree` proves nothing; seven
   branches this run merged conflict-free and then failed to compile or failed
   tests. All three gates run on the merge, not on the branch.
5. **Never `git add -A`.** The worktree tooling symlinks `node_modules` to the main
   checkout, git sees a symlink as a blob, and one got committed that way. Stage
   explicit paths only.
6. **Prove the test bites.** Revert the fix, confirm red, restore, report the output.

## 2. Environment traps

- **Ambient `node` is v10.24.1** and cannot run `npm` or `npx` at all. Use
  `~/.nvm/versions/node/v22.22.1/bin`.
- **`gh issue view` returns empty output** in agent contexts. `gh issue list` and
  `gh api repos/styrbjornkindberg/favro-cli/issues/N` both work.
- **`npm run typecheck`** is `tsc --noEmit -p tsconfig.test.json`. A bare
  `npx tsc --noEmit` excludes test files and will lie to you.
- **`npm run check:cycles`** is `madge --circular --extensions ts src`. The
  `--extensions ts` is load-bearing — without it madge processes 0 files and passes
  vacuously.

## 3. Repo doctrine

- **Fail-closed.** Absent or unresolvable data must refuse or be reported as
  unknown, never converted into a plausible answer. A refusal names the
  unresolvable token and lists candidates. `RefusalError` in `src/lib/refusal.ts`.
- **ADR-0002** — a successful command never prints nothing.
- **ADR-0003** — never declare an unmeasured API shape.
- **Ratchets** walk the *real* surface via the TypeScript checker, carry an
  allowlist of known-bad entries, and have a **staleness arm** (fails when an
  allowlisted item becomes compliant but stays listed) plus a **self-check arm**
  (proves the scan actually read files and enumerated a non-trivial number).
  Exemplars: `scope-lock-coverage.test.ts`, `list-envelope-coverage.test.ts`,
  `board-resolution-wire.test.ts`, `filter-fail-closed-coverage.test.ts`.
  A ratchet with no allowlist correctly has no staleness arm.
- **Wire tests over queued mocks.** A queued mock hands back the next canned
  response regardless of what the request asked for. That is how nine broken
  pagination loops stayed green for years, with one off-by-one *encoded as an
  assertion*. Prefer a real `node:http` server; exemplar
  `src/__tests__/pagination-wire.test.ts`.
- **Commander, measured twice.** A leaf **can own** a flag; it **cannot shadow** an
  ancestor's. `cli.ts` enables neither `_enablePositionalOptions` nor
  `_passThroughOptions`, so the root's `parseOptions` scans the whole argv and
  swallows any flag the root declared, wherever it appears
  (`commander/lib/command.js:1732-1745`). This killed `--human` on eight commands
  for several merges. Corollary on record: a root `--json` is only safe once no leaf
  declares one — i.e. after #119. **Verify flag behaviour by experiment, never by
  reasoning about commander.**
- Pagination: the single helper is `getAllPages(client, url, params, {max})` in
  `src/lib/paginate.ts`. The options object is the **fourth** argument and is not a
  normalizer.
- `configDir()` in `src/lib/config.ts` resolves **per call** since #65. Comments in
  three test files claiming it freezes at import are false; the practice of setting
  `FAVRO_CONFIG_DIR` early is still right, but for a different reason.

## 4. Closed this session

#82, #83, #84, #99, #116, #127, #129, #130, #131, #139, #141, #144, #145, #146 —
fourteen, each merged with all three gates verified on the merge result and closed
with a comment recording what review caught.

Two worth remembering:

- **#127's ratchet went red within minutes of merging**, because main already carried
  #116 which had deleted `--format`, and `API-REFERENCE.md` still taught it. Two
  branches, both green in isolation, drift caught on contact. That is the whole case
  for ratchets in one event.
- **#146's ticket had the wrong threat model and I wrote it.** Card titles do *not*
  reach `commitWithMessage` — `slugify` strips the dangerous characters first. The
  real vectors were `branchPattern` and `cardPrefix`, read from `.favro.json`, a file
  **checked into the repo**: clone, run `favro git branch`, RCE. Stronger than what
  the ticket claimed. Corrected on the issue.

## 5. The backlog-growth correction

Mid-session count: 5 closed, 8 filed. Net +3. The cause was the orchestrator's, not
the agents' — every prompt carried `Scope discipline: real bugs outside X get
REPORTED, not fixed`, and both implementers and reviewers obeyed exactly.

Reversed as rule 3 above. Three of the eight filed should have been absorbed
(#141 unicode, #144 `.gitignore` clobber, #145 stale/health boundary) and are now
batched to a single agent rather than sitting as tickets.

Keep watching this ratio. Filing is the correct outcome for a genuine product
decision — #140 (`ParseErrorDetail` needs a reader or a deletion) and #142 (should a
malformed `--limit` refuse?) are right to be tickets. It is the wrong outcome for a
two-line fix.

## 6. Open decisions needing a human

- **#140** — `ParseErrorDetail` has six `kind` discriminants and zero production
  readers. Delete them, or give them a reader (a JSON refusal body an agent can
  branch on)? Interacts with #133; both should agree on one shape. Labelled
  `needs-triage` deliberately.
- **#142** — should a malformed `--limit` refuse rather than silently mean no cap?
  Behaviour change across 21 commands.
- **`RefusalError` divergence.** #116 throws `RefusalError` for a bad flag, so
  `retryable: false`; #115's commands throw bare `Error`, so `retryable: true`. An
  agent consuming this CLI would retry a malformed `--budget` forever on one command
  and not the other. May be the same bug as open ticket #134.
- **#145's boundary** — `stale` uses `>= 14`, `health` uses `> 14`. Whichever wins
  changes reported results at the most common threshold.

## 7. Known un-absorbed work

- `src/lib/cards-api.ts` is 1122 lines and `src/cli.ts` is ~1215, both over the 800
  ceiling.
- Three separate `buildProgram()` walkers exist (`verbose-coverage.test.ts`,
  `help-topic-drift.test.ts`, `documented-commands-coverage.test.ts`) with no shared
  helper in `src/test-support/`. Third strike; `command-surface.ts` is the DRY move.
- `assertScope` takes a raw board reference at sites beyond the five #82 fixed.
- `columns list`, `custom-fields list --board` and `members list --board` share a
  200-empty fail-open.
- 18 fetch-cap `parseInt(options.limit, 10)` sites (#143).
