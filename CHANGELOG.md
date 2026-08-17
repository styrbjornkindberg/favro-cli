# Changelog

This file starts at 3.0.0. Releases up to and including 2.4.1 have no entries — the
history is in `git log`.

Every claim below was measured against two built CLIs: `2.4.1` (built from the commit
that set that version, `a13a02a`) and this release. Commands were driven with
`FAVRO_CONFIG_DIR` pointed at a throwaway config and no real credentials, so exit codes
and streams are real and no request reached a live org.

## 5.1.0 — unreleased

### Added

#### `FAVRO_SCOPE_COLLECTION_ID` — a scope lock that belongs to one shell (#174)

The scope lock was process-global state stored in one file. `scopeCollectionId` lived only
in `~/.favro/config.json` and every reader loaded it fresh per invocation, so **two
concurrent CLI sessions could not hold different locks** — two terminals, or two agents
driving the CLI in parallel, shared one, and `favro scope set X` in window A silently
retargeted window B's next write. The only isolation that existed was `FAVRO_CONFIG_DIR`,
which forks the *entire* config including credentials: the wrong granularity for one string.

Exporting `FAVRO_SCOPE_COLLECTION_ID` now overrides the file lock for that shell and every
child process. An env var **is** session state — per-shell, inherited, dies with the window
— so there is no session id, lockfile, registry, TTL or stale-session GC, and the lock
finally joins the priority order every other config field already used (flag > `FAVRO_*`
env > file).

Measured on `dist/cli.js` against a local stand, `FAVRO_CONFIG_DIR` pointed at a throwaway
config whose file lock is `coll-file`, both shells and both polarities:

| exported | `boards delete brd-a --dry-run` | `brd-b` | `brd-file` |
|---|---|---|---|
| `coll-a` | previews, exit 0 | refuses, exit 1 | refuses, exit 1 |
| `coll-b` | refuses, exit 1 | previews, exit 0 | refuses, exit 1 |
| *(unset)* | refuses, exit 1 | refuses, exit 1 | previews, exit 0 |

The third row is the unchanged-behaviour arm and the third column is the one that shows the
two locks do **not** union. `--force` still overrides (`⚠ Warning: Board brd-b is outside
your locked scope (coll-a)` then the preview, exit 0), and an unresolvable board is still
*uncheckable, not exempt* — `brd-ghost --dry-run --force` exits 1 with `Scope check failed:
Board brd-ghost not found.` Where the lock comes from changed; nothing about how it is
enforced did.

**Empty or whitespace-only is an error, not "no lock".** `FAVRO_SCOPE_COLLECTION_ID= favro
boards delete brd-file --dry-run` exits 1 with `FAVRO_SCOPE_COLLECTION_ID is set but empty.
Unset it or provide a collectionId.` — measured, and note that `brd-file` is inside the FILE
lock, so a fall-through would have previewed there. Falling back would make a typo silently
name another collection; resolving to "no lock" would silently unlock every board in the
organization. It mirrors the existing empty-`FAVRO_API_KEY` throw, and for the same reason
is a bare `Error` rather than a refusal: `--dry-run`'s credential deferral only swallows
refusals, so a malformed environment cannot become a silent preview.

**The session lock never reaches disk**, which is the half that would have turned this fix
back into the bug. `readConfig()` feeds `writeConfig()` at six call sites, every one
spreading a readConfig-derived object — `resolveUserId`, `tracker-init`, `scope set`, `scope
clear`, `auth login`, `auth logout` — and `resolveUserId`'s auto-resolve fires with no flag
and no prompt on `next`, `my-cards`, `my-standup` and every `@me`. One guard in `writeConfig`
preserves the file's own `scopeCollectionId` / `scopeCollectionName` whenever the variable is
set, rather than six guards at the callers. Measured on the built CLI with `coll-a` exported:
`auth logout` removed the `apiKey` and left `"scopeCollectionId":"coll-file"` and
`"scopeCollectionName":"File Lock"` byte-identical on disk.

The merge sits in `readConfig`, **not** `loadConfig`. `loadConfig` is the function that looks
like the merge point and it is dead outside tests — every real reader, including all 26
guarded command registrations, calls `readConfig` directly, so an override merged in
`loadConfig` would be one no scope guard ever saw.

### Changed

#### `scope show` names the source of the lock; `scope set` / `scope clear` refuse under an override (#174)

`scope show` prints a second line — `Source: FAVRO_SCOPE_COLLECTION_ID — this shell only, and
it overrides the config file.` or `Source: config file — shared by every shell on this
machine.` — and the JSON surface gains a `source` field (`"env"` / `"file"`). Without it the
file and the environment disagree and no output explains why.

`scope set` and `scope clear` manage the FILE lock, and under an active override nothing in
that shell will ever read it. Both now exit 1 naming the variable and the effective lock,
with the file untouched, instead of writing and reporting success — measured on the built
CLI, `scope set coll-b` under `FAVRO_SCOPE_COLLECTION_ID=coll-a` left the config file
byte-identical. `scope set`'s refusal comes before its verifying `GET /collections/{id}`, so
it costs no request either.

Two consequences, stated rather than discovered later.

**Exporting the variable IS a configured lock for the credential gate #135 measured.** All
seven commands whose guard resolves its target over the wire want a credential for
`--dry-run` while it is exported, exactly as they do under a file lock — measured on the
built CLI against an EMPTY config (`{}`), so the only lock present is the one exported:

| invocation, each with `--dry-run` | var unset | `FAVRO_SCOPE_COLLECTION_ID=coll-a` |
|---|---|---|
| `boards update brd-a --name X` | previews, exit 0 | `API key not found`, exit 1 |
| `boards delete brd-a` | previews, exit 0 | `API key not found`, exit 1 |
| `dependencies delete crd-1 crd-2` | previews, exit 0 | `API key not found`, exit 1 |
| `dependencies delete-all crd-1` | previews, exit 0 | `API key not found`, exit 1 |
| `custom-fields set crd-1 f1 v` | previews, exit 0 | `API key not found`, exit 1 |
| `git todos --board brd-a` | report, exit 0 | report, then exit 1 |
| `git sync` | report, exit 0 | report, then exit 1 |

The two `git` rows still print their local report before refusing, unchanged: that output
describes the repo, not the write. With nothing locked either way the credential-free
preview is unchanged, which is the whole left-hand column.

**The lock is also the default READ scope for ten commands, so the override retargets those
reads too.** `health`, `next`, `my-cards`, `my-standup`, `overview`, `team`, `stale`,
`workload`, the interactive menu and `init`'s default collection all fall back to
`config.scopeCollectionId` when no `--collection` is given. That is the same field, so it
follows the same override — intended, and consistent with "the effective lock", but it is a
read retargeting and not only a write guard. Measured on the built CLI against a
request-logging stand, config lock `coll-file`: `favro health` issued `GET
/collections/coll-file` with the variable unset and `GET /collections/coll-env` with
`FAVRO_SCOPE_COLLECTION_ID=coll-env` exported.

### Fixed

#### A scope refusal under the override told you to run a command that refuses (#175)

Every scope-lock refusal ended with `Run 'favro scope set <collectionId>' to change it, or
pass --force to override.` — advice that fails under `FAVRO_SCOPE_COLLECTION_ID`, because
`scope set` refuses while the override is live (above, by design). The guardrail message
every write can produce spent the user a second refusal to self-correct from.

The remediation line now names the lock's SOURCE. Measured on `dist/cli.js` against a local
stand, config lock `File Lock` (`coll-file`), both polarities of the same command:

```
$ FAVRO_SCOPE_COLLECTION_ID=coll-b favro boards delete brd-a --dry-run --human
✗ Scope violation: board "Board brd-a" is not in locked collection "coll-b".
  Run 'favro scope show' to see your current lock.
  To retarget this shell: export FAVRO_SCOPE_COLLECTION_ID=<collectionId>, or pass --force to override.

$ favro boards delete brd-a --dry-run --human        # variable unset
✗ Scope violation: board "Board brd-a" is not in locked collection "File Lock".
  Run 'favro scope show' to see your current lock.
  Run 'favro scope set <collectionId>' to change it, or pass --force to override.
```

Following the new line verbatim works: `export FAVRO_SCOPE_COLLECTION_ID=coll-a` then the
same command previews at exit 0. The file arm is byte-identical to what shipped.

All three guards that carry a remediation line move together — the board guard
(`assertScope`), the collection guard (`checkCollectionScope`, measured: `collections delete
coll-other` refuses with the same two wordings), and the org-wide guard (`assertOrgScope`),
whose advice was `Run 'favro scope clear' to unlock` — `scope clear` refuses under an
override for exactly the same reason `scope set` does.

The org-wide arm names TWO steps, and the second one is not padding. Unsetting the variable
only drops the SESSION lock; the config file's lock then applies and refuses the same write
again. Measured on `dist/cli.js`, config lock `File Lock` (`coll-file`):

```
$ FAVRO_SCOPE_COLLECTION_ID=coll-env favro tags delete tag-1 --dry-run --human -y
✗ Scope violation: Deleting tag tag-1 is an ORGANIZATION-WIDE write — it reaches every board in the
  organization, including every board outside your locked collection ("coll-env").
  …
  To unlock this shell: unset FAVRO_SCOPE_COLLECTION_ID — then 'favro scope clear' if the
  config file still locks you. Or pass --force to allow this single write.

$ favro tags delete tag-1 --dry-run --human -y       # step 1 done, file lock surfaces
✗ Scope violation: Deleting tag tag-1 is an ORGANIZATION-WIDE write …
  … outside your locked collection ("File Lock").
```

An earlier draft of this fix said only `unset FAVRO_SCOPE_COLLECTION_ID`, which is the whole
answer for `scope clear`'s own refusal and NOT for this one — the same defect this entry
closes, in the pair nobody had checked. `safety.test.ts` now walks both steps and asserts
that step 1 alone still refuses, so the second step cannot be dropped again unnoticed.

