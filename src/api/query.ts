/**
 * Semantic Query API
 * CLA-1798 / FAVRO-036: Semantic Query Command
 *
 * Executes natural language queries against a board's ContextAPI snapshot.
 * Uses parseAction (CLA-1795) to parse the query and ContextAPI (CLA-1796)
 * to fetch board context.
 *
 * Supported query patterns:
 *   status:done / status:"In Progress"
 *   assigned:@me / assigned:alice
 *   blocked / blocking
 *   relates:card-x
 *   priority:high
 *   label:bug / tag:bug
 *   due:overdue
 *   free text search
 */

import FavroHttpClient from '../lib/http-client';
import ContextAPI, { type BoardContextSnapshot, type ContextCard } from './context';
import type { QueryFilter, QueryMatch, QueryResult } from '../types/query';

// ─── Query Parser ─────────────────────────────────────────────────────────────

/**
 * Parse a natural language query string into a QueryFilter.
 *
 * Supports explicit key:value syntax as well as natural language shorthands.
 * Examples:
 *   "status:done"                → { status: "done" }
 *   "assigned to @alice"         → { owner: "alice" }
 *   "blocked cards"              → { blocked: true }
 *   "priority:high"              → { priority: "high" }
 *   "bug fixes in review"        → { text: "bug fixes", status: "review" }
 *   "overdue"                    → { due: "overdue" }
 *   "relates to api-redesign"    → { relatesTo: "api-redesign" }
 */
export function parseQueryFilter(query: string): QueryFilter {
  const filter: QueryFilter = { rawQuery: query };
  let remaining = query.trim();

  // ── key:value extractions ────────────────────────────────────────────────
  // status:value  (stop at next key: or end of string)
  const statusMatch = remaining.match(/\bstatus:["']?([^"'\s,]+(?:\s+(?![a-z]+:)[^"'\s,]+)*)["']?/i);
  if (statusMatch) {
    filter.status = statusMatch[1].trim();
    remaining = remaining.replace(statusMatch[0], '').trim();
  }

  // assigned:value / owner:value
  const assignedMatch = remaining.match(/\b(?:assigned|owner|assignee):["']?@?([^"'\s,]+)["']?/i);
  if (assignedMatch) {
    filter.owner = assignedMatch[1].replace(/^@/, '').trim();
    remaining = remaining.replace(assignedMatch[0], '').trim();
  }

  // priority:value
  const priorityMatch = remaining.match(/\bpriority:["']?([^"'\s,]+)["']?/i);
  if (priorityMatch) {
    filter.priority = priorityMatch[1].trim();
    remaining = remaining.replace(priorityMatch[0], '').trim();
  }

  // label:value / tag:value
  const labelMatch = remaining.match(/\b(?:label|tag):["']?([^"'\s,]+)["']?/i);
  if (labelMatch) {
    filter.label = labelMatch[1].trim();
    remaining = remaining.replace(labelMatch[0], '').trim();
  }

  // relates:value / relates-to:value
  const relatesToMatch = remaining.match(/\brelates(?:-to)?:["']?([^"'\s,]+(?:\s+[^"'\s,]+)*)["']?/i);
  if (relatesToMatch) {
    filter.relatesTo = relatesToMatch[1].trim();
    remaining = remaining.replace(relatesToMatch[0], '').trim();
  }

  // due:value
  const dueMatch = remaining.match(/\bdue:["']?([^"'\s,]+)["']?/i);
  if (dueMatch) {
    filter.due = dueMatch[1].trim();
    remaining = remaining.replace(dueMatch[0], '').trim();
  }

  // ── Natural language shorthands ──────────────────────────────────────────
  // "blocked" / "blocked cards"
  if (/\bblocked(?:\s+cards?)?\b/i.test(remaining) && !/\bblocking\b/i.test(remaining)) {
    filter.blocked = true;
    remaining = remaining.replace(/\bblocked(?:\s+cards?)?\b/i, '').trim();
  }

  // "blocking"
  if (/\bblocking(?:\s+cards?)?\b/i.test(remaining)) {
    filter.blocking = true;
    remaining = remaining.replace(/\bblocking(?:\s+cards?)?\b/i, '').trim();
  }

  // "overdue" shorthand
  if (/\boverdue\b/i.test(remaining)) {
    filter.due = filter.due ?? 'overdue';
    remaining = remaining.replace(/\boverdue\b/i, '').trim();
  }

  // "assigned to @alice" / "assigned to alice"
  if (!filter.owner) {
    const assignedToMatch = remaining.match(/\bassigned\s+to\s+@?(\w+)/i);
    if (assignedToMatch) {
      filter.owner = assignedToMatch[1];
      remaining = remaining.replace(assignedToMatch[0], '').trim();
    }
  }

  // "relates to <card>" / "related to <card>"
  if (!filter.relatesTo) {
    const relatesToNlMatch = remaining.match(/\brelate[sd]?\s+to\s+["']?([^"'\n]+?)["']?(?:\s|$)/i);
    if (relatesToNlMatch) {
      filter.relatesTo = relatesToNlMatch[1].trim();
      remaining = remaining.replace(relatesToNlMatch[0], '').trim();
    }
  }

  // "with status <status>" / "in status <status>"
  if (!filter.status) {
    const withStatusMatch = remaining.match(/\b(?:with|in)\s+status\s+["']?([^"'\s,]+(?:\s+[^"'\s,]+)*)["']?/i);
    if (withStatusMatch) {
      filter.status = withStatusMatch[1].trim();
      remaining = remaining.replace(withStatusMatch[0], '').trim();
    }
  }

  // "high priority" / "low priority" (adjective-before-noun)
  if (!filter.priority) {
    const adjPriorityMatch = remaining.match(/\b(critical|high|medium|low|urgent)\s+priority\b/i);
    if (adjPriorityMatch) {
      filter.priority = adjPriorityMatch[1].toLowerCase();
      remaining = remaining.replace(adjPriorityMatch[0], '').trim();
    }
  }

  // "done" / "in progress" / "todo" — naked status shorthand (only if no status yet)
  if (!filter.status) {
    const nakedStatusMatch = remaining.match(/\b(done|finished|completed|closed)\b/i);
    if (nakedStatusMatch) {
      filter.status = nakedStatusMatch[1].toLowerCase();
      remaining = remaining.replace(nakedStatusMatch[0], '').trim();
    }
  }

  // Clean up punctuation / stop words from remaining
  const stopWords = /\b(cards?|show|list|find|get|all|the|that|are|is|have|has|been|my|me|with|and|or|in|on|for|by|to|of|a|an)\b/gi;
  remaining = remaining.replace(stopWords, '').replace(/\s+/g, ' ').trim();

  // Whatever is left: free-text search
  if (remaining.length > 2) {
    filter.text = remaining;
  }

  return filter;
}

