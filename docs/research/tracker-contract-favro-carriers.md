# The tracker contract, and which Favro feature could carry each part

Research for GitHub issue #14 (part of #1, feeds #15). This is the **reading** half of a
two-ticket pair. It **decides nothing** — it produces the candidate table #15 decides from.

Two source classes only:

- The matt-pocock skill set under `~/.claude/skills/` — the *demand* side. Every capability
  below is derived from what those skills actually do, quoted with `file:line`.
- The Favro developer reference at <https://favro.com/developer/> plus this repository's
  source — the *supply* side, cited by doc section or `file:line`.

**One live probe was run** (in scope per the ticket) against the real org, inside the
scope-locked `🤖 AI` collection, on throwaway cards that were deleted afterwards. It
settled the single question a one-call frontier hinges on, and turned up four further
facts nobody asked for. See §1.

Confidence legend, as in `dependencies-and-parent-child-semantics.md`:

- **(a) documented** — stated in the Favro developer reference.
- **(b) implemented** — present in this codebase; says nothing about whether it matches the API.
- **(c) unknown** — neither docs nor code settle it.
- **(d) probed** — established live this session. Beats (a) where they disagree.
- **(e) UI-only** — needs eyes on the Favro web app; no API call can answer it. Marked
  as inference wherever it appears in a "renders in the UI?" column.

---

## 1. The live probe

### 1.1 What was asked

`GET /cards` (the list form) was believed **not** to inline populated `dependencies`.
Favro's docs place `dependencies` on the Card entity but describe the dedicated endpoints
separately, and #1's 26-card probe saw the key present but always `[]` — inconclusive,
because none of those 26 cards had an edge.

### 1.2 What was done

Two scratch cards were created on the one board in the scope-locked collection
(`widgetCommonId: 77a732ee70173a24439818ca`), one `isBefore` edge was written between them
via the repo's own client, four read shapes were compared, then both cards were deleted
with `?everywhere=true`. Post-cleanup verification confirmed the board is back to its
original 26 cards and no `ZZ probe` card remains.

### 1.3 Result — `GET /cards` **does** inline populated `dependencies`. (d) probed

The edge write returned:

```json
{"cardId":"79ab…e26","cardCommonId":"49aa…09b","organizationId":"b0b3…541",
 "dependencies":[{"cardId":"0e38…f89","isBefore":true,
                  "cardCommonId":"78c8…149","reverseCardId":"79ab…e26"}]}
```

and the **list** endpoint `GET /cards?widgetCommonId=…` returned, for the same two cards:

```
LIST_ROW 0e38…f89  deps= [{"cardId":"79ab…e26","isBefore":false,…,"reverseCardId":"0e38…f89"}]
LIST_ROW 79ab…e26  deps= [{"cardId":"0e38…f89","isBefore":true, …,"reverseCardId":"79ab…e26"}]
```

Identical population under `unique: true` and under `cardSequentialId`. So the earlier
`[]` readings were **true empties, not omissions**. This is the pivotal fact of the whole
ticket: **blocked/unblocked is representable in one call**, and every "one call?" column
below is answered against a list response that carries `dependencies`, `tags`,
`assignments`, `columnId`, `archived`, `parentCardId` and `customFields` together.

Full key set on a list row, verbatim from the probe:

```
cardId, cardCommonId, organizationId, archived, position, listPosition, name,
widgetCommonId, columnId, laneId, isLane, parentCardId, sheetPosition, dependencies,
tags, sequentialId, createdByUserId, createdAt, assignments, tasksTotal, tasksDone,
attachments, customFields, timeOnBoard, timeOnColumns, favroAttachments
```

### 1.4 Four unasked-for findings from the same probe

**(i) Assigning a user forks the card into a second instance.** (d) probed. Before the
claim, `GET /cards?cardSequentialId=<n>` returned **1** entity. After
`PUT /cards/:cardId {addAssignmentIds:[userId]}` it returned **2** — the board instance
(`widgetCommonId` set, `columnId` set) and a second instance with **no `widgetCommonId`
and no `columnId`**, i.e. the assignee's personal to-do list. This sharpens #13's
complaint about `findCardBySequentialId` picking `entities[0]`: the moment a ticket is
claimed, a sequentialId lookup has two candidates and the non-board one has no column, so
any column-derived open/closed read off `entities[0]` can silently read the wrong instance.

**(ii) `archived` is a selector, not an exclusion.** (d) probed, and it contradicts the
natural reading of the docs. `PUT /cards/:cardId {archive:true}` returns 200 and the row's
`archived` flips to `true`. But `GET /cards?widgetCommonId=W` **with no `archived` param
still returns the archived card** (count went 26 → 27 with `archived:true` on the row),
while `GET /cards?widgetCommonId=W&archived=true` returns **only** the archived card
(count 1). So the default list is "everything", and excluding archived cards is a
**client-side filter** — free, since the flag is on the row, but it is not a server-side
filter and cannot be combined with "give me the archived ones too" in one call.

**(iii) `PUT /cards/:cardId {tags:[…]}` is a silent no-op.** (d) probed. It returns
**200** and the card's `tags` stays `[]`. The documented parameters are `addTags` /
`removeTags` (names) and `addTagIds` / `removeTagIds` (ids) — `PUT {addTags:["Feature
Ready"]}` worked and the row came back as `tags:["0685be76408c23208e730c6a"]`, i.e.
**write by name, read back as tagId**. This is a live bug in this repo:
`UpdateCardRequest.tags` (`src/lib/cards-api.ts:141`) is spread straight into the PUT body
by `updateCard` (`src/lib/cards-api.ts:535-536`), which maps `description`, `boardId` and
`assignees` but leaves `tags` untranslated — so `favro cards update --tags …`
(`src/commands/cards-update.ts:86`) silently changes nothing and reports success. Since
tags are the carrier #13 chose for the triage vocabulary, this blocks `retag` outright.