The env wordings are `commands/scope.ts`'s own, not a second phrasing of the same
instruction: both refusals now read one exported string each, and `config.ts` stays the only
module that asks where the lock came from.

### Not fixed, deliberately

`writeConfig` is still a read-modify-write with no lock, so two near-simultaneous writers
still clobber each other's `userId`, `apiKey`, `organizationId` and `tracker`. The env path
sidesteps that race for the *scope* field because it writes nothing at all; the general race
is a separate ticket. And the env-supplied collection id is **not** verified against the
wire the way `scope set` verifies it — a bad id fails closed, since every board mismatches
and every write refuses, which is the safe direction.

## 5.0.1 — 2026-08-14

### Docs

#### The shipped skill now defines the vocabulary the contract gives instructions in (#173)

`favro help issue-tracker` — the topic `SKILL.md` and bare `--help` both send an agent to
before its first write — says *"delete removes ONE board instance; other instances of the
same `cardCommonId` survive."* Measured against the built `5.0.0` CLI, **nothing an
installed agent can reach defines either term.** There is one help topic; it uses
`cardCommonId` at line 39 and `board instance` at lines 38 and 280, and defines neither.
`CONTEXT.md` does define them, but `package.json`'s `files` is `["dist","skills",…]`, so it
does not ship. A write-safety instruction written in undefined vocabulary is worse than a
missing one.

The skill carries the model now: the containment chain (organization → collection → board →
column → card), **card as one work item existing once per board it sits on**, the three card
identifiers and the fact that `cardId` and `cardCommonId` share one 24-char-hex syntax so
nothing can tell them apart by looking, board-as-widget on the wire, the **fork** Favro
creates on assignment, column-as-status (there is no `state` field), collection as what the
scope lock locks, tags written by name, and the one-edge-per-pair blocking relationship
together with the unordered one that does not exist.

**Deliberately not the command surface.** That is what #160 deleted 920 lines of, and its
measurement was drift: 820 of those lines predated the map that replaced the surface they
described, while `--help` stayed generated from the code. The model is the part of that file
that did **not** drift — a card has existed once per board since before this CLI. The split
is the one #8 was reaching for: the surface changes every release and belongs to `--help`;
the model does not change and belongs where an agent reads it first.

Ported from `CONTEXT.md`'s entities section, stripped of `src/` paths, ticket references, and
the `resolveBoardId` open edge, which is about resolution behaviour rather than the model.
No code changed; no help topic changed.

## 5.0.0 — 2026-08-14

**Section hygiene, fixed in the release cut.** `v4.0.0` was tagged at 05:37 on the same
day (`a649bd8`), and this release's notes kept landing in its section for every commit
after it — the same defect `4.0.0`'s own opening paragraph records happening to `3.1.0`.
Cutting this release moved five top-level entries back out of it: #165 from its
`Breaking`, #160 from its `Removed`, and three from its `Fixed` (#162 twice, #169). Each
is in the matching section here, unedited. Cutting it also found the opposite failure:
**#167's post-tag fixes had no entry in either section**, so the largest behaviour change
in this release — every aggregate count changing what it counts — was undocumented. It is
written up below for the first time, from the commits' own measurements. The `4.0.0`
section now describes only what the `v4.0.0` tarball shipped, which is the only thing a
released section is for.

### Breaking

#### `next` and `sprint-plan` now score one priority vocabulary, and `urgent` is in it

The two commands carried a copy each of the priority reader, and they disagreed in
**three measured ways**. One home now — `readPriority` in `api/context.ts`, beside
`extractEffort`, which went there under #89 for the same reason.

The defect that forced it: **`next` scored a card whose `Priority` field literally read
`urgent` as ZERO**, because its band list was `critical|blocker` / `high` /
`medium|normal` / `low` and `urgent` matches none of them. `scoreCard` then pushed no
priority reason either, so the most urgent card on a board came back
`reasons: ["available in queue"]` — indistinguishable from a card nobody had
prioritised. `sprint-plan`'s copy scored the same value 4. Same fabricated-zero species
as the rest of #169, one vocabulary over.

What changes in output:

| | before | after |
|---|---|---|
| `next`, `Priority: urgent` | score 0, no priority reason | score **16**, `priority: urgent` |
| `next`, `Priority: normal` | score 8 (matched `normal`) | score 8 — unchanged |
| `next`, `Priority: P1` | `unset`, silent | `p1`, reported as outside the vocabulary |
| `sprint-plan`, `Priority: blocker` | score **0** — no `blocker` key, and no band name is a substring of it | score **4** |
| `sprint-plan`, `Priority: High` | displayed `High` | displayed `high` |
| `sprint-plan`, no priority field | `priority` absent from JSON, cell rendered `—` | `priority: "unset"`, cell reads `unset` |
| `sprint-plan`, `Priority Level: medium` | not read at all | scored 2 |

`blocker` is the second fabricated zero the merge removes and it is worth naming
separately: it did not merely rank low, it ranked **with the unset cards**, on the command
whose entire product is that ranking.

The scored vocabulary is `critical/blocker, urgent > high > medium/normal > low`, quoted
into both `--help` texts and `sprint-plan`'s warning from one constant, so the three
copies cannot drift from EACH OTHER. They could still drift from the code — the constant
is hand-written prose — so a test splits it, asserts every token scores through
`readPriority`, and pins `PRIORITY_BANDS.length`; a sixth band or a renamed one reddens
instead of leaving all three copies lying. Both `--help` texts also now name the field
names each term matches, which neither did.

**A value that is set but outside the vocabulary is no longer reported as `unset`.**
That was false in both copies — `unset` means "no priority field", and a card holding
`P1` has one. It is reported as itself, ranked nowhere, and both commands say so:
`next` in `reasons`, `sprint-plan` in a line naming the values it could not rank. That
line is separate from the `unavailable` one on purpose — `P1` DID match a field name,
so one sentence for the two would be false about whichever it was not written for.

The third difference was the key match: `sprint-plan` looked up six literal spellings
(`priority`, `Priority`, `urgency`, `Urgency`, `severity`, `Severity`) and `next` used
`/priority|urgency|severity/i` over every key. The regex wins, so a field named
`Priority Level` is now read on the sprint path too.

#### An impossible due date is refused instead of stored two days late (#168)

`PUT {dueDate: "2026-02-30"}` answers **200 with no message** and stores
`2026-03-02T00:00:00.000Z` — measured live on the #105 board, echo and follow-up GET
agreeing. The CLI does no date parsing on this path, so the rollover is Favro's; the
digits went out exactly as given. A caller setting an invalid date got a card dated two
days past anything they typed, at exit 0.

`setDueDate` now declines it before the request. It is a **`RefusalError`**, and that is
the load-bearing part: the read-back below already caught the rollover (`dueDay` compares
the digits) but caught it as a `TransientError`, i.e. `retryable: true` — and
`favro help issue-tracker` tells an agent to obey that field, so an impossible date was
retried forever. Same call, same failure, every time: that is a refusal.

The guard is the rollover only, and it reuses the detector `isOverdue` already had
(`localMidnight`'s round-trip). `2026-02-28`, `2026-03-31` and `2024-02-29` all still
write; `2026-02-29` does not, because 2026 is not a leap year. An out-of-range **month**
never needed us: `2026-13-01` and `not-a-date` both answer `202 {"message":"Invalid
date"}` and write nothing, which #165's rule already refuses.

#### A column move un-archives the card, and the CLI now says so (#168)

Measured, and it answers the question the ticket left open: the un-archive is the
**column write**, not the read-back that follows it. Archive a card (`PUT {archive:true}`
→ 200, `archived:true`, confirmed by a GET), then `PUT {columnId, widgetCommonId}` → 200,
no message, and the write's **own echo** already reads `archived:false`. So it is Favro's
side effect, and `moveColumn`'s `columnId` comparison passes straight through it because
the move itself landed. `cards update --status`, `claim` and `resolve` all put an archived
card back on the board.

Reported, not fought: refusing the move would break `claim` and `resolve` on an archived
card, and it is not a failure — the requested change happened. `moveColumn` compares the
card's `archived` before and after and names it.

**Known edge, recorded rather than closed:** the warning is on **stderr** and in
`favro help issue-tracker`, NOT in the JSON envelope — `DispatchResult` has no warnings
channel and adding one means plumbing it through `reportDispatch`, the human render and
the MCP shape. The upgrade is that channel, or a compensation entry so a later failure
re-archives; `PUT {archive:true}` after a move was measured to stick, so the inverse is
known to work.

The first probe run measured nothing about archiving and is recorded anyway: `PUT
{columnId}` **alone** answers `202 "Access denied"` on an archived card — and equally on
an unarchived one, which is this repo's existing #162 finding (Favro resolves the column
against `widgetCommonId`), not a new one.

#### The clean-200 refusals are documented and re-measured, and a wire-level arm added (#170)

`favro help issue-tracker` gains a section naming the population and, more usefully,
**which write paths verify themselves**: five re-read and compare (column move, archive,
name/description, dueDate, custom-field value), and **every other write path** has no
read-back and is unprotected by construction — on the card that is `create`, `delete`,
tags, assignees, both blocking-edge directions and board moves, plus everything off it.
That list was the point of the ticket and the first draft of this section omitted the seven
card ones while opening with "Every other write path", which read as exhaustive. An agent
is told to read the entity back after a write on any of them. The `retryable` consequence
is written down as the known edge it is, with the one actionable rule the ambiguity
permits: obey the field, but a second identical failure means stop and read the card,
because that is the deterministic case.

**The fourteen are re-measured, because the per-request log is not in this repo** — only
#170's count and its four family names were. Nine of the four families reproduce on the
scratch org, enumerated with request, echo and follow-up GET in
`docs/research/tracker-contract-favro-carriers.md` §6c: the `assignmentIds` full replace,
`favroAttachments`, five immutable fields, and `addTagIds`/`addAssignmentIds` ignored on a
POST. **`removeTagIds` does NOT reproduce** — it is honoured for a tag the card carries,
and the "no effect" of removing a tag that was never there is the correct outcome, not
evidence of a refusal. Recorded as a non-reproduction rather than repeated. The two POST
rows are new and are *not* a defect here: `createCard` sends `tags` and `assignmentIds`,
both measured honoured.