// ─── Card Matcher ─────────────────────────────────────────────────────────────

/**
 * Check whether a card matches the given filter.
 * Returns a match reason string if it matches, or null if it doesn't.
 */
export function matchCard(
  card: ContextCard,
  filter: QueryFilter,
  context: BoardContextSnapshot,
): string | null {
  const reasons: string[] = [];

  // ── Status ──────────────────────────────────────────────────────────────
  if (filter.status !== undefined) {
    const cardStatus = (card.status ?? '').toLowerCase();
    const filterStatus = filter.status.toLowerCase();
    if (!cardStatus.includes(filterStatus) && cardStatus !== filterStatus) {
      return null;
    }
    reasons.push(`status: ${card.status}`);
  }

  // ── Owner / assignee ────────────────────────────────────────────────────
  if (filter.owner !== undefined) {
    const filterOwner = filter.owner.toLowerCase();
    const assignees = card.assignees ?? [];

    // Support @me → match any card that has at least one assignee
    const isMe = filterOwner === 'me';

    const matched = isMe
      ? assignees.length > 0
      : assignees.some(a => {
          const al = a.toLowerCase();
          return al.includes(filterOwner) || al === filterOwner;
        });

    // @me with no assignees → no match
    if (isMe && !matched) {
      return null;
    }

    // Also check against member names/emails from context
    if (!matched && !isMe) {
      const memberMatch = context.members.find(m => {
        const ml = (m.name + ' ' + m.email).toLowerCase();
        return ml.includes(filterOwner);
      });
      if (memberMatch) {
        const inCard = assignees.some(a => {
          const al = a.toLowerCase();
          return al.includes((memberMatch.email ?? '').toLowerCase()) ||
                 al.includes((memberMatch.name ?? '').toLowerCase());
        });
        if (!inCard) return null;
      } else {
        return null;
      }
    }

    reasons.push(`assigned to: ${assignees.join(', ') || 'unassigned'}`);
  }

  // ── Label / tag ─────────────────────────────────────────────────────────
  if (filter.label !== undefined) {
    const filterLabel = filter.label.toLowerCase();
    const tags = card.tags ?? [];
    if (!tags.some(t => t.toLowerCase().includes(filterLabel))) {
      return null;
    }
    reasons.push(`tag: ${filter.label}`);
  }

  // ── Blocked ──────────────────────────────────────────────────────────────
  if (filter.blocked === true) {
    if (!card.blockedBy || card.blockedBy.length === 0) {
      return null;
    }
    reasons.push(`blocked by: ${card.blockedBy.join(', ')}`);
  }

  // ── Blocking ─────────────────────────────────────────────────────────────
  if (filter.blocking === true) {
    if (!card.blocking || card.blocking.length === 0) {
      return null;
    }
    reasons.push(`blocking: ${card.blocking.join(', ')}`);
  }

  // ── Relates to ──────────────────────────────────────────────────────────
  if (filter.relatesTo !== undefined) {
    const filterRel = filter.relatesTo.toLowerCase();
    const allLinks = [...(card.blockedBy ?? []), ...(card.blocking ?? [])];
    const matched = allLinks.some(l => l.toLowerCase().includes(filterRel));
    if (!matched) {
      return null;
    }
    reasons.push(`relates to: ${filter.relatesTo}`);
  }

  // ── Priority ────────────────────────────────────────────────────────────
  if (filter.priority !== undefined) {
    const filterPriority = filter.priority.toLowerCase();
    const customFields = card.customFields ?? {};
    const priorityValue = (
      customFields['priority'] ??
      customFields['Priority'] ??
      customFields['Urgency'] ??
      customFields['urgency']
    );
    if (!priorityValue) {
      return null;
    }
    const pv = String(priorityValue).toLowerCase();
    if (!pv.includes(filterPriority)) {
      return null;
    }
    reasons.push(`priority: ${priorityValue}`);
  }

  // ── Due date ────────────────────────────────────────────────────────────
  if (filter.due !== undefined) {
    const filterDue = filter.due.toLowerCase();
    if (!card.due) {
      return null;
    }
    if (filterDue === 'overdue') {
      const dueDate = new Date(card.due);
      const now = new Date();
      if (isNaN(dueDate.getTime()) || dueDate >= now) {
        return null;
      }
      reasons.push(`overdue (due: ${card.due})`);
    } else {
      // Date match: check if due contains the filter date string
      if (!card.due.includes(filter.due)) {
        return null;
      }
      reasons.push(`due: ${card.due}`);
    }
  }

  // ── Free-text search ────────────────────────────────────────────────────
  if (filter.text !== undefined && filter.text.length > 0) {
    const filterText = filter.text.toLowerCase();
    const titleMatch = card.title.toLowerCase().includes(filterText);
    const tagMatch = (card.tags ?? []).some(t => t.toLowerCase().includes(filterText));
    if (!titleMatch && !tagMatch) {
      return null;
    }
    reasons.push(`matches: "${filter.text}"`);
  }

  // If no specific filter criteria were set (empty filter), match everything
  if (reasons.length === 0) {
    return 'all cards';
  }

  return reasons.join('; ');
}

