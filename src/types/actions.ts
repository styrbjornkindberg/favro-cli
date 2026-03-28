/**
 * Natural Language Action Parser — Types
 * CLA-1795 / FAVRO-033: Natural Language Action Parser API
 *
 * Defines the ParsedAction interface returned by parseAction().
 * This is the public output contract for the NL parser.
 */

/**
 * A reference to a card from the board, used for fuzzy matching.
 */
export interface CardRef {
  id: string;
  name: string;
}

/**
 * A single fuzzy match result for a card title.
 */
export interface CardMatch {
  id: string;
  name: string;
  score: number; // 0.0 (no match) → 1.0 (exact)
}

/**
 * Ambiguity result: returned when the card title matches multiple cards.
 * Top 3 matches are provided so the caller can prompt the user.
 */
export interface AmbiguityResult {
  /** Top 3 fuzzy matches, sorted by score descending */
  cardMatches: CardMatch[];
  /** Always true when ambiguities are present */
  requiresUserChoice: boolean;
}

/**
 * The structured output of parseAction().
 *
 * verb        — the detected action (move, assign, set, link, create, close)
 * cardName    — the raw card title extracted from the input
 * targetValue — the target of the action (status, assignee, priority, etc.)
 * secondCard  — only for "link" actions — the target card title
 * ambiguities — populated when cardName fuzzy-matches multiple cards
 */
export interface ParsedAction {
  verb: string;
  cardName?: string;
  targetValue?: string;
  /** For link actions: the second card name */
  secondCard?: string;
  ambiguities?: AmbiguityResult;
}