**And the wire level had no arm for one of the five.** Each read-back was mutation-tested
by replacing its comparison with `if (false)`. Four redden in the two wire suites —
`moveColumn` 4 arms there (6 across the full suite), `setArchived` 1, `setText` 2,
`setDueDate` 2 — and `setFieldValue`'s left **151 tests in
`tx-cards-field-writes-wire.test.ts` and `dispatch-tx-wire.test.ts` green**. Scoped
deliberately: the mock-level arm at `src/__tests__/commands/custom-fields.test.ts` DOES
redden, so the guard was pinned and a cleanup would not have gone green — an earlier draft
of this entry claimed it was the one member a cleanup could delete silently, and that was
false. The new arm drives the clean-200 shape (200, untouched row, no
message) through the real facade rather than a mocked `updateCard`, which is better cover
for the same guard — that is the reason to keep it, not a hole it closes.

Not attempted: a per-field echo comparison, and probing for a shared precondition. Both
are unmeasured, and the ticket asks for neither.

#### A write Favro refuses with a SUCCESS status now fails instead of reporting `ok` (#165)

Favro answers some rejected writes `202` with the reason in the body. Axios resolves a
2xx, so the refusal arrived as the entity the caller asked for — every field `undefined`
— and the CLI reported success. Both of this release's CRITICALs are that shape.

The HTTP client now refuses **any** 2xx carrying a top-level `message`, on every
endpoint. Measured 2026-08-14, 110 logged probes: 28 of 28 message-carrying 2xx were
denials, and 47 of 47 successful 2xx — card writes, dependencies, tasklists, comments,
deletes, and every single-entity and paginated GET in remit — carried no message at all.
Keyed on the message rather than on 202, because 202 legitimately means "accepted" in
HTTP and a message rule survives Favro moving a denial onto a 200.

Live, on the #105 scratch board, same request through plain axios and through the client:

```
$ favro custom-fields set <card> 5XdsToqDtXLn2rtL9 nonsense --yes
{"intent":"update","outcome":"rolled-back","retryable":false,
 "error":"Favro answered 202 — a SUCCESS status — and said \"Unsupported custom field type\"..."}
```

`Unsupported custom field type` is the **eleventh** distinct denial message measured, and
the first one found by driving the rule rather than probing for it — nothing had to be
taught it, which is why the rule is a default rather than a longer list of known
messages. `retryable: false`: the refusal is deterministic and repeating the call repeats
it, where the read-back that used to catch some of these called them transient.

**A 202 refuses at least one field, not necessarily all of them.** Measured the same day:
`PUT /cards/{id} {name, columnId:<bogus>, widgetCommonId:<real>}` answers
`202 {"message":"Invalid column"}` **and the name changes anyway**. So a transaction now
unwinds around one of these rather than propagating it as "nothing was written" — driven
live across two dispatches sharing one compensation log, where the second's first write
was refused and the first's write was restored. What the 202 itself applied was never
logged and cannot be undone; the refusal says so rather than claiming a clean rollback.

**Inside the rollback report too.** A compensating write Favro refuses with
`202 {"message":"Access denied"}` classifies `not-found` on its message — the same words
a 403 uses for an absent resource — so the unwind counted it as already-undone and
reported `rolled-back` with no orphan, for a change that is still there. It is a
`compensation-failed` orphan now, quoting Favro's words, and the outcome is
`rollback-incomplete`.

**What this does NOT close**, and no message here claims it does: 14 rejected writes that
answer a clean 200 with a full entity and no effect (`removeTagIds`, an `assignmentIds`
full-replace, `favroAttachments`, immutable fields) — only `TxCards`' read-backs catch
those, and they stay; `dueDate: "2026-02-30"` accepted and stored as March 2nd; and a
column move on an archived card silently un-archiving it.

#### Every aggregate count is a board instance now, and two custom-field filters refuse (#167)

`AggregateAPI` read the whole collection with `unique: true`, which returns one arbitrary
row per `cardCommonId`, and then attributed each row to exactly one board. A card on two
boards of the collection was counted on one of them and **missing from the other** —
structurally, in `totalCards` and `stageDistribution` alike. Measured live on the #105
scratch collection: a second board holding only a shared card was absent from `overview`'s
`boards[]` entirely, `boardCount: 2, totalCards: 10` against `3` / `11` without the flag,
while `cards list` on that board answered one.

Dropping the flag makes every count in the report a **board instance** — `CONTEXT.md`'s own
reading of `card`, what `cards list <board>` answers, and what the `__boards__` branch
already did. `stats.total`, `by_status`, `by_owner` and `overview`'s `totalCards` /
`stageDistribution` / `dueSummary` are one partition of that set and move together;
`stageDistribution` renders as a percentage of `totalCards`, so they cannot count different
things. `blockingCount` is the one number **not** in that partition, so it counts distinct
blocked cards by `commonId` rather than edges — otherwise a blocker of a two-board card
would have been reported as blocking two.

The same partition then had to reach the member rollups, where it had stopped. `workload`
and `team` now collapse per member on a shared `workItemKey` expression in `aggregate.ts`,
so the four sites that must agree cannot drift. `totalEffort` / `effortSum` is the
unarguable one: an estimate is a single card-level field holding a single number, and a
card committed to two boards was reported as **twice the work**. `activeCards` gates
`OVERLOAD_THRESHOLD`, so it would also have raised `⚠ OVERLOADED` on somebody carrying
eight items across two boards. `activeBoards` and `workload`'s `cards[]` stay
per-instance — they name the board, and those are the two the un-collapsed read genuinely
improved. `next` dedupes for the same reason: both rows of a two-board card score
identically and spent two of `--count`'s five slots on one thing. `stale` is left
per-instance on purpose and now says so at the loop — it lists places to go, and divides by
nothing. `ListCardsOptions.unique` goes with the flag; `aggregate` was its only caller.

**`customField:` and `customFields:` now refuse instead of answering.**
`favro query <board> "customField:Status=Todo"` answered `matches: []` over three cards
that all carry `Status` = `Todo`, exit 0, with a summary saying it had searched. Two
independent causes, both measured on a live card
(`[{"customFieldId":"zxMLxD4zx4tSwJr75","value":["YLanLiuXKA8JpvEsX"]}]`): the predicate
matched `f.name`, a key the wire does not send, and the found value is the option's **id**
while the query names the **label**. Refused rather than repaired — resolving a field name
and an option label needs the board's definitions, and `GET /customfields` is org-scoped
and ignores its board filter (3797 rows over 38 pages on the measured org, for a board that
defines 2), which is not a read this grammar can make on every filtered query. Matching the
id and not the label would trade a wrong-empty for a wrong-populated, which is worse than
both. One throw site, in `validateField`, so every spelling reaches it — including
`customField in(…)`, which returns from a branch above the operator parse. The refusal
names the two commands that DO read the values, and both exist: `custom-fields list <board>`
and `cards list <board> --include custom-fields`.

The plural `customFields` — the key on every card — refuses too, and that one was worse:
`customFields~object` answered **true for every card**, because `compareValues` stringifies
the array and `String([{…}])` is `[object Object]`. Populated and wrong rather than empty
and wrong. The exclusion lives in `knownFields` rather than in the refusal's message,
because the plural reaches that set from three directions, so striking it once at the
source is what keeps the "Known fields" list from advertising a field that refuses.

`preWarmCache` is deleted — no caller in `src/`, no test, and this ticket narrowed what it
warmed — along with the three `PERFORMANCE.md` claims that described it.

### Added

#### `favro-mcp-http` answers `GET /health` with its version

The server served one route, `POST /mcp`, so a deployed instance could not say what it
was. Asking cost a full transport handshake plus valid Favro credentials plus the
`Accept: application/json, text/event-stream` header, and returned `serverInfo.version`
buried in an `initialize` response — impossible from a platform probe. `GET /health` now
returns `200` with `{"status":"ok","version":"<package version>"}`, unauthenticated, from
the same `require('../package.json')` that `mcp-server.ts` already reads for
`serverInfo.version`. Nothing else is in the body — no org, no user, no config.

This matters at this release specifically: a client that composes command strings through
`favro_run` behaves differently against `4.0.0` and `5.0.0`, and until now the wire could
not say which one it was talking to.

**Measured limit, recorded rather than papered over:** `/health` returns before the
transport's `Host` allowlist runs, so a `200` proves the process is up and NOT that
`FAVRO_MCP_ALLOWED_HOSTS` is correct. A wrong allowlist surfaces as `403 Invalid Host
header` on `/mcp` and nowhere else. `docs/DEPLOY-MCP-HTTP.md` says so at the probe step.

`GET` only — any other method on `/health` still gets `405`, and unknown paths still `404`.

### Removed

