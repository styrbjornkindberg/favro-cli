# Research: name→id lookups for tags, boards, columns, users/members, collections

Issue: [#3](https://github.com/styrbjornkindberg/favro-cli/issues/3) (part of #1)
Date: 2026-07-31
Sources: <https://favro.com/developer/> (single-page docs, section anchors cited by name) + this repo.

Every claim below is cited to a doc section or a `file:line`. Where the docs say nothing,
it is marked **docs silent** — that means unverified, not "safe to assume".

---

## TL;DR for the resolver

| Entity | Server-side name filter? | Cost of a full list | Verdict |
|---|---|---|---|
| Tag | **Yes** — `GET /tags?name=` | 1 call, but usually unnecessary | **Inline.** Better: often skip resolution entirely (cards accept tag *names*). |
| Board (widget) | No | 1 call typical, N pages at >100 boards | **Inline**, cache only if a workspace really has >100 boards. |
| Column | No, but scoped by `widgetCommonId` (required) | 1 call, always small | **Inline.** Never cache — column names are the thing users rename. |
| User/member | No (docs list no params) | 1 call typical | **Inline**, but see the 50 calls/hour user-route limit note. |
| Collection | No | 1 call typical | **Inline.** Cheapest of the lot. |

The headline: **no entity here needs a cache for cost reasons.** Every lookup is one
`GET` returning ≤100 rows in the normal case. The pressure for caching in this codebase
is turn-count and latency, not API cost — and that is a different ticket (#1 "Not yet specified: Caching").

The headline #2: **tags may not need resolving at all.** See [Tags](#tags).

---

## Tags

**Endpoint**: `GET /api/v1/tags` — "Get all tags" section of <https://favro.com/developer/>.

**Server-side name filter: YES.** The "Get all tags" section documents a query parameter
`name` (string): *"The name of the tag to filter by. Optional."* This is the only one of
the five entities with a documented name filter.

**The CLI does not use it.** `src/lib/tags-api.ts:22-48` (`listTags`) sends no `name` param
and pages the whole tag list; `src/commands/tags.ts:26` calls it bare. There is no
name→id helper anywhere — `grep -rl "listTags\|TagsAPI" src/` returns only
`src/lib/tags-api.ts`, `src/commands/tags.ts` and their two test files.

**Match semantics: docs silent.** The docs do not say whether `?name=` is exact,
prefix, or substring, nor whether it is case-sensitive. Must be probed against a live
workspace before the resolver depends on it.

**Duplicate names: docs silent.** The "Create a tag" section states no uniqueness
constraint on tag names within an organization. Since `?name=` returns a *paginated
collection* (not a single object), the response shape itself admits >1 match — the
resolver must handle a multi-hit result rather than assume `entities[0]`.

**Most important finding — tag resolution is often avoidable.** The card endpoints take
tag *names* directly. Card-create docs: *"The list of tag names or card tags that will be
added to card. If current tag is not exist in the organization, it will be created."*
Card-update `tagsToAdd`: *"The list of tag names or card tags that will be added to the
card. If the tag does not exist in the organization it will be created."* `tagsToRemove`:
*"The list of tag names, that will be removed from card."* A separate `tagIds` parameter
exists as the id-based alternative.

Consequence for the resolver: for the card write path, passing the raw name through is
one call instead of two — **but it silently creates the tag if it does not exist**, which
is a footgun for an agent that typo'd a tag name. Design choice to make explicitly:
pass-through (fast, auto-creates) vs. resolve-then-`tagIds` (one extra call, fails loud
on typo). `src/lib/cards-api.ts:14,91,131` already models `tags?: string[]`, i.e. the
name-based shape.

---

## Boards (widgets)

**Endpoint**: `GET /api/v1/widgets` — "Get all widgets".

**Server-side name filter: NO.** Documented query params are only `collectionId`
(*"The id of the collection to filter by. Optional."*) and `archived`. Full list +
client-side match is forced.

**Local behavior**: `src/lib/boards-api.ts:175-197` (`listBoards`) pages `/widgets`;
`src/lib/boards-api.ts:236-270` (`listBoardsByCollection`) passes `collectionId` through.
Neither filters by board name at all — the CLI has no board name→id path today.
`favro columns list <boardId>` etc. all demand an id (`src/commands/columns.ts:21`).

**Response size**: one widget object per board — `widgetCommonId, organizationId,
collectionIds, name, type, color, ownerRole, editRole, archived, lanes, columns`
("Get all widgets" response fields). Fat-ish but bounded by board count.

**Case sensitivity / duplicates**: N/A server-side (no filter). Client-side, board names
are **not** unique in Favro — nothing in the docs constrains them, and boards live in
multiple collections (`collectionIds` is an array), so the same name across collections
is expected. The resolver needs a disambiguation story, ideally
`--collection` scoping first (which *is* a server-side filter) then name match within.

---

## Columns

**Endpoint**: `GET /api/v1/columns` — "Get all columns".

**Server-side name filter: NO.** The only documented query param is `widgetCommonId`
(*"The common id of the widget to filter by. Required."*). Required, so the query is
always board-scoped — which makes the full-list-and-match approach cheap by construction.

**Local behavior**: `src/lib/columns-api.ts:23-49` (`listColumns`) sends
`widgetCommonId: boardId`, pages, and sorts by `position`. Already exactly the list the
resolver needs.

**Response size**: small — a board's columns. Fields: `columnId, organizationId,
widgetCommonId, name, position, cardCount, timeSum, estimationSum`. Realistically one
page; pagination will effectively never trigger.

**Case sensitivity**: N/A server-side. Client-side match should be case-insensitive —
agents write "in progress" for a column named "In Progress".

**Duplicates**: docs silent on whether column names must be unique within a widget. The
Favro UI permits it as far as the docs disclose, so treat duplicates as possible.

**Resolution ordering constraint**: resolving a column name requires a board id first
(`widgetCommonId` is required), so column resolution is always a *two-step* chain:
board name → `widgetCommonId` → column name → `columnId`. Card-create docs reinforce
this: *"The columnId to create the card in. It must belong to the widget specified in the
widgetCommonId parameter. WidgetCommonId is required if this parameter is set."*

---

## Users / members

**Endpoint**: `GET /api/v1/users` — "Get all users". Response fields: `userId, name,
email, organizationRole`.

**Server-side name filter: NO.** The "Get all users" section documents **no query
parameters at all**.

**Local behavior, and a discrepancy worth flagging**: `src/api/members.ts:51-76`
(`getMembers`) sends `boardId` and `collectionId` as query params to `/users`
(`src/api/members.ts:58-59`). **Neither is documented** for that endpoint. Either these
are undocumented-but-working, or they are silently ignored and
`favro members list --board <id>` is returning the whole org. Unverified — needs a live
probe. `src/lib/users-api.ts:28-54` (`listUsers`) is the clean, param-free version.

**Response size**: four small fields per user; one page for any normal org.

**Rate limit caveat — the one real reason to cache anything here.** The docs' rate-limit
section puts *"Get a user"* on the **user-level** route bucket: **50 calls/hour**.
Org-level routes are far more generous (Trial 100/h, Standard 1000/h, Enterprise
10000/h; Lite 0/h). *"If the delay exceeds 10 seconds, the call will fail with the `429`
status code."* The docs list "Get a user" (singular, `/users/:userId`) in the 50/h
bucket; whether "Get all users" shares it is **not stated**. If it does, per-command
`GET /users` is the single lookup that could realistically exhaust a bucket. **Probe this
before deciding.**

**Duplicates**: display names are obviously non-unique (two people named the same). Email
is the only human-usable unique key, and `src/api/members.ts:82-95` already treats email
as the write-side identity for `addMember`. A name→userId resolver should prefer exact
email match, then fall back to name with explicit ambiguity reporting.

**Assignments take ids only.** Card create: *"The list of assignments (array of
userIds)."* Card update: `addAssignmentIds` / `removeAssignmentIds`, *"array of
userIds"*. Unlike tags, there is **no** name/email pass-through — assignee resolution is
mandatory.

---

## Collections

**Endpoint**: `GET /api/v1/collections` — "Get all collections".

**Server-side name filter: NO.** Only `archived` (*"If true, return archived
collections. Optional."*) is documented.

**Local behavior**: `src/lib/collections-api.ts:33-55` (`listCollections`) and the
duplicate implementation at `src/lib/boards-api.ts:301-320`. Two copies of the same
paging loop — worth collapsing when the resolver lands.

**Client-side matching already exists here**, and is the de-facto precedent in this repo:
`src/commands/boards-list.ts:60-88` (`filterBoardsByCollection`) does
- 24-char-hex sniff to decide "this is an id, not a name" (`boards-list.ts:65`),
- **case-insensitive substring** match (`boards-list.ts:75`),
- on multiple matches: warn and **silently take the first** (`boards-list.ts:81-84`),
- on zero matches: error and list available collection names (`boards-list.ts:134-139`).

Recommend the resolver keep the id-sniff and the helpful zero-match error, and **change**
the two other behaviors: substring matching is too loose for a write path (exact →
case-insensitive-exact → prefix → substring, in that order), and "take the first of N"
should be a hard error on write commands, not a warning.

**Duplicates**: docs silent on collection name uniqueness. The existing code assumes
duplicates are possible (`boards-list.ts:81`), which is the right assumption.

---

## Pagination — shared machinery, and two bugs

**Documented contract** ("Pagination" section):
- Responses carry `requestId`, `entities`, `page`, `pages`, `limit`.
- `limit`: *"The number of entities per page. This should always be 100."*
- Subsequent pages: send `requestId` (*"The requestId returned by the original request to
  the paged endpoint"*) and `page` (*"The index of the page to request"*).
- First page index is **0** (all doc examples show `"page": 0`).
- *"if an entity that was returned by the original request is deleted in between calls, it
  will not be returned when requesting subsequent pages. Therefore, you might not always
  receive 100 items per page."*
- Routing: *"Every response ... will include a header called X-Favro-Backend-Identifier
  ... If subsequent requests need to be routed to the same instance, you should include
  this identifier in the request header."* Handled correctly and globally at
  `src/lib/http-client.ts:38` and `:44-47`.

### Bug 1 — page 1 is skipped in four paging loops

`listBoards` (`src/lib/boards-api.ts:178`), `listBoardsByCollection`
(`src/lib/boards-api.ts:244`), `CollectionsAPI.listCollections`
(`src/lib/collections-api.ts:36`), `BoardsAPI.listCollections`
(`src/lib/boards-api.ts:304`) and `getMembers` (`src/api/members.ts:54`) all initialise
`let page = 1` and then `page++` *before* the next request:

```
let page = 1;
while (true) {
  // first pass sends no requestId → server returns page 0
  ...
  if (!requestId || !response.pages || page >= response.pages || boards.length === 0) break;
  page++;   // → 2
}
```

Trace with `pages = 3`: request 1 returns page 0; `1 >= 3` is false; `page` becomes 2;
request 2 asks for page **2**. **Page 1 is never fetched.** Anything past the first 100
boards / collections / users is partially lost, silently.

The tag, column and user loops are correct — they start at `page = 0` and increment
before use: `src/lib/tags-api.ts:25,44`, `src/lib/columns-api.ts:26,45`,
`src/lib/users-api.ts:31,50`.

Impact on the resolver: name→id built on `listBoards`/`listCollections` will report
"no such board" for boards sitting in page 1 of a >100-board workspace. Fix the loops
before building resolution on them — or better, extract **one** paging helper (there are
currently seven near-identical copies) and delete the rest.

### Bug 2 (minor) — undocumented `limit` param

`boards-api.ts:181`, `collections-api.ts:39` and `members.ts:57` send `limit: pageSize`
(default 50). The docs describe `limit` as a **response** field fixed at 100 and document
no request-side `limit`. Most likely ignored by the server, meaning `pageSize` is a lie
in the signature. **Unverified** — needs a live probe; harmless either way, but it makes
the page arithmetic above harder to reason about.

---

## Where the docs are silent (all need a live probe before the resolver relies on them)

1. `GET /tags?name=` match semantics — exact vs. prefix vs. substring, case sensitivity.
2. Whether tag names are unique per organization.
3. Whether column names are unique per widget.
4. Whether collection / board names are unique.
5. Whether `GET /users` honours the undocumented `boardId` / `collectionId` params the CLI
   sends (`src/api/members.ts:58-59`).
6. Whether "Get all users" (plural) falls in the 50 calls/hour user-route bucket or the
   org bucket.
7. Whether a request-side `limit` param does anything.

---

## Recommendation to the resolver design (#6)

1. **No cache for cost.** Every lookup is one bounded `GET`. Build resolution inline;
   revisit caching only if item 6 above turns out badly, or purely for latency.
2. **Fix pagination first.** One shared paging helper, `page = 0`-based. Resolution built
   on today's loops is wrong above 100 entities.
3. **Order of operations is forced by the API**: collection → board (`widgetCommonId`) →
   column (`widgetCommonId` required). Scope with the server-side filters that exist
   (`?collectionId=` on widgets, `?widgetCommonId=` on columns) before matching names
   client-side — that keeps every candidate list small by construction.
4. **One match ladder, shared**: id-sniff (24-hex) → exact → case-insensitive exact →
   prefix → substring. Ambiguity is an **error on writes** with the candidate list
   printed, not a warn-and-pick-first as at `src/commands/boards-list.ts:81-84`.
5. **Tags are the exception**: decide deliberately between name pass-through (0 extra
   calls, auto-creates on typo) and `?name=` resolution + `tagIds` (1 call, fails loud).
6. **Assignees always need resolution** — the API takes `userIds` only — and email is the
   only unambiguous human key.