**(iv) `completeAssignments` is real, writable, and the docs' name is plural.**
(a)+(d). `PUT /cards/:cardId {completeAssignments:[{userId,completed:true}]}` returned 200
and the row came back `assignments:[{"userId":"pk3q…","completed":true}]`. The doc text is
*"The list of card assignment, that will update their statuses accordingly"* under the
name **`completeAssignments`** — note the plural; a singular `completeAssignment` will not
be picked up.

Also incidental: `GET /cards?cardSequentialId=<deleted>` answers **403**, not 404 —
relevant to #6's resolver escalation rule, which escalates on 404.

---

## 2. What an issue tracker has to be able to do

Derived from the skills, not from what GitHub happens to offer. Each capability is quoted
from the skill that demands it.

| # | Capability | Demanded by |
|---|---|---|
| A | **Open / closed**, per ticket | wayfinder: *"a closed ticket is unambiguously off the frontier"* (`wayfinder/SKILL.md:101`); *"A ticket is **unblocked** when every ticket blocking it is closed"* (`:69`) |
| B | **Claimed, and by whom** — visible to a *parallel* session | *"A session **claims** a ticket by assigning it to the dev driving the map, **first**, before any work, so concurrent sessions skip it. That assignee _is_ the claim: an open, unassigned ticket is unclaimed."* (`wayfinder/SKILL.md:67`); *"The user may run unblocked tickets in parallel, so expect other sessions to be editing the tracker concurrently."* (`:128`) |
| C | **Blocked / unblocked**, natively and visibly | *"Blocking uses the tracker's **native** dependency relationship — essential because it renders the frontier _visually_ in the tracker's own UI, so the human sees what's takeable without opening the map."* (`wayfinder/SKILL.md:69`); to-tickets: *"Give each ticket its **blocking edges**"* (`to-tickets/SKILL.md:38`) |
| D | **Map vs ticket** — a kind marker | *"The map is a single issue on this repo's issue tracker, labelled `wayfinder:map` — the canonical artifact."* (`wayfinder/SKILL.md:21`) |
| E | **Ticket-belongs-to-map** | *"Its tickets are child issues of the map"* (`wayfinder/SKILL.md:21`); *"Each ticket is a **child issue** of the map; the tracker's issue id is its identity."* (`:57`) |
| F | **Ticket type** — a 4-value enum | *"Each ticket carries a `wayfinder:<type>` label — one of `research`, `prototype`, `grilling`, `task`"* (`wayfinder/SKILL.md:65`) |
| G | **Triage vocabulary** — **two category roles and five state roles**, exactly one of each | *"Two **category** roles: `bug`… `enhancement`"* + *"Five **state** roles: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`"* (`triage/SKILL.md:24-37`); *"Every triaged issue should carry exactly one category role and one state role. If state roles conflict, flag it and ask"* (`:41`). Note: **seven** label slots, not five — the ticket's summary undercounts. |
| H | **Durable prose records** — resolution answers, triage notes, agent briefs, and an AI disclaimer on every one | *"post the answer as a **resolution comment**"* (`wayfinder/SKILL.md:125`); *"Every comment or issue posted to the issue tracker during triage **must** start with this disclaimer"* (`triage/SKILL.md:13`); the agent-brief template is a ~40-line markdown comment (`triage/AGENT-BRIEF.md:41-68`) |
| I | **Long-form markdown body**, including checkbox acceptance criteria | `to-tickets/SKILL.md:84-103` (`## Acceptance criteria` / `- [ ] Criterion 1`); `to-spec/SKILL.md:21-75` (a whole PRD as one body) |
| J | **Deterministic frontier ordering** | *"Otherwise take the first frontier ticket in order"* (`wayfinder/SKILL.md:123`); *"first in map order wins"* (`issue-tracker-github.md:43`) |
| K | **Label-absence discovery**, and "reporter activity since last triage notes" | *"1. **Unlabeled** — never triaged. 2. **`needs-triage`**… 3. **`needs-info` with reporter activity since the last triage notes**"* (`triage/SKILL.md:58-62`) |
| L | **Frontier query** — open + unblocked + unclaimed, in as few calls as possible | *"the **frontier** is the open, unblocked, unclaimed children"* (`wayfinder/SKILL.md:69`); the GitHub contract does it as one list plus a per-issue dependency summary (`issue-tracker-github.md:43`) |

Two demands are **not** capabilities Favro must carry, and are recorded here so #15 does
not hunt for them:

- **PRs as a triage surface.** `triage/SKILL.md:11` and both remote tracker docs carry a
  "PRs as a request surface" flag, defaulted **off** (`issue-tracker-github.md:18`). Favro
  has no pull-request analogue at all, so the flag is permanently `no` and the whole
  `gh pr` half of the contract is vacuous. No carrier needed.
- **`.out-of-scope/` and `CONTEXT.md` / `docs/adr/`.** `triage/OUT-OF-SCOPE.md:3-17` and
  `domain-modeling/SKILL.md:10-40` both live in the **git repo**, never on the tracker.
  Favro carries nothing for them.

---

## 3. Carrier inventory

Nine candidate carriers, with the four properties measured once so the per-capability
tables can stay terse. "One call" means: present on a row of a single
`GET /cards?widgetCommonId=…` response (§1.3).

