# Command Reference

Complete reference for every `favro` CLI command, flag, and option.

**Tip:** Run `favro <command> --help` for built-in help on any command.

---

## Breaking changes

Changes to how reads answer, and to two names. Each is visible; none is silent.

### `--json` on a list read is an object, not an array

Every **list** read now prints one envelope:

```json
{"rows":[…],"truncated":true,"unreachable":[{"id":"…","reason":"…"}]}
```

`rows` is always present. `truncated` appears only when `--limit` cut rows off
the end; `unreachable` only when a composite read could not reach part of its
input. **Single** reads (`cards get`, `tags get`, `boards get`, …) are unchanged
and stay bare.

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
`(truncated to N of M …)` in human output. `--limit` takes whole digits and
nothing else: `1e9`, `2.7`, `5,000` and `banana` are all unparseable, and an
unparseable `--limit` is no cap — never an empty list, and never a cap read off
the leading digits (`--limit 1e9` printing one row).

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

### `favro query` no longer takes blocking predicates

`blocked`, `blocking` and `relates:`/`relates to` are gone from the natural-
language `query` command. All three read `card.links`, which was never populated
for them, so every one of them answered about an empty array on every card. Ask
`cards list --filter` instead, where the grammar fails closed:

```
favro cards list <board> --filter "unblocked"
favro cards list <board> --filter "blocked-by:CLA-1804"
favro cards list <board> --filter "blocks:CLA-1804"
```

`favro next` also stopped scoring blocking, rather than keep a penalty that
could never fire.

---

## Blocking: `unblocked`, `blocks:`, `blocked-by:`

Favro's UI says only **before** and **after**; this CLI says **blocks** and
**blocked-by**. That is one deliberate, scoped override of the
mirror-Favro-terminology rule — mapped exactly once, here: an edge whose far card
`isBefore` **blocks** the card you asked about.

There is one edge, with one direction flag. No `depends-on`, no `related`, no
`duplicates` — the API cannot store them.

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

### Only `unblocked` and `next` judge a blocker's doneness

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

When scope is set, every write command checks the target board's parent collection. Mismatches exit with an error before any mutation.

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

| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON |

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
| `--json` | Output raw JSON |
| `--columns` | Include column definitions |

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
| `--json` | Output raw JSON |
| `--include <fields>` | Include extra data: `board`, `collection` |
| `--board <boardId>` | Board context for the card |

### `cards list`

| Flag | Description |
|------|-------------|
| `--board <boardId>` | **Required.** Board to list from |
| `--json` | Output the `{rows, truncated?, unreachable?}` envelope, compact |
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
| `--position <pos>` | `top` or `bottom` |

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
| `custom-fields list <boardId>` | List fields for a board |
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
| `widgets list --card <cardCommonId>` | List boards a card sits on |
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

### `batch update --from-csv <file>` ⚠️ HIGH BLAST RADIUS

CSV format: `card_id,status,owner,due_date`

### `batch move --board <id> --filter <expr>` ⚠️ HIGH BLAST RADIUS

### `batch assign --board <id> --to <user> --filter <expr>` ⚠️ HIGH BLAST RADIUS

All batch commands support: `--dry-run`, `--yes`, `--force`, `--json`, `--verbose`

Filter syntax: `status:<value>`, `assignee:<user>`, `tag:<tag>`

---

## v2 Cross-Board Commands

These commands work across boards via `--collection <name>` or the scoped collection. JSON output by default.

| Command | Persona | Description |
|---------|---------|-------------|
| `my-cards` | Developer | Your cards grouped by collection/board/stage |
| `my-standup` | Developer | Personal standup: done/active/blocked/due. *Blocked* is the card's column (`Blocked`, `On Hold`), not its dependency edges — see below |
| `next` | Developer | AI-scored "what should I work on next?" |
| `workload` | PM | Per-member card distribution + overload alerts |
| `stale` | PM | Cards inactive N days or more (`--days`, inclusive; default 14 — the same threshold `health` scores against) |
| `overview` | PM | Collection dashboard with blockers |
| `health` | CTO | Per-board health scores 0-100 |
| `team` | CTO | Team utilization + bottleneck analysis |

Common flags: `--collection <name>`, `--limit <n>`, `--human` (formatted output), `--json` (default)

---

## Interactive TUI

| Command | Description |
|---------|-------------|
| `favro` | Launch interactive menu |
| `board <boardRef>` | Kanban view (`--compact`, `--watch`, `--ids`) |
| `diff <boardRef> --since 1d` | Board change diff |
| `shell` | Interactive REPL with tab completion |
| `browse` | Collection → Board → Card browser |
