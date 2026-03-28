/**
 * Natural Language Action Parser — Public API
 * CLA-1795 / FAVRO-033: Natural Language Action Parser API
 *
 * Wraps the internal action-parser (CLA-1803) to expose the flat
 * ParsedAction interface required by FAVRO-033.
 *
 * Input examples:
 *   "move card 'urgent bug' to In Progress"
 *   "assign @john to 'review feedback'"
 *   "set status to Closed on 'old ticket'"
 *   "link 'feature-x' to 'requirement-a'"
 *   "create card 'new task' in backlog"
 *   "close card 'resolved issue'"
 *
 * Output:
 *   { verb, cardName?, targetValue?, secondCard?, ambiguities? }
 */

import {
  parseAction as parseActionCore,
  findMatchingCards,
  ActionParseError,
  type MoveAction,
  type AssignAction,
  type SetPriorityAction,
  type AddDateAction,
  type LinkAction,
  type CreateAction,
  type CloseAction,
  type ParsedAction as CoreParsedAction,
} from './action-parser';

import type { ParsedAction, CardRef } from '../types/actions';

export { ActionParseError };
export type { ParsedAction };

// ---------------------------------------------------------------------------
// Core conversion
// ---------------------------------------------------------------------------

/**
 * Convert an internal CoreParsedAction to the flat ParsedAction format.
 */
function toFlat(core: CoreParsedAction): ParsedAction {
  switch (core.type) {
    case 'move':
      return {
        verb: 'move',
        cardName: core.title,
        targetValue: core.toStatus,
      };

    case 'assign':
      return {
        verb: 'assign',
        cardName: core.title,
        targetValue: core.owner,
      };

    case 'set-priority':
      return {
        verb: 'set',
        cardName: core.title,
        targetValue: core.priority,
      };

    case 'add-date':
      return {
        verb: 'set',
        cardName: core.title,
        targetValue: core.date,
      };

    case 'link':
      return {
        verb: 'link',
        cardName: core.title,
        targetValue: core.relationship,
        secondCard: core.targetTitle,
      };

    case 'create':
      return {
        verb: 'create',
        cardName: core.title,
        targetValue: core.status,
      };

    case 'close':
      return {
        verb: 'close',
        cardName: core.title,
      };

    default: {
      const _exhaustive: never = core;
      return { verb: 'unknown' };
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a natural language action string into a flat ParsedAction.
 *
 * When `cards` is provided, the parsed cardName is fuzzy-matched against the
 * known card list. If multiple cards match at a similar score, the result
 * includes an `ambiguities` field with the top 3 candidates.
 *
 * @param input  Plain English action string
 * @param cards  Optional list of known cards for fuzzy matching
 * @throws ActionParseError if input cannot be parsed
 */
export async function parseAction(
  input: string,
  cards: CardRef[] = []
): Promise<ParsedAction> {
  // Parse using the internal parser (sync)
  const core = parseActionCore(input);
  const flat = toFlat(core);

  // If we have a cardName and a card list, do fuzzy matching
  if (flat.cardName && cards.length > 0) {
    const cardTitles = cards.map(c => c.name);
    const matches = findMatchingCards(flat.cardName, cardTitles, 0.5);

    if (matches.length === 0) {
      // No match found — return as-is, no ambiguity
      return flat;
    }

    const topScore = matches[0].score;

    // Check for ties at the top score (ambiguity)
    const tied = matches.filter(m => Math.abs(m.score - topScore) < 0.01);

    if (tied.length > 1 && topScore < 1.0) {
      // Multiple cards at the same fuzzy score — ambiguous
      const top3 = matches.slice(0, 3);
      return {
        ...flat,
        ambiguities: {
          cardMatches: top3.map(m => {
            const ref = cards.find(c => c.name === m.title);
            return { id: ref?.id ?? '', name: m.title, score: m.score };
          }),
          requiresUserChoice: true,
        },
      };
    }

    // Check for exact match among cards — return matched card name (preserves casing)
    if (topScore === 1.0) {
      // Exact match — check for duplicate exact matches
      const exactMatches = matches.filter(m => m.score === 1.0);
      if (exactMatches.length > 1) {
        return {
          ...flat,
          ambiguities: {
            cardMatches: exactMatches.slice(0, 3).map(m => {
              const ref = cards.find(c => c.name === m.title);
              return { id: ref?.id ?? '', name: m.title, score: m.score };
            }),
            requiresUserChoice: true,
          },
        };
      }
      // Single exact match — update cardName to canonical name
      const ref = cards.find(c => c.name === matches[0].title);
      return {
        ...flat,
        cardName: ref?.name ?? flat.cardName,
      };
    }

    // Single best fuzzy match
    return {
      ...flat,
      cardName: matches[0].title,
    };
  }

  return flat;
}
