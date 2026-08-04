# ADR-0005: One card-filter grammar — `favro query` is re-pointed, not deleted

Status: accepted (#95, decision recorded on the ticket 2026-08-04)

## Context

Two parsers answered the same question.

`lib/query-parser.ts` is the grammar `cards list --filter`, `cards export --filter`,
`batch move --filter` and `batch assign --filter` speak. It **fails closed**: an unknown field,
an unparseable token, a tag outside the org's list or a column the board does not have each
refuse and name what they refused. Its own docstring records what #32 and #46 killed to get
there — *"the old fallback read an unparseable token as a title search and answered a plausible
0 rows; free text is `title~\"…\"` and nothing else."*

`api/query.ts` still did exactly that. It held a second, regex-based parser for the same
concepts — `status:`, `assignee:`, `tag:`, `due:overdue` — that scraped what it recognised,
swept the remainder into a free-text title search, and printed a confident paragraph explaining
why there were no results. It was reachable from a registered command (`favro query`) and from
the skill engine's `query` step (`lib/skill-engine.ts`).

So, measured on this branch before the change:

| Typed | `cards list --filter` | `favro query` |
|-------|----------------------|---------------|
| `statuz:done` | refuses, lists the known fields | **answers zero rows**, explains why |
| `tag:typoo` | refuses, lists the org's tags | **answers zero rows** |
| `pricing page` | refuses, points at `title~"…"` | answers a title search |

The middle column is the contract this CLI advertises. The right column is a plausible empty
result, and a plausible empty result is indistinguishable from a genuinely empty board.

## Decision

**`favro query` survives and is re-pointed at `lib/query-parser.ts`. The second parser is
deleted.** `QueryAPI.execute` now runs `resolveQuery` (parse **and** settle the closed-vocabulary
values, the whole protocol in one call, #83) and then `filterCards` — the same two calls
`cards list --filter` makes.

Deleting the command was declined: the skill engine calls it, which is a wider blast radius than
a grammar change.

Three consequences were accepted deliberately.

**1. It is a breaking change, and the break is the point.** Every input the deleted parser
*invented* now refuses: `assigned:`/`owner:` (say `assignee:`), `priority:` (say
`customField:Priority=`), `due:` (say `due_date:`), and bare words (say `title~"…"`). Nothing
that now refuses used to answer *correctly* — each was swept into a title search. Version 3.0.0
is unreleased (`package.json`), and the ticket records `npm view @square-moon/favro-cli`
answering 404, so the change costs nothing today and stops being free the day this ships.

**2. The filter runs over RAW cards, not the `ContextCard` snapshot.** The grammar evaluates a
card by Favro's own field names — `name`, `dueDate`, `customFields` as the array the wire sends.
`ContextCard` renames three of those and flattens the fourth, so running the grammar over
`ContextAPI.getSnapshot`'s output would silently answer `false` for `due_date:`, throw on
`customField:`, and read `description:` as absent on every card. That is a *new*
plausible-zero-rows on fields the grammar advertises, so `QueryAPI` reads `listCards` directly
and normalises only the survivors. A dead card read is still recorded as `unreachable` rather
than swallowed as an empty board (#116).

**3. The refusal reaches the skill engine's `query` step, and aborts the run.** A refusal there
unwinds the compensation log, which is demonstrated in `skill-dispatch-wire.test.ts` against the
HTTP stand rather than assumed: a `create` step followed by a `query` step naming an unknown
field leaves the created card DELETED and the run `failed`. The alternative is worse — a step
that silently matched zero cards would let the steps after it filter an empty list, write
nothing, and report `completed` over a board the run never touched.

## Consequences

- `QueryFilter` and `QueryMatch` are gone from `types/query.ts`. `QueryResult.filter` is the
  parsed `Query`, whose `ast` carries the values already settled (`assignee:` as a `userId`,
  `status:` as the column's own name). `matches` is a flat `ContextCard[]`: under one fail-closed
  grammar the reason every row matched is the query, which the summary states once, so a per-row
  `matchReason` was a copy of the same sentence.
- `explainNoResults` is deleted. It guessed why a query it had mangled found nothing and listed
  the board's real columns as a hint; every one of those hints is now delivered by a refusal,
  before any card is read.
- `unblocked` is refused on `query` and pointed at `cards list --filter "unblocked"` — the same
  carve-out `cards export` takes (#47), for the same reason: judging whether each blocker is
  finished takes reads this command does not make and cannot report holes for.
  `blocks:<ref>` and `blocked-by:<ref>` ARE answered — they read the card's own `isBefore` edges.
- An EMPTY query refuses. `favro query <board> "$SPRINT"` with the variable unset asked for a
  narrowed read, and answering the whole board is the #138 fail-open in its widest direction.
- `favro query` writes its refusal as `{error:{message,retryable}}` on **stdout** (ADR-0002),
  while the four `--filter` commands are unmigrated and write `✗ Error: …` to stderr (#119 owns
  that). The refusal MESSAGE is identical across them, and
  `filter-fail-closed-coverage.test.ts` compares it; the channel is not, deliberately, and a
  byte comparison across the two channels would fail on the envelope rather than on the grammar.

## What was NOT done

- **No `pushed`/`residual` split.** #95 asked whether wire-narrowed predicates should be marked
  so they are not re-evaluated client-side. The ticket's own default was to leave it (YAGNI)
  unless the double `status` filtering forced it, and it did not: `favro query` takes no
  `--status` flag, so nothing on this path filters `status` twice.
- **`.description()` strings joined the drift test** rather than only the one stale string being
  fixed. `standup`'s help pointed at an `unblocked` top-level command, which has never existed — the
  second stale-guidance bug on this map, which makes it a class. `help-topic-drift.test.ts` now
  walks the live commander tree's descriptions, summaries and option help against the real argv
  paths. Measured: exactly one dead invocation across 147 argv paths, and it was that one.
