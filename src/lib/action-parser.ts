/**
 * Natural Language Action Parser — CLA-1803 / FAVRO-041 (SPEC-003 T001)
 *
 * Parses individual natural language commands for card actions:
 *
 *   move card "<title>" from <status> to <status>
 *   assign "<title>" to <owner>
 *   set priority of "<title>" to <priority>
 *   add "<title>" to <date>
 *   link "<title>" blocks "<other-title>"
 *   create card "<title>" in <status> [with priority <p>, owner <o>, effort <e>]
 *   close "<title>"
 *
 * Fuzzy matching is provided via `findMatchingCards()` and `resolveCard()`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActionType = 'move' | 'assign' | 'set-priority' | 'add-date' | 'link' | 'create' | 'close';

export type LinkRelationship = 'blocks' | 'depends' | 'depends-on' | 'relates' | 'relates-to';

export interface MoveAction {
  type: 'move';
  title: string;
  fromStatus: string;
  toStatus: string;
}

export interface AssignAction {
  type: 'assign';
  title: string;
  owner: string;
}

export interface SetPriorityAction {
  type: 'set-priority';
  title: string;
  priority: string;
}

export interface AddDateAction {
  type: 'add-date';
  title: string;
  date: string;
}

export interface LinkAction {
  type: 'link';
  title: string;
  relationship: LinkRelationship;
  targetTitle: string;
}

export interface CreateAction {
  type: 'create';
  title: string;
  status: string;
  priority?: string;
  owner?: string;
  effort?: string;
}

export interface CloseAction {
  type: 'close';
  title: string;
}

export type ParsedAction =
  | MoveAction
  | AssignAction
  | SetPriorityAction
  | AddDateAction
  | LinkAction
  | CreateAction
  | CloseAction;

export class ActionParseError extends Error {
  constructor(message: string, public readonly input?: string) {
    super(message);
    this.name = 'ActionParseError';
  }
}

// ---------------------------------------------------------------------------
// Known valid values
// ---------------------------------------------------------------------------

export const VALID_PRIORITIES = ['low', 'medium', 'high', 'critical', 'urgent'];

export const VALID_LINK_RELATIONSHIPS: LinkRelationship[] = [
  'blocks', 'depends', 'depends-on', 'relates', 'relates-to',
];

// ---------------------------------------------------------------------------
// Title extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract a quoted or unquoted title from a string starting at position 0.
 * Returns { title, rest } where rest is the remaining string after the title.
 *
 * Supports:
 *   - "double quoted"
 *   - 'single quoted'
 *   - unquoted (reads until a known keyword boundary)
 */
export function extractTitle(input: string): { title: string; rest: string } {
  const s = input.trimStart();
  if (!s) {
    throw new ActionParseError(`Expected a card title but got empty input`);
  }

  // Quoted title
  if (s[0] === '"' || s[0] === "'") {
    const quote = s[0];
    let title = '';
    let i = 1;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\\' && i + 1 < s.length) {
        // Escape sequence — consume next char literally
        title += s[i + 1];
        i += 2;
      } else if (ch === quote) {
        // Closing quote
        i++;
        break;
      } else {
        title += ch;
        i++;
      }
      // If we reach the end without closing quote, it's unterminated
      if (i >= s.length && s[s.length - 1] !== quote) {
        // Check if we never hit closing quote
        if (!s.slice(1).includes(quote)) {
          throw new ActionParseError(`Unterminated quote in title: ${s}`);
        }
      }
    }
    // Verify we actually found a closing quote
    if (i === s.length + 1 || (i <= s.length && s[i - 1] !== quote && !title && !s.slice(1).includes(quote))) {
      throw new ActionParseError(`Unterminated quote in title: ${s}`);
    }
    title = title.trim();
    if (!title) {
      throw new ActionParseError(`Empty quoted title is not allowed`);
    }
    const rest = s.slice(i).trimStart();
    return { title, rest };
  }

  // Unquoted — read until a keyword boundary
  // Boundaries: " from ", " to ", " in ", " blocks ", " depends ", " relates ", EOL
  const BOUNDARIES = [
    / from /i, / to /i, / in /i, / blocks /i, / depends /i, / relates /i,
    / with /i, / at /i, / on /i,
  ];

  // BUG 2 fix: Find the FIRST boundary match (earliest index)
  let firstMatch: { index: number; fullMatch: string } | null = null;
  for (const boundary of BOUNDARIES) {
    const m = s.match(boundary);
    if (m && m.index !== undefined && m.index > 0) {
      if (firstMatch === null || m.index < firstMatch.index) {
        firstMatch = { index: m.index, fullMatch: m[0] };
      }
    }
  }

  if (firstMatch) {
    const candidateTitle = s.slice(0, firstMatch.index).trim();
    const rest = s.slice(firstMatch.index).trimStart();
    return { title: candidateTitle, rest };
  }

  // No boundary found — entire string is the title
  return { title: s.trim(), rest: '' };
}

