/**
 * `favro query` — result types.
 *
 * `QueryFilter` and `QueryMatch` are GONE (#95). Both were artefacts of the
 * second, fail-open parser this command used to run:
 *
 *   - `QueryFilter` was that parser's bag of scraped fields (`owner`, `priority`,
 *     `text`, `due`) — a vocabulary no other surface spoke. The filter a query
 *     runs is now a `Query`, the same parsed AST `cards list --filter` gets, and
 *     its `raw` is the expression as typed while its `ast` carries the values
 *     already SETTLED (`assignee:` as a userId, `status:` as the column's own
 *     name).
 *   - `QueryMatch` wrapped each card with a `matchReason` string the old matcher
 *     assembled as it scraped. With one fail-closed grammar the reason every row
 *     matched is the query, which the summary states once; a per-row copy of the
 *     same sentence is not information.
 */

import type { ContextCard } from '../api/context';
import type { Query } from '../lib/query-parser';
import type { Unreachable } from '../lib/read-shape';

/**
 * Result of running a filter expression against one board.
 */
export interface QueryResult {
  /** The cards that matched, normalised the way `favro context` renders them. */
  matches: ContextCard[];
  /** Total cards searched. */
  total: number;
  /** The parsed, value-settled query that was applied. */
  filter: Query;
  /** The one line every run prints — the match list, or the empty answer. */
  summary: string;
  /**
   * Facets of the board this query could not read (#116). Present only when
   * there are any, so `matches: []` with no marker means the board genuinely
   * holds no matching card rather than that the fetch died.
   */
  unreachable?: Unreachable[];
}
