/**
 * `favro query <board> <query…>` — the SAME grammar `cards list --filter` speaks
 * (#95).
 *
 * This file used to hold a second, regex-based parser for the same concepts —
 * `status:`, `assignee:`, `tag:`, `due:overdue` — that scraped what it
 * recognised, swept the remainder into a title search, and printed a confident
 * sentence explaining why there were no results. So `favro query <board>
 * "statuz:done"` answered a plausible ZERO ROWS while `favro cards list --filter
 * "statuz:done"` refused: two grammars, one product, and the one that answered
 * was the one that was lying.
 *
 * `query-parser.ts` already records what #32 and #46 killed: *"the old fallback
 * read an unparseable token as a title search and answered a plausible 0 rows;
 * free text is `title~"…"` and nothing else."* That sentence was true of
 * `--filter` and false of this file. It is true of both now.
 *
 * WHAT THIS BREAKS, DELIBERATELY (the owner's call on #95, recorded there)
 * Every input the old parser INVENTED now refuses, naming the token and the
 * known fields:
 *
 *   - `assigned:@alice` / `owner:bob`      → `assignee:alice`
 *   - `priority:high` / `high priority`    → `customField:Priority=high`
 *   - `due:overdue`                        → `due_date:overdue`
 *   - `authentication refactor` (free text) → `title~"authentication refactor"`
 *   - `done`, `overdue`, `assigned to bob` (naked shorthands) → say the field
 *
 * Nothing that refuses here used to ANSWER correctly: an unrecognised token was
 * swept into a title search, and a plausible empty result is indistinguishable
 * from a genuinely empty board. Converting that into a refusal is the point.
 *
 * WHY THE CARDS ARE RAW, NOT `ContextCard`s
 * The grammar evaluates a card by Favro's own field names — `name`, `dueDate`,
 * `customFields` as the array the wire sends. `ContextCard` renames three of
 * those and flattens the fourth, so running the grammar over a snapshot would
 * silently answer `false` for `due_date:`, throw on `customField:`, and read
 * `description:` as absent on every card — a NEW plausible-zero-rows on fields
 * the grammar advertises. So the filter runs over `listCards`, exactly as
 * `cards list --filter` does, and only the SURVIVORS are normalised for output.
 */
import FavroHttpClient from '../lib/http-client';
import BoardsAPI from '../lib/boards-api';
import CardsAPI, { Card } from '../lib/cards-api';
import { normalizeCard, type ContextCard } from './context';
import { filterCards, queryNames, ParseError } from '../lib/query-parser';
import { resolveQuery } from '../lib/query-values';
import { holeCollector } from '../lib/read-shape';
import type { QueryResult } from '../types/query';

// ─── Summary ──────────────────────────────────────────────────────────────────

/**
 * The one line every run prints, matched or not (ADR-0002: a successful command
 * never prints nothing).
 *
 * The 85-line `explainNoResults` this replaced was the fail-open parser's
 * apology — it guessed why a query it had mangled found nothing, and listed the
 * board's real statuses as a hint. Every one of those hints is now delivered by
 * a REFUSAL instead, before any card is read: `status:` is settled against the
 * board's own columns, `tag:` against the org's tag list, `assignee:` against
 * its users. So a zero-row answer here is an empty answer, not a near miss, and
 * saying more than that would be inventing a reason again.
 */
export function buildSummary(
  matches: ReadonlyArray<ContextCard>,
  boardName: string,
  raw: string,
  searched: number,
): string {
  const count = matches.length;
  if (count === 0) {
    return `No cards on board "${boardName}" match '${raw}' — searched ${searched} card(s).`;
  }

  const noun = count === 1 ? 'card' : 'cards';
  // Short list: every title. Long list: the first three and a count.
  const titles = matches.slice(0, count <= 5 ? 5 : 3).map((c) => `"${c.title}"`).join(', ');
  return count <= 5
    ? `Found ${count} matching ${noun}: ${titles}`
    : `Found ${count} matching ${noun}: ${titles}, … and ${count - 3} more`;
}