// ─── No-Results Explainer ─────────────────────────────────────────────────────

/**
 * Explain why a query returned no results.
 * Looks at the card population to give specific, useful feedback.
 */
export function explainNoResults(
  filter: QueryFilter,
  context: BoardContextSnapshot,
): string {
  const { cards } = context;
  const rawQuery = filter.rawQuery ?? '';

  if (cards.length === 0) {
    return `Board "${context.board.name}" has no cards.`;
  }

  // Status mismatch
  if (filter.status) {
    const filterStatus = filter.status.toLowerCase();
    const statuses = [...new Set(cards.map(c => c.status ?? 'Unknown'))];
    const statusList = statuses.map(s => `"${s}"`).join(', ');
    return (
      `No cards have status "${filter.status}" in board "${context.board.name}". ` +
      `Available statuses: ${statusList}.`
    );
  }

  // Owner mismatch
  if (filter.owner) {
    const filterOwner = filter.owner.toLowerCase();
    // Check if cards exist with this status but different owner
    if (filter.status) {
      const statusCards = cards.filter(c =>
        (c.status ?? '').toLowerCase().includes((filter.status ?? '').toLowerCase())
      );
      if (statusCards.length > 0) {
        const owners = [...new Set(statusCards.flatMap(c => c.assignees ?? []))];
        if (owners.length === 0) {
          return `All cards matching status "${filter.status}" are unassigned.`;
        }
        return (
          `No cards with status "${filter.status}" are assigned to "${filter.owner}". ` +
          `That status is assigned to: ${owners.slice(0, 3).join(', ')}.`
        );
      }
    }
    // Generic owner message
    const allAssignees = [...new Set(cards.flatMap(c => c.assignees ?? []))];
    if (allAssignees.length === 0) {
      return `No cards in board "${context.board.name}" are assigned to anyone.`;
    }
    return (
      `No cards are assigned to "${filter.owner}" in board "${context.board.name}". ` +
      `Active assignees: ${allAssignees.slice(0, 3).join(', ')}.`
    );
  }

  // Blocked
  if (filter.blocked) {
    return `No cards in board "${context.board.name}" are currently blocked.`;
  }

  // Blocking
  if (filter.blocking) {
    return `No cards in board "${context.board.name}" are currently blocking others.`;
  }

  // Priority
  if (filter.priority) {
    return (
      `No cards have priority "${filter.priority}" in board "${context.board.name}". ` +
      `Check if the "Priority" custom field is set on your cards.`
    );
  }

  // Label
  if (filter.label) {
    const allTags = [...new Set(cards.flatMap(c => c.tags ?? []))];
    const tagList = allTags.length > 0 ? allTags.slice(0, 5).join(', ') : 'none';
    return (
      `No cards have tag "${filter.label}" in board "${context.board.name}". ` +
      `Available tags: ${tagList}.`
    );
  }

  // Relates to
  if (filter.relatesTo) {
    return (
      `No cards relate to "${filter.relatesTo}" in board "${context.board.name}".`
    );
  }

  // Due / overdue
  if (filter.due) {
    if (filter.due === 'overdue') {
      return `No cards are overdue in board "${context.board.name}".`;
    }
    return `No cards are due on "${filter.due}" in board "${context.board.name}".`;
  }

  // Text search
  if (filter.text) {
    return `No cards match "${filter.text}" in board "${context.board.name}".`;
  }

  // Generic fallback
  return `No cards match '${rawQuery}' in board "${context.board.name}".`;
}