function findClosingQuote(s: string, start: number, quote: string): number {
  for (let i = start; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) { i++; continue; } // skip escape
    if (s[i] === quote) return i;
  }
  return -1;
}

/**
 * Strip optional article "card" or "the card" or "the" from the front of a string.
 */
function stripArticle(s: string): string {
  return s
    .replace(/^the\s+card\s+/i, '')
    .replace(/^card\s+/i, '')
    .replace(/^the\s+/i, '')
    .trimStart();
}

// Boundary keywords that can incorrectly truncate unquoted titles
const BOUNDARY_KEYWORDS_RE = /^(from|to|in|blocks|depends|relates|with|at|on)\s/i;

/**
 * BUG 2 fix (structural): For unquoted titles, detect when the body starts with
 * a boundary keyword. This means the user typed a title containing a boundary word
 * but forgot quotes — causing the parser to extract only a fragment.
 *
 * For quoted input, this check is skipped (quotes protect boundary words).
 *
 * @param body  The input to extractTitle (after stripping action keyword + articles)
 * @param action  The action name for the error message
 * @param raw  The original raw input for error context
 */
function assertNoBoundaryStart(body: string, action: string, raw: string): void {
  if (!body) return;
  // Only applies to unquoted titles — quoted titles start with " or '
  if (body[0] === '"' || body[0] === "'") return;
  if (BOUNDARY_KEYWORDS_RE.test(body)) {
    throw new ActionParseError(
      `Unquoted title starts with boundary keyword "${body.split(/\s/)[0]}". ` +
      `Use quotes to include boundary words in titles: ${action} "<title with keyword>" ...`,
      raw
    );
  }
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Parse a natural language action string into a typed ParsedAction.
 *
 * @throws ActionParseError if the input cannot be parsed
 */
export function parseAction(input: string): ParsedAction {
  if (!input || !input.trim()) {
    throw new ActionParseError('Input is empty');
  }

  const raw = input.trim();

  // ── move card "<title>" from <status> to <status> ──
  if (/^move\b/i.test(raw)) {
    return parseMoveAction(raw);
  }

  // ── assign "<title>" to <owner> ──
  if (/^assign\b/i.test(raw)) {
    return parseAssignAction(raw);
  }

  // ── set priority of "<title>" to <priority> ──
  if (/^set\b/i.test(raw)) {
    return parseSetAction(raw);
  }

  // ── add "<title>" to <date> ──
  if (/^add\b/i.test(raw)) {
    return parseAddAction(raw);
  }

  // ── link "<title>" blocks|depends|relates "<other-title>" ──
  if (/^link\b/i.test(raw)) {
    return parseLinkAction(raw);
  }

  // ── create card "<title>" in <status> [with priority <p>, owner <o>, effort <e>] ──
  if (/^create\b/i.test(raw)) {
    return parseCreateAction(raw);
  }

  // ── close "<title>" ──
  if (/^close\b/i.test(raw)) {
    return parseCloseAction(raw);
  }

  // ── done "<title>" (alias for close) ──
  if (/^done\b/i.test(raw)) {
    return parseCloseAction(raw);
  }

  throw new ActionParseError(
    `Unknown action "${raw.split(/\s/)[0]}". ` +
    `Supported actions: move, assign, set, add, link, create, close.`,
    raw
  );
}

// ---------------------------------------------------------------------------
// Action-specific parsers
// ---------------------------------------------------------------------------

function parseMoveAction(raw: string): MoveAction {
  // Strip "move [card] [the] "
  const body = stripArticle(raw.replace(/^move\s+/i, '').trimStart());

  if (!body) {
    throw new ActionParseError(`Cannot parse move action. Expected: move card "<title>" from <status> to <status>`, raw);
  }

  // BUG 2 fix (structural): detect unquoted title starting with boundary keyword
  assertNoBoundaryStart(body, 'move card', raw);

  const { title, rest } = extractTitle(body);

  // Expect: from <status> to <status>  OR  to <status> (from is optional)
  const fullMatch = rest.match(/^from\s+(.+?)\s+to\s+(.+)$/i);
  if (fullMatch) {
    const fromStatus = fullMatch[1].trim();
    const toStatus = fullMatch[2].trim();
    // BUG 2 fix: Detect unquoted title truncation at boundary word.
    if (toStatus.includes(' to ') || fromStatus.includes(' to ')) {
      throw new ActionParseError(
        `Unquoted title "${title}" may be truncated by boundary keyword. Use quotes.`,
        raw
      );
    }
    return {
      type: 'move',
      title,
      fromStatus,
      toStatus,
    };
  }

  // Just "to <status>"
  const toMatch = rest.match(/^to\s+(.+)$/i);
  if (toMatch) {
    const toStatus = toMatch[1].trim();
    // BUG 2 fix: Detect unquoted title truncation at boundary word.
    if (toStatus.includes(' to ')) {
      throw new ActionParseError(
        `Unquoted title "${title}" may be truncated by boundary keyword. Use quotes.`,
        raw
      );
    }
    return {
      type: 'move',
      title,
      fromStatus: '',
      toStatus,
    };
  }

  throw new ActionParseError(
    `Cannot parse move action. Expected: move card "<title>" from <status> to <status>`,
    raw
  );
}

function parseAssignAction(raw: string): AssignAction {
  // Strip "assign [card] [the] "
  const body = stripArticle(raw.replace(/^assign\s+/i, '').trimStart());

  if (!body) {
    throw new ActionParseError(`Cannot parse assign action. Expected: assign "<title>" to <owner>`, raw);
  }

  // BUG 2 fix (structural): detect unquoted title starting with boundary keyword
  assertNoBoundaryStart(body, 'assign', raw);

  const { title, rest } = extractTitle(body);

  const toMatch = rest.match(/^to\s+(.+)$/i);
  if (!toMatch) {
    throw new ActionParseError(
      `Cannot parse assign action. Expected: assign "<title>" to <owner>`,
      raw
    );
  }

  // Owner can be quoted or unquoted
  let owner = toMatch[1].trim();

  // BUG 2 fix: Detect unquoted title truncation at boundary word.
  if (owner.includes(' to ')) {
    throw new ActionParseError(
      `Unquoted title "${title}" may be truncated by boundary keyword. Use quotes.`,
      raw
    );
  }
  if ((owner.startsWith('"') && owner.endsWith('"')) ||
      (owner.startsWith("'") && owner.endsWith("'"))) {
    owner = owner.slice(1, -1);
  }

  // BUG 4 fix: Detect comma-separated multi-assignee input and reject it
  if (owner.includes(',')) {
    throw new ActionParseError(
      'Multiple assignees not supported. Use separate assign commands.',
      raw
    );
  }

  return {
    type: 'assign',
    title,
    owner,
  };
}

function parseSetAction(raw: string): SetPriorityAction {
  // Pattern 1: set [the] priority of "<title>" to <priority>
  const prefixOfMatch = raw.match(/^set\s+(?:the\s+)?priority\s+of\s+(.+)$/i);
  if (prefixOfMatch) {
    const rest = prefixOfMatch[1].trim();
    const { title, rest: afterTitle } = extractTitle(rest);
    const toMatch = afterTitle.match(/^to\s+(.+)$/i);
    if (!toMatch) {
      throw new ActionParseError(
        `Cannot parse set action. Expected: set priority of "<title>" to <priority>`,
        raw
      );
    }
    return { type: 'set-priority', title, priority: toMatch[1].trim() };
  }

  // Pattern 2: set "<title>" priority to <priority>
  const titlePriorityMatch = raw.match(/^set\s+(["'].+?["'])\s+priority\s+to\s+(.+)$/i);
  if (titlePriorityMatch) {
    const { title } = extractTitle(titlePriorityMatch[1]);
    return { type: 'set-priority', title, priority: titlePriorityMatch[2].trim() };
  }

  throw new ActionParseError(
    `Cannot parse set action. Expected: set priority of "<title>" to <priority>`,
    raw
  );
}

function parseAddAction(raw: string): AddDateAction {
  // add [due date of] "<title>" to <date>
  // Strip "add [due date of] "
  const bodyFull = raw.replace(/^add\s+/i, '').trimStart();
  const body = bodyFull.replace(/^due\s+date\s+of\s+/i, '').trimStart();

  if (!body) {
    throw new ActionParseError(`Cannot parse add action. Expected: add "<title>" to <date>`, raw);
  }

  // BUG 2 fix (structural): detect unquoted title starting with boundary keyword
  assertNoBoundaryStart(body, 'add', raw);

  const { title, rest } = extractTitle(body);

  const toMatch = rest.match(/^to\s+(.+)$/i);
  if (!toMatch) {
    throw new ActionParseError(
      `Cannot parse add action. Expected: add "<title>" to <date>`,
      raw
    );
  }

  const date = toMatch[1].trim();

  // BUG 2 fix: Detect unquoted title truncation at boundary word.
  if (date.includes(' to ')) {
    throw new ActionParseError(
      `Unquoted title "${title}" may be truncated by boundary keyword. Use quotes.`,
      raw
    );
  }

  return { type: 'add-date', title, date };
}

function parseLinkAction(raw: string): LinkAction {
  // link "<title>" blocks|depends on|relates to|depends|relates "<other>"
  // Remove "link " prefix
  const body = raw.replace(/^link\s+/i, '').trimStart();

  if (!body) {
    throw new ActionParseError(`Cannot parse link action. Expected: link "<title>" blocks|depends|relates "<other-title>"`, raw);
  }

  // Try to find the relationship keyword between two titles
  // Order matters: try multi-word relations first
  const relPatterns: Array<{ pattern: string; rel: LinkRelationship }> = [
    { pattern: 'depends on', rel: 'depends-on' },
    { pattern: 'relates to', rel: 'relates-to' },
    { pattern: 'blocks', rel: 'blocks' },
    { pattern: 'depends', rel: 'depends' },
    { pattern: 'relates', rel: 'relates' },
  ];

  for (const { pattern, rel } of relPatterns) {
    const escapedPattern = pattern.replace(' ', '\\s+');
    const regexPattern = new RegExp(`^(.+?)\\s+${escapedPattern}\\s+(.+)$`, 'i');
    const m = body.match(regexPattern);
    if (m) {
      const { title: title1 } = extractTitle(m[1].trim());
      const { title: title2 } = extractTitle(m[2].trim());
      return {
        type: 'link',
        title: title1,
        relationship: rel,
        targetTitle: title2,
      };
    }
  }

  throw new ActionParseError(
    `Cannot parse link action. Expected: link "<title>" blocks|depends|relates "<other-title>"`,
    raw
  );
}

function parseCreateAction(raw: string): CreateAction {
  // create [card] "<title>" in <status> [with priority <p>, owner <o>, effort <e>]
  const body = raw.replace(/^create\s+/i, '').trimStart();
  const bodyNoCard = stripArticle(body);

  if (!bodyNoCard) {
    throw new ActionParseError(
      `Cannot parse create action. Expected: create card "<title>" in <status>`,
      raw
    );
  }

  // BUG 2 fix (structural): detect unquoted title starting with boundary keyword
  assertNoBoundaryStart(bodyNoCard, 'create card', raw);

  const { title, rest } = extractTitle(bodyNoCard);

  // Expect "in <status> [with ...]"
  const inMatch = rest.match(/^in\s+(.+?)(?:\s+with\s+(.+))?$/i);
  if (!inMatch) {
    throw new ActionParseError(
      `Cannot parse create action. Expected: create card "<title>" in <status> [with priority <p>, owner <o>, effort <e>]`,
      raw
    );
  }

  const status = inMatch[1].trim();

  // BUG 2 fix: Detect unquoted title truncation at boundary word.
  if (status.includes(' in ') || status.includes(' to ')) {
    throw new ActionParseError(
      `Unquoted title "${title}" may be truncated by boundary keyword. Use quotes.`,
      raw
    );
  }
  const withClause = inMatch[2]?.trim() ?? '';

  const result: CreateAction = { type: 'create', title, status };

  if (withClause) {
    parseWithClause(withClause, result);
  }

  return result;
}

function parseWithClause(clause: string, result: CreateAction): void {
  // Parse comma-separated key-value pairs: priority high, owner alice, effort 3
  const parts = clause.split(/,\s*/);
  for (const part of parts) {
    const trimmed = part.trim();

    const priorityMatch = trimmed.match(/^priority\s+(.+)$/i);
    if (priorityMatch) { result.priority = priorityMatch[1].trim(); continue; }

    const ownerMatch = trimmed.match(/^owner\s+(.+)$/i);
    if (ownerMatch) { result.owner = ownerMatch[1].trim(); continue; }

    const effortMatch = trimmed.match(/^effort\s+(.+)$/i);
    if (effortMatch) { result.effort = effortMatch[1].trim(); continue; }
  }
}

function parseCloseAction(raw: string): CloseAction {
  // close ["card"] "<title>"
  // done ["card"] "<title>"
  const keyword = raw.match(/^(\w+)/)?.[1] ?? 'close';
  // Use regex that requires at least one space after the keyword
  const afterKeyword = raw.replace(new RegExp(`^${keyword}\\s+`, 'i'), '');

  // If nothing was replaced (keyword had no space after it), body is empty
  if (afterKeyword === raw) {
    throw new ActionParseError(`Cannot parse close action. Expected: close "<title>"`, raw);
  }

  const body = afterKeyword.trimStart();
  const bodyNoCard = stripArticle(body);

  if (!bodyNoCard) {
    throw new ActionParseError(`Cannot parse close action. Expected: close "<title>"`, raw);
  }

  const { title, rest } = extractTitle(bodyNoCard);

  // BUG 2 fix: Detect unquoted title truncation at boundary word.
  // If rest is non-empty for a close action, the user likely had a title
  // containing a boundary keyword. Require quotes to disambiguate.
  if (rest) {
    throw new ActionParseError(
      `Unquoted title "${title}" may be truncated by boundary keyword. Use quotes: close "${title} ${rest.trim()}"`,
      raw
    );
  }

  return { type: 'close', title };
}

// ---------------------------------------------------------------------------
// Fuzzy matching utilities
// ---------------------------------------------------------------------------

export interface FuzzyMatch {
  title: string;
  score: number; // 0.0 (no match) to 1.0 (exact match)
  matchType: 'exact' | 'case-insensitive' | 'contains' | 'fuzzy' | 'starts-with';
}

/**
 * Compute Levenshtein edit distance between two strings.
 */
export function levenshteinDistance(a: string, b: string): number {
  // BUG 5 fix: Length guard to avoid O(m×n) DP on very long strings
  if (a.length > 200 || b.length > 200) {
    return Math.abs(a.length - b.length) > 5 ? Infinity : 0.5;
  }

  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }

  return dp[m][n];
}

/**
 * Normalize a string for fuzzy comparison:
 * - lowercase
 * - normalize separators (hyphen, underscore, slash → space)
 * - collapse whitespace
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[_\-/]/g, ' ')   // normalize separators
    .replace(/\s+/g, ' ')      // collapse whitespace
    .trim();
}

/**
 * Find cards whose titles match the query using fuzzy matching.
 *
 * @param query  The title to search for (may have typos, be partial, etc.)
 * @param titles The list of known card titles
 * @param threshold  Score threshold (0.0–1.0), default 0.5
 * @returns Sorted list of matches (best first)
 */
export function findMatchingCards(
  query: string,
  titles: string[],
  threshold = 0.5
): FuzzyMatch[] {
  // Empty query should not match anything
  if (!query || !query.trim()) return [];

  const normQuery = normalizeTitle(query);
  const results: FuzzyMatch[] = [];

  for (const title of titles) {
    const normTitle = normalizeTitle(title);
    let score = 0.0;
    let matchType: FuzzyMatch['matchType'] = 'fuzzy';

    // Exact match (preserving original case)
    if (title === query) {
      score = 1.0;
      matchType = 'exact';
    }
    // Case-insensitive exact match
    else if (normTitle === normQuery) {
      score = 0.98;
      matchType = 'case-insensitive';
    }
    // Starts-with match (case-insensitive) — only when query is non-trivial
    else if (normQuery.length > 0 && (normTitle.startsWith(normQuery) || normQuery.startsWith(normTitle))) {
      // BUG 1 fix: Use a fixed score for all starts-with matches so that
      // multiple cards with the same prefix are detected as tied (ambiguous).
      // The old ratio-based score favored shorter titles, masking ambiguity.
      score = 0.82;
      matchType = 'starts-with';
    }
    // Contains match (case-insensitive)
    else if (normTitle.includes(normQuery) || normQuery.includes(normTitle)) {
      const ratio = Math.min(normQuery.length, normTitle.length) /
                    Math.max(normQuery.length, normTitle.length);
      score = 0.55 + ratio * 0.15;
      matchType = 'contains';
    }
    // Fuzzy (Levenshtein)
    else {
      const dist = levenshteinDistance(normQuery, normTitle);
      const maxLen = Math.max(normQuery.length, normTitle.length);
      const similarity = maxLen > 0 ? 1 - dist / maxLen : 0;
      if (similarity >= threshold) {
        score = similarity * 0.9; // cap fuzzy at 0.9
        matchType = 'fuzzy';
      }
    }

    if (score >= threshold) {
      results.push({ title, score, matchType });
    }
  }

  // Sort by score descending, then alphabetically for stability
  results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return results;
}

export interface CardResolutionResult {
  match: string | null;
  isAmbiguous: boolean;
  candidates: FuzzyMatch[];
}

/**
 * Resolve a card title query against a list of known titles.
 *
 * - Returns exact/best match if unambiguous
 * - Returns isAmbiguous=true if multiple cards score at the same level (tie)
 * - Returns match=null if no card found above threshold
 */
export function resolveCard(
  query: string,
  titles: string[],
  threshold = 0.5
): CardResolutionResult {
  const matches = findMatchingCards(query, titles, threshold);

  if (matches.length === 0) {
    return { match: null, isAmbiguous: false, candidates: [] };
  }

  // If top match is exact, check for duplicate exact-match titles (BUG 3 fix)
  if (matches[0].matchType === 'exact') {
    const exactCount = matches.filter(m => m.matchType === 'exact').length;
    if (exactCount > 1) {
      return { match: matches[0].title, isAmbiguous: true, candidates: matches };
    }
    return { match: matches[0].title, isAmbiguous: false, candidates: matches };
  }

  // Check for ties at the top score
  const topScore = matches[0].score;
  const tied = matches.filter(m => Math.abs(m.score - topScore) < 0.01);

  if (tied.length > 1) {
    return { match: null, isAmbiguous: true, candidates: matches };
  }

  return { match: matches[0].title, isAmbiguous: false, candidates: matches };
}