- **The shipped skill's `references/command-reference.md` is deleted (#160)** — 896
  lines, of which `git blame` dates 783 to 2026-03/04, before the map that replaced the
  surface they documented. #8 had already ruled `--help` the single source of truth and
  specified `SKILL.md` as a "thin stub, ~15 lines" whose body is a pointer, with no
  duplicated content and nothing beside it. `SKILL.md:8-10` says the same in the shipped
  prose: anything written there instead "would be a second
  copy". Nothing reached it: `SKILL.md` never named it, and MCP `favro_help` shells out
  to `favro <tokens> --help` (`mcp-server.ts:58`), so a file in `references/` cannot
  appear there. It did ship — `package.json`'s `files` includes `skills` — so the tarball
  drops 26.5 kB and goes from 268 files to 267. `skills/` still carries `SKILL.md` and the
  four `skills/builtin/*.yaml`.

  What the tests lose, stated rather than implied. It supplied **173 of the 308**
  option-table rows `documented-commands-coverage.test.ts` reads (171 of the 302 it
  scopes to a command) — more than half of both counters in one file. The floors are
  re-measured to the exact new counts, 307/301 → 134/130 against 135/131 today, so they
  still grip on a single lost row. It also supplied all 79 of the command headings the
  `declaredHeadings` arm of `help-topic-drift.test.ts` read; that entry now reads
  `docs/commands.md`, where the arm reads 22 command headings nothing was checking
  before. Pointing it there found two defects on the first run: `cards blockers` — which
  the built CLI answers with `unknown command 'blockers'` — still stood as a live
  heading, and the heading spelling `favro query` was invisible to an arm that never
  expected the `favro` prefix on a heading. Both are fixed.

  `SKILL.md` survives the delete and needed no rewrite, but two of its own claims did.
  Its frontmatter advertised "batch card operations", a family removed in 4.0 — it now
  names the surviving spelling, keeping "batch" as a trigger word. Its body promised "the
  seven intents"; the dispatch table holds thirteen, and the number is dropped rather than
  re-pinned, for the reason `issue-tracker-help.ts:141-144` already records about the
  sibling string: "a number here rots silently, and did".

### Docs

#### `docs/DEPLOY-MCP-HTTP.md` now covers the container target its own `Dockerfile` builds

