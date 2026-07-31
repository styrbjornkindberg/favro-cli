# Favro card identifiers: `cardId` vs `cardCommonId` vs `sequentialId`

- **Issue:** <https://github.com/styrbjornkindberg/favro-cli/issues/2>
- **Date:** 2026-07-31
- **Primary source:** <https://favro.com/developer/> (single-page doc; sections cited by anchor)
- **Secondary source:** this repository (paths are repo-relative, `file:line`)

Citation convention used throughout:

- **Documented** — stated on <https://favro.com/developer/>.
- **Docs silent; inferred from …** — not stated by Favro; conclusion drawn from code or from
  the shape of the documented API. Treat as a hypothesis, not fact.

---

## 1. Definitions

### 1.1 `cardId` — one card *instance* on one widget

Documented, Cards section (<https://favro.com/developer/#cards>): the Card object's `cardId` is
described only as *"The id of the card"*. That gloss is misleading on its own; the meaning comes
from the surrounding API surface:

- Every card-mutating path is keyed on it: `PUT /cards/:cardId`, `DELETE /cards/:cardId`,
  `GET /cards/:cardId`, `GET /cards/:cardId/dependencies`, `GET /cards/:cardId/activities`
  (documented, Cards / Dependencies / Activities sections).
- `GET /cards` accepts `cardCommonId` as a filter **and** a separate `unique` boolean documented as
  *"Return unique cards only"* (documented, Cards → Get all cards).

A `unique` flag only makes sense if the unfiltered result set contains **several rows per logical
card**. Combined with `cardCommonId` being *"A shared id for all instances of this card in the
organization"* (documented, below), the operative reading is:

> `cardId` identifies **one instance of a card on one widget** (board or backlog). A card placed on
> three boards has three `cardId`s and one `cardCommonId`.

*Docs silent on the phrase "instance"; inferred from the `unique` parameter's documented purpose
plus the `cardCommonId` definition.* The repo already encodes this reading:
`src/lib/cards-api.ts:85` (`cardCommonId — stable ID across widgets`),
`src/commands/init.ts:245` (`Cards may have different cardIds across boards`),
`src/lib/widgets-api.ts:24`.

### 1.2 `cardCommonId` — the logical card, across all its board instances

Documented verbatim, Cards section: **"A shared id for all instances of this card in the
organization."**

Consequences that matter and are load-bearing for this repo:

- It is **org-scoped**, not board-scoped.
- It is the key for everything *attached to the card as a concept* rather than to a board placement:
  comments, tasks, tasklists (documented — see the table in §2).
- **It is never a path parameter.** There is no `GET /cards/:cardCommonId`, no
  `PUT /cards/:cardCommonId`. It appears only as a query filter on `GET /cards` and as a query
  filter / body field on the comment, task and tasklist endpoints. This single fact explains most of
  the scar tissue in §3.
- `cardId` and `cardCommonId` are **different keyspaces with identical surface syntax** — both are
  24-char hex. Nothing in a string tells you which one you hold. `src/api/comments.ts:106-108`
  states this explicitly as the reason for its probe-then-fallback resolver.

### 1.3 `sequentialId` — the human-readable counter

Documented, Cards section: the Card object carries `sequentialId` (number), described as
*"Useful for creating human readable links"*.

Two distinct things share the name:

| Thing | Form | Where it lives |
|---|---|---|
| `sequentialId` field | number, e.g. `8850` | Card object (documented) |
| Human label | `Squ-8850`, `CLA-1804` | Favro web UI and card URLs — **not** a documented API field |
| `cardSequentialId` | query param, number | `GET /cards` filter (documented, Cards → Get all cards) |

The `Squ` / `CLA` prefix is what the issue calls `sequentialIdPrefix`. **The Favro docs never
mention `sequentialIdPrefix`, nor any field carrying the prefix** (verified: no occurrence in the
Cards or Widgets sections as fetched). The repo does not model it either — `src/lib/cards-api.ts:212`
matches `/(\d+)\s*$/` and **discards the prefix entirely**, keeping only the trailing digits. See
§3.4 for why that is a latent bug.

Whether `sequentialId` is unique org-wide, or only unique *within a prefix*, is **not documented**
and could not be established. This is the single most consequential open question in this document
(§5).

---

## 2. Per-endpoint identifier table

Every Favro endpoint this codebase issues a request to. "Identifier" is the *card* identifier the
endpoint consumes; endpoints that take no card identifier are listed for completeness because the
issue asks for full coverage of what favro-cli touches.

Base URL is `https://favro.com/api/v1` (documented, Routing). All requests additionally require the
`organizationId` header (documented, Authentication).

### 2.1 Cards

| Method + path | Card identifier | Where | Source |
|---|---|---|---|
| `GET /cards` | `cardCommonId`, `cardSequentialId`, `widgetCommonId`, `collectionId`, `columnId`, `unique`, `archived`, `todoList`, `descriptionFormat` | query params | Docs, Cards → Get all cards. Code: `src/lib/cards-api.ts:541`, `:547`, `:531`; `src/lib/widgets-api.ts:64` |
| `GET /cards/:cardId` | **`cardId`** | path | Docs, Cards → Get a card. Code: `src/lib/cards-api.ts:337`, `:344`, `:385`, `:391`; `src/api/comments.ts:127` |
| `POST /cards` | none (creates one); targets a board via `widgetCommonId` | body | Docs, Cards → Create a card. Code: `src/lib/cards-api.ts:488` |
| `PUT /cards/:cardId` | **`cardId`** | path | Docs, Cards → Update a card. Code: `src/lib/cards-api.ts:470`, `:513`; `src/lib/widgets-api.ts:82` |
| `DELETE /cards/:cardId` | **`cardId`** (+ `everywhere` to remove all instances) | path / query | Docs, Cards → Delete a card. Code: `src/lib/cards-api.ts:517` |
| `GET /cards/:cardId/dependencies` | **`cardId`** | path | Docs, Dependencies. Code: `src/lib/cards-api.ts:415`, `:436` |
| `POST /cards/:cardId/dependencies` | **`cardId`** | path | Docs, Dependencies. Code: `src/lib/cards-api.ts:445` |
| `DELETE /cards/:cardId/dependencies/:dependencyCardId` | **`cardId`** ×2 | path | Docs, Dependencies. Code: `src/lib/cards-api.ts:455` |
| `DELETE /cards/:cardId/dependencies` | **`cardId`** | path | Docs, Dependencies. Code: `src/lib/cards-api.ts:462` |
| `POST /cards/:cardId/attachments` | **`cardId`** per docs | path | Docs, Attachments → Upload a file to card. Code passes a variable named `cardCommonId`: `src/lib/attachments-api.ts:19`, `:39` — **mismatch, see §3.5** |
| `GET /cards/search` | — | — | **Not in the Favro docs.** Code: `src/lib/cards-api.ts:568`, `:575`. See §3.6 |
| `POST /cards/bulk` | — | — | **Not in the Favro docs.** Code: `src/lib/cards-api.ts:492`. See §3.6 |

### 2.2 Comments — `cardCommonId` only

| Method + path | Card identifier | Where | Source |
|---|---|---|---|
| `GET /comments` | **`cardCommonId` (required)** | query param | Docs, Comments → Get all comments. Code: `src/lib/comments-api.ts:64,71`; `src/api/comments.ts:63,72`; `src/lib/cards-api.ts:423` |
| `POST /comments` | **`cardCommonId`** | body field | Docs, Comments → Create a comment. Code: `src/lib/comments-api.ts:98,101`; `src/api/comments.ts:99` |
| `GET /comments/:commentId` | `commentId` | path | Docs, Comments. Code: `src/api/comments.ts:141` |
| `PUT /comments/:commentId` | `commentId` | path | Docs, Comments. Code: `src/api/comments.ts:153` |
| `DELETE /comments/:commentId` | `commentId` | path | Docs, Comments. Code: `src/api/comments.ts:162` |
| `POST /comments/:commentId/attachments` | `commentId` | path | Docs, Attachments. Code: `src/lib/attachments-api.ts:59` |

The Comment object itself carries `cardCommonId` and no `cardId` (documented, Comments section) —
which is why `src/lib/comments-api.ts:41` maps `raw.cardCommonId` into its own `cardId` field.

### 2.3 Tasks and tasklists — `cardCommonId` only

| Method + path | Card identifier | Where | Source |
|---|---|---|---|
| `GET /tasks` | **`cardCommonId` (required)**; `taskListId` optional | query params | Docs, Tasks → Get all tasks. Code: `src/lib/tasks-api.ts:29,35`; `src/lib/cards-api.ts:350` |
| `POST /tasks` | required body is **`taskListId` + `name`** (docs); `cardCommonId` is *not* documented as required | body | Docs, Tasks → Create a task. Code sends `cardCommonId` too: `src/lib/tasks-api.ts:55` — harmless surplus, see §3.7 |
| `PUT /tasks/:taskId` | `taskId` | path | Docs, Tasks. Code: `src/lib/tasks-api.ts:64` |
| `DELETE /tasks/:taskId` | `taskId` | path | Docs, Tasks. Code: `src/lib/tasks-api.ts:68` |
| `GET /tasklists` | **`cardCommonId` (required)** | query param | Docs, Tasklists → Get all tasklists. Code: `src/lib/tasklists-api.ts:25,31` |
| `GET /tasklists/:taskListId` | `taskListId` | path | Docs, Tasklists. Code: `src/lib/tasklists-api.ts:48` |
| `POST /tasklists` | `cardCommonId` + `name` | body | Docs, Tasklists. Code: `src/lib/tasklists-api.ts:52,54` |
| `PUT /tasklists/:taskListId` | `taskListId` | path | Docs, Tasklists. Code: `src/lib/tasklists-api.ts:58` |
| `DELETE /tasklists/:taskListId` | `taskListId` | path | Docs, Tasklists. Code: `src/lib/tasklists-api.ts:62` |

The Task object carries `cardCommonId` and `taskListId`, no `cardId` (documented, Tasks section) —
matching `src/lib/tasks-api.ts:8` and `src/lib/tasklists-api.ts:6`.

### 2.4 Widgets (boards) — `widgetCommonId`, no card identifier

| Method + path | Identifier | Where | Source |
|---|---|---|---|
| `GET /widgets` | `collectionId`, `archived` — **`cardCommonId` is NOT a documented parameter** | query params | Docs, Widgets → Get all widgets. Code: `src/lib/boards-api.ts:187`, `:253`; `src/lib/widgets-api.ts:32,38` passes `cardCommonId` — **see §3.3** |
| `GET /widgets/:widgetCommonId` | `widgetCommonId` | path | Docs, Widgets. Code: `src/lib/boards-api.ts:200`, `:213`; `src/lib/safety.ts:52` |
| `POST /widgets` | — | body | Docs, Widgets. Code: `src/lib/boards-api.ts:282`, `:287` |
| `PUT /widgets/:widgetCommonId` | `widgetCommonId` | path | Docs, Widgets. Code: `src/lib/boards-api.ts:293` |
| `DELETE /widgets/:widgetCommonId` | `widgetCommonId` | path | Docs, Widgets. Code: `src/lib/boards-api.ts:298` |

Documented widget `type` values are **`"backlog"`** and **`"board"`** only (docs, Widgets → widget
object). There is no `"card"` widget type. This matters for §3.3.

### 2.5 Columns, collections, tags, users, custom fields, webhooks — no card identifier

| Method + path | Identifier | Source |
|---|---|---|
| `GET /columns` (query `widgetCommonId`) | `widgetCommonId` | Docs, Columns. Code: `src/lib/columns-api.ts:35` |
| `GET/POST/PUT/DELETE /columns/:columnId` | `columnId` | Docs, Columns. Code: `src/lib/columns-api.ts:55,66,73,80` |
| `GET /collections`, `GET/POST/PUT/DELETE /collections/:collectionId` | `collectionId` | Docs, Collections. Code: `src/lib/collections-api.ts:45,66,73,80,84`; `src/lib/boards-api.ts:313,326,330,334,338`; `src/commands/init.ts:217` |
| `POST/DELETE /collections/:collectionId/boards/:boardId` | `collectionId`, `widgetCommonId` | **Not in the Favro docs.** Code: `src/lib/boards-api.ts:342`, `:346`. See §3.6 |
| `GET /tags`, `POST /tags`, `PUT/DELETE /tags/:tagId` | `tagId` | Docs, Tags. Code: `src/lib/tags-api.ts:34,58,62,66` |
| `GET /users`, `GET /users/:userId` | `userId` | Docs, Users. Code: `src/lib/users-api.ts:40`; `src/api/members.ts:66`; `src/lib/config.ts:151`; `src/commands/auth.ts:212` |
| `GET /organizations` | — | Docs, Organizations. Code: `src/commands/auth.ts:60`, `:171` |
| `GET /customfields`, `GET /customfields/:customFieldId` (query `widgetCommonId`) | `customFieldId`, `widgetCommonId` | Docs, Custom fields. Code: `src/lib/custom-fields-api.ts:195`, `:196` |
| `GET /webhooks`, `POST /webhooks`, `DELETE /webhooks/:webhookId` | `webhookId` | Docs, Outgoing webhooks. Code: `src/api/webhooks.ts:121`, `:146` |
| `GET/POST/PUT/DELETE /usergroups[/:groupId]` | `groupId` | Docs name the path **`/groups`**, not `/usergroups`. Code: `src/lib/users-api.ts:71,88,94,98,102`. See §3.6 |
| `POST /members`, `DELETE /members/:memberId` | `memberId` | **Not in the Favro docs.** Code: `src/api/members.ts:93`, `:101`. See §3.6 |
| `GET /boards/:boardId/activity` | `widgetCommonId` | **Not in the Favro docs** — the documented activity endpoint is `GET /cards/:cardId/activities`. Code: `src/lib/activity-api.ts:128`. See §3.6 |

### 2.6 The one-line rule

> **Anything addressed by URL path takes `cardId`. Anything attached to the card as a concept —
> comments, tasks, tasklists — takes `cardCommonId`, and only ever as a query param or body field.
> `cardCommonId` is never a path segment.**

---

## 3. The scar tissue, explained

### 3.1 `src/lib/comments-api.ts:53` — comments require `cardCommonId`

The code comment is **correct and matches the docs**. `GET /comments` documents `cardCommonId` as a
*required* query parameter (docs, Comments → Get all comments), and the Comment object has no
`cardId` field at all.

Why Favro designed it this way follows from §1.2: a comment belongs to the card as a concept. If
comments were keyed on `cardId`, the same discussion thread would fragment across every board the
card sits on. Keying on `cardCommonId` means one thread, visible from every instance.

Same reasoning applies to tasks and tasklists — and indeed those are keyed identically (§2.3). The
comment at `src/lib/comments-api.ts:6-7` is the most accurate piece of documentation in the repo on
this topic.

### 3.2 `src/cli.ts:815` and `src/cli.ts:844` — `card.cardCommonId ?? cardId`

```
815:        const cardCommonId = card.cardCommonId ?? cardId;
844:        const cardCommonId = card.cardCommonId ?? cardId;
```

**When the fallback is wrong: always, if it ever fires.** `cardId` and `cardCommonId` are disjoint
keyspaces (§1.2). Substituting one for the other is not a degraded guess — it is a different key. It
cannot accidentally be right except by hash collision.

What actually happens on each site:

- **`:815` (tasks, read).** `GET /tasks?cardCommonId=<a cardId>` returns an empty `entities` array
  rather than an error. The surrounding `try { … } catch { /* best effort */ }`
  (`src/cli.ts:816-824`) then swallows nothing, because nothing threw — the code simply concludes
  `tasks.length === 0` and **silently skips the checklist warning** at `src/cli.ts:821-822`. The user
  then appends to the description and Favro escapes their checklist items, which is exactly the
  failure the warning exists to prevent. A wrong identifier here degrades into a missing safety
  warning, with no diagnostic.
- **`:844` (comments, write).** `POST /comments` with a bogus `cardCommonId` is a *write*. Best case
  it 404s; worst case it creates an orphaned comment against a nonexistent common card. This is the
  more dangerous of the two.

**Does the fallback ever fire in practice?** `card` comes from `api.getCard(cardId)` at
`src/cli.ts:810` → `GET /cards/:cardId`, and `cardCommonId` is a documented field of the Card object,
so in normal operation `card.cardCommonId` is populated and the `??` branch is dead. Note the type is
optional at `src/lib/cards-api.ts:86` (`cardCommonId?: string`), so TypeScript demands *some*
handling.

The defect is therefore not "this fires and breaks things daily" — it is that **the chosen handling
converts a should-never-happen condition into a silently wrong API call instead of a loud error.**
The correct handling is to throw: if `getCard` returned a card without a `cardCommonId`, no
comment/task operation on it is well-defined.

**Two sibling sites have the same bug or worse:**

- `src/lib/cards-api.ts:347` — `const cardCommonId = rawCard.cardCommonId ?? rawCard.cardId;` then
  `GET /tasks?cardCommonId=…` at `:350`. Identical pattern, identical silent-empty failure, which
  here means `getRawDescription` fails to strip injected checklist lines.
- `src/lib/cards-api.ts:421-424` — **worse, and unconditional:**

  ```
  421:        // Favro: GET /comments?cardCommonId=<cardId>
  423:          params: { cardCommonId: cardId }
  ```

  No fallback, no resolution — it passes a `cardId` as `cardCommonId` every single time. The code
  comment at `:421` even spells the bug out. So `favro cards get <id> --include comments` returns an
  empty comment list for every card, and the `try/catch` at `:419-426` hides it. This is the highest
  -value fix uncovered by this research and is not currently listed in issue #2.

For contrast, `src/api/comments.ts:110-134` (`resolveCardCommonId`) is the one place that handles the
ambiguity deliberately: probe `GET /comments?cardCommonId=X&limit=1`, and if that does not look
right, fall back to `GET /cards/X` and read `cardCommonId` off the card. It costs an extra round trip
and its success test is weak (`response.entities !== undefined` is true for an empty result, so a
valid-but-unrelated `cardId` passed as `cardCommonId` returns `{entities: []}` and the probe
wrongly declares success) — but the *intent* is right and the fallback direction is the cheap one
(§4.3).

### 3.3 `src/lib/widgets-api.ts:61` — the cardCommonId → cardId re-fetch

```
60:  async addWidgetToBoard(boardId: string, cardCommonId: string, columnId?: string) {
61:    // Step 1: Resolve cardCommonId → cardId by fetching any instance
62-65:  GET /cards?cardCommonId=<x>&unique=true
71:     const cardId = res.entities[0].cardId;
82:     PUT /cards/${cardId}  { widgetCommonId: boardId, dragMode: 'commit' }
```

**What the re-fetch is really doing.** It is not a lookup for data — the response body is almost
entirely discarded. It exists purely to cross the keyspace boundary described in §2.6: the operation
that adds a card to a board is `PUT /cards/:cardId`, and **`cardCommonId` is not a legal path
segment anywhere in the Favro API**. The public entry point `favro widgets add <boardId>
<cardCommonId>` (`src/commands/widgets.ts:49`) accepts a `cardCommonId` by design, so *some*
translation must happen, and `GET /cards?cardCommonId=…` is the only documented way to do it.

**Is it necessary? Yes, given the input.** There is no cheaper documented route. It costs exactly one
extra GET.

**Is it correct?** Mostly, with one soft spot. `unique: true` collapses the multi-instance result to
one row, and `entities[0]` then picks an **arbitrary** instance — the docs do not specify an ordering,
so which board's instance you get is undefined. For this specific call that is tolerable, because
`dragMode: 'commit'` *adds* the card to the target board without removing it from the source
(as the comment at `:57-58` states). The identity of the source instance therefore does not change
the outcome. If the same resolve-then-PUT pattern were reused for an operation that *moves* rather
than commits — e.g. `moveCard` at `src/lib/cards-api.ts:468-474`, which sends `widgetCommonId`
without `dragMode` — picking an arbitrary source instance would move a card off a board the caller
never named. *Docs silent on `unique`'s ordering; inferred from the absence of any documented sort
guarantee on `GET /cards`.*

**A real bug in the sibling method.** `listWidgetsForCard` at `src/lib/widgets-api.ts:26-53` does
two things the docs contradict:

1. `:32` passes `cardCommonId` as a `GET /widgets` query param. The documented parameters for
   `GET /widgets` are only `collectionId` and `archived` (docs, Widgets → Get all widgets).
   An undocumented filter is most likely ignored, in which case the call returns *every widget in
   the organization*, not the card's instances.
2. `:52` then filters `w.type === 'card'`. The documented widget `type` values are **`"backlog"`**
   and **`"board"`** (docs, Widgets). There is no `"card"` type.

Taken together, `listWidgetsForCard` almost certainly returns `[]` unconditionally, which would make
`favro widgets list --card <id>` (`src/commands/widgets.ts:21`) always report nothing. *Inferred from
the documented parameter and type lists; not verified against a live org — see §5.* The stale comment
at `src/lib/widgets-api.ts:5` (`Sometimes widgets omit this or return exactly cardCommonId depending
on endpoint`) reads like a note written while this was being guessed at rather than confirmed.

The documented way to enumerate a card's board instances is **`GET /cards?cardCommonId=<x>`
*without* `unique`** — each returned entity is one instance and carries its own `cardId` and
`widgetCommonId`. That is one call, and it is the fix.

### 3.4 `sequentialId` "appears in commit messages but nowhere in `src/lib`"

**This premise is now stale.** Commit `1d15c6d feat(cards): find card by Favro web URL` closed the
gap. `sequentialId` is currently present in `src/lib`:

- `src/lib/cards-api.ts:17`, `:51`, `:100` — the field is parsed off raw cards and carried on `Card`.
- `src/lib/cards-api.ts:198-225` — `parseCardUrl()` extracts the sequential ID from a Favro web URL.
- `src/lib/cards-api.ts:526-552` — `findCardBySequentialId()` queries `GET /cards` with the
  documented `cardSequentialId` param at `:531`.
- `src/lib/cards-api.ts:560-563` — `findCardByUrl()`.
- Covered by `src/__tests__/cards-find-by-url.test.ts:52-88`.

**The gap that actually remains is the prefix.** `parseCardUrl` at `src/lib/cards-api.ts:206-216`
reads the `card=Squ-8850` query value, keeps `cardSequentialIdLabel` on the returned object
(`:184`, `:224`) — and then `findCardByUrl` at `:561` destructures **only** `sequentialId` and throws
the prefix away. `findCardBySequentialId` then searches **org-wide** (`widgetCommonId` is optional at
`:535-537`, and `findCardByUrl` never supplies it, even though `parseCardUrl` returned one at `:222`)
and returns `entities[0]` (`:551`).

So: if two boards in one organization use different prefixes over overlapping number ranges —
`Squ-8850` and `CLA-8850` — `findCardByUrl` can return the wrong card, silently. Whether that
collision is actually possible depends on whether Favro's `sequentialId` counter is org-wide or
per-prefix, which is **not documented** (§5). Two cheap hardenings that do not depend on resolving
that question:

1. Pass the `widgetCommonId` that `parseCardUrl` already extracted into `findCardBySequentialId`'s
   existing `options.widgetCommonId`. Zero extra API calls.
2. Assert `entities.length === 1`, or verify the returned card's label against
   `cardSequentialIdLabel`, instead of blindly taking `[0]`.

Separately, there is **no documented API field carrying the prefix**. The repo can only recover it
from a URL. If the prefix is ever needed from an API response alone, that is currently impossible
through documented means.

### 3.5 `src/lib/attachments-api.ts:19` — parameter named `cardCommonId`, endpoint takes `cardId`

```
19:  async uploadAttachment(cardCommonId: string, filePath: string)
39:    axiosClient.post(`/cards/${cardCommonId}/attachments`, …)
```

The documented path is `POST /api/v1/cards/:cardId/attachments` (docs, Attachments → Upload a file to
card) — a **path** parameter, therefore `cardId` by the rule in §2.6. The parameter name here claims
the opposite. Either the name is simply wrong (most likely — it interpolates straight into a
`:cardId` slot), or callers are genuinely passing a `cardCommonId` and every upload 404s. Worth a
one-line rename plus a check of the call sites.

### 3.6 Undocumented endpoints this codebase calls

Not card-identifier issues, but they surfaced during the endpoint enumeration and bear on how much
the docs can be trusted as a complete contract. None of these appear on <https://favro.com/developer/>:

| Endpoint | Code | Note |
|---|---|---|
| `GET /cards/search?q=` | `src/lib/cards-api.ts:568`, `:575` | No search endpoint is documented |
| `POST /cards/bulk` | `src/lib/cards-api.ts:492` | No bulk endpoint is documented |
| `GET /boards/:boardId/activity` | `src/lib/activity-api.ts:128` | Documented equivalent is `GET /cards/:cardId/activities`; there is no `/boards` route at all |
| `POST /members`, `DELETE /members/:memberId` | `src/api/members.ts:93`, `:101` | Undocumented. `src/api/members.ts:65` already notes "Favro API uses /users not /members" for the read path but the write paths still use `/members` |
| `POST/DELETE /collections/:collectionId/boards/:boardId` | `src/lib/boards-api.ts:342`, `:346` | Undocumented sub-resource |
| `/usergroups[/:groupId]` | `src/lib/users-api.ts:71,88,94,98,102` | Docs name this path **`/groups`** |

These are either private/legacy routes, or dead code that has never been exercised. Distinguishing
the two requires live calls (§5).

### 3.7 `POST /tasks` sends a surplus `cardCommonId`

`src/lib/tasks-api.ts:55` sends `{ cardCommonId, name, taskListId }`. The docs list only `taskListId`
and `name` as required, with `position` and `completed` optional (docs, Tasks → Create a task) —
`cardCommonId` is not listed. The card association is implied by the tasklist, which itself belongs
to a `cardCommonId`. Harmless surplus, not a bug; noted only so a future reader does not conclude
`cardCommonId` is required here.

---

## 4. Direct answers

### 4.1 What does `cardCommonId` identify?

**The logical card, across every board instance of it, within one organization.** Documented
verbatim: *"A shared id for all instances of this card in the organization"* (docs, Cards). It is the
key for card-level content that must not fragment per board — comments, tasks, tasklists. It is
**never** addressable as a URL path segment; it appears only as a query filter or body field.

### 4.2 Is `sequentialId` queryable via the API, and how?

**Yes — via the documented `cardSequentialId` query parameter on `GET /cards`.**

```
GET /api/v1/cards?cardSequentialId=8850&unique=true
```

Documented in Cards → Get all cards ("Filter by sequential identifier"). Already implemented at
`src/lib/cards-api.ts:526-552`, exercised by `src/__tests__/cards-find-by-url.test.ts:52-88`.

Note the asymmetric naming, which is the reason this was hard to find: the **field** on the Card
object is `sequentialId`, the **query parameter** is `cardSequentialId`. Grepping for one will not
find the other.

Three caveats:

1. The parameter takes the **number only** (`8850`), not the label (`Squ-8850`). There is no
   documented way to query by the full human-readable label.
2. There is **no** `GET /cards/:sequentialId` path form. Sequential lookup is a filter, never a path.
3. Scope it with `widgetCommonId` when you can. §3.4 explains the collision risk otherwise.

### 4.3 Which translation direction is cheap?

Costs are in additional HTTP round trips, assuming you already hold whatever you start with.

| From → To | Cost | How | Reliability |
|---|---|---|---|
| **`cardId` → `cardCommonId`** | **0 calls** if you already have the Card object; **1 call** otherwise | `cardCommonId` is a field on every Card response — `GET /cards/:cardId` and read it (`src/lib/cards-api.ts:37`) | **Exact.** One instance has exactly one common id |
| **`cardId` → `sequentialId`** | **0 calls** if you hold the Card object; **1 call** otherwise | `sequentialId` is a Card field (`src/lib/cards-api.ts:51`) | Exact |
| **`sequentialId` → `cardId` / `cardCommonId`** | **1 call** | `GET /cards?cardSequentialId=N&unique=true` | Ambiguous if prefixes collide (§3.4). Scope with `widgetCommonId` |
| **`cardCommonId` → `cardId`** | **1 call** | `GET /cards?cardCommonId=X&unique=true`, take `entities[0]` (`src/lib/widgets-api.ts:62-71`) | **Inherently ambiguous** — a common card has *N* instances, so "the" cardId does not exist. `unique=true` picks one with no documented ordering |
| **`cardCommonId` → *all* `cardId`s** | **1 call** (+ pagination) | `GET /cards?cardCommonId=X` **without** `unique` — each entity is one instance with its own `cardId` and `widgetCommonId` | Exact and complete. This is what `listWidgetsForCard` should be doing (§3.3) |

**The headline:** `cardId → cardCommonId` is the cheap, exact direction — usually free, because the
field is already sitting on any card you have fetched. The reverse, `cardCommonId → cardId`, is not
merely more expensive; it is **not a function**. A common card maps to a *set* of card ids, and any
code that collapses that set to one element is making an arbitrary choice it should be explicit
about.

**Design consequence for this CLI:** prefer to carry the whole `Card` object rather than a bare id
string. Every identifier is then free and the keyspace question never arises. Where only a string can
be carried, carry the `cardId` — you can always derive `cardCommonId` from it exactly, but not the
other way round. This is the opposite of what `src/commands/widgets.ts:21,49` chose (it takes
`cardCommonId` on the command line), which is precisely why `addWidgetToBoard` needs its re-fetch.

---

## 5. Confidence / gaps

**High confidence (documented, quoted directly):**

- `cardCommonId` = "A shared id for all instances of this card in the organization".
- `GET /comments`, `GET /tasks`, `GET /tasklists` all require `cardCommonId`.
- `cardSequentialId` is a documented `GET /cards` query parameter.
- `cardCommonId` appears in no documented URL path.
- Documented widget `type` values are `"backlog"` and `"board"` only.
- `POST /cards/:cardId/attachments` uses `cardId` in the path.

**Medium confidence (inferred from code + documented API shape, marked as such above):**

- That `cardId` means specifically "one instance on one widget". Favro's own gloss is only "The id of
  the card"; the instance reading is inferred from the `unique` parameter and the `cardCommonId`
  definition. The repo's own comments (`src/commands/init.ts:245`) agree, but they are secondary.
- That `listWidgetsForCard` (`src/lib/widgets-api.ts:26-53`) always returns `[]`. Inferred from the
  documented parameter list and type enum; **not verified against a live organization.**

**Could NOT be established:**

1. **Is `sequentialId` unique org-wide, or only within a prefix?** The docs never say. This decides
   whether `findCardByUrl` (`src/lib/cards-api.ts:560`) can genuinely return a wrong card, and it is
   the most important open question here. Resolving it needs a live org with two differently
   prefixed boards.
2. **Where does the `Squ` / `CLA` prefix come from?** No documented field carries it. Is it per-board,
   per-collection, or per-organization? Not answerable from the docs. `sequentialIdPrefix` — named in
   issue #2 — does not appear anywhere on <https://favro.com/developer/> or anywhere in this
   codebase.
3. **Does `GET /widgets` silently ignore an undocumented `cardCommonId` param, or error?** Determines
   whether §3.3's bug is "returns everything" or "returns nothing". Needs a live call.
4. **Does `unique=true` have a deterministic ordering?** Undocumented. Determines whether
   `entities[0]` is stable across calls.
5. **Are the §3.6 undocumented endpoints real private routes or dead code?** `/cards/search`,
   `/cards/bulk`, `/boards/:boardId/activity`, `/members`, `/usergroups`,
   `/collections/:id/boards/:id`. Needs live calls against a real org.
6. **Full parameter tables for Attachments and Custom fields.** WebFetch returned the request lines
   but the parameter tables were truncated in the fetched content. The request lines quoted in §2 are
   reliable; the parameter lists for those two sections are not exhaustive here.

**Method note:** all doc content was retrieved via WebFetch against <https://favro.com/developer/>
and its anchors (`#cards`, `#comments`, `#widgets`, `#upload-a-file-to-card`). The site is a single
long page; anchor fetches return overlapping windows of it, and two fetches returned partial content
for the Attachments and Custom fields sections (noted in gap 6). No page 404'd. No live Favro API
calls were made — this repository's behaviour against a real organization was not tested, so every
claim about runtime behaviour is inference from code plus documentation.