// ─── Summary Builder ──────────────────────────────────────────────────────────

/**
 * Build a human-readable summary line from a list of matches.
 */
export function buildSummary(matches: QueryMatch[], filter: QueryFilter): string {
  if (matches.length === 0) {
    return '';
  }

  const count = matches.length;
  const noun = count === 1 ? 'card' : 'cards';

  // Short list: show all titles
  if (count <= 5) {
    const titles = matches.map(m => `"${m.card.title}"`).join(', ');
    return `Found ${count} matching ${noun}: ${titles}`;
  }

  // Long list: show first 3 with ellipsis
  const first3 = matches.slice(0, 3).map(m => `"${m.card.title}"`).join(', ');
  return `Found ${count} matching ${noun}: ${first3}, … and ${count - 3} more`;
}

// ─── QueryAPI ─────────────────────────────────────────────────────────────────

export class QueryAPI {
  private contextApi: ContextAPI;

  constructor(private client: FavroHttpClient) {
    this.contextApi = new ContextAPI(client);
  }

  /**
   * Execute a natural language query against a board.
   *
   * @param boardRef   Board name or ID
   * @param query      Natural language query string
   * @param cardLimit  Max cards to fetch (default 1000)
   */
  async execute(
    boardRef: string,
    query: string,
    cardLimit: number = 1000,
  ): Promise<QueryResult> {
    // Fetch board context
    const context = await this.contextApi.getSnapshot(boardRef, cardLimit);

    // Parse query into filter
    const filter = parseQueryFilter(query);

    // Filter cards
    const matches: QueryMatch[] = [];
    for (const card of context.cards) {
      const reason = matchCard(card, filter, context);
      if (reason !== null) {
        matches.push({ card, matchReason: reason });
      }
    }

    // Build summary / explanation
    let summary: string;
    let noResultsExplanation: string | undefined;

    if (matches.length === 0) {
      noResultsExplanation = explainNoResults(filter, context);
      summary = noResultsExplanation;
    } else {
      summary = buildSummary(matches, filter);
    }

    return {
      matches,
      total: context.cards.length,
      filter,
      summary,
      noResultsExplanation,
    };
  }
}

export default QueryAPI;