| Carrier | Write path | In one `GET /cards`? | Renders in UI? | Human can desync by dragging? |
|---|---|---|---|---|
| **column** (`columnId`) | `PUT /cards/:cardId {columnId}` (a) | **Yes** — `columnId` on every row (d) | **Yes** — Favro's UI calls the column a card's "status"; there is no separate status field (#13) | **Yes, trivially — dragging a card between columns *is* the write.** This is the carrier a human desyncs by accident |
| **tag** (`tags`) | `PUT {addTags:[name]}` / `{removeTags:[name]}`, or `addTagIds`/`removeTagIds` (a)(d). **`{tags:[…]}` silently no-ops** (d, §1.4-iii) | **Yes** — but as **tagIds**, not names (d) | Yes — coloured chips on the card | No. Dragging never edits tags |
| **assignment** (`assignments[].userId`) | `PUT {addAssignmentIds}` / `{removeAssignmentIds}` (a)(d) | **Yes** — `assignments` on every row (d) | Yes — avatars on the card | No — but see §1.4-i: assigning **forks a second card instance** onto the assignee's to-do list |
| **`assignments[].completed`** | `PUT {completeAssignments:[{userId,completed}]}` (a)(d, §1.4-iv) | **Yes** — nested in `assignments` (d) | Yes — per-assignee tick (e) inference | No |
| **custom field** (`customFields`) | `PUT {customFields:[{customFieldId,value}]}` (a); definitions read via `GET /customfields` (`src/lib/custom-fields-api.ts`) | **Yes** — `customFields` on every row, as `{customFieldId, value}` pairs with **no name** (d) | Yes — a named field on the card face | No |
| **dependency edge** (`dependencies[].isBefore`) | `POST /cards/:cardId/dependencies {dependencies:[{cardId,isBefore}]}` (a), verified live in #12 | **Yes — settled by §1.3** (d) | Yes, and this is *why* wayfinder wants it (capability C). **Direction settled 2026-08-13, both halves** — see the note below the table | No |
| **`parentCardId`** | `POST`/`PUT /cards` `{parentCardId}` (a); **same-widget only, never cross-board** (#4) | **Yes** — `parentCardId` on every row (d) | Yes — nesting under the parent | (c) unknown — whether dragging a child out of its parent clears `parentCardId`. Plausible and untested |
| **`archived`** | `PUT {archive:true}` (a)(d) | **Yes** — `archived` on every row; but the default list **includes** archived cards, so exclusion is client-side (d, §1.4-ii) | Yes — the card leaves the board view | (c) unknown — archiving is a menu action, not a drag; low risk |
| **comment** | `POST /comments {cardCommonId, comment}` (a); `src/api/comments.ts:100` | **No.** Comments are a separate endpoint keyed on **`cardCommonId`**, one call per card — **derived N** across a frontier | Yes — the card's comment thread | No |

### `isBefore` direction — settled 2026-08-13, both halves

Open since #1 and closed by the 4.0.0 live runs. On card X's row,
`{cardId: Y, isBefore: true}` means **Y blocks X**.

- **API half — measured.** Five edges across two live runs, both directions. The edge is
  stored on **both** cards, mirrored: the reverse row carries `isBefore: false` and a
  `reverseCardId`. `GET /cards` inlines the edge with the same four keys the dedicated
  endpoint returns — `{cardId, isBefore, cardCommonId, reverseCardId}` — and **neither
  carries `cardSequentialId`**. This confirms `dependency-direction.ts:21-27` live rather
  than by inference.
- **UI half — confirmed visually by the repo owner**, not by a payload. On the probe board,
  the blocked card files its blocker under waiting-on/blocked-by, matching the CLI's
  vocabulary. Recorded as human visual confirmation, since nothing here can reproduce it
  from a response.

The refutation case was named in advance and did not occur: had the UI filed the blocker
under *blocks/before*, `--blocked-by` would be writing edges backwards and every
`cards link --type blocks` in the wild would be reversed.

Consequence found while settling it: `normalizeInlinedDependency` had been **discarding the
`cardId`** off every inlined edge, so `blocked-by:` / `blocks:` matched only a
`cardCommonId` and silently returned nothing for the id `cards list` prints. Four comments
in the tree asserted the inlined edge could not carry it. Fixed under #162.

Two carriers the skills might expect that Favro does **not** have:

- **A card description field on a board or collection.** #13 probed both `collections get`
  and `boards get` and found no description field — so nothing Favro-side can hold the
  tracker's own configuration.
- **A tag scoped to a board.** `GET /tags` is a flat **org-wide** namespace
  (`src/lib/tags-api.ts:22-40`); the probe returned 100 tags on page one. Any
  `wayfinder:*` or triage tag pollutes every board in the organization.

---

## 4. One table per capability

Columns throughout: **W** = writable via API, **1** = returned by `GET /cards` in one
call, **UI** = renders in the Favro UI, **Desync** = a human can break it by dragging
cards.

### A. Open / closed

Skills need: a **binary, per-ticket** state where "closed" is unambiguous
(`wayfinder/SKILL.md:101`) and is the input to unblocked-ness (`:69`). Note wayfinder also
needs closed-ness on the *blocker*, not just the ticket in hand — which is what forces
this onto a one-call carrier.

| Candidate | W | 1 | UI | Desync | Notes |
|---|---|---|---|---|---|
| **column** (`done` columnId) | Yes | Yes | Yes — Favro's own "status" | **Yes** | #13 already chose this: two stored `columnId`s (`active`, `done`), ids not names, verified per call. Semantically the *right* fit; the drag hole is intrinsic — and here the drag is a **feature**, since a human moving a card to Done genuinely means it |
| `archived` | Yes | Yes | Yes | Low | Unambiguous boolean, no mapping to store — but archiving means "hide from the board", not "decided". Would hide closed tickets from the human's own view of the map, contradicting C's visual-frontier premise. Also §1.4-ii: the default list still returns them, so it saves no filtering |
| `assignments[].completed` | Yes | Yes | Yes (e) | No | Per-*assignee*, not per-card: a card with two assignees has two flags and no card-level answer. Wrong arity |
| tag (`closed`) | Yes | Yes (as tagId) | Yes | No | Drag-proof, but duplicates the column the human is already dragging — two sources of truth for one fact, and the tag is the one that silently rots |
| custom field (select) | Yes | Yes | Yes | No | Same duplication problem, plus `customFields` rows carry no field *name* (§3) so a `GET /customfields` call is needed to interpret them |
| dependency edge / `parentCardId` / comment | — | — | — | — | No plausible encoding |

### B. Claimed, and by whom — visible to a parallel session

Skills need: *"that assignee **is** the claim"*, written **first, before any work**, and
readable by a *different concurrent session* (`wayfinder/SKILL.md:67`, `:128`).

| Candidate | W | 1 | UI | Desync | Notes |
|---|---|---|---|---|---|
| **assignment** (`addAssignmentIds`) | Yes | Yes | Yes | No | Carries **both** facts the skill needs in one field — that it is claimed, and by whom. Literal match to *"assigning it to the dev driving the map"*. Cost: §1.4-i, the claim **forks a second card instance** onto the assignee's to-do list, so a `cardSequentialId` lookup goes from 1 to 2 entities the instant a ticket is claimed |
| `assignments[].completed` | Yes | Yes | Yes (e) | No | Adds a *third* state on top of assignment (unassigned / assigned-incomplete / assigned-complete) with no GitHub analogue. Tempting for "claimed but not finished", but only meaningful once an assignment exists, so it cannot carry claimed-ness alone |
| column (`Doing`) | Yes | Yes | Yes | **Yes** | Carries "worked on" but **not by whom** — fails the parallel-session requirement outright, since a second session cannot tell its own claim from another's |
| tag (`claimed`) | Yes | Yes | Yes | No | Carries claimed-ness but not the identity, unless one tag per dev — which pollutes the org-wide namespace (§3) and duplicates a field Favro already has |
| custom field (user type) | Yes | Yes | Yes | No | Would carry both facts and avoid the instance fork — at the cost of an invented field and a `GET /customfields` call to interpret it. Reinvents `assignments` |
| comment | Yes | **No** | Yes | No | Fails the one-call test, and a claim must be *cheap* to read for every frontier candidate |

### C. Blocked / unblocked

Skills need: the **native** relationship specifically, *"because it renders the frontier
visually in the tracker's own UI"*, with a body-text convention only as a fallback for
trackers that lack one (`wayfinder/SKILL.md:69`).

| Candidate | W | 1 | UI | Desync | Notes |
|---|---|---|---|---|---|
| **dependency edge** (`isBefore`) | Yes | **Yes — §1.3** | Yes | No | Favro's only native relationship (#4, #10). `isBefore:true` on card A pointing at B = "B blocks A" (`src/lib/dependency-direction.ts:21-27`). Was the blocker for a one-call frontier; §1.3 removes it. Residual: the edge gives the blocker's **cardId**, not its state — resolving state is free *only if the blocker is on the same board* (§5) |
| `parentCardId` | Yes | Yes | Yes | (c) | Already spoken for by capability E, and a card has one parent but many blockers. Wrong arity, and contending for a carrier E needs |
| tag (`blocked`) | Yes | Yes | Yes | No | Would be the body-convention fallback in tag form. Loses *who* blocks, does not render as a frontier, and needs a human or a second write to clear when the blocker closes — exactly the desync wayfinder is avoiding |
| body text (`Blocked by: …`) | Yes | Yes (`detailedDescription`, with `descriptionFormat`) | As prose | No | The skill's own explicit fallback — but Favro *has* a native edge, so `wayfinder/SKILL.md:69` forbids it here |
| column (`Blocked`) | Yes | Yes | Yes | **Yes** | Contends with A for the same carrier: a card is either in `Doing` or in `Blocked`, never both, so a blocked-in-progress ticket is unrepresentable |

### D. Map vs ticket

Skills need: a kind marker on exactly one card per effort, queryable
(`wayfinder/SKILL.md:21`).

| Candidate | W | 1 | UI | Desync | Notes |
|---|---|---|---|---|---|
| **tag** (`wayfinder:map`) | Yes | Yes (as tagId) | Yes | No | Direct transliteration of the GitHub contract's label. Cost: org-wide namespace pollution (§3), and reading it needs the tagId→name map, i.e. one extra bounded `GET /tags` |
| **`parentCardId` = null among siblings** | — | Yes | Yes | (c) | Free: the map is *the card the tickets point at*. No marker to provision, no tag to pollute. But it is inferential — any unparented card on the board looks like a map |
| custom field (select `map`/`ticket`) | Yes | Yes | Yes | No | Explicit, drag-proof, board-scoped — no org pollution. Costs a definition and a `GET /customfields` |
| column (a `Map` column) | Yes | Yes | Yes | **Yes** | Burns the carrier capability A needs, and a map has no open/closed of its own |
| `isLane` | (c) — docs describe it as read-facing | Yes | Yes | (c) | Favro's own "this card is a lane header" flag. Structurally map-like; not established as writable. Worth one probe if #15 wants it |

### E. Ticket-belongs-to-map

Skills need: *"Each ticket is a **child issue** of the map"* (`wayfinder/SKILL.md:57`), and
the frontier query must be scoped to *one* map's children (`issue-tracker-github.md:43`).

| Candidate | W | 1 | UI | Desync | Notes |
|---|---|---|---|---|---|
| **`parentCardId`** | Yes | Yes | Yes — nesting | (c) — untested whether a drag can clear it | The literal analogue of a GitHub sub-issue. Hard constraint from #4: **same-widget only, never cross-board** — so a map and all its tickets must live on one board, which is also exactly what makes the one-call frontier work (§5) |
| tag (`wayfinder:map-<slug>`) | Yes | Yes | Yes | No | Works across boards, which `parentCardId` cannot — at the price of a new org-wide tag per effort, unbounded growth of the namespace, and no UI nesting |
| dependency edge to the map | Yes | Yes | Yes | No | Contends with C for the same carrier and would make every ticket look blocked by (or blocking) the map |
| custom field (text = map cardId) | Yes | Yes | Yes | No | Cross-board capable and drag-proof; opaque in the UI, and needs `GET /customfields` |
| board = map | — | n/a | Yes | No | One board per effort makes membership free and the frontier query one call by construction. But it drops the map *card* — nothing holds the Destination / Decisions-so-far body (capability I), since #13 probed that boards have no description field |

### F. Ticket type (`research` / `prototype` / `grilling` / `task`)

Skills need: exactly one of four values per ticket, and it changes *how the session is
run* — AFK research fires a subagent, HITL types must not (`wayfinder/SKILL.md:65`, `:75-80`).

| Candidate | W | 1 | UI | Desync | Notes |
|---|---|---|---|---|---|
| **tag** (`wayfinder:research` …) | Yes | Yes (as tagId) | Yes | No | Direct transliteration. Four more org-wide tags, and nothing enforces "exactly one" |
| **custom field (single-select)** | Yes | Yes | Yes | No | Enforces exactly-one **structurally**, board-scoped so no org pollution, and reads as a labelled field in the UI. Costs a definition and a `GET /customfields` to map optionIds → names |
| column | Yes | Yes | Yes | **Yes** | Contends with A; type is not a workflow stage |
| `parentCardId` (four type-hub cards) | Yes | Yes | Yes | (c) | Contends with E |
| comment / body | Yes | body yes, comment no | prose | No | Unparseable-ish; no UI affordance |

### G. Triage vocabulary — two category roles + five state roles

Skills need: **seven** label strings, *"exactly one category role and one state role"*, a
state machine between them, and a conflict to be **flagged and asked about** rather than
resolved (`triage/SKILL.md:24-45`). Transitions are label swaps: `needs-info` → back to
`needs-triage` when the reporter replies.

| Candidate | W | 1 | UI | Desync | Notes |
|---|---|---|---|---|---|
| **tag** ×7 | Yes | Yes (as tagId) | Yes | No | #13 already chose this axis and has `tracker init` provisioning the vocabulary so `retag` refuses unknowns instead of typo-auto-creating. **Blocked today by §1.4-iii** — the repo's tag-write path is a silent no-op. Nothing enforces one-of-each, so `retag` must enforce the mutual exclusion itself |
| **two custom fields** (category select, state select) | Yes | Yes | Yes | No | Enforces exactly-one per axis structurally, and makes the two axes *separately* readable — which is what `triage/SKILL.md:41`'s "if state roles conflict" check is for. Board-scoped, no org pollution. Costs two definitions and a `GET /customfields` |
| column | Yes | Yes | Yes | **Yes** | Contends with A. Five states × two categories does not fit a workflow lane, and #13 already put open/closed here |
| `archived` for `wontfix` | Yes | Yes | Yes | Low | Partial only: `wontfix` also **closes** (`triage/SKILL.md:82`), so it needs A anyway, and the other six roles have no boolean |

### H. Durable prose records — resolution answers, triage notes, agent briefs

Skills need: an **append-only** record separate from the body, that survives on the ticket
(`wayfinder/SKILL.md:125`), starts with a mandated disclaimer (`triage/SKILL.md:13`), and
can hold a ~40-line structured brief (`triage/AGENT-BRIEF.md:41-68`). Also read back:
*"Parse any prior triage notes so you don't re-ask resolved questions"* (`triage/SKILL.md:70`).

| Candidate | W | 1 | UI | Desync | Notes |
|---|---|---|---|---|---|
| **comment** | Yes — `POST /comments {cardCommonId, comment}` | **No** — separate endpoint, `cardCommonId`-keyed, one call per card | Yes — the card's thread | No | The only true append-only carrier, and the only one with an author and a timestamp (`created`, `userId` on the raw shape — `src/api/comments.ts:21-32`; the docs also list `lastUpdated`). Its one-call failure is tolerable *here*: resolutions are written and read for **one** ticket at a time, not across a frontier. It becomes fatal only if a frontier query needs to read them (see K) |
| append to `detailedDescription` | Yes | Yes | Yes | No | One call, but read-modify-write: two concurrent sessions clobber each other, which is exactly the concurrency wayfinder warns about (`:128`). Also collides with capability I's body |
| custom field (text) | Yes | Yes | Yes | No | Not append-only; same clobber problem; no author, no timestamp |
| attachment | (a) `addDescriptionFiles` / `favroAttachments` | key present, content not | Yes | No | Wayfinder does say *"Assets created while resolving a ticket are linked from the issue, not pasted in"* (`:71`) — so attachments serve **assets**, not the resolution text itself |

### I. Long-form markdown body with checkboxes

Skills need: a whole PRD (`to-spec/SKILL.md:21-75`) or a ticket with `- [ ]` acceptance
criteria (`to-tickets/SKILL.md:95-98`) as the body, plus wayfinder's map body with four
named sections (`wayfinder/SKILL.md:31-53`).

| Candidate | W | 1 | UI | Desync | Notes |
|---|---|---|---|---|---|
| **`detailedDescription`** | Yes — `POST`/`PUT /cards` with `descriptionFormat:'markdown'` (a); `src/lib/cards-api.ts:536-538` | Yes, **only if `descriptionFormat` is passed** — the repo retries without it on failure (`src/lib/cards-api.ts:311-313`) | Yes | No | The obvious carrier. Not verified this session whether Favro's renderer keeps `- [ ]` as a **checkbox** or as literal text — (c)/(e) |
| Favro **tasks / tasklists** | Yes — `src/lib/tasks-api.ts`, `src/lib/tasklists-api.ts`, `cardCommonId`-keyed | **No** — separate endpoint. `tasksDone`/`tasksTotal` counters *are* on the row (d) | Yes — real checkboxes with progress | No | The native fit for `- [ ]` acceptance criteria, and the counters give a one-call progress read. Costs one call per card to read the items, and splits the body across two carriers |

### J. Deterministic frontier ordering

Skills need: *"take the **first** frontier ticket in order"* (`wayfinder/SKILL.md:123`),
*"first in map order wins"* (`issue-tracker-github.md:43`). GitHub gets this free from
monotonic issue numbers.

| Candidate | W | 1 | UI | Desync | Notes |
|---|---|---|---|---|---|
| **`sequentialId`** | implicit on create | Yes | Yes — the `CLA-1804` label humans hold | No | Monotonic, org-unique (#9). The closest analogue to a GitHub issue number, and the only order a human cannot silently change |
| `createdAt` | implicit | Yes | indirectly | No | Equivalent to `sequentialId` for ordering, less legible |
| `position` / `listPosition` / `sheetPosition` | via `PUT {position,…}` (a) | Yes — all three on the row (d) | Yes — it *is* the visible order | **Yes** — this is what a drag changes | Matches what the human *sees* as map order, which is arguably more faithful to "map order". Directly desyncable, which for ordering may be a feature |

### K. Label-absence discovery, and reporter activity since last triage

Skills need three buckets: never-triaged (**no** state label), `needs-triage`, and
*"`needs-info` **with reporter activity since the last triage notes**"* (`triage/SKILL.md:58-62`).

| Candidate | W | 1 | UI | Desync | Notes |
|---|---|---|---|---|---|
| tag absence | n/a | Yes | Yes | No | `GET /cards` has **no tag filter** (§5), so "no state tag" is a client-side predicate over one board list. Fine — the list is bounded |
| custom field unset | n/a | Yes | Yes | No | Same shape; an unset select reads as absent on the row |
| **comment timestamps** | Yes | **No** | Yes | No | Bucket 3 needs *"activity since the last triage notes"* — i.e. compare the newest comment's `created` against the newest AI-authored comment's `created`. That is **one `GET /comments` per candidate card** = **derived N**, banned by #11. This capability has **no bounded carrier** |
| `GET /activity` (`src/lib/activity-api.ts`) | n/a | No | Yes | No | An org- or card-scoped feed rather than a per-card fetch — the only shape that could make bucket 3 bounded. Not investigated this session; flagged for #15 |

### L. Frontier query — open + unblocked + unclaimed, in fewest calls

Skills need one query returning the takeable set (`wayfinder/SKILL.md:69`,
`issue-tracker-github.md:43`), judged against #11's rule: **enumerated N (cap 20) allowed,
derived N fan-out banned**.

| Composition | Calls | Bounded? | Notes |
|---|---|---|---|
| **`GET /cards?widgetCommonId=<tracker board>`** | **1** | Yes | Returns, per row: `columnId` (open/closed), `assignments` (claimed + by whom), `dependencies` (blockers, **§1.3**), `parentCardId` (map membership), `tags` (as tagIds), `archived`, `customFields`, and three position fields. Blocker *state* resolves **within the same response** because #4 forces map and tickets onto one board (capability E) — so every blocker's row is already in hand. Client-side filtering only |
| … `+ GET /tags` | 2 | Yes — bounded, paginated | Needed **only if** the triage vocabulary or type enum lives on tags, to map tagIds → names. #3 established tag lookups are one bounded GET |
| … `+ GET /customfields?widgetCommonId=…` | 2 | Yes — bounded | Needed only if type / vocabulary lives on custom fields, to map `customFieldId` and optionIds → names |
| … `+ GET /comments` per candidate | 1 + N | **No — derived N** | Banned. Any capability that reads comments across the frontier (K bucket 3) is out |
| … `+ GET /cards/:cardId/dependencies` per candidate | 1 + N | **No — derived N** | **No longer needed** — this is precisely what §1.3 eliminated |
| … `+ GET /cards?cardId=<blocker>` for off-board blockers | 1 + N | **No — derived N** | The residual hole: a dependency edge may point at a card on **another board**, whose state is not in the response. See §6 |

Per the cost model (#6, #11), calls 1–2 are all inside one CLI invocation, so the agent
still made **one call**. The one-call frontier is **achievable**.

---

## 5. Supply-side constraints that shape every row

1. **`GET /cards` requires at least one filter**, and the documented set is
   `widgetCommonId`, `collectionId`, `columnId`, `cardCommonId`, `cardSequentialId`,
   `unique`, `archived`, `descriptionFormat`, `todoList` (a, re-confirmed §1). **There is
   no tag filter, no assignee filter, and no custom-field filter.** Every
   vocabulary-based selection is a client-side predicate over a board- or
   collection-scoped list. Bounded, so allowed — but it means a tag can never *narrow* a
   query, only annotate a row.
2. **One board per map, forced.** `parentCardId` is same-widget only (#4). If E uses it,
   the map and all its tickets share one board — which is exactly what makes L's one call
   sufficient, since every blocker's row arrives in the same response.
3. **Dependency edges are not board-scoped.** They take a `cardId` on both ends (#4), so
   an edge *can* point off-board. Nothing prevents it, and such a blocker's state is
   absent from the one-call response.
4. **Tags are org-wide** (`src/lib/tags-api.ts:22-40`, 100 on page one). Every
   `wayfinder:*` and triage tag is visible on every board in the organization.
5. **`customFields` rows are id-only.** A row carries `{customFieldId, value}` with no
   name and, for selects, an optionId rather than a label (d). Interpreting them always
   costs one extra bounded call.
6. **Comments and tasks are `cardCommonId`-keyed separate endpoints** (#2,
   `src/api/comments.ts:100`), so neither can ever be part of a one-call frontier.
7. **`normalizeCard` is lossy in ways that matter here.** It reads `raw.status` — a field
   Favro never sends (`src/lib/cards-api.ts:40`) — and drops `assignments[].completed`
   (`:42`), `dependencies`, `archived`-vs-column distinctions, `position`/`listPosition`,
   `tasksDone`/`tasksTotal` and `timeOnColumns`. Every capability above that reads a row
   needs a normalizer that keeps those fields.
8. **`updateCard` does not translate `tags`** (§1.4-iii), and has no `archive` mapping at
   all (`src/lib/cards-api.ts:535-551`). Two of the nine carriers are unwritable through
   the repo's current library.

---

## 6. Open tensions for #15

Where the reading points somewhere, it is marked as a **lean** — not a decision.

1. **What the probe settled.** `GET /cards` **does** inline populated `dependencies`
   (§1.3). The one-call frontier is live, `add-blocking-edge` stays the blocked/unblocked
   carrier, and the *"blocked is unrepresentable in the one call a frontier query gets"*
   premise deferred out of #13 is **false** and should be struck. Also settled: the wire
   key is `cardCommonId` (not the docs' `cardCommonKey`) and its value is the **far**
   card's commonId — closing open question 2 of `dependencies-and-parent-child-semantics.md`.

2. **The column is contended by four capabilities.** A (open/closed), B (claimed, as
   `Doing`), C (blocked, as a `Blocked` column) and G (triage state) all fit a column, and
   a card has exactly one. #13 already gave the column to **A**. Lean: that holding is
   right and the other three must go elsewhere — but note the consequence, that a
   *blocked* ticket and a *doing* ticket become indistinguishable in the UI column the
   human actually looks at, which is a real loss against C's visual-frontier premise.

3. **Tag vs custom field for the two enums (F, G) is genuinely open.** Tags transliterate
   the GitHub contract and #13 already committed to them; custom fields enforce
   exactly-one structurally, stay board-scoped instead of polluting the org-wide
   namespace, and separate the category axis from the state axis so `triage/SKILL.md:41`'s
   conflict check has something to check. Both cost one extra bounded call to resolve
   ids → names, so the cost model does not break the tie. No lean.

4. **B's carrier is decided by the skill and paid for by Favro.** *"That assignee is the
   claim"* leaves no room: **assignment**. The price is §1.4-i — every claim forks a
   second card instance onto the assignee's to-do list, so any `cardSequentialId`-based
   resolution must pick the **board instance** deliberately, not `entities[0]`. #13
   already ruled `claim`/`resolve` act on the tracker-board instance; this probe shows the
   fork is *caused by claiming itself*, so the rule is load-bearing, not defensive.

5. **`assignments[].completed` has no consumer.** It is real, writable, one-call, and has
   no GitHub analogue — and no skill asks for a third state between claimed and closed.
   Lean: surface it (the field-surface gap at `src/lib/cards-api.ts:42` is worth fixing
   regardless) but give it **no contract meaning**. Inventing a state the skills don't
   have is how a tracker contract drifts.

6. **Capability K bucket 3 has no bounded carrier.** *"`needs-info` with reporter activity
   since the last triage notes"* requires comparing comment timestamps per candidate =
   derived N. Options for #15: drop the bucket for Favro, degrade it to "all `needs-info`
   cards, newest first", or investigate whether `GET /activity`
   (`src/lib/activity-api.ts`) can supply it in one bounded call. Not investigated here.

7. **D and E contend for `parentCardId`.** If ticket-belongs-to-map is `parentCardId`
   (E), then "the unparented card among siblings" is *already* the map (D) and needs no
   marker — elegant, but it means any stray unparented card on the board reads as a map.
   A `wayfinder:map` tag is explicit and cheap. No lean; the two options differ in failure
   mode, not cost.

8. **Off-board blockers break the one call.** Dependency edges are not board-scoped
   (§5.3), so an edge pointing off the tracker board makes blocker state a derived-N
   fetch. Lean: `add-blocking-edge` should **refuse a cross-board edge** on a tracker
   board, preserving the one-call guarantee by construction rather than paying for it at
   read time. That is a decision for #15, and it is a *new* constraint on the #10 intent.

9. **Two carriers are unwritable through this repo today.** `PUT {tags:[…]}` silently
   no-ops (§1.4-iii) and `updateCard` has no `archive` mapping. Whichever way #15 decides
   G, the tag write path must be fixed first or `retag` reports success while changing
   nothing. This is the same class of bug as #12's `linkCard`, in a path #13 already
   depends on.

10. **Body vs tasks for acceptance criteria (I) is unresolved and untested.** Whether
    Favro renders `- [ ]` in `detailedDescription` as a real checkbox is (e) — it needs
    eyes on the UI. If it does not, `to-tickets`' acceptance criteria want Favro
    **tasklists**, which splits the ticket body across two `cardCommonId`-keyed carriers.

11. **PRs, `.out-of-scope/` and `CONTEXT.md` need no carrier** (§2). #15 should record
    that explicitly rather than leave a gap that reads as unfinished.

---

## 6b. Two write-path measurements for #168 — 2026-08-14

Raw axios, not `FavroHttpClient`: #165's rule refuses a message-carrying 2xx before a
caller sees it, and the question was what the wire says. Org
`b0b311ac98a0250191573541`, board `5dd75f0d5116020817ebe70a` (`Kanban`), three
throwaway cards prefixed `probe: #168`, each deleted with `?everywhere=true` (200) and
the follow-up `GET` verified **403**, which is this org's answer for a card that is gone
(§1.4's closing note).

### (i) An out-of-range DAY is rolled over silently; an out-of-range MONTH is refused

| request | status | `message` | echoed / stored `dueDate` |
|---|---|---|---|
| `PUT /cards/:id {dueDate:"2026-02-30"}` | **200** | *(none)* | `"2026-03-02T00:00:00.000Z"` |
| `GET /cards/:id` after it | 200 | *(none)* | `"2026-03-02T00:00:00.000Z"` |
| `PUT /cards/:id {dueDate:"2026-13-01"}` | **202** | `"Invalid date"` | no card row; stored value unchanged |
| `PUT /cards/:id {dueDate:"not-a-date"}` | **202** | `"Invalid date"` | no card row; stored value unchanged |

Measurement: the rollover is **server-side** — the CLI does no date parsing on this path
(`setDueDate` → `updateCard` → PUT sends the digits given) — and it is confined to a day
past the end of a valid month. The two `202`s carry a message, so #165's rule already
turns those into refusals. `2026-02-30T00:00:00.000Z` (an impossible day inside a full
ISO timestamp) was **not** probed.

### (ii) A column move un-archives the card, and the un-archive is in the write's own echo

Two runs. The first sent `PUT {columnId}` alone and answered `202 "Access denied"` on an
archived card — but the polarity run showed the same `202` on an **unarchived** card, so
that reproduced this repo's existing #162 measurement (Favro resolves `columnId` against
`widgetCommonId`; a column with no board has nothing to resolve against) and said nothing
about archiving. The second run used the body `updateCard` actually sends:

| step | request | status | `message` | `archived` | `columnId` |
|---|---|---|---|---|---|
| A | `PUT {columnId:Doing, widgetCommonId}` | 200 | *(none)* | `false` | `Doing` |
| B | `PUT {archive:true}` | 200 | *(none)* | **`true`** | `Doing` |
| B′ | `GET /cards/:id` | 200 | *(none)* | **`true`** | `Doing` |
| C | `PUT {columnId:Todo, widgetCommonId}` | **200** | *(none)* | **`false`** | `Todo` |
| C′ | `GET /cards/:id` | 200 | *(none)* | `false` | `Todo` |

Measurement: step C's own response already reads `archived:false`, so the un-archive is
the **column write**, not a read-back that follows it — the question #168 asked. It
carries no `message` and an ordinary 200, so nothing at the wire can see it, and
`moveColumn`'s `columnId` comparison passes because the move genuinely landed.

Also measured in the same run, and consistent with §1.4 (ii)/(iii)'s family:
`PUT {archived:true}` — the READ-side spelling used as a write — answers **200** and
leaves `archived:false`. And `PUT {archive:true}` on a card that has already been moved
sticks (200, `archived:true`), which is what makes re-archiving a viable inverse.

---

## 7. Sources consulted

Demand side, read in full:

- `~/.claude/skills/wayfinder/SKILL.md`
- `~/.claude/skills/to-tickets/SKILL.md`
- `~/.claude/skills/to-spec/SKILL.md`
- `~/.claude/skills/triage/SKILL.md`, `AGENT-BRIEF.md`, `OUT-OF-SCOPE.md`
- `~/.claude/skills/domain-modeling/SKILL.md`, `ADR-FORMAT.md`, `CONTEXT-FORMAT.md`
- `~/.claude/skills/setup-matt-pocock-skills/SKILL.md`, `issue-tracker-github.md`,
  `issue-tracker-gitlab.md`, `issue-tracker-local.md`, `triage-labels.md`

Supply side:

- <https://favro.com/developer/> — sections read: "Get all cards", "Create a card",
  "Update a card", the Card entity, "Card assignment", "Card custom field parameters",
  "Card dependency" / "Card dependency option", the dependency endpoints, "Get all
  comments", "Create a comment", "Get all tags".
- `src/lib/cards-api.ts`, `src/lib/tags-api.ts`, `src/api/comments.ts`,
  `src/lib/custom-fields-api.ts`, `src/lib/dependency-direction.ts`,
  `src/lib/query-parser.ts`, `src/api/context.ts`, `src/commands/cards-update.ts`
- Prior research in this repo: `docs/research/dependencies-and-parent-child-semantics.md`;
  established facts from issues #2, #3, #4, #6, #9, #10, #11, #12, #13 via the map (#1).

Live probes (§1), run through this repo's own `client-factory` / `FavroHttpClient` against
the real organization, inside the scope-locked `🤖 AI` collection, on three throwaway
cards — all deleted with `?everywhere=true` and verified gone. No secondary sources.