// ─── QueryAPI ─────────────────────────────────────────────────────────────────

export class QueryAPI {
  private boardsApi: BoardsAPI;
  private cardsApi: CardsAPI;

  constructor(private client: FavroHttpClient) {
    this.boardsApi = new BoardsAPI(client);
    this.cardsApi = new CardsAPI(client);
  }

  /**
   * Run a filter expression against one board.
   *
   * No card cap, and deliberately no parameter for one — the `cardLimit` this
   * used to pass into `getSnapshot` was read by nothing, so `query --limit 50`
   * filtered the whole board and always had (#143 close).
   *
   * @param boardRef   Board name or ID
   * @param query      A `--filter` expression, in the one grammar
   * @throws ParseError on any refusal the grammar or its vocabularies raise —
   *         BEFORE the board is paged, so a typo costs no card read.
   */
  async execute(boardRef: string, query: string): Promise<QueryResult> {
    // An EMPTY query is not an absent one. `favro query <board> "$SPRINT"` with
    // the variable unset asked for a narrowed read; answering the whole board
    // instead is the #138 fail-open in its widest direction, and it is the same
    // refusal `--filter ""` has always given (`refuseEmpty`). Checked before the
    // board is even resolved: nothing about it can make an empty query mean
    // something.
    if (query.trim() === '') {
      throw new ParseError(
        `The query is empty — it narrows nothing, and ignoring it would answer the whole board. ` +
          `Pass a filter expression, or ask for the board: favro cards list <board>.`
      );
    }

    // The board settles FIRST, because `status:` cannot be checked without one —
    // a column name is only unique within a board. `getBoard` is the resolver
    // (ADR-0003): an id reads directly, a name matches trimmed and EXACT.
    const board = await this.boardsApi.getBoard(boardRef);
    const boardId = board.boardId;

    // Parse AND settle every closed-vocabulary value, in one call — the whole
    // protocol (#83). `resolveQuery` is what makes the second half unskippable.
    const resolved = await resolveQuery(query, { client: this.client, boardId });

    // `unblocked` is refused rather than answered wrong, the same carve-out
    // `cards export` takes (#47): judging whether each blocker is FINISHED costs
    // a tracker-mapping read plus one read per blocker, and the holes have to
    // ride out somewhere the caller sees them. `cards list` pays for that and
    // reports them; this command does not, and answering anyway would silently
    // drop every card carrying any edge at all. `blocks:`/`blocked-by:` are NOT
    // refused — they read the card's own `isBefore` edges and need nothing else.
    if (queryNames(resolved, 'unblocked')) {
      // The board is quoted when it needs to be. A refusal whose remedy cannot
      // be pasted back is the #126 defect: `favro cards list Sprint 42 --filter …`
      // reads as two positionals and answers about the wrong thing.
      const asTyped = /\s/.test(boardRef) ? `"${boardRef}"` : boardRef;
      throw new ParseError(
        `"unblocked" is not available here: it has to judge each blocker, which takes ` +
          `reads this command does not make and cannot report on. ` +
          `Ask the frontier where it is answered: favro cards list ${asTyped} --filter "unblocked"`
      );
    }

    // A dead cards read is a hole, not an empty board (#116). Swallowing it as
    // `[]` would report "we could not look" as "there is nothing there", which
    // is the same lie the deleted parser told with different words.
    const { unreachable, orElse } = holeCollector();
    const cards = await orElse('cards', this.cardsApi.listCards(boardId), [] as Card[]);

    const matches = filterCards(resolved, cards).map(normalizeCard);

    return {
      matches,
      total: cards.length,
      filter: resolved,
      summary: buildSummary(matches, board.name, resolved.raw, cards.length),
      ...(unreachable.length > 0 ? { unreachable } : {}),
    };
  }
}

export default QueryAPI;