The guide documented exactly one target — a Linux box with systemd behind a reverse proxy
— while the repo ships a `Dockerfile` whose first line reads "container image for Cloud
Run". Two of the guide's instructions were wrong for that image, and one of them fails
closed: the image sets `FAVRO_MCP_HOST=0.0.0.0` (against the guide's "leave on localhost")
and does **not** set `FAVRO_MCP_ALLOWED_HOSTS`, so a deploy straight from it answers every
authenticated request with `403 Invalid Host header: <service>.a.run.app` — the fallback
allowlist is `127.0.0.1:8080,localhost:8080` and Cloud Run passes its own hostname
through. The unauthenticated `POST /mcp` → `401` smoke test still passes in that state, so
it does not catch it.

A new **Cloud Run / containers** section states five things: why `0.0.0.0` is right in a
container, that `FAVRO_MCP_ALLOWED_HOSTS` is service config set with `--update-env-vars`
(never `--set-env-vars`), that `$PORT` is already bridged to `FAVRO_MCP_PORT` by the
image's `CMD` so operators must not set it, that `FAVRO_MCP_STATE_DIR`'s "point at a
persistent path" mitigation has no equivalent on a container tmpfs — scope locks are lost
per instance recycle and are per-instance across replicas — and that the liveness probe
belongs on `GET /health`, not on the `401` smoke test, which stays green in exactly the
failure state above. The localhost notes in **Run target** now say the rule is about
co-tenants on a shared host, not containers.

### Fixed

- **`cards claim`, `next`, `my-cards` and `my-standup` were unreachable for anyone past
  the first page of `/users` (#162 item 7).** `resolveUserId` issued one
  `GET /users?limit=100` and matched the caller's email against that page alone. Favro
  answered `{page: 0, pages: 2, limit: 100}` for the 135-user organization this CLI is
  developed against, with the caller's own account at index 112 — so the match failed,
  `undefined` came back, and `cards claim`'s `@me` default refused
  `Cannot resolve "@me" — no userId is cached for your credentials`. `--assignee "<name>"`
  worked throughout, because `UsersAPI` has always paged; only the default was broken.

  Both copies of that lookup now go through `UsersAPI.listUsers()` and its `getAllPages`.
  The second copy was **inside `favro auth login`** — the remedy the refusal printed — so
  the advice did not work either: it stored no `userId` and printed
  `⚠ (not found in org users)` for the caller's own account. Driven live against the
  scratch board with the cached `userId` deleted first:

  ```
  $ favro cards claim 67aeaf77a49d4618a6f16c19 -y
  {"cardId":"67aeaf77a49d4618a6f16c19","columnId":"635d44b1e9de8d4de07ba795","assignee":"pk3qK36WHjnJt5jwr"}
  ```

  `my-cards` and `next` answer for the same identity and cache it, so the next call costs
  no lookup. The `@me` refusal that remains states an outcome rather than a mechanism —
  `resolveUserId` returns `undefined` for a missing cache, an unmatched email and a failed
  read alike — and names two remedies that exist: `favro auth login`, and passing a name,
  email or userId with `favro users list` to find one.

- **`Would creating tag "x"` — every shared dry-run preview was ungrammatical (#162 item
  10).** `dryRunLog` renders `Would ${verb} ${targetType} "${targetName}"`, and 17 of its
  19 call sites passed a participle; the two that read correctly were the two that passed
  a bare verb. All 19 pass an infinitive now, so the preview reads
  `Would create tag "release"`, `Would delete task list "…"`, `Would upload attachment
  "…"`. Three call sites also embedded their own quotes inside the name and printed
  `Would creating column ""probe" on board 5dd7…"`; they pass the bare name, and the board
  or card id they wrapped is the positional argument the caller typed —
  `attachments upload` now does the same on both its arms.

  Two sites kept the nesting through that fix, because the scan read the VERB only:
  `git sync --dry-run` printed `Would move cards "3 card(s) to "Done""` — the only two
  previews in the set that stand for a bulk card move rather than one named object.
  Both drop the inner pair. Their destination stays inside the target —
  unlike `attachments`, it is derived from the branch mapping, not an argument the caller
  typed back — so what `dry-run-verb-grammar.test.ts` now bans across all 19 sites is the
  `"` character, not the composite shape. The scan covers both halves of the string,
  because this text was pinned verbatim by a green test and one arm on one command would
  leave the other eighteen free.

  **The same item's `answered 200` claim was real.** `TxCards`' three echo read-backs
  (`setArchived`, `setText`, `setDueDate`) hardcoded the status into user-facing prose —
  `Archive write on card X answered 200 but did not take` — and the one write status code
  this repo has written down is a **`202`** (`custom-fields set`, live on the #105 board,
  #165; 47 successful 2xx were measured there too, their codes just never recorded).
  That one was a refusal, and a message-carrying 2xx is classified as one before it
  reaches these checks — so what arrives here is a clean 2xx whose code nothing observed,
  and `200` was a number the message invented, in the one line an agent reads while
  deciding whether a write landed. All three now say `answered a SUCCESS status`, the
  wording `favro-error.ts` already uses. The observed code is not threaded out of the
  write seam; that is the upgrade if anything ever needs to tell 200 from 202 here.

  Two other item-10 claims **do not reproduce** on this release, measured on the built
  CLI: passing `--json` to `boards delete` or to `columns create` answers
  `error: unknown option '--json'` on stderr at exit 1, with **nothing on stdout** — no
  JSON, pretty-printed or otherwise. Neither command has that flag, and the advice that
  suggested it went in #160, after #119 made JSON the default.

- **`workload` and `team` reported `Effort: 0` for everyone, structurally (#169).**
  `extractEffort` matches a custom field by NAME (`/effort|story.?points?|points?|estimate/i`)
  and the card payload carries no name: `GET /cards` and the create echo both inline
  `[{"customFieldId":"zxMLxD4zx4tSwJr75","value":["YLanLiuXKA8JpvEsX"]}]`, so the regex
  was matched against a base62 id and could never hit. Both commands then summed the miss
  as `?? 0` and printed a confident zero for estimates nothing had looked at.

  Effort now fails **closed**: `totalEffort` / `effortSum` are `null`, printed
  `Effort: unavailable`, as soon as a counted card carries a custom field the payload
  identifies only by id. A card carrying no custom fields at all still contributes an
  honest `0`, so a measured zero and an unmeasurable one are different values for the
  first time. Measured live on board `5dd75f0d5116020817ebe70a`, same card both runs:

  | | before | after |
  |---|---|---|
  | `workload --board` (JSON) | `"totalEffort":0` | `"totalEffort":null` |
  | `workload --board` (human) | `Effort: 0` | `Effort: unavailable` + the reason |

  `next` loses two of its three weighted terms on the same payload — priority and effort
  both read those fields — so a card whose priority could not be read now says
  `priority and effort unreadable — ranked on due date and stage only` in `reasons`, and
  reports `priority: "unavailable"` rather than `"unset"`. `"unset"` still means the
  fields were read and held no priority. The joint sentence is gated on effort having
  actually missed: the predicate under it answers about ANY id-shaped key, so a card
  carrying a named `Effort` beside one id-keyed field claimed effort was unreadable in the
  same `reasons` array that said `quick win (effort: 1)`. Such a card now says
  `priority unreadable — not weighted in this ranking`. Not reachable where cards come off
  `GET /cards` — nothing there carries a name at all — but reachable through any caller
  that hands names in.

  The shape test that decides all of this went through the declared table (ADR-0003)
  instead of importing the two regexes raw, which needed a `customFieldId` row and so a
  measurement: `GET /customfields` for org `b0b311ac…` serves **3799** rows, **3769**
  base62-17 and **30** hex-24 (2026-08-14). Both shapes are real for this resource, which
  the previous docblock had asserted off option ids rather than field ids. That read was
  repeated with and without `widgetCommonId` and returned the identical 3799-row set both
  ways — which confirms the client-side-filter claim `listFields` rests on a second time,
  and leaves the two-row gap from the **3797** recorded earlier the same day (below, and in
  `custom-fields-api.ts`) unexplained: the 270-unattributed and 2-naming-the-board counts
  match across all three reads, so it is not the filter. The reconciliation lives in
  `custom-fields-api.ts`.

  `sprint-plan` fabricated the same miss into its central judgement, and that is fixed
  here too. Its per-card cell really did render `—`, but `cumulative`, `totalSuggested`
  and `withinBudget` were all built from `?? 0` — so on the payload above every card was
  free, `running <= budget` was `0 <= 40` for all of them, and the command reported the
  entire backlog as fitting a 40-point sprint with `totalSuggested: 0` and `overflow: []`.
  All three are now `number | null` / `boolean | null`: a card whose cost could not be
  read is neither claimed to fit a budget nor excluded as over it, and `overflow` holds
  only cards MEASURED not to fit. The human header has three states rather than two,
  because `addEffort`'s `null` is sticky but POSITIONAL — a card measured to overflow can
  rank ahead of the first unreadable one, so `overflow` is non-empty while the total is
  `null`, and `no budget cut made` printed four lines above the cut it made.

  **`priorityScore` was the same defect on the same payload, and the louder one.**
  `extractPriority` looks up six literal field NAMES, so on an id-keyed payload every
  lookup missed and every card carried `priorityScore: 0` under a field documented
  "0–4 numeric (higher = more important)". `compareSprintCards` reads that score FIRST,
  found them all equal, found every effort `undefined`, and fell through to its
  alphabetical tiebreaker — so the command whose `--help` advertised a priority×effort
  ranking was sorting by title and said so nowhere. `priorityScore` is now
  `number | null` with `priority: "unavailable"` beside it, the same spelling `next`
  reports; the comparator ranks `null` where `unset` ranks (it must stay a total order)
  and human mode names the cards it could not read and says the order is not the
  documented ranking. `--help` says which fields have to be readable for it to be.

  `sprint-plan`'s `extractPriority` is **still not reconciled** with `next`'s — they use
  different vocabularies (`urgent` scores 4 here and 0 there) and different fallbacks (a
  non-band value like `P1` displays itself here, `unset` there), so merging them would
  ride a sort and display change in on a disclosure fix. Both now answer the
  unavailability question through the one shared predicate; the duplication is recorded on
  `extractPriority` as the open edge it is.

  **Not fixed: the name is still not resolved.** The id→name map half-exists —
  `getSnapshot` already holds a board-filtered one (`listFields(boardId)`, filtered
  CLIENT-side, and its own two measured gaps carry over: 270 rows of the same page-through
  are attributed to no board, and a card can carry a field whose definition names
  another), and the
  aggregate path could buy the whole thing with one org-scoped `/customfields`
  page-through per report — and that is the upgrade path recorded on `addEffort`. It was
  not taken here for the reason #167 refused the `customField:` filter: a lookup that can
  fail still needs this answer for the case where it does.

- **`widgets list` answered `{"rows":[]}` for every card, and had since the filter was
  written (#167).** `GET /widgets?cardCommonId=<x>` **ignores the filter** — measured
  2026-08-14 on the #105 scratch board: 500 rows over 5 pages, every board in the
  organisation. The rows are typed `backlog` and `board`, and the caller kept only
  `type === 'card'`, so nothing ever survived. It is the command someone reaches for to
  check whether a card forked onto several boards, and it said "no instances" for a card
  that has one. It reads `GET /cards?cardCommonId=<x>` without `unique` now, one
  entity per board instance, the route `docs/research/card-identifier-semantics.md` §3.3
  prescribed and §5 had filed as unverified. The reference is settled to a `cardCommonId`
  first: `/cards` takes it as a query value, so a `cardId` in that slot is a 200 with zero
  rows — the same silent empty under a second spelling. The wire arm is paired-polarity,
  two instances back for the matching card and empty for an unrelated one, because a lone
  zero-row assertion cannot tell a silent wrong answer from a correct empty one.

  `widgets list --card` also advertises `sequentialId`, and a colliding one refused through
  `pickOneInstance` with "pass `--board <board>`" — **a flag the command did not have**,
  which is `standup.ts:59` again. It has it now, threaded into the resolver, with an arm
  asserting the board reaches the query. `listInstancesOfCard` sends no `archived`, and
  that is the answer rather than a default taken: measured 2026-08-14, an archived instance
  comes back carrying `archived: true`, and it is still an instance of that card on that
  board.

- **`custom-fields list <board>` reported the whole organisation as the board's (#167).**
  `GET /customfields?widgetCommonId=<board>` **ignores the filter** — measured 2026-08-14
  on the #105 org: 3797 rows came back for a board that defines 2, and the raw row carries
  `widgetCommonId` and no `boardId` at all. The CLI forwarded the param and passed every
  row through, so both `custom-fields list <board>` and the `customFields` facet of
  `favro context <board>` answered with the organisation, with nothing in the envelope
  saying so. The narrowing is client-side now, on `widgetCommonId` — the wire's own key —
  inside `listFields`, so both callers get it from one place. The board argument is settled
  through `resolveBoardId` first: with a client-side filter an unresolved **name** matches
  no row, which would have traded an over-broad answer for an empty one.

  Two edges recorded rather than asserted about: 270 of the 3797 rows carry no
  `widgetCommonId` and belong to no board any probed endpoint can name, so they are listed
  for none; and a card can carry a field whose definition names a different board — measured,
  the write was accepted and echoed — so this is what a board **defines**, not everything
  its cards can carry. The test fixtures had carried `boardId` and no `widgetCommonId`,
  which is the shape the wire does not send; they carry the measured one now, and the new
  arms are paired — the board's row in, the other board's and the boardless row out.

- **`API-REFERENCE.md`'s custom-field reporting recipe emitted `null` per card (#167).** It
  read `.fieldId` and `.displayValue` off a card's inlined array. Neither key is there —
  `fieldId` is `CustomFieldsAPI`'s normalised spelling and `displayValue` lives on
  `CustomFieldValue` — in the file that documents the CLI. Rewritten as the join it actually
  is, against `.customFieldId` and `.value`, with the per-card loop deleted: one board read
  carries every value. All three pipelines were run against the live board before being
  written down. Two `cards list … | jq '.[].cardId'` pipelines nearby read a bare array off
  an envelope; both fixed.

## 4.0.0 — 2026-08-14

**This section was headed `3.1.0` until #110 landed in it.** The map (#80) planned the
whole write-seam collapse as one `3.0.0`, but `3.0.0` was dated in this file and tagged
`v3.0.0` on 2026-08-12, before any of the removals below existed — so they cannot go
there. A major after a released major is `4.0.0`. **Four** entries already under this
heading were breaking and mis-filed under a minor — #109's two new caps, its wholesale
abort on an unreadable `git sync` card, and `dependencies delete-all` refusing above
twenty; all four are under `### Breaking` now.

### Breaking

#### `batch update`, `batch move`, `batch assign` and `batch-smart` are removed (#110)

All four are still REGISTERED. Each exits 1 and names its replacement, so a script that
calls one gets a next move instead of `unknown command`:

```
$ favro batch update --from-csv cards.csv
{"error":{"message":"'favro batch update' was removed in 4.0.\nUse 'favro cards update --from-csv <file>' — same CSV, one transaction, capped at 20 rows.","retryable":false}}
```

That is **stdout**, at exit 1 — the JSON default (ADR-0002), so an agent reading stdout
gets a parseable next move rather than `(no output)`. `--human` prints the same two lines
on stderr behind `✗ Error:` instead. All six spellings below answer identically; verified
against the built CLI with `FAVRO_CONFIG_DIR` pointed at an empty directory, so none of
them needs a credential either.

| Removed | What to run |
|---|---|
| `favro batch update` | `favro cards update --from-csv <f>` |
| `favro batch move` | `favro cards list --filter …`, then `--from-csv` |
| `favro batch assign` | `favro cards list --filter …`, then `--from-csv` |
| `favro batch-smart` | Decide the operations yourself, then `--from-csv` |
| `favro cards update --board <b>` (no card id) | `favro cards list --filter …`, then `--from-csv` |

The stubs accept the old flags (`allowUnknownOption`), because the real invocation
carries them and `error: unknown option '--from-csv'` is the same dead end one token to
the right. They are kept for one major.

**`favro batch` on its own no longer prints help** — it refuses like its subcommands, and
so does any unrecognised subcommand under it (`favro batch nonsense`), which used to be
`error: unknown command 'nonsense'`. A caller who half-remembered the spelling is the one
most in need of the pointer.

**Why no deprecation cycle.** A warning that still performed the write would keep alive
exactly what the removal is for: five spellings that DERIVED their write set from a
board read — a `--filter`, a `--label`, or a plain-English `--goal` chose the cards — so
what was written appeared neither in the invocation nor in any record afterwards.
`--from-csv` is the same job with the set enumerated by the caller.

**What goes with them:** `BulkTransaction` (rollback engine #2, whole-field restore with
no compare-before-restore, `ROLLBACK FAILED` to stderr) and `batch-smart`'s best-effort
unwind (engine #3). `tx-cards` is now the only rollback engine in the codebase.
**1 996 lines deleted** — `commands/batch.ts` 617, `commands/batch-smart.ts` 732,
`lib/bulk.ts` 647, counted off the deletion commit rather than off #110's estimate of
1 117, which was two releases stale.

#### `cards update --from-csv` is capped at 20 rows, in one transaction

The CSV goes through the shared `update` intent now, which is what buys the cap. **Over
twenty rows the whole file refuses**, naming the cap; it does not write the first twenty.
Splitting is the remedy, and each chunk is its own transaction.

The same routing changes four more things about this command:

- **A failure part-way unwinds field by field and reports `rolled-back`.** The old
  transaction re-PUT the whole previous state best-effort and printed `ROLLBACK FAILED`
  to stderr when that failed; an incomplete unwind is now in the result, with what it
  left behind.
- **A row naming nothing but `card_id` refuses** rather than being a silent no-op
  success. In a batch, skipping it reports success for a card that was never written.
- **An unresolvable `owner` is no longer refused before the first write.** The old
  transaction pre-settled every name in one pass; the intent settles per entry, so a
  typo on row 12 lands rows 1-11 and then unwinds them. The cap bounds that at 19 writes
  and one unwind that reports what it left behind if it could not finish. `bulk.ts`'s own
  note said the pre-pass existed because the lazy path cost 399 writes and a partial
  rollback on a 500-row file — which the cap now makes unreachable. **When the unwind
  completes** it is a regression in wire cost on a bad row and nothing else; when it does
  not, it is also a regression in what the caller is left holding, and the result says
  which rows those are.
- **`--json` now prints the `DispatchResult`** (`{intent, outcome, retryable, value}`),
  not `{total, success, failure, skipped, rolledBack, errors, operations}`. Success and
  failure print the same shape; they used to print two.

`--verbose` no longer shows per-card progress on this path — it is the root
stack-trace flag and nothing else.

#### The `custom_field_*` CSV columns are gone, and unknown columns now refuse

`cards update --from-csv` accepts `card_id` (required), `status`, `owner`, `due_date`,
with `cardId`, `assignee` and `dueDate` as aliases. **Every other column refuses**,
naming itself and listing the columns that exist.

`custom_field_*` was accepted, parsed, stored on the operation and **never sent** — the
old parser's own comment said "stored but not directly mapped". A CSV naming a custom
field reported success having written none of it. Refusing is the fail-closed half of
the same fact.

#### `BoardsAPI`'s duplicate collections surface is removed (#123)

Library consumers, and one CLI path covered under `### Changed` below. No command
called any of these methods directly; the single reachable use was
`cards get --include collection`, which went through `BoardsAPI.getCollection` and now
goes through `CollectionsAPI`'s. `BoardsAPI` declared a second
`Collection` interface and a second copy of `resolveCollectionId`, `listCollections`,
`getCollection`, `createCollection`, `updateCollection` and `deleteCollection`, all of
which live on `CollectionsAPI`. They are gone from `BoardsAPI`; import `Collection` from
`lib/collections-api` and call `CollectionsAPI` for the rest. `addBoardToCollection` and
`removeBoardFromCollection` were not duplicated and MOVED to `CollectionsAPI` — both
endpoints are `/collections/…`. `listBoardsByCollection` stays on `BoardsAPI`; it resolves its
collection through the one surviving implementation, a free function in
`lib/name-resolve.ts`, and its behaviour is unchanged.

The re-exports Part A left behind are gone too: `isTagId` is no longer exported from
`lib/tags-api` and `isUserId` no longer from `lib/users-api`. Both come from
`lib/id-shapes`, which is where the measurement that earns each shape lives.

#### Four writes that used to go through now refuse (#109)

All four break invocations that worked in 3.0.0, so they are here and not under
`### Changed`, where they sat until #110's review: a repo with 21 mapped branches,
a repo with 21 TODOs, a `git sync` over a deleted card, and a card carrying 21
dependency edges all used to write, and each refuses as a whole now.

- **`git sync` is now ONE transaction, not a loop with a success counter.** A failure on
  card 4 of 6 moves cards 1–3 back and reports `rolled-back`, where it used to print
  `✗ Could not update card X` alongside `✓ Updated 5/6 cards.` and leave the five standing.
  Two branches naming the same card are collapsed to one write. Over twenty cards it
  REFUSES, naming the cap, rather than moving the first twenty — and the refusal costs no
  requests.

- **`git todos --create` refuses on a repo with more than twenty TODOs, by default.** The
  scan is an enumerated list, so it is one `create` transaction and inherits the same cap —
  but the listing's `--limit` defaults to 100, so this is a cliff and not a corner. Refusing
  is the right half (creating twenty and dropping the rest would report success for cards
  nobody made); the refusal now also names the remedy, `--limit 20`, because the shared
  cap message ends "split an enumerated list, or act on a derived one entry at a time" and
  a codebase scan is neither. A part-way failure deletes the cards already made.

  The ticket's premise that `git sync` was silently writing nothing —
  `PUT {status: 'Done'}` being a measured no-op — turned out to be **false**, and the
  correction is pinned rather than argued: `CardsAPI.updateCard` already translated
  `status` into a `columnId` before anything reached the wire.
  `git-sync-intent-wire.test.ts` asserts the bytes are `{columnId}` and that the card
  MOVED, read back off the stand's own store.

- **A card that cannot be read now aborts the whole `git sync`.** A stale branch mapping
  onto a deleted card used to sync the rest and report a partial count; a batch is one
  transaction now, so it refuses as a whole and writes nothing. Under a configured lock the
  old code aborted here too — what changes is the unlocked case.

- **`dependencies delete-all` no longer wipes an unbounded edge set.** It was one
  `DELETE /cards/{id}/dependencies` with no record of what it removed and no way back. It
  now enumerates the edges, refuses above twenty rather than wiping, and removes each one
  through a write that captured its direction first — so a failure part-way through re-adds
  the ones already gone.

#### `cards move` no longer takes a position flag (#161)

The flag advertised `top` or `bottom`, and the wire wants a NUMBER: `--position top`
answered `400 Unexpected value of position` and took the whole move down with it. It has
never worked in any released version, and the three documents that taught it were
teaching a `400`. Removed rather than repaired — placing a card at a board's top or
bottom is not something anything else here does, and a major is where a flag that never
worked comes out. `cards move <card> --to-board <board>` is unchanged; a script passing
the flag now gets commander's `error: unknown option` instead of a `400`.

#### `--json` is gone from every remaining command (#119)

3.0.0 removed it from the commands migrated by then; #119 finishes the job. Every
command in `src/commands/` and `src/cli.ts` is on the one runner now, so **JSON is the
default everywhere and `--human` is the only way out** (ADR-0002). A leaf `--json` is
`error: unknown option '--json'` at exit 1.

Three of them meant something other than "format", and those are behaviour changes
rather than a flag rename:

- **`git sync --json` reported the branch analysis and synced NOTHING**, because the arm
  sat above the confirm and the write. With JSON becoming the default, renaming the flag
  would have made the plain `favro git sync` a command that reports and never writes. The
  flag is deleted and `--dry-run` is the successor: same `{branches, linkedBoard}` payload
  plus the moves it plans, and unlike `--json` it takes the scope lock first (#155).
- **`git todos --create --json` printed the scan and created nothing**, same shape. The
  listing arm's payload is now the `{rows, truncated?}` envelope every list read emits.
- **`cards update --from-csv` answered in HUMAN by default** while the refusal at the top
  of the same action answered in JSON — one command, two output defaults depending on
  which branch you hit. Both are the runner's now.

#### A card write's JSON output parses, and its refusal reaches stdout (#119)

Measured against the real API before the fix: `cards create … ` put `✓ Card created: …`
on **stdout ahead of** the JSON, so the documented default did not parse —
`Unexpected token '✓'`. Every `✓` line is on the human formatter now, and stdout carries
one document. Affected `cards create/update/retag/link/unlink/archive/unarchive/delete/move`
and `widgets add`.

The same run measured a scope violation exiting 1 with **stdout empty** and the refusal
on stderr — the dead end #110 existed to remove, still open on any path that got far
enough to build a real client. Every migrated command's refusal is now
`{"error":{"message","retryable"}}` on stdout under the default, `✗ …` on stderr under
`--human`.

#### `widgets add` answers a non-zero code as a FINDING, not a failure (#119)

It exits 1 when the write is accepted (200) but the response carries no
`widgetCommonId` — nothing observed the card on that board, and exit 0 is a positive
claim. Unchanged behaviour, recorded because migrating it naively would have made it
exit 0 and lost the finding silently.

`cards move` was the second command in this pair until #161, below: it now REFUSES a
response that does not name the destination board, so an unobserved board reaches the
caller as a failure rather than as a finding, and the exit code is the failure's own.

### Changed

- **`favro tracker init --board "<name>"` refuses in the shared wording (#123).** It
  matched `--board` with its own filter — the fourth copy in the tree of "id, or exact
  folded name" — and refused with `"<name>" matches 0 boards in collection <id>`. It
  calls `resolveNameToId` now, so an unknown name answers `No board named "<name>" — it
  is missing or not visible to your key.` followed by the collection's boards, and an id
  match wins over a name match instead of counting as a second candidate. The refusal is
  a `NameResolutionError` rather than a `TrackerConfigError`; both extend `RefusalError`,
  so the runner renders them identically and `retryable` is `false` either way. The board
  list it matches against is still the COLLECTION's, not the org's — `tracker init` will
  not adopt a board from somewhere else, and the shared board cache is deliberately not
  consulted here for that reason. Pinned in `tracker-init-wire.test.ts`.

- **`favro cards get <card> --include collection` escalates an unreadable collection
  (#123).** The facet called `BoardsAPI.getCollection`, an id-only read; it calls
  `CollectionsAPI.getCollection` now, the twin that retries a classified not-found as a
  name lookup — the same escalation the `board` facet has always had. The card is still
  returned with the facet ABSENT and an `unreachable` marker naming it; only the marker's
  `reason` changes, from `Favro said "Access denied" — the resource is missing or not
  visible to your key.` to `No collection named "<id>" — it is missing or not visible to
  your key.`, and the failing read costs a `/collections` listing when the name cache is
  cold. Both the old and the new wording misattribute the cause the same way the board
  facet's does, and `cards-get-include-unreachable-wire.test.ts` pins it so a fix to the
  escalation comes back here.

- **A card on two boards refuses in the resolver's wording (#123).** Reachable from
  `favro cards find <url>`, the one caller of `findCardBySequentialId`, which carried its
  own copy of the refusal. The copy is deleted and the shared `pickOneInstance` answers
  instead, so the reference is now quoted — `Card "8850" exists on 2 boards — pass
  --board <board> to say which:` where it read `Card 8850 exists on 2 boards …` — and a
  candidate Favro sent with no `name` is listed as `<cardId> (board <boardId>)` rather
  than as `<cardId> (board <boardId>, "undefined")`. The candidate ids, their order and
  the exit code are unchanged.

- **`cards update` writes `dueDate` (#110).** The field was measured in #106 —
  `null` clears, an ISO timestamp is honoured and echoed verbatim, `""` is a silent
  no-op and is refused rather than forwarded — and then held out of the `update`
  intent until a command passed one, because an arg nothing passes is a surface with
  no caller to keep it honest. The CSV's `due_date` column is that caller. It carries
  a real compensating write, like every other field on the intent.

- **The `--from-csv` reader moved from `lib/bulk.ts` to `lib/csv.ts` (#110)**, next to
  the CSV writer `cards export` already used. It is the only half of `bulk.ts` that
  survived the collapse onto the dispatch table.

- **Seven more write paths go through the one dispatch table (#109).** `git branch`'s
  auto-move, `git sync`, `git todos --create`, `custom-fields set`, `widgets add`,
  `cards move` and all three `dependencies` subcommands reached the wire directly, each
  dropping a different guarantee. They now take the mandatory scope lock **inside** the
  intent, so the CLI, `skill run` and MCP cannot disagree about it, and they inherit the
  boardless-write refusal, the 20-write cap and a compensation log.

- **`dependencies add` takes the scope lock even when the card has no board.** The check
  sat behind `if (sourceCard && sourceCard.boardId)`, so an assignment fork — the exact
  case the lock exists for — skipped it. It also gains the bounded pre-read: an edge that
  is already there is reported rather than rewritten, and a pair holding the REVERSE edge
  refuses instead of 403-ing off the wire.

- **`dependencies add --type blocks` now checks the TARGET card's board, not the source's.**
  "A blocks B" is the edge recorded on B with A as its blocker, and the shared intent boards
  off the card the edge is recorded on — which `cards link` has always done. Both directions
  of the change, stated rather than left to be discovered: source-inside/target-outside now
  REFUSES where it used to pass, and source-outside/target-inside now PASSES where it used
  to refuse. One end is unchecked either way; that is pre-existing and shared with
  `cards link`, and closing it means checking both cards' boards for both commands — a
  decision about the lock rather than about this routing, so it is recorded and not taken
  here. `--type depends-on` is unaffected. Pinned in `commands/dependencies.test.ts`.

- **`custom-fields set` no longer has an "accepted (200) but UNCONFIRMED" arm.** The write
  is read back and matched on `customFieldId`, so an echo that does not carry what was sent
  is a failure the table reports with retry advice, not a success-shaped notice. The value
  is still resolved against the field's own definition, and still sent under the payload key
  that field's TYPE spells — only `Single select` is measured on this path (#106) and
  nothing here widens that. One consequence to know about: that failure carries
  `retryable: true`, where the old notice was a flat exit 1. Nothing observed whether the
  write landed, so "try again" is the honest advice and the message says to read the card
  first.

- **`cards create --board "<name>"` no longer 404s under a scope lock.** The board argument
  reached `assertScope` unresolved, and the lock GETs `/widgets/<id>` — handed a name it
  404s into "Board … not found", a refusal naming the wrong problem (#82). It settles inside
  the intent now.

  On a real create it costs nothing: `createCard` settles the same value through the same
  15-minute name cache, and the two settlings are one board list even from cold — measured
  on a socket in `git-sync-intent-wire.test.ts`, on a fresh cache partition per arm.
  **A `--dry-run` with no scope lock does pay one request where it previously made none**,
  because the settling happens before the preview returns. That is an exception to the
  "no extra requests when nothing is locked" rule, and it is taken rather than gated on a
  name/id shape test: `looksLikeName` is weak by design — a one-word board name is
  shape-identical to an id — so gating on it would reopen #82 for the names most likely to
  be typed.

- **`cards move` checks BOTH boards, and gains `--dry-run`.** The origin and the settled
  destination are checked before anything is written, so a move out of the locked collection
  and a move into it refuse alike, and a fork can no longer ride in on the destination. A
  destination board that does not resolve now refuses by name before the write, instead of
  taking a 404 off the wire and reporting "card or board not found" for two different
  problems. The move is marked IRREVERSIBLE in the table: the column the card held on the
  old board is not captured, so nothing here can honestly claim `rolled-back`.

- **`widgets add` is inside the table as the one write allowed to manufacture a board
  instance.** That absence is what makes a card boardless, which is the shape every other
  write is refused on. Also IRREVERSIBLE: the new instance's own id is not measured on this
  response, so nothing can name it to undo it.

- An unlocked `--dry-run` on `dependencies delete`, `dependencies delete-all` and
  `custom-fields set` still makes no request and needs no credential. It previews from the
  intent's own pure preview, so the wording cannot drift from the run that writes. It
  therefore cannot report anything only a read could know — an unlocked
  `delete-all --dry-run` will not tell you the card is over the cap.

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

### Removed

- **The command-runner allowlist is deleted (#119).** `command-runner-ratchet.test.ts`
  held the files not yet migrated to `run()`, and failed in both directions — a listed
  file that had gone clean failed too, so the list could not rust into cover. #119 struck
  the last sixteen entries, so the ban on the five preamble spellings
  (`createFavroClient(`, `process.exit(`, `console.log(JSON.stringify`, `.opts()?.verbose`,
  `new […]API(`) is now **absolute** over `src/cli.ts` and `src/commands/`: a new command
  written against the old preamble fails with nowhere to be excused. Four arms that
  existed only to police the list went with it, and the arm asserting every pattern still
  had a LIVE example is replaced by a self-check on synthetic strings — with the list
  empty there are no live examples left by design.

- **`src/commands/batch.ts`, `src/commands/batch-smart.ts` and `src/lib/bulk.ts` are
  deleted (#110)** — 1 117 lines, and with them `BulkTransaction`, the CSV-to-operation
  mapping, the bulk preview/summary formatters, and `batch-smart`'s goal parser and
  rollback engine. `grep -r BulkTransaction src/` returns nothing.

  `Profiler` and `ConcurrencyController` in `lib/profiling.ts` lose their only
  production caller with `bulk.ts` and are now exercised only by their own tests.
  Deleting a published export is a semver call rather than this ticket's, so they stay
  and the fact is recorded here and in `profiling.test.ts`. **Superseded by the entry
  below**, which found the premise wrong: they were never published.

- **The dead half of `src/lib/profiling.ts` is deleted** — 257 of its 354 lines.
  `Profiler`, `ConcurrencyController`, `formatBenchmarkReport()`, `formatDuration()`,
  `assertBenchmarkTarget()` and the two types they passed around (`ProfileSpan`,
  `BenchmarkResult`) are gone. `CustomFieldCache` and `globalFieldCache` stay — they are
  the half with a consumer, `lib/custom-fields-api.ts`.

  **This is not a breaking change and is not under `### Breaking`.** #110 left the two
  classes standing on the grounds that deleting a published export is a semver call; the
  premise was wrong. `src/index.ts` exports four names — `FavroHttpClient`, `CardsAPI`,
  `BoardsAPI` and `version` — and none of these was ever among them, so no documented
  entry point loses a symbol. It rides 4.0.0 for one reason only: shipping dead code in a
  fresh major is silly. #89 was the dead-module ticket and never named this file, which
  was a miss rather than a decision.

  What that costs, stated rather than implied: `src/__tests__/lib/profiling.test.ts` drops
  two arms — `Profiler`'s span/throughput measurement and `ConcurrencyController`'s
  concurrency ceiling. Both were the last references their subject had anywhere in the
  tree, so nothing that still runs lost an assertion. #110's `SLEPT = 49` fix went with
  them and is deliberately not transplanted: it loosened a floor across a `setTimeout(50)`
  that only `Profiler` measured, and the surviving TTL arm sleeps 20ms against a 10ms TTL,
  which is a whole timer period of margin rather than a millisecond. `PERFORMANCE.md`
  named every deleted symbol and is corrected — including a *How to Profile* block that
  told the reader to `import { profile } from './src/lib/profiling'`, a name that never
  existed on that module in any commit.

- **`CardsAPI.deleteAllDependencies`, `CustomFieldsAPI.setFieldValue` and its private
  `putCardCustomField` are deleted (#109).** All three were un-instrumented card writes with
  no production caller left after the routing above. The seam's premise is that a write
  outside the transactional facade is *unconstructible*, not merely unused — one left
  reachable is one the next command takes without touching the table. The payload
  resolution `setFieldValue` did survives as `CustomFieldsAPI.fieldWrite`, which makes no
  WRITE of its own — it still reads the field definition, from cache where it can.

### Internal

- **#99 and #85 are not "closed by this sequence", and the record says so rather than
  repeating the ticket.** Both were already CLOSED before #119 started. #99 ("route every
  list read through the envelope") became a verification pass rather than a migration
  when the runner took over `capRows`/`writeEnvelope`, and #119 is where the last list
  reads arrive — but there was nothing left to re-scope. #85 ("`--verbose` is resolved in
  fifteen syntactically distinct forms") was fixed at the root by the `isVerbose()` latch;
  deleting the 47 `.opts()?.verbose` reads dotted through `src/commands/` is cleanup of a
  resolved bug, not the fix, exactly as `error-handler.ts` says — *"the reads still dotted
  through `src/commands` are redundant rather than wrong"*.

### Fixed

- **`blocked-by:` and `blocks:` returned zero rows for a live dependency edge (#162).**
  `normalizeCard` mapped each inlined edge through a normaliser that enumerated three
  keys and dropped the `cardId` Favro puts on every one of them; `linksOf` reads
  `card.links` before `card.dependencies`, and `normalizeCard` always sets `links`, so
  the intact array was unreachable on every list path. The filters therefore matched a
  `cardCommonId` only — while `cards list` prints `cardId` as the card's identity, and
  `cards blocked-by <card>` (which reads `/cards/:id/dependencies` raw) prints a
  `cardId` too. Pasting the id one command printed into the filter of the same name
  returned nothing. Measured live on board `abf5860049452d51cacb8162`, before → after:

  | filter | before | after |
  |---|---|---|
  | `blocked-by:<cardId>` | 0 rows | **2** (T2, T3) |
  | `blocked-by:<cardCommonId>` | 2 rows | 2 (T2, T3) |
  | `blocks:<cardId>` | 0 rows | **1** (T1) |
  | `blocks:<cardCommonId>` | 1 row | 1 (T1) |

  The premise the normaliser was built on was false and four comments asserted it:
  `GET /cards` inlines an edge **byte-identical** to what `/cards/:id/dependencies`
  returns — `{cardId, isBefore, cardCommonId, reverseCardId}` — and *neither* endpoint
  carries `cardSequentialId`. The normaliser now passes every key through.

  **No command's output changed.** `unblocked` and `parentcardid:` were measured
  correct and are untouched. The one surface that could have moved is `blockingEdges`,
  which feeds `context`'s `blockedBy`/`blocking` arrays — it now states outright that it
  reports a `cardCommonId`, where before it took a `cardId` first and only ever saw the
  common id because the normaliser had dropped the other. That is the id `overview`
  builds its top-blocker index from, so reporting the `cardId` instead would have sent
  every blocker to `unreachable` with an empty ranking — a wrong answer shaped exactly
  like a right one, which no test in the repo caught until this release added one.
  `context` was measured byte-identical before and after; `standup`, `health`,
  `workload` and `team` read only the LENGTH of those arrays, so they cannot move at
  all. `cards export --filter` shares the fix, since it shares `filterCards`.

- **`blocked-by:CLA-1804` had never matched anything, and said nothing about it (#162).**
  The documented sequentialId spelling was compared against `cardSequentialId`, a key
  Favro has never been measured sending on either dependency shape — so it silently
  matched no card, which is indistinguishable from an unblocked board. A sequentialId is
  now resolved to a `cardCommonId` before the filter runs, through the same
  `CardReferenceResolver` every other command uses, and an unresolvable reference
  refuses at exit 1 instead. Measured live: `blocked-by:24523` returns T2 and T3,
  `blocks:24524` returns T1, `blocked-by:99999` refuses. A `cardId` or `cardCommonId`
  still costs no call — the edge carries both, so either settles locally.

- **`cards retag` refused a tag that resolves, and blamed a reason that was not the
  reason (#164).** The refusal itself was right — `retag` carries two closed
  vocabularies, `bug|enhancement` and the five triage states, and writes nothing outside
  them — but it justified itself with *"an unknown name on a tag write is a tag
  creation, not a match"*, which is `TxCards.setTags`'s rule, not this one. `settleAxis`
  looks nothing up, so it is in no position to call any name unknown. Measured live:
  `tags get "wayfinder:map"` resolves to `ZLAszhmCsDpuNGG66`, and the very next
  `cards retag <card> --category "wayfinder:map"` was told the name was unknown. A live
  run read that as "the tag does not exist" and abandoned a workflow on it. The refusal
  now says what is true — the name is not on the role list, and nothing was looked up —
  and points at `cards update <card> --tags`, which writes a workspace tag by name;
  measured on the same tag, exit 0, `tagIds` gained `ZLAszhmCsDpuNGG66`, no duplicate
  minted. `cards retag --help` and the `retag` row in `favro help issue-tracker` carried
  the same wrong reason and now carry the right one.

- **A deterministic failure was advertised as safe to retry (#162).** `retryable` was
  derived by classifying the response MESSAGE; a message the closed sets do not
  recognise was read as transient whatever the status. Measured live: `cards update
  <card> --name <1115 chars>` answers `400 {"message":"Card can't have more than 1024
  characters."}`, and the CLI printed
  `{"intent":"update","outcome":"rolled-back","retryable":true,…}` with *"safe to
  retry"* on stderr — identically on two identical runs. `favro help issue-tracker`
  tells agents to *"read the 'retryable' field, never the outcome"*, so obeying the
  documented contract there is an infinite loop against a wall. An unrecognised message
  is now decided by status, through the same expression `FavroHttpClient` already
  retries on (`isTransientStatus`: no response, 408, 429, 5xx) — so what the client
  retries and what an agent is told to retry are one set, and every wire failure we
  still call retryable has already been retried four times in-process. The same command
  now answers `"retryable":false` and *"the failure is deterministic"*.

- **Seven places still taught a `--json` flag no command takes any more (#162).** The
  report this fixes said the opposite — that the root `--human` line claimed a JSON
  default the read commands lacked — and that was true when it was filed and is not true
  now: #119 finished the ADR-0002 migration, so `boards list`, `cards list`, `columns
  list`, `scope show`, `comments list`, `members list`, `my-cards`, `overview`,
  `activity`, `cards create` and `cards update` all answer `error: unknown option
  '--json'`, and every one of them this run could drive to an answer printed JSON on
  stdout — measured one by one on the built binary against the live org. What survived
  was the advice pointing the other way: four `--json` examples in `cards list --help`, a
  `cards update` tip telling the reader to run `cards list` with a `--json` on it, an
  `overview --human` line offering *"(use --json for all)"* for a flag that command has
  never had, and the same claim in `EXAMPLES.md`, `API-REFERENCE.md`,
  `docs/commands.md` and `examples/workflows.md`. All now say what the binary does.
  `favro init`, `favro board`, `favro tracker init` and `cards move` still declare a real
  `--json` and are untouched.

  Eleven calls in `src/__integration__` were passing the dead flag too. Those files are
  outside `npm test` (`jest.config.js` ignores them), so nothing was red — they would
  have failed on the first run with credentials. The flag is gone from the eleven, and
  the assertions in the tests touched now read the `{"rows":[…]}` envelope those
  commands actually print, measured live.

- **`cards move --to-board` never moved anything — it FORKED the card onto a second
  board (#161).** `PUT /cards/{cardId}` defaults `dragMode` to `commit`, and `commit`
  adds a board instance instead of moving one. The command sent no `dragMode`, so every
  move left the card on the board it was moving off and minted a second instance of the
  same `cardCommonId` on the destination, with its own `cardId` — which is why the write
  answered naming an id nobody had asked about. It was `widgets add` under another name,
  at a genuine `200`: no status, message or envelope check could tell the two apart, only
  the request body. Favro's validator names the enum when probed with a bogus value:
  `dragMode is expected as one of "commit", "move" (optional)`. Measured on the scratch
  board with two equivalent cards and the same command, one binary each: before, one card
  became two instances (source untouched, `cardId` `ea1bd733…` → `86bc9043…`); after, the
  card is on one board — the destination — under the `cardId` that was asked for. The
  move now also READS ITS WRITE BACK, comparing the board Favro echoes against the board
  it sent and throwing on a mismatch. That is what catches this endpoint's denial shape:
  a board id the key cannot write to answers `202 {"message":"Access denied"}` — a
  success to every HTTP client — with no board on the body at all. `widgets add` already
  sent `dragMode:'commit'` and is unaffected; it is now the only way to put a card on a
  second board.

- **Every column move was refused by the live API, and so was the rollback of one
  (#162).** Favro resolves `columnId` against `widgetCommonId`, so a `PUT` naming a
  column with no board had nothing to resolve it against and answered
  `202 {"message":"Access denied"}` — a resolution failure wearing a rights message.
  202 is a success to the HTTP stack, so the write seam handed the refusal back typed as
  a card and only `TxCards.moveColumn`'s re-read noticed the card had not moved.
  `cards update --status` / `--column`, `cards resolve`, `cards claim`'s move arm and
  bulk CSV `status` rows all funnel through that one `PUT` — and so does `moveColumn`'s
  own compensating write, so a batch that failed part-way could not put a moved card
  back: this release's rollback guarantee held for names, assignees and tags but not for
  the column. The move now carries the card's own board. Measured on the scratch board
  with the same card and the same command: before, `cards update <card> --status
  "Doing"` answered `{"intent":"update","outcome":"rolled-back","retryable":true,…}` and
  a board read left the card in Todo; after, it answers
  `{"cardId":…,"wrote":["status"]}` and the board read shows Doing. The unwind was
  driven too — a two-row CSV whose second row names an unknown owner now restores the
  first row's column, which is the path no test and no live run had ever seen work.
  `CardsAPI.moveCard` (a board move) never had this: it already sent `widgetCommonId`.

- **`favro help issue-tracker` stopped promising three things the code does not hold
  (#111).** All three were falsifiable with `git grep`, and the topic is what an agent
  reads to decide whether it can trust a write. "Every write … lives in the shared
  dispatch table" held only for the thirteen intents — 26 guard call sites live outside
  the table, and comment, task, tasklist, attachment, board, column, member and
  collection writes take the lock at their own. "`cards create --csv/--bulk` and `cards
  update --from-csv` are bulk edits, not intents … no compensation log" stopped being
  true for the CSV path when #110 routed it onto the `update` intent, and was never true
  for `cards create --csv`; both dispatch the whole file as ONE invocation and REFUSE
  over 20 rows — a failure on row 12 unwinds rows 1-11. And "every write command … takes
  `--dry-run`" is now "most": `git branch`, `git commit`, `members remove`, `webhooks
  delete` and `tracker init` do not declare the flag, and `README.md`'s "every write is
  previewed before executing" is corrected with them. Separately, `docs/commands.md` and
  the shipped skill's `command-reference.md` both said the collection lock checks "every
  write command"'s target *board* — it does not for the six collection-target writes, nor
  for the nine org-wide ones that land on no board at all.

- A whitespace-only `--tags` entry (`--tags "bug, ,urgent"`) reached the tag resolver as a
  blank tag *name*, and an unknown name on a write is a tag creation. It is dropped now.
  The trim was added with a broader justification than it deserved — every downstream
  resolver already trims, so a spaced-but-nonempty ` bug ` always resolved correctly — and
  a mutation run found the real case the trim covers, which is now the case pinned.

- **The missing-credential refusal no longer doubles its glyph.** `favro cards update
  card-1 --name x` with no key answered `✗ Error: ✗ API key not found. Run 'favro auth
  login' first`: `missingApiKeyError()` carried a `✗` of its own and `logError` adds the
  `✗ Error:` heading. The glyph belongs to whoever prints, so it was taken off the string
  — which also takes it out of `{"error":{"message"}}` under the JSON default, where a
  terminal glyph in a machine field was never right.

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

  **Superseded, later in this same 4.0.0 section.** The `include=cards` edge has since been
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
