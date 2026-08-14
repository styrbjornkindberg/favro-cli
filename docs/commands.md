# Command Reference

Complete reference for every `favro` CLI command, flag, and option.

**Tip:** Run `favro <command> --help` for built-in help on any command.

---

## Breaking changes

Changes to how reads answer, and to two names. Each is visible; none is silent.

### A list read answers an object, not an array

Every **list** read now prints one envelope:

```json
{"rows":[…],"truncated":true,"unreachable":[{"id":"…","reason":"…"}]}
```

`rows` is always present. `truncated` appears only when `--limit` cut rows off
the end; `unreachable` only when a composite read could not reach part of its
input. **Single** reads (`cards get`, `tags get`, `boards get`, …) stay bare —
no `rows`, no envelope.

A bare read can still carry `unreachable`, on the entity itself: `cards get
<card> --include board,collection,links,comments` costs one call per facet, and a
facet it could not read is named under the same `unreachable` key with the same
`{id, reason}` shape. There is no envelope to put it in, so the card holds it.
The key is absent when every facet answered — which is what makes `links: []`
mean "no dependencies" rather than "we could not look".

The envelope is always an envelope, marker or not: a shape that varied with the
data would make the branch that matters most the one an agent exercises least.

Anything piping `jq '.[]'` must become `jq '.rows[]'`.

The JSON is also **compact** now, not indented. Pipe through `jq .` for eyes.

### `cards list` reads live cards only by default

`archived` is a Favro **selector**, not an exclusion — Favro's own default list
INCLUDES archived cards, so they used to arrive silently mixed into every read.
`--archived false` is now the default. Pass `--archived all` for the old mixed
behaviour, or `--archived true` to read the archive alone. It filters on the
wire.

### `--limit` caps output, not the fetch

`--limit` used to truncate the *fetch*, so every filter after it filtered a
partial set and answered a plausible wrong number (Favro ignores `limit` on
`GET /cards` anyway — always clamped to 100 per page). The order is now: fetch
to completion, filter, cap last, and say `"truncated": true` when the cap bit.

`cards export` lost `--limit` entirely: a cap there could only export part of a
board and still call itself the export.

Every list read takes `--limit` now, not just `cards list` — `columns`, `tags`,
`users`, `groups`, `members`, `tasks`, `tasklists`, `widgets`, `webhooks`,
`custom-fields list` / `values`, `dependencies list`, `activity`, `skill list`,
`boards list`, `collections list` and `cards dependencies` / `blocking` /
`blocked-by`. Uncapped by default, so a read with no `--limit` prints
everything; pass one and the cut is marked `truncated` in JSON and printed as
`(truncated to N of M …)` in human output. `--limit` takes whole digits of 1 or
more and nothing else: `1e9`, `2.7`, `5,000`, `-1`, `0` and `banana` are all
unparseable, and an unparseable one is a **refusal** naming the value that exits
1 — never no cap, never an empty list, and never a cap read off the leading
digits (`--limit 1e9` printing one row).

The fourteen board- and collection-wide reads have **no `--limit` at all**:
`context`, `standup`, `sprint-plan`, `query`, `board`, `diff`, `health`,
`my-cards`, `my-standup`, `next`, `overview`, `stale`, `team`, `workload`. They
each used to accept one and thread it into `ContextAPI.getSnapshot` /
`AggregateAPI.getMultiBoardSnapshot`, which declared the parameter and never read
it — so the flag advertised a fetch cap that no fetch ever applied. It is
removed rather than wired: the collection sweep runs three fetches concurrently,
so any global cut point would depend on wire arrival order, and these commands
report `by_status` / `by_owner` proportions that a subsampled read would make
plainly wrong. Passing `--limit` to one of them now exits 1 with
`unknown option '--limit'` instead of being silently ignored.

### Card bodies and custom fields are omitted from list output

`cards list` omits `description` / `detailedDescription` and `customFields` from
what it *prints*; `collections list` omits `sharedToUsers` and `boards`. This is
a **rendering** decision — the read still returns every field, so
`--filter "description:foo"` is real grammar and costs no extra call.

Bring them back with `--body` and `--include custom-fields`. There is no
`--full`. `cards export` is carved out and always carries bodies.

