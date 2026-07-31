/**
 * Semantic Query Command — Types
 * CLA-1798 / FAVRO-036: Semantic Query Command
 *
 * Defines types for the query result returned by QueryAPI.execute().
 */

import type { ContextCard } from '../api/context';

// ─── Query Filter ─────────────────────────────────────────────────────────────

/**
 * Parsed query filter extracted from natural language.
 * Each field is optional — unspecified means "match anything".
 */
export interface QueryFilter {
  /** Filter by status (e.g. "done", "In Progress") */
  status?: string;
  /** Filter by assignee name, email, or @-handle */
  owner?: string;
  /** Filter by label/tag */
  label?: string;
  // `blocked` / `blocking` / `relatesTo` are GONE (#47). They read `card.links`,
  // which `normalizeCard` never populated, so all three answered about an empty
  // array on every card. Blocking lives on `cards list --filter` — `unblocked`,
  // `blocks:`, `blocked-by:` — where it reads the real `isBefore` edge and where
  // a mistyped predicate is a refusal instead of a free-text title search.
  /** Filter by priority custom field value */
  priority?: string;
  /** Free-text search across title and tags */
  text?: string;
  /** Filter by due date (ISO string or human term like "overdue") */
  due?: string;
  /** Raw query string (for "no results" messages) */
  rawQuery?: string;
}

// ─── Query Result ─────────────────────────────────────────────────────────────

/**
 * A single card in the query result, with a human-readable reason it matched.
 */
export interface QueryMatch {
  card: ContextCard;
  /** Brief human-readable reason why this card matched (for "explains why" feature) */
  matchReason: string;
}

/**
 * Result of executing a semantic query.
 */
export interface QueryResult {
  /** Matching cards */
  matches: QueryMatch[];
  /** Total cards searched */
  total: number;
  /** Parsed filter that was applied */
  filter: QueryFilter;
  /** Human-readable summary line (e.g. "Found 3 matching cards: …") */
  summary: string;
  /** If no results, explanation of why (e.g. "No cards have status 'done' in this board") */
  noResultsExplanation?: string;
}
