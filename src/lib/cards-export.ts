/**
 * The `cards export` filter helpers (FAVRO-009).
 *
 * Library, not a command: the live `cards export` is registered inline in
 * `cli.ts` and calls into here. It used to carry a `registerCardsExportCommand`
 * twin as well — a second registration nothing but its own tests ever reached,
 * whose ~500 lines of tests reported coverage the live path did not have (#139).
 * With the twin gone this file registers nothing, so it lives in `lib/`.
 */
import { Card } from './cards-api';
import { filterCards, queryNames, ParseError } from './query-parser';
import { resolveQuery, refuseEmpty, ValueContext } from './query-values';

export type ExportFormat = 'json' | 'csv';

/**
 * Apply a filter expression to cards.
 *
 * Fails closed on the WHOLE grammar, not half of it (#83): the expression goes
 * through `resolveQuery`, so an unknown field, an unparseable token, a tag
 * outside the org vocabulary and a column the board does not have all refuse
 * with the same `ParseError` `cards list` raises. It used to run the parse step
 * alone, which checks field names and nothing else — `--filter "tag:typoo"`
 * then exported zero rows and called it the export.
 *
 * `ctx` is required, not optional: a caller with no client would silently be
 * back to the half-protocol, which is the bug this signature exists to prevent.
 *
 * @throws ParseError on any refusal — the caller lets it reach `logError`, so
 *         the wording matches `cards list` exactly.
 */
export async function applyFilter(
  cards: Card[],
  filterExpression: string,
  ctx: ValueContext,
): Promise<Card[]> {
  // An EMPTY expression is not an absent one. `--filter "$SPRINT"` with the
  // variable unset used to parse to a null AST and match EVERY card — on
  // `cards export` a whole board in the file, and since #138 routed the bulk
  // writers through here, `batch move --filter "" --yes` moved the whole board
  // and exited 0. `cards list` refused it all along; this is that same refusal.
  refuseEmpty('filter', filterExpression);
  const query = await resolveQuery(filterExpression, ctx);

  // `unblocked` is refused here rather than answered wrong (#47). Judging whether
  // a blocker is FINISHED takes extra reads, and an export writes a file — it is
  // carved out of the envelope contract, so it has no `unreachable` to report the
  // blockers it could not check. Answering anyway would silently drop every card
  // that has any edge at all.
  if (queryNames(query, 'unblocked')) {
    throw new ParseError(
      `"unblocked" is not available on export: it has to judge each blocker, and an ` +
        `export has no way to tell you which ones it could not reach. ` +
        `Ask the frontier instead: favro cards list <board> --filter "unblocked"`,
    );
  }

  return filterCards(query, cards);
}

/**
 * Apply multiple filters to cards using the enhanced query parser.
 * Combines all filters with AND logic (all filters must match).
 * @throws ParseError if any filter names or values are outside the vocabulary
 */
export async function applyFilters(
  cards: Card[],
  filterExpressions: string[],
  ctx: ValueContext,
): Promise<Card[]> {
  if (filterExpressions.length === 0) return cards;
  // Per expression, before composing: `["", "tag:bug"]` would otherwise become
  // `() AND (tag:bug)` and refuse with a parser position instead of the reason.
  for (const expression of filterExpressions) refuseEmpty('filter', expression);

  // Combine multiple filter expressions with AND — each PARENTHESISED, because
  // AND binds tighter than OR. A bare join turned
  // `--filter "a OR b" --filter "c"` into `a OR b AND c`, which parses as
  // `a OR (b AND c)` — a strictly WIDER set than the user asked for. `cards
  // export` wrote the extra rows to a file; since #138 `batch move`/`batch
  // assign` reach the same call, and would have WRITTEN to them.
  // `resolveCardFilter` parenthesises on composition for this exact reason.
  const combinedFilter =
    filterExpressions.length === 1 ? filterExpressions[0] : filterExpressions.map((f) => `(${f})`).join(' AND ');
  return applyFilter(cards, combinedFilter, ctx);
}