### `cards blockers` is now `cards blocking`

It returns the cards this card *blocks*, exactly as its own help string always
said. `blockers` named the other end; `cards blocked-by` is unchanged.

### `favro query` speaks the `--filter` grammar, and only that

There is one grammar for filtering cards. `favro query` used to run a second,
regex-based one of its own: it scraped what it recognised, swept the remainder
into a title search, and printed a confident explanation of why there were no
results. So `favro query <board> "statuz:done"` answered **zero rows** while
`favro cards list <board> --filter "statuz:done"` refused.

Every input that parser invented now refuses, naming the token:

| Was | Say |
|-----|-----|
| `assigned:@alice`, `owner:bob` | `assignee:alice` |
| `priority:high`, `high priority` | the column, tag or field that carries it — `customField:`/`customFields:` are refused too (#167) |
| `due:overdue` | `due_date:overdue` |
| `pricing page` (free text) | `title~"pricing page"` |
| `done`, `overdue`, `assigned to bob` | name the field |

Nothing that refuses used to answer *correctly* — an unrecognised token became a
title search, and a plausible empty result is indistinguishable from a genuinely
empty board.

`blocks:<ref>` and `blocked-by:<ref>` are answered on `query`. `unblocked` is
not: it has to judge each blocker, which takes reads `query` does not make and
cannot report on. Ask the frontier where it is answered:

```
favro cards list <board> --filter "unblocked"
```

`blocked`, `blocking` and `relates:`/`relates to` were removed earlier, for a
different reason: all three read `card.links`, which was never populated for
them, so every one answered about an empty array on every card. `favro next`
also stopped scoring blocking, rather than keep a penalty that could never fire.

---

## Blocking: `unblocked`, `blocks:`, `blocked-by:`

Favro's UI says only **before** and **after**; this CLI says **blocks** and
**blocked-by**. That is one deliberate, scoped override of the
mirror-Favro-terminology rule — mapped exactly once, here: an edge whose far card
`isBefore` **blocks** the card you asked about.

There is one edge, with one direction flag. No `depends-on`, no `related`, no
`duplicates` — the API cannot store them.

`blocks:<ref>` and `blocked-by:<ref>` take a `cardId`, a `cardCommonId` or a
`sequentialId` (`CLA-1804`, or the bare number). The first two are settled
against the edge itself and cost no call; a `sequentialId` is resolved to a
`cardCommonId` first, and a reference that resolves to nothing **refuses**
rather than answering an empty board. Until #162 only a `cardCommonId` matched:
`cards blocked-by <card>` printed a `cardId`, and pasting that same id into
`--filter "blocked-by:…"` returned zero rows.

`--filter "unblocked"` is the frontier: takeable now.

- **Board-agnostic.** A blocker is a blocker wherever it lives.
- Says nothing about the column: *blocked* and *doing* are indistinguishable in
  the column a human looks at, because the column carries open/closed.
- Excludes **archived** cards and **forks** (an assignment entity has no board
  and no column, so there is nothing to act on).
- A blocker counts as finished when it sits in the **tracker board's mapped
  `done` column** (`favro tracker init`), or is **archived** off that board.
  There is no board-independent completion signal in Favro to use instead: no
  `completed`, no `status`, no `state`; `assignments[].completed` is per person;
  and `position` is monotone but rightmost is not done on every board.
- **A blocker we could not read still blocks**, and says so under `unreachable`.

So `unblocked` is wrong in one direction only — it can hide a takeable ticket,
never offer a blocked one.

### Only `cards list --filter unblocked` judges a blocker's doneness

Judging costs a tracker-mapping read plus one read per blocker, so the summary
commands do not pay it. Nothing clears a Favro edge when the blocker finishes,
so an unjudged edge count would report a card as blocked forever — including
cards that are already done. Those commands therefore report the **edge count**
and leave the blocked *state* to the column:

| Command | Field | Means |
|---------|-------|-------|
| `health` | `boards[].breakdown.dependencies` | % of non-done cards carrying **no** edge |
| `workload` | `members[].dependencyCards` | cards carrying ≥1 edge |
| `team` | `members[].dependencyCount`, `bottleneck.dependencyCount` | cards carrying ≥1 edge |
| `standup` | `StandupCard.dependencies` | that card's edge count |
| `my-standup`, `standup` | `blocked` group | column/status says blocked — edges are **not** consulted |

`next` was listed here as a second payer and is not one: it dropped its blocking
term in #47 and does not read a blocker at all. Ask the frontier instead —
`cards list --board <id> --filter "unblocked"`. Corrected in #98.

The interactive TUI follows the same rule: *My Work* lists cards under **With
dependencies** rather than *Blocked*, counts them in `queued` all the same, and
the kanban badge no longer marks a card blocked on an edge alone.

---

## Honest failure: unavailable is not empty

`0 blockers` and `couldn't check blockers` demand opposite next moves, so the CLI
never conflates them. Where the line falls depends on how many calls a read makes:

- A **single-call** read **throws**. Unavailability never reaches stdout dressed
  as emptiness, so an empty answer unambiguously means true-empty.
- A **composite** read returns the rows it reached **plus** an `unreachable`
  marker naming each id it could not, and why — a capped sweep can hold 17 real
  rows *and* a hole, and collapsing that into either "17 rows" or an error loses
  the part that matters.

Composite reads go through one shared `boundedSweep`, which caps a sweep at 20
per-item calls. Ids past the cap come back as `unreachable` with a reason of
"not attempted", so "we stopped counting" is never printed as "there was nothing
there".

Reporting the hole is only half of it. The consumer then has to decide what it
*does* with the data behind the hole, and the cross-board commands do not all
answer the same way — because a missing workflow stage is not the same problem in
a census as it is in a recommendation:

| Command | On a board whose `/columns` read failed |
|---------|----------------------------------------|
| `health` | the board is **omitted** from scoring; every board in scope dark is a refusal, because an empty `boards[]` rolls up to 100/green |
| `workload`, `team`, `stale` | the board's cards are **dropped**, so nobody is reported at a fabricated zero WIP and no finished card is reported stale |
| `my-standup` | the cards are **kept**, in a `stageUnknown` group — they are your cards, and a finished one must not be read out as in progress |
| `my-cards` | the cards are **kept and listed**; only `suggestedNext` degrades, since it cannot rank what it cannot stage |
| `next` | the cards are **not ranked**, and `unreachable` says the pool shrank |
| `overview` | the cards are **counted** under stage `unknown`, which is honest for a census |

No command applies the exclusion at the producer. A card whose stage is unknown is
still a real card assigned to a real person, so dropping it there would delete
work from `my-cards` and `my-standup` to fix a bug in `health`.

---

## Global Options

| Flag | Description |
|------|-------------|
| `--verbose` | Show detailed error output and stack traces |
| `--help` | Display help for any command |

---

## Auth

```
favro auth login     — Store API token (also resolves userId)
favro auth logout    — Remove stored credentials
favro auth verify    — Test the current token
favro auth check     — Show stored credential info
```

---

## Scope (Write Safety)

| Command | Description |
|---------|-------------|
| `favro scope set <collectionId>` | Lock writes to this collection |
| `favro scope show` | Display current lock |
| `favro scope clear` | Remove lock |

When scope is set, a write that lands on a board checks that board's parent collection, and a write that targets a collection checks the collection itself. Mismatches exit with an error before any mutation. Org-wide writes (tags, user groups, webhooks, `collections create`) land on no board, so the lock cannot narrow them — the three irreversible ones are refused outright while a lock is set.

---

## Init (Repo Context)

| Command | Description |
|---------|-------------|
| `favro init` | Create `.favro/context.json` from scoped collection |
| `favro init --collection <id>` | Bootstrap from a specific collection |
| `favro init --refresh` | Update existing context after board changes |
| `favro init --json` | Print to stdout instead of writing file |

See [Repo Context Guide](./repo-context.md) for the full format.

---

## Collections

### `collections list`
List all collections in the organization.

### `collections get <id>`
Get a single collection by ID.

### `collections create` ⚠️ WRITE

| Flag | Description |
|------|-------------|
| `--name <name>` | **Required.** Collection name |
| `--description <text>` | Collection description |
| `--dry-run` | Preview only |

### `collections update <id>` ⚠️ WRITE

| Flag | Description |
|------|-------------|
| `--name <name>` | New name |
| `--description <text>` | New description |
| `-y, --yes` | Skip confirmation |
| `--force` | Bypass scope check |

### `collections delete <id>` ⚠️ DESTRUCTIVE

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |
| `--force` | Bypass scope check |

---

## Boards

### `boards list [collectionId]`
List boards, optionally filtered by collection.

### `boards get <id>`
Get board details including columns, members, and stats.

| Flag | Description |
|------|-------------|
| `--include <options>` | Comma-separated: `custom-fields`, `cards`, `members`, `stats`, `velocity` |

### `boards create <collectionId>` ⚠️ WRITE

| Flag | Description |
|------|-------------|
| `--name <name>` | **Required.** Board name |
| `--type <type>` | `board` or `backlog` |
| `--dry-run` | Preview only |
| `--force` | Bypass scope check |

### `boards update <id>` ⚠️ WRITE

| Flag | Description |
|------|-------------|
| `--name <name>` | New name |
| `-y, --yes` | Skip confirmation |
| `--force` | Bypass scope check |

### `boards delete <id>` ⚠️ DESTRUCTIVE

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |
| `--force` | Bypass scope check |

---

## Cards

### `cards get <cardId>`

| Flag | Description |
|------|-------------|
| `--include <items>` | Comma-separated: `board`, `collection`, `custom-fields`, `links`, `comments`, `relations` |

### `cards list`

| Flag | Description |
|------|-------------|
| `--board <boardId>` | **Required.** Board to list from |
| `--limit <n>` | Cap how many cards are **printed** (default: 25); sets `truncated` |
| `--filter <expr>` | Query expression, parsed and value-checked **before** the fetch |
| `--status <column>` | Narrow to one column, by name or `columnId`. On the wire. |
| `--archived <mode>` | `true`, `false` (default) or `all`. On the wire. |
| `--body` | Keep card descriptions in the output |
| `--include custom-fields` | Keep `customFields` in the output |
| `--assignee <user>` | Narrow to one assignee — a name, an email, a userId or `@me`. Same as `--filter "assignee:…"`. |
| `--tag <tag>` | Narrow to one tag, by exact name. Same as `--filter "tag:…"`; an unknown name is refused. |

The board is always fetched to completion, so `--filter`, `--assignee` and
`--tag` filter the whole board rather than one truncated page.

`--filter` values that come from a list Favro owns (`tag:`, `status:`,
`assignee:`) are checked against that list before any query runs, so a typo
refuses instead of answering a plausible `0 rows`. `status:` needs `--board`.

### `cards create <title>` ⚠️ WRITE

| Flag | Description |
|------|-------------|
| `--board <boardId>` | Target board |
| `--description <text>` | Card description |
| `--status <column>` | Column to create the card in — a name needs `--board`, or pass a `columnId` |
| `--tag <name>` | Tag by **name**, repeatable. An unknown name is refused CLI-side, never created |
| `--assignee <user>` | Assignee — name, email, `userId` or `@me`. Repeatable |
| `--parent <cardId>` | Parent card, same board only (makes this a child). `CLA-1804` or a `cardId` |
| `--blocked-by <cardId>` | Card that must come before this one, repeatable. `CLA-1804` or a `cardId` |
| `--blocks <cardId>` | Card this one comes before, repeatable. `CLA-1804` or a `cardId` |
| `--csv <file>` | Bulk import from CSV |
| `--bulk <file>` | Bulk import from JSON |
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |
| `--force` | Bypass scope check |

Every flag above rides the **one** `POST /cards`, so a bad tag, assignee, column
or dependency target fails the whole create and leaves no card behind.

Card references on `--parent`, `--blocked-by` and `--blocks` take a
`sequentialId` (`CLA-1804`) or a `cardId`. A `cardCommonId` is **not** accepted
here — it reaches the wire unresolved and Favro rejects the create.

### `cards update <cardId>` ⚠️ WRITE

| Flag | Description |
|------|-------------|
| `--name <name>` | New title |
| `--status <status>` | Move the card to this column (name or `columnId`) |
| `--column <column>` | Move to column by name (requires `--board`) |
| `--assignees <list>` | Comma-separated assignees — the whole set; drop one to unassign |
| `--tags <list>` | Comma-separated tags |
| `--board <boardId>` | Board context |
| `--from-csv <file>` | Batch update from CSV |
| `--dry-run` | Preview only |
| `-y, --yes` | Skip confirmation |
| `--force` | Bypass scope check |

**Important:** `--status` IS the column — Favro has no separate status field, so a
`--status` write moves the card, resolving the name against the card's own board
and refusing an unknown name with that board's real columns listed.

**Important:** never read a description back and write it again. Favro injects a
card's tasklist items into the description it returns, so a read-modify-write
re-persists those `- [ ]` lines as literal body text and doubles the tasklist
permanently. Compose the whole body and write that (`--description`).

There is no `--parent` on update: Favro answers `202 Access denied` to
`parentCardId` on a card update, and rejects `parentCardId: null` with a 400, so
a parent can be set at create time only and can never be cleared.

### `cards export <board>`

| Flag | Description |
|------|-------------|
| `--format <fmt>` | `json` or `csv` |
| `--out <file>` | Output file path |
| `--filter <expr>` | Filter expression (repeatable) |

Export is carved out of the default output omission: it always carries card
bodies, whole. It has no `--limit` — the board is fetched to completion.

### `cards link <cardId> <toCardId>` ⚠️ WRITE

| Flag | Description |
|------|-------------|
| `--type <type>` | `depends-on` or `blocks` — Favro stores one edge with one direction flag, so `related` / `duplicates` are refused, not discarded |

### `cards unlink <cardId> <fromCardId>` ⚠️ WRITE

### `cards move <cardId>` ⚠️ WRITE

| Flag | Description |
|------|-------------|
| `--to-board <boardId>` | Destination board |

---

## Comments

| Command | Description |
|---------|-------------|
| `comments list <cardId>` | List comments on a card. `--limit <n>` caps what is **printed** (default: 100) and sets `truncated`; the fetch always runs to completion |
| `comments get <commentId>` | Get a single comment |
| `comments add <cardId> --text "..."` | Add a comment ⚠️ |
| `comments update <commentId> --text "..."` | Update a comment ⚠️ |
| `comments delete <commentId>` | Delete a comment ⚠️ |

---

## Custom Fields

| Command | Description |
|---------|-------------|
| `custom-fields list <board>` | Fields whose definition names the board |
| `custom-fields get <fieldId>` | Get field definition |
| `custom-fields values <fieldId>` | List allowed select values |
| `custom-fields set <cardId> <fieldId> <value>` | Set a field value ⚠️ |

---

## Columns & Widgets

| Command | Description |
|---------|-------------|
| `columns list <boardId>` | List columns on a board |
| `columns create <boardId> --name "..."` | Create a column ⚠️ |
| `columns update <columnId>` | Update a column ⚠️ |
| `widgets list --card <card>` | List boards a card sits on |
| `widgets add <boardId> <cardCommonId>` | Add card to a board ⚠️ |

---

## Tasks, Task Lists & Dependencies

| Command | Description |
|---------|-------------|
| `tasks list <cardCommonId>` | List checklist items |
| `tasks add <cardCommonId> <name>` | Add a task ⚠️ |
| `tasks update <taskId>` | Update a task ⚠️ |
| `tasks delete <taskId>` | Delete a task ⚠️ |
| `tasklists list <cardCommonId>` | List task lists |
| `tasklists get <taskListId>` | Get a task list |
| `tasklists create <cardCommonId> --name "..."` | Create a task list ⚠️ |
| `tasklists update <taskListId>` | Update a task list ⚠️ |
| `tasklists delete <taskListId>` | Delete a task list ⚠️ |
| `dependencies list <cardId>` | List dependencies |
| `dependencies add <sourceId> <targetId> --type blocks` | Add dependency ⚠️ |
| `dependencies delete <cardId> <targetId>` | Remove dependency ⚠️ |
| `dependencies delete-all <cardId>` | Remove all dependencies ⚠️⚠️ |

---

## Tags & Attachments

| Command | Description |
|---------|-------------|
| `tags list` | List all workspace tags |
| `tags create --name "..." [--color ...]` | Create a tag ⚠️ |
| `tags update <tagId>` | Update a tag ⚠️ |
| `tags delete <tagId>` | Delete a tag ⚠️ |
| `attachments upload <cardCommonId> --file ./path` | Upload to card ⚠️ |
| `attachments upload-to-comment <commentId> --file ./path` | Upload to comment ⚠️ |

---

## Members, Users & Groups

| Command | Description |
|---------|-------------|
| `users list` | List workspace users |
| `groups list` | List user groups |
| `groups get <groupId>` | Get a group |
| `groups create --name "..."` | Create a group ⚠️ |
| `groups update <groupId>` | Update a group ⚠️ |
| `groups delete <groupId>` | Delete a group ⚠️ |
| `members list [--board <id>] [--collection <id>]` | List members |
| `members add <email> --to <targetId>` | Add a member ⚠️ |
| `members remove <memberId> --from <targetId>` | Remove a member ⚠️ |
| `members permissions <memberId> --board <id>` | Check permissions |

---

## Webhooks

| Command | Description |
|---------|-------------|
| `webhooks list` | List webhooks |
| `webhooks create --event <event> --target <url>` | Create webhook ⚠️ |
| `webhooks delete <webhookId>` | Delete webhook ⚠️ |

---

## Batch Operations

`batch update`, `batch move`, `batch assign` and `batch-smart` were **removed in
4.0**. All four still exist as commands and all four exit 1 naming their
replacement, so a script that calls one gets a next move rather than
`unknown command`.

There is one bulk write now:

### `cards update --from-csv <file>` ⚠️ HIGH BLAST RADIUS

CSV columns: `card_id` (required), `status`, `owner`, `due_date`. `cardId`,
`assignee` and `dueDate` are accepted aliases. **Any other column refuses** —
including `custom_field_*`, which the old parser accepted and then never sent.

Supports `--dry-run`, `--yes`, `--force`. JSON is the default output; `--human`
opts out, and a leaf `--json` is `error: unknown option '--json'`.

The whole file is **one transaction**, capped at **20 rows**: over the cap it
refuses rather than writing the first twenty, and a failure on row 12 unwinds
rows 1–11 through each field's own compensating write. Every distinct board the
file touches is checked against the scope lock before the first write, and a file
straddling the lock refuses as a whole.

**What is gone, and why.** The three removed spellings derived their write set
from a board read: `--filter`, `--label` or a plain-English `--goal` decided
which cards to write to, so what was written was in neither the invocation nor
any record. `cards update --board <board>` with no card id — the same predicate
shape on this command — refuses for the same reason. Enumerate the set first
(`favro cards list --filter …`), then hand it over as a CSV.

---

## v2 Cross-Board Commands

These commands work across boards via `--collection <name>` or the scoped collection. JSON output by default.

| Command | Persona | Description |
|---------|---------|-------------|
| `my-cards` | Developer | Your cards grouped by collection/board/stage |
| `my-standup` | Developer | Personal standup: done/active/blocked/due, plus `stageUnknown` for a card whose workflow stage could not be read. *Blocked* is the card's column (`Blocked`, `On Hold`), not its dependency edges — see below |
| `next` | Developer | AI-scored "what should I work on next?" |
| `workload` | PM | Per-member card distribution + overload alerts |
| `stale` | PM | Cards inactive N days or more (`--days`, inclusive; default 14 — the same threshold `health` scores against) |
| `overview` | PM | Collection dashboard with blockers |
| `health` | CTO | Per-board health scores 0-100 |
| `team` | CTO | Team utilization + bottleneck analysis |

Common flags: `--collection <name>`, `--human` (formatted output). JSON is the
default; there is no `--json` flag.

No `--limit` on any of them, and none of them ever had a working one — see
[`--limit` caps output, not the fetch](#--limit-caps-output-not-the-fetch). The
sweep reads every card in scope.

---

## Interactive TUI

| Command | Description |
|---------|-------------|
| `favro` | Launch interactive menu |
| `board <boardRef>` | Kanban view (`--compact`, `--watch`, `--ids`) |
| `diff <boardRef> --since 1d` | Board change diff |
| `shell` | Interactive REPL with tab completion |
| `browse` | Collection → Board → Card browser |
