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
import { resolveQuery, ValueContext } from './query-values';

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
 *         the wording and the structured `detail` match `cards list` exactly.
 */
export async function applyFilter(
  cards: Card[],
  filterExpression: string,
  ctx: ValueContext,
): Promise<Card[]> {
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
      { kind: 'unsupported-here', field: 'unblocked', value: 'unblocked' },
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

  // Combine multiple filter expressions with AND operator
  const combinedFilter = filterExpressions.join(' AND ');
  return applyFilter(cards, combinedFilter, ctx);
}
