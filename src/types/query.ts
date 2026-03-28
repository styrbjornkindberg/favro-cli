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
  /** Filter: only blocked cards (blockedBy.length > 0) */
  blocked?: boolean;
  /** Filter: only blocking cards (blocking.length > 0) */
  blocking?: boolean;
  /** Filter by relationship to a card ID or title */
  relatesTo?: string;
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
