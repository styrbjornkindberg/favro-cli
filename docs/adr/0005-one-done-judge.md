# ADR-0005: One judge of "done", one judge of "blocked", one cosmetic reader

Status: accepted (#98, owner's decision recorded on the ticket 2026-08-04)

## Context

#61 fixed the *edge* half of blocking: seven consumers that read `blockedBy` and asserted
"blocked" from the mere existence of a Favro `isBefore` edge. That part is closed.

What it did not touch is the **keyword** half — a predicate that reads a column name, a tag or a
status string and decides from the words in it whether work is finished or stuck. #98's title
counted eight of those. **Of those eight, six were still live at `8754500`** — two had been
resolved by other tickets before this one started. (An earlier draft of this ADR said five and
"three had already been resolved". That was wrong, and its own table below contradicted it:
`risks.ts`'s `isBlocked` was not resolved, it was *relocated* to `lib/card-predicates.ts` by #89
and is still live. Corrected in review; ADR-0003 applies to a count as much as to an API shape.)

| Predicate | Evidence | State at `8754500` |
|---|---|---|
| `judgeBlockers` (`lib/blocking.ts`) | tracker `done` columnId, then `archived` | live — **the real one** |
| `isBlocked` (`api/standup.ts`) | `BLOCKED_STATUSES` list vs column name | live |
| `isBlocked` (`lib/card-predicates.ts`) | a `blocked` tag **or** a status substring | live — was the `risks.ts` copy |
| `isBlocked` (`commands/batch-smart.ts`) | byte-identical copy of the above | **already gone** — #89 |
| `statusIcon` (`lib/board-renderer.ts`) | `'block'` / `'done'` substrings | live |
| `isCompleted` (`api/standup.ts`) | `COMPLETED_STATUSES` list | live |
| `detectStage` (`lib/workflow-stage.ts`) | a regex over column names | live — the existing home |
| `doneCol` (`api/propose.ts`) | a fourth `/done\|closed\|complete\|finished/i` | **already gone** — #124 deleted the whole module (ADR-0004) |

So the byte-identical `risks` / `batch-smart` pair that #98 asked to resolve **was resolved by
#89**, which moved the surviving copy to `lib/card-predicates.ts` and deleted the duplicate.
Nothing was left to delete there and nothing was invented to look busy.

The done-stage **set** was a separate five, and all five were live: `DONE_STAGES` in `team.ts`,
`stale.ts` and `health.ts`; the identical three strings under the name `COMPLETED_STAGES` in
`my-standup.ts`; and the same three inlined into a longer array in `main-menu.ts`.

`lib/workflow-stage.ts` exists *because* three copies of `detectStage` were consolidated into it
once already (#52). The question this ADR answers is therefore not "where should a new home go"
but "why was that job left half-finished", and the answer is that the *stage* was consolidated
while the *verdict about a stage* was not.

## Decision

**Three readers survive. Each has a different right to be believed, and that is the whole point.**

### 1. `judgeBlockers` (`lib/blocking.ts`) is the sole judge of "blocked"

It is the only predicate that reads evidence rather than words: the tracker board's mapped `done`
columnId, then `archived` off that board, and anything it could not read still blocks. It is
wrong in one direction only — over-blocking. Only `cards list --filter unblocked` pays for it.

### 2. `isDoneStage` (`lib/workflow-stage.ts`) is the sole judge of "is this *stage* finished"

Scope of that claim, stated precisely because review found it overstated: `isDoneStage` is the
only reader that turns a *workflow stage or column name* into a done verdict. It is **not** the
only place in the tree that decides a card is finished — see the `boards-api.ts` pair under "What
is not consolidated" below.

The five copies of the stage set and `isCompleted`'s `COMPLETED_STATUSES` list all route here.
`isCompleted` now reads `isDoneStage(detectStage(card.status))`, because `status` *is* the column
name after `hydrateNames`, and "what does this column name mean" is exactly what `detectStage`
answers.

This is a keyword guess and it stays labelled as one. What it is trusted with is unchanged from
#52: an init-time proposal, a display, and *summary* grouping — `standup`, `my-standup`, `team`,
`stale`, `health`. What it is not trusted with is unchanged too: `claim` / `resolve` read the two
stored `columnId`s and never consult it.

### 3. `statusIcon` (`lib/board-renderer.ts`) survives as presentation only

A substring match on `'block'` is fine for choosing a glyph and is not fine for deciding
anything. It is labelled cosmetic in the source, with an explicit instruction not to consolidate
it, because a future reader sweeping for duplicate keyword matches will otherwise find it and
"finish the job" — and a renderer taking a real verdict would have to pay for a per-blocker
sweep on every board draw.

`renderStatusBar` in the same file colours a status label by the same `'done'` / `'complete'` /
`'block'` substrings. It is cosmetic for the same reason and on the same terms — it picks a colour
for a bucket `buildStats` already keyed by raw status name, and decides nothing.

### What is *not* consolidated, and why

- **`isBlocked` in `api/standup.ts` and `lib/card-predicates.ts` are heuristics, not judges.**
  They answer "does a column name or tag contain the word", which is the only question a snapshot
  can answer without a per-blocker sweep. Both already carry comments pointing at
  `judgeBlockers` as the thing with actual evidence, and both are retained: deleting them would
  remove the `blocked` group from `standup`, `my-standup` and `risks` outright, which is a
  product change #98 did not ask for. They were **not** merged with each other either — they take
  different types (`ContextCard` vs `Card`) and read different fields (column name vs tag *or*
  status), so a merge would be a behaviour change dressed as a cleanup.
- **`api/query.ts`'s `/\b(done|finished|completed|closed)\b/i`** matches a word the *user typed
  in a query string*. It judges no card. Left alone.
- **`lib/boards-api.ts` held two more done judgements, and they were real ones.**
  `aggregateBoardStats` counted `doneCards` (and therefore `openCards`) and `calculateVelocity`
  counted `completed`, both from `status?.toLowerCase() === 'done' || === 'completed'`. Both are
  live: `favro boards get --include stats,velocity` reaches them. Neither #98's census of eight
  nor this ADR's first draft found them; review did. #98 **left them as they were** rather than
  routing them through `isDoneStage`, because they were exact-match and every other judge in this
  tree is not — a `Klar`, `Approved` or `Done ✅` column read as *open* to them — and rerouting
  them moves a printed count and a printed velocity. That is a behaviour change #98 did not ask
  for and did not measure. Its own ticket, not a line in that one.

  **Both were rerouted in #157, and this ADR's claim of one done judge only became true then.**
  See "Amendment (#157)" at the foot of this file. Until that commit, ADR-0005 said "one judge"
  while two more lived in `boards-api.ts`, which is the exact class of overstatement §2's scope
  paragraph was rewritten to avoid. It is recorded here rather than quietly corrected.

## Consequences

`isCompleted` changes behaviour in three measured ways, all of them consequences of having one
judge instead of two:

- **Wider.** `Approved` and `Archived` columns now group as `completed` in `standup`. Before,
  they matched no group and the card was dropped from the standup entirely. Swedish (`Klar`,
  `Färdig`, `Avslutad`) and `Shipped` / `Deployed` / `Live` count now as well.
- **Narrower, in one case.** A column named `Unresolved` used to read as completed, because the
  old list tested `status.includes('resolved')`. `detectStage` gained `(?<!un)resolv` — a
  lookbehind rather than a bare `resolv`, because this branch runs first and returns
  immediately, so a false `done` would become `proposeColumnMapping`'s pick for the board's done
  column and `init` would write that guess into `context.json`.
- **`Ready to Deploy` reads as done**, since `detectStage`'s done regex already contained
  `deploy`. That quirk is inherited, not introduced — it has always driven column-mapping
  proposals — and it is recorded here rather than quietly tuned, because tuning the regex to
  suit one consumer is how a shared judge becomes five again.
- **Three more inherited quirks now reach `standup`, measured over 48 column names in review.**
  `detectStage`'s `approved` branch matches `accept|verified|sign.?off|godkän`, so `Accepted`,
  `Verified`, `Sign-off` and `Godkänd` group as `completed` too — and so does **`Pending
  Approval`**, because `approv` is tested before `pending`. Its `live` term is unanchored, so
  **`Delivery`, `Deliverables` and `Delivered`** read as done off the `live` inside "de**live**ry".
  All of these already drove `team`'s `doneCount`, `stale`'s skip and `health`'s flow ratio before
  #98 — the branch changed which consumers see them, not what `detectStage` says. Recorded, not
  tuned, for the reason in the bullet above. `Unresolved` was the ONLY narrowing across those 48
  names.

### Amendment (#158): two of those three quirks were tuned, in the shared judge

The bullet above deferred the tuning rather than refusing it — "recorded, not tuned" bought an
argument on its own terms, and #158 is where it happened. What changed, in `detectStage` and
nowhere else, because a special case at one call site is what turns a shared judge back into five:

- **A wait branch runs first.** `/pending|awaiting|await|waiting|vänta/` returns `review`. It sits
  above `done`, not beside `approved`, because the names it exists for pair a wait word with a
  *finished* word — `Pending Approval` read `approved`, `Awaiting Deploy` read `done`.
- **`approv` narrowed to `approved`, `godkän` to `godkän[dt]`.** The short stems also matched
  `Approval` and `godkännande` — the name of the gate, not a decision — which the wait branch alone
  does not catch, since neither carries a wait word. Both now reach `review`, which gained
  `approval|godkännande`. `godkän[dt]` and not `godkänd`, because Swedish inflects the participle
  for gender: `Godkänd` and `Godkänt` are the same decision, and `godkänd` alone dropped `Godkänt`
  all the way to the `queued` default — the mirror of this ticket's bug, shrinking done counts.
- **`sign.?off` moved from `approved` to `review`, and `signed.?off` added to `approved`.** Same
  participle line one word over: `Sign-off` is a noun naming the gate, exactly like `Approval`. The
  old spelling had the pair backwards — `Sign-off` read `approved` (done) while `Signed Off` matched
  nothing and fell to `queued`.
- **`accept` narrowed to `accept(?!ance)`.** The third instance, and the only one landing in a
  branch below `approved`: `Acceptance` is the gate and `Acceptance Testing` is a testing column,
  and both read `approved` — done — because this branch runs before `testing`. `Accepted` and the
  Swedish `Accepterad` still match.
- **`live` anchored to `\blive\b`, with `delivered` spelled out beside it.** `Delivery`,
  `Deliverables` and `Livestream` no longer read `done` off the `live` inside "de**live**ry".
  `Delivered` is finished work and keeps saying so; anchoring alone would have demoted it.
- **`klar` guarded as `(?<!o)klar`.** `Oklar` is Swedish for *unclear* and read `done` off the `klar`
  inside it. It is the same negating-prefix shape as the `(?<!un)resolv` already in this branch, not
  an anticipation prefix, so it needed no new rule. `Klar`, `Klart`, `Klara`, `Klar för deploy` and
  compounds like `Produktionsklar` all still match.

**Kept, deliberately.** `Accepted`, `Accepterad`, `Verified`, `Signed off`, `Godkänd` and `Godkänt`
still read `approved` and therefore done: each is a past participle naming a decision that was made,
unlike `Approval`, `Acceptance` and `Sign-off`. `Ready to Deploy` and `To Deploy` still read
`done` — the bullet above is still true of them. They are the same mistake with no wait word in
them, and closing them needs a rule about anticipation prefixes, which is a larger claim than this
ticket argued. Two more are recorded rather than closed for the same reason: the space-separated
Swedish negations `Ej klar` and `Inte klar` (a lookbehind cannot reach across a word), and
`Acceptanstest`, which slips past `accept(?!ance)` on the Swedish compound spelling.

**Blast radius, traced rather than assumed.** `proposeColumnMapping` matches `stage === 'done'`
exactly, not `isDoneStage`, so the `Pending Approval` half never reached `favro init` at all —
`approved` was never a candidate for a board's done column. The `live` half did: `Delivery` used to
read `done`, and the pick is the *rightmost* such column, so on a board written
`Backlog | Done | Delivery` it beat a real `Done`. It no longer does. Where `Delivery` was the only
done-reading column, the pick does not move — nothing reads `done`, and the last-column fallback
lands on the same column. All three shapes are pinned in `done-judge.test.ts`.

**Measured, not asserted (ADR-0003).** Over 161 column names, before and after: 44 verdicts move.
41 of them are a gate, a negation or a "de**live**ry" false positive losing a `done` it should never
have had; 3 are `Signed Off` / `Signed-off` / `Signedoff` GAINING `approved`, which they had never
had. Not one name that was correctly read as done stopped being read as done. The 87-name set the
first pass used reported ten movers and was reproduced exactly — but it omitted `Godkänt`, which is
how a `godkänd` that dropped a real approval survived that measurement. The wider set is the reason
the count is 44 rather than 10; it is the same code measured over more names, not a wider change.

The five stage-set copies are gone. `done-judge.test.ts` ratchets the count at one definition in
the tree, the same way `detectStage`'s own ratchet has since #52. That ratchet greps for the three
stage names **co-occurring** in a non-test file, not for one literal spelling of the array: as
first written it grepped `'approved',\s*'archived'`, and a sixth copy in double quotes or with the
members reordered walked past it. Both bypasses were built and both went undetected. Fixed in
review.

**One of the five copies was never tested, and that was found by mutation rather than review.**
The done half of `main-menu.ts`'s queued filter — the copy inlined into a longer array — had no
arm that discriminated it: every existing case in `tui-blocking-labels.test.ts` feeds cards in
stage `queued`, so no card in a done stage ever reached the filter, and deleting the three
strings from it passed all 3334 tests. The gap predates this ADR; it was closed here because the
sibling-site mutation was run at all five call sites instead of the four that already had
coverage. The other four (`team`, `stale`, `health`, `my-standup`) each killed both an inverting
and a neutering mutation.

## Amendment (#157): the two `boards-api` counters, and what their numbers did

`aggregateBoardStats` and `calculateVelocity` now read `isDoneStage(detectStage(c.status))` —
the same composition `isCompleted` performs, not a stage judgement forced onto a status by a
cast. `detectStage` already accepts `string | null | undefined`, so nothing was widened to fit
and `workflow-stage.ts` was not touched.

**What `status` is, and where it comes from — the first draft of this amendment got this wrong.**
`status` is not a wire field. `cards-api.ts` says so at `normalizeCard`: *"`status` is deliberately
NOT read off the raw card: Favro sends no such field. It is the column name, filled in by the
caller from `columnId`."* CONTEXT.md says the same under "column-as-status". The filler is
`CardsAPI.hydrateNames`, which resolves `columnId` → column name through `ColumnDirectory`.
`isCompleted` therefore gets a real column name because its input arrived via `CardsAPI` →
`normalizeCard` (`api/context.ts`). **`getBoardWithIncludes` does not.** It passes `board.cards`
off the raw `/widgets/{id}` payload — no `normalizeCard`, no `hydrateNames` — so on the only live
path that supplies cards at all, `c.status` is `undefined`, `detectStage` falls through to
`queued`, and both counters answer exactly as they did before the reroute.

**So the reroute is correct and latent, not printed.** The 25 movers below are what the judge
answers *given a column name*; they are not a change any user can currently observe. And whether
`/widgets?include=cards` returns a `cards` array in the first place is **unmeasured** — the only
thing in this repo that says it does is a hand-written test stand in `boards-api.test.ts` that
invents both the array and a `status` field on its members. Per ADR-0003 that is a hint, not a
measurement, and this records the open edge rather than asserting either answer. The declared
`ExtendedBoard.cards` shape (`status?: string`) is the same hint in type form; the `(board as any)`
cast that read it has been removed, since a cast is how an unmeasured shape gets asserted.
Making the widening visible is a separate change — it needs hydrated cards, which means a column
lookup this class does not have — and it was not approved here.

> **The open edge closed on 2026-08-12, and it closed the other way. See
> "Amendment (2026-08-12)" at the foot of this file.** `/widgets/{id}?include=cards` returns *no
> `cards` key at all*, so there is no live path that supplies cards, the reroute is dormant rather
> than latent, and the zeros this section describes as unobservable were being printed as measured
> fact on every board. The paragraph above stands as written — it is what was known then — and the
> amendment supersedes its conclusion.

**Measured over 49 column names** (every name this ADR and #157 quote, plus this org's Swedish and
English column vocabulary). 25 move open → done. **Nothing moves done → open** — `Unresolved` was
the only narrowing in the `isCompleted` merge and it is not affected here, because the exact test
never called it done either.

| moves open → done | stage `detectStage` returns |
|---|---|
| `Klar`, `Färdig`, `Avslutad`, `Closed`, `Released`, `Shipped`, `Deployed`, `Live`, `Finished`, `Resolved`, `Complete`, `Done ✅`, `Ready to Deploy` | `done` |
| `Approved`, `Accepted`, `Verified`, `Sign-off`, `Godkänd`, **`Pending Approval`** | `approved` |
| `Archived`, `Arkiverad` | `archived` |
| **`Delivery`**, **`Deliverables`**, **`Delivered`**, **`Livestream`** | `done` |
| unchanged done: `Done`, `done`, `Completed`, `completed` | — |
| unchanged open: `Unresolved`, `Backlog`, `Inbox`, `To Do`, `Todo`, `Doing`, `In Progress`, `Pågår`, `In Review`, `Granskning`, `Testing`, `QA`, `Kvalitetssäkring`, `Selected`, `Vald`, `Ready`, `Next`, `Sprint`, `Blocked`, `On Hold` | — |

The five **bold** names are the inherited `detectStage` quirks this ADR already recorded — `approv`
tested before `pending`, and an unanchored `live` matching inside "de**live**ry". They now reach
`boards get --include stats` too. Not tuned here for the reason §"What is *not* consolidated" gives:
tuning a shared regex to suit one consumer is how one judge becomes five. #158 owns the term list.

**`overdueCards` goes down wherever a column name reaches it.** The expression is *past due*
**and** *not done*, so widening "done" narrows overdue by exactly the past-due cards sitting in any
of the 25 columns above. It also fixes an inconsistency inside the old pair: the overdue conjunct
tested `!== 'done'` and not `=== 'completed'`, so a past-due card in a `Completed` column counted as
done **and** overdue simultaneously. 27 of the 49 names are now excluded from overdue where they
were eligible before (29 read as done; only `Done` and `done` were excluded before).

**Not all 27 exclusions are right, and the wrong ones are the inherited quirks.** `Archived`,
`Arkiverad`, `Klar`, `Färdig`, `Avslutad`, `Closed`, `Released`, `Shipped`, `Deployed`, `Finished`,
`Complete`, `Resolved`, `Done ✅`, `Ready to Deploy` and the five real approval columns are correct
exclusions — finished work with a due date last year is not overdue, it is finished. **`Pending
Approval`, `Delivery`, `Deliverables` and `Livestream` are artefacts**: a card in any of them is
unfinished, and suppressing it from `overdueCards` hides work that is genuinely late. They are
wrong today and right after #158 anchors `live` and orders `pending` before `approv`. `Delivered`
is the one honest member of that group. Nothing here tunes the term list, for the reason
§"What is *not* consolidated" gives — tuning a shared regex to suit one consumer is how one judge
becomes five — and the artefacts are invisible on the live path anyway, since it supplies no
column names at all.

**`calculateVelocity` is a rate, but there is no series to distort.** Nothing caches, persists or
compares a velocity across runs — the only readers are the two formatters in
`commands/boards-get.ts` and `commands/boards-list.ts`. All four weeks are recomputed from
`updatedAt` on every invocation, so the widening applies to the whole printed series at once.

**Not fixed here, and still open.** `listBoardsByCollection` and `commands/boards-list.ts` call both
helpers with **no cards**, so `favro boards list --include stats,velocity` still reports
`doneCards: 0` and `completed: 0` unconditionally, on every board, regardless of this change. #157
raised it as possibly "the real defect"; it is a separate question about whether that path should
fetch cards at all, and it was not approved as part of this reroute.

> **It was the real defect, and it was wider than this paragraph says. Fixed — see
> "Amendment (2026-08-12)".** `boards get --include stats` reported the same unconditional zeros,
> because its cards array does not exist either.

The counters were mutation-tested at **both** sites, since a counter fed a fixture where every card
is done cannot tell a real judge from `() => true` — it reports the array length either way.
Sixteen mutations, fourteen killed, each typechecked before its result was recorded (deleting a
guard makes TS lose a narrowing and jest then reports a bogus mass failure, which is not a kill).

| mutation | failures |
|---|---|
| revert stats site to the old exact test | 19 |
| revert velocity site to the old exact test | 12 |
| revert overdue conjunct to `!== 'done'` | 2 |
| stats judge → `true` / → `false` | 28 / 28 |
| overdue judge neutered → `true` / → `false` | 4 / 4 |
| velocity judge → `true` / → `false` | 10 / 13 |
| delete overdue's `dueDate < now` conjunct | 1 |
| delete overdue's not-done conjunct | 4 |
| delete velocity's `>= weekStart` / `< weekEnd` conjunct | 1 / 2 |
| delete velocity's judge conjunct | 10 |
| delete `if (!c.dueDate) return false` (cast past `tsc`) | **survives** |
| delete `if (!c.updatedAt) return false` (cast past `tsc`) | **survives** |

**Two survivors, both semantically equivalent, recorded rather than tested around.** Neither guard
deletion fails `tsc` by luck — each fails it outright, because `new Date(string | undefined)`
matches no overload, so the type system is the real defence. Forced past that with a cast, no count
changes: `new Date(undefined)` is an Invalid Date, and `NaN` makes **every** relational comparison
false — `<`, `>`, `>=` and `<=` alike — so the overdue filter's `InvalidDate < now` and velocity's
`InvalidDate >= weekStart` both short-circuit to `false` exactly as the guards did. No comparison in
either expression reads `NaN` any other way, and neither uses `!==` or `isNaN`. No test can kill
these, which is the correct outcome for mutants that change nothing. The first draft of this
amendment reported only the `dueDate` one; the sibling site's identical mutant was not run.

## Amendment (2026-08-12): there are no cards, so the counters report unknown

The open edge the #157 amendment recorded has been measured. Probed against a throwaway board:

```
GET /widgets/{id}?include=cards
  keys: archived, collectionIds, color, columns, editRole, name,
        organizationId, ownerRole, type, widgetCommonId
  has cards array: false
```

There is no `cards` key — not an empty array, absent — and no `cardCount` either. `include=cards`
does nothing on that endpoint.

**What that makes of the #157 amendment.** Its central claim, that the reroute is "correct and
latent, not printed", rested on `getBoardWithIncludes` handing the counters unhydrated cards. It
hands them nothing. Every board path took `aggregateBoardStats`'s second branch — the one described
above as a fallback to board metadata — and that branch returned `doneCards: 0`, `overdueCards: 0`
and `openCards: board.cardCount ?? 0`. `calculateVelocity` was called with `undefined` and answered
four weeks of `completed: 0`. So `favro boards get <board> --include stats,velocity` reported **zero
done cards, zero overdue cards and a flat velocity series for every board that exists**, printed as
measured fact by `commands/boards-get.ts`, and `boards list --include stats,velocity` did the same
in table form. Absent data converted into a plausible answer: the fail-closed violation, and an
ADR-0003 violation, since the computation was justified by a wire shape nobody had looked at.

**The fix reports unknown rather than refusing.** `BoardStats` and `VelocityData` facets are
`number | null` (`MeasuredCount`), `null` means "nothing measured this", and both formatters render
it `unknown` — never `0`. The JSON shapes carry `null` for the same facets, so a `jq` consumer sees
the difference between "nothing is finished" and "the finished count cannot be read". Refusing
`--include stats` outright was the alternative; it was rejected because the flag has one honest
answer left — the facet list itself, and the command that *can* count — and a refusal would take
`boards get`'s whole board detail down with it on a composite read. ADR-0002 is satisfied by a note
that names the measurement and points at `favro columns list <boardId>`.

**One attach point, five call sites collapsed.** `withBoardIncludes` in `lib/boards-api.ts` is now
the only place any board receives `stats` or `velocity`. Three of the five previous sites passed no
cards at all, which is how one path could print `unknown` while another printed `0`.

**`added` was never measured either, in either branch.** It was the literal `0`, and
`netChange: completed` therefore asserted `added === 0`. Both are `null` now, always. Nothing this
CLI reads carries a card's creation date on a board-level path.

**The measured per-column source is not read, deliberately.** `GET /columns?widgetCommonId=` carries
`cardCount`, `timeSum` and `estimationSum` on every column — measured the same day, three columns,
`["Done","Doing","Todo"]` — and `cardCount` excludes archived cards. Summing it would turn
`totalCards` from unknown into a real figure, and `detectStage` over the measured column `name`
would do the same for `doneCards`. It is not done here because `boards list --include stats` would
then need one `/columns` request per board, and 322 boards is this repo's measured worst case. That
is a change with its own cost to measure. `estimationSum`/`timeSum` are **not** a velocity source:
nothing establishes that either means what `velocity` reports, and inferring it is the step ADR-0003
refuses.

The regression check is `src/__tests__/board-stats-wire.test.ts` — a real `node:http` server serving
the measured key set, asserting the **printed** output of both commands in both modes, across all
four attach paths. The fixture that let this ship was the opposite: a hand-written widget with a
three-card `cards` array, in `boards-api.test.ts`, which every counter test then agreed with. It is
gone.
