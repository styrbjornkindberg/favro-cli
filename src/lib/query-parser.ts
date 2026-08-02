/**
 * Enhanced Query Parser — CLA-1780 / FAVRO-018
 *
 * Extends SPEC-001 base filter syntax to support:
 *   - AND/OR logical operators with proper precedence
 *   - Parenthesised sub-expressions
 *   - Field operators: =, >, <, >=, <=, ~ (contains), in(list)
 *   - Date predicates: today, tomorrow, next-week, next-month, last-month
 *   - Relative date maths: due_in:7d, due_in:2w
 *   - Absolute date formats: 2026-04-01, 2026-Q2, 2026-W15
 *   - Dependency predicates: unblocked, blocks:<ref>, blocked-by:<ref>
 *   - Custom field queries: customField:name=value
 *   - Numeric operators on any numeric card field
 *   - Fail-closed field validation against a DERIVED field list (#46)
 *
 * Grammar (simplified LL):
 *
 *   query    → expr EOF
 *   expr     → orExpr
 *   orExpr   → andExpr (OR andExpr)*
 *   andExpr  → primary (AND primary)*
 *   primary  → '(' expr ')' | predicate
 *   predicate → field op value | keyword
 *
 * Public API:
 *   parseQuery(filter: string): Query
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Operator = '=' | '>' | '<' | '>=' | '<=' | '~' | 'in';

export interface FieldPredicate {
  kind: 'field';
  field: string;
  operator: Operator;
  value: string;
}

export interface DatePredicate {
  kind: 'date';
  field: string;
  operator: Operator;
  dateValue: DateValue;
}

export interface CustomFieldPredicate {
  kind: 'customField';
  fieldName: string;
  operator: Operator;
  value: string;
}

export interface AndExpression {
  kind: 'and';
  left: QueryNode;
  right: QueryNode;
}

export interface OrExpression {
  kind: 'or';
  left: QueryNode;
  right: QueryNode;
}

export type QueryNode =
  | FieldPredicate
  | DatePredicate
  | CustomFieldPredicate
  | AndExpression
  | OrExpression;

export interface DateValue {
  type: 'absolute' | 'relative' | 'relative-math' | 'week' | 'quarter';
  // ISO string for absolute dates
  iso?: string;
  // keyword for relative: today, tomorrow, next-week, next-month, last-month, overdue, this-week
  keyword?: string;
  // for relative-math: "+7d", "-2w", "+1y"
  offset?: number;
  unit?: 'd' | 'w' | 'm' | 'y';
}

export interface Query {
  /** Parsed AST node — null for empty query */
  ast: QueryNode | null;
  /** Raw filter string */
  raw: string;
}

// ---------------------------------------------------------------------------
// The checked field list
//
// It is DERIVED, not enumerated. `normalizeCard` passes every field Favro sends
// straight through, so the cards in hand ARE the field list; a hand-written list
// rots (the one this replaced was 19 entries, the majority naming fields that
// exist on no card). Two things cannot be derived and are therefore declared:
// the aliases `resolveFieldValue` maps, and the predicates computed here with no
// card field behind them. `CARD_FIELDS` is the static floor, so a zero-row fetch
// still refuses a typo instead of accepting everything.
// ---------------------------------------------------------------------------

/** The `Card` interface's named keys — the floor, for when no card is in hand. */
export const CARD_FIELDS: readonly string[] = [
  'cardId', 'cardCommonId', 'name', 'description', 'status', 'assignees', 'tags',
  'tagIds', 'dueDate', 'createdAt', 'boardId', 'widgetCommonId', 'assignments',
  'columnId', 'collectionId', 'archived', 'sequentialId', 'parentCardId', 'board',
  'collection', 'customFields', 'links', 'comments', 'relations',
];

/** Aliases and computed predicates — the part no card can tell you about. */
export const DECLARED_FIELDS: readonly string[] = [
  // Aliases onto real card fields (see `resolveFieldValue`).
  'title', 'label', 'tag', 'assignee', 'due_date', 'due_before', 'due_after',
  'created_at', 'updated_at',
  // Computed here — nothing on the card is named this.
  'due_in', 'unblocked', 'blocks', 'blocked-by', 'customfield',
];

/**
 * Every field a filter may name, lowercased.
 *
 * Pass the cards in hand to widen it by what Favro actually sent; with none,
 * the floor plus the declared set still refuses a typo.
 */
export function knownFields(cards: ReadonlyArray<Record<string, unknown>> = []): Set<string> {
  const fields = new Set<string>(
    [...CARD_FIELDS, ...DECLARED_FIELDS].map((f) => f.toLowerCase())
  );
  for (const card of cards) {
    for (const key of Object.keys(card)) fields.add(key.toLowerCase());
  }
  return fields;
}

/** Fields whose values come from a closed vocabulary — see `validateQueryValues`. */
const CLOSED_VOCABULARY_FIELDS = ['tag', 'label', 'status', 'assignee'];

/** Bare keywords that are a whole predicate on their own. */
const BARE_KEYWORDS = ['unblocked'];

export const DATE_KEYWORDS = [
  'today', 'tomorrow', 'yesterday', 'next-week', 'next-month',
  'last-month', 'last-week', 'this-week', 'this-month', 'overdue',
];

// ---------------------------------------------------------------------------
// Tokeniser
// ---------------------------------------------------------------------------

type TokenType =
  | 'FIELD_OP'    // field:value, field>value, field>=value, etc.
  | 'AND'
  | 'OR'
  | 'LPAREN'
  | 'RPAREN'
  | 'EOF';

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

/**
 * Tokenise a query string into a flat list of tokens.
 * Handles:
 *   - AND / OR keywords (case-insensitive)
 *   - ( / )
 *   - field:value, field>value, field>=value, field<=value, field~value, field in(v,v)
 *   - Quoted strings: "hello world" (after an operator)
 */
function tokenise(input: string): Token[] {
  // DoS Protection: Input length limit
  if (input.length > 10000) {
    throw new ParseError(`Query string exceeds maximum length (10000 chars), got ${input.length} chars`);
  }

  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  const skipWS = () => { while (i < n && /\s/.test(input[i])) i++; };

  while (i < n) {
    skipWS();
    if (i >= n) break;

    const start = i;

    // Parentheses
    if (input[i] === '(') { tokens.push({ type: 'LPAREN', value: '(', pos: start }); i++; continue; }
    if (input[i] === ')') { tokens.push({ type: 'RPAREN', value: ')', pos: start }); i++; continue; }

    // Standalone quoted string. NOT free text — it is emitted as-is so the
    // parser refuses it and points at `title~"…"`, the one deliberate form.
    if (input[i] === '"' || input[i] === "'") {
      const quote = input[i++];
      let raw = '';
      while (i < n && input[i] !== quote) {
        if (input[i] === '\\' && i + 1 < n) { raw += input[i + 1]; i += 2; }
        else { raw += input[i++]; }
      }
      if (i < n) i++; // skip closing quote
      tokens.push({ type: 'FIELD_OP', value: raw, pos: start });
      continue;
    }

    // Read a raw token.
    // When an operator char (:, =, ~, >, <) is encountered followed by a quote,
    // switch to quoted-value mode and read through spaces until the closing quote.
    let raw = '';
    let inQuote = false;
    let quoteChar = '';
    while (i < n) {
      const ch = input[i];
      if (inQuote) {
        if (ch === quoteChar) {
          i++;
          inQuote = false;
          // Closing quote encountered — we intentionally drop the quote chars
        } else if (ch === '\\' && i + 1 < n) {
          raw += input[i + 1]; i += 2;
        } else {
          raw += ch; i++;
        }
      } else if ((ch === '"' || ch === "'") && /[:=~><]/.test(raw[raw.length - 1] ?? '')) {
        // Opening quote after an operator — enter quoted mode
        quoteChar = ch;
        inQuote = true;
        i++;
      } else if (/[\s()]/.test(ch)) {
        break; // end of token
      } else {
        raw += ch; i++;
      }
    }

    if (!raw) continue;

    const upper = raw.toUpperCase();
    if (upper === 'AND') { tokens.push({ type: 'AND', value: 'AND', pos: start }); continue; }
    if (upper === 'OR')  { tokens.push({ type: 'OR',  value: 'OR',  pos: start }); continue; }

    // Look-ahead: handle "field in(list)" where space separates field and in(...)
    // If this is a bare identifier (no operator chars) and the next non-whitespace
    // chars are 'in(' — combine into a single token.
    if (/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(raw)) {
      let j = i;
      while (j < n && /\s/.test(input[j])) j++; // skip whitespace
      if (input.slice(j, j + 3).toLowerCase() === 'in(') {
        const listStart = j + 3; // after 'in('
        const listEnd = input.indexOf(')', listStart);
        if (listEnd !== -1) {
          const list = input.slice(listStart, listEnd);
          i = listEnd + 1; // advance past the closing ')'
          tokens.push({ type: 'FIELD_OP', value: `${raw} in(${list})`, pos: start });
          continue;
        }
      }
    }

    // Otherwise it should be a field:value, field>value, etc.
    tokens.push({ type: 'FIELD_OP', value: raw, pos: start });
  }

  tokens.push({ type: 'EOF', value: '', pos: n });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
  private tokens: Token[];
  private pos = 0;
  private depth = 0;

  constructor(private input: string, private fields: Set<string>) {
    this.tokens = tokenise(input);
  }

  private peek(): Token { return this.tokens[this.pos]; }
  private consume(): Token { return this.tokens[this.pos++]; }

  private expect(type: TokenType): Token {
    const t = this.consume();
    if (t.type !== type) {
      throw new ParseError(`Expected ${type} but got '${t.value}' at position ${t.pos}`);
    }
    return t;
  }

  parse(): QueryNode | null {
    if (this.peek().type === 'EOF') return null;
    const node = this.parseOr();
    if (this.peek().type !== 'EOF') {
      const t = this.peek();
      throw new ParseError(`Unexpected token '${t.value}' at position ${t.pos}`);
    }
    return node;
  }

  private parseOr(): QueryNode {
    let left = this.parseAnd();
    while (this.peek().type === 'OR') {
      this.consume();
      const right = this.parseAnd();
      left = { kind: 'or', left, right } as OrExpression;
    }
    return left;
  }

  private parseAnd(): QueryNode {
    let left = this.parsePrimary();
    while (this.peek().type === 'AND') {
      this.consume();
      const right = this.parsePrimary();
      left = { kind: 'and', left, right } as AndExpression;
    }
    return left;
  }

  private parsePrimary(): QueryNode {
    const t = this.peek();
    if (t.type === 'LPAREN') {
      this.depth++;
      // DoS Protection: Depth limit (max 50 nested parens)
      if (this.depth > 50) {
        throw new ParseError(`Query nesting exceeds maximum depth (50 levels), at position ${t.pos}`);
      }
      this.consume(); // consume '('
      const inner = this.parseOr();
      // Validate matching closing paren
      if (this.peek().type !== 'RPAREN') {
        throw new ParseError(`Unclosed parenthesis at position ${t.pos}`);
      }
      this.consume(); // consume ')'
      this.depth--;
      return inner;
    }
    if (t.type === 'FIELD_OP') {
      return this.parsePredicate(this.consume().value, t.pos);
    }
    if (t.type === 'EOF') {
      throw new ParseError(`Unexpected end of query — expected a predicate`);
    }
    throw new ParseError(`Unexpected token '${t.value}' at position ${t.pos}`);
  }

  /**
   * Parse a raw predicate token like:
   *   status:done
   *   estimate>5
   *   due_date>=2026-04-01
   *   title~"bug"
   *   customField:Priority=High
   *   blocked-by:CLA-1804
   *   unblocked
   *   due_in:7d
   *   due_date:today
   *   assignee in(john,mary)
   */
  private parsePredicate(raw: string, pos: number): QueryNode {
    // Handle "field in(v1,v2,...)" format — raw ends with part before in(...)
    // but we may have read it as a single token if no space; handle anyway
    const inMatch = raw.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s+in\((.+)\)$/i);
    if (inMatch) {
      const [, field, list] = inMatch;
      this.validateField(field.toLowerCase(), pos);
      return { kind: 'field', field: field.toLowerCase(), operator: 'in', value: list } as FieldPredicate;
    }

    // A bare keyword that is a whole predicate on its own.
    if (BARE_KEYWORDS.includes(raw.toLowerCase())) {
      return { kind: 'field', field: raw.toLowerCase(), operator: '=', value: 'true' } as FieldPredicate;
    }

    // Parse field + operator + value
    // Operators to detect: >=, <=, >, <, ~, =, :
    const opRegex = /^([a-zA-Z_][a-zA-Z0-9_.-]*)(>=|<=|>|<|~|=|:)(.+)$/;
    const m = raw.match(opRegex);
    if (!m) {
      // Fails closed. The old fallback read an unparseable token as a title
      // search and answered a plausible `0 rows`; free text is `title~"…"` and
      // nothing else.
      throw new ParseError(
        `Unrecognised filter token '${raw}' at position ${pos} — it names no field and carries no operator. ` +
          `Filters are field:value (see 'favro cards list --help'). For free text, say it: title~"${raw}".`,
        { kind: 'unknown-token', value: raw, position: pos }
      );
    }

    let [, fieldRaw, opChar, valuePart] = m;

    // Determine the Operator type
    const operatorMap: Record<string, Operator> = {
      '>=': '>=', '<=': '<=', '>': '>', '<': '<', '~': '~', '=': '=', ':': '=',
    };
    const operator: Operator = operatorMap[opChar] ?? '=';

    // Strip surrounding quotes from value
    valuePart = valuePart.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');

    // --- Handle customField:name=value ---
    if (fieldRaw.toLowerCase() === 'customfield') {
      // format: customField:Name=value or customField:Name>value etc.
      const cfMatch = valuePart.match(/^([^=><~]+)(>=|<=|>|<|~|=)(.+)$/);
      if (!cfMatch) {
        throw new ParseError(`Invalid customField syntax at position ${pos}. Use: customField:Name=value`);
      }
      const [, cfName, cfOp, cfVal] = cfMatch;
      const cfOperator: Operator = operatorMap[cfOp] ?? '=';
      return {
        kind: 'customField',
        fieldName: cfName.trim(),
        operator: cfOperator,
        value: cfVal.trim(),
      } as CustomFieldPredicate;
    }

    // --- Handle date-specific fields ---
    const dateFields = ['due_date', 'created_at', 'updated_at', 'due_before', 'due_after', 'due_in'];
    if (dateFields.includes(fieldRaw.toLowerCase())) {
      const dateValue = parseDateValue(valuePart, pos);
      return {
        kind: 'date',
        field: fieldRaw.toLowerCase(),
        operator,
        dateValue,
      } as DatePredicate;
    }

    // --- Validate field name ---
    this.validateField(fieldRaw.toLowerCase(), pos);

    // `status` is a column name, which is board-specific — there is no global
    // vocabulary to check here. `validateQueryValues` checks it against the
    // board's real columns, where the board is known.

    return {
      kind: 'field',
      field: fieldRaw.toLowerCase(),
      operator,
      value: valuePart,
    } as FieldPredicate;
  }

  private validateField(field: string, pos: number): void {
    // Allow any field that starts with 'customfield' (dynamic)
    if (field.startsWith('customfield')) return;
    if (this.fields.has(field)) return;
    const known = [...this.fields].sort().join(', ');
    throw new ParseError(
      `Unknown filter field '${field}' at position ${pos} — refusing to run a query that cannot mean what you asked. ` +
        `Known fields: ${known}.`,
      { kind: 'unknown-field', value: field, position: pos, candidates: [...this.fields].sort() }
    );
  }
}

// ---------------------------------------------------------------------------
// Date value parser
// ---------------------------------------------------------------------------

const RELATIVE_MATH_RE = /^([+-]?\d+)([dwmy])$/i;
const ABSOLUTE_ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const QUARTER_RE = /^(\d{4})-Q([1-4])$/i;
const WEEK_RE = /^(\d{4})-W(\d{1,2})$/i;
const DUE_IN_RE = /^(\d+)([dwmy])$/i;

function parseDateValue(raw: string, pos: number): DateValue {
  const lower = raw.toLowerCase();

  // Special "overdue" keyword — means due_date < today
  if (lower === 'overdue' || DATE_KEYWORDS.includes(lower)) {
    return { type: 'relative', keyword: lower };
  }

  // due_in:7d / due_in:2w style
  const dueInMatch = raw.match(DUE_IN_RE);
  if (dueInMatch) {
    const [, numStr, unitChar] = dueInMatch;
    return {
      type: 'relative-math',
      offset: parseInt(numStr, 10),
      unit: unitChar.toLowerCase() as 'd' | 'w' | 'm' | 'y',
    };
  }

  // Relative math: +7d, -2w (signed)
  const relMathMatch = raw.match(RELATIVE_MATH_RE);
  if (relMathMatch) {
    const [, numStr, unitChar] = relMathMatch;
    return {
      type: 'relative-math',
      offset: parseInt(numStr, 10),
      unit: unitChar.toLowerCase() as 'd' | 'w' | 'm' | 'y',
    };
  }

  // Quarter: 2026-Q2
  const quarterMatch = raw.match(QUARTER_RE);
  if (quarterMatch) {
    const [, year, q] = quarterMatch;
    return { type: 'quarter', keyword: `${year}-Q${q}` };
  }

  // Week: 2026-W15
  const weekMatch = raw.match(WEEK_RE);
  if (weekMatch) {
    const [, year, wk] = weekMatch;
    return { type: 'week', keyword: `${year}-W${wk}` };
  }

  // Absolute ISO date: 2026-04-01
  if (ABSOLUTE_ISO_RE.test(raw)) {
    // Validate it's a real date
    const d = new Date(raw);
    if (isNaN(d.getTime())) {
      throw new ParseError(`Invalid date '${raw}' at position ${pos}. Use YYYY-MM-DD`);
    }
    return { type: 'absolute', iso: raw };
  }

  // If we get here, it's an unknown keyword (not a valid date format or known keyword)
  throw new ParseError(`Unknown date keyword: "${raw}". Invalid date format. Use YYYY-MM-DD or valid keywords: today, yesterday, tomorrow, this-week, next-week, last-week, this-month, next-month, last-month, overdue`);
}

// ---------------------------------------------------------------------------
// ParseError
// ---------------------------------------------------------------------------

export type ParseFailure =
  /** The token names no field this parser knows. */
  | 'unknown-field'
  /** The token carries no operator at all — the old `title~` degrade path. */
  | 'unknown-token'
  /** The value is not in the closed vocabulary its field draws from. */
  | 'unknown-value'
  /** `status:` was asked without the board whose columns settle it. */
  | 'missing-board'
  /**
   * The predicate is well-formed and this command still cannot answer it.
   * `unblocked` on `cards export` is the one: judging a blocker takes extra
   * reads, and a file has no `unreachable` to report the ones it missed.
   */
  | 'unsupported-here'
  /** Anything structural: unclosed parens, bad dates, limits. */
  | 'syntax';

/**
 * The machine-readable half of a refusal. Replaces `Query.warnings`, which had
 * no production reader and so notified nobody.
 */
export interface ParseErrorDetail {
  kind: ParseFailure;
  /** The offending text — the field name, the token, or the value. */
  value?: string;
  /** Character offset into the filter string, when known. */
  position?: number;
  /** The field whose value was refused (`unknown-value` only). */
  field?: string;
  /** What the vocabulary actually holds, when it is closed and in hand. */
  candidates?: string[];
}

export class ParseError extends Error {
  constructor(
    message: string,
    readonly detail: ParseErrorDetail = { kind: 'syntax' }
  ) {
    super(message);
    this.name = 'ParseError';
  }
}

// ---------------------------------------------------------------------------
// Evaluation helpers — apply a parsed Query to a Card
// ---------------------------------------------------------------------------

/**
 * What evaluation cannot work out from one card on its own.
 *
 * `unblocked` needs to know whether each blocker is FINISHED, and Favro has no
 * board-independent completion signal — the answer comes from the tracker's
 * mapped `done` column, or from `archived`, both of which live on the *blocker*.
 * `lib/blocking.ts` settles that before the filter runs and hands the verdicts in
 * here. Omitting it is safe and deliberate: with no verdicts every blocker
 * blocks, which is the over-blocking direction this whole predicate accepts.
 */
export interface EvalContext {
  /** `cardCommonId`s of blockers proved done. Anything absent still blocks. */
  doneBlockers?: ReadonlySet<string>;
}

/**
 * Evaluate a parsed QueryNode against a card object.
 * Returns true if the card matches the node.
 * Designed to work with the Card interface from cards-api.ts (duck-typed).
 */
export function evaluateNode(
  node: QueryNode,
  card: Record<string, any>,
  ctx: EvalContext = {},
): boolean {
  switch (node.kind) {
    case 'and': return evaluateNode(node.left, card, ctx) && evaluateNode(node.right, card, ctx);
    case 'or':  return evaluateNode(node.left, card, ctx) || evaluateNode(node.right, card, ctx);

    case 'field': {
      // Computed dependency predicates — Favro stores one edge with one flag,
      // `isBefore`: true means the linked card comes before, i.e. blocks this one.
      if (node.field === 'unblocked') return isUnblocked(card, ctx);
      if (node.field === 'blocked-by') return blockersOf(card).some(l => linkMatches(l, node.value));
      if (node.field === 'blocks') return blockedByThis(card).some(l => linkMatches(l, node.value));

      const v = resolveFieldValue(node.field, card);
      return compareValues(v, node.operator, node.value);
    }

    case 'date': {
      // Special handling for 'due_in' field — check if dueDate is within X days from today
      if (node.field === 'due_in') {
        const raw = resolveFieldValue('due_date', card) ?? resolveFieldValue('dueDate', card);
        if (!raw) return false;

        // Extract card's due date — for consistency with day-level comparison below, use YYYY-MM-DD string
        let cardDateStr: string;
        if (typeof raw === 'string') {
          cardDateStr = raw.includes('T') ? raw.split('T')[0] : raw.slice(0, 10);
        } else {
          const d = new Date(raw);
          if (isNaN(d.getTime())) return false;
          cardDateStr = d.toISOString().split('T')[0];
        }

        // Create today's date in UTC for consistent comparison
        const now = new Date();
        const todayDateStr = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
          .toISOString().split('T')[0];

        // Resolve the target date (e.g., 7 days from today)
        const target = resolveDateValue(node.dateValue);
        const targetDateStr = target.toISOString().split('T')[0];

        // For due_in, check if cardDate is between today and the target date (inclusive)
        return cardDateStr >= todayDateStr && cardDateStr <= targetDateStr;
      }

      const raw = resolveFieldValue(node.field, card);
      if (!raw) return false;

      // Extract YYYY-MM-DD string from raw (could be ISO string with time, or plain date string)
      let cardDateStr: string;
      if (typeof raw === 'string') {
        // Handle both "2026-03-27" and "2026-03-27T14:30:00" formats
        cardDateStr = raw.includes('T') ? raw.split('T')[0] : raw.slice(0, 10);
      } else {
        // If it's a Date object, convert to YYYY-MM-DD
        const d = new Date(raw);
        if (isNaN(d.getTime())) return false;
        cardDateStr = d.toISOString().split('T')[0];
      }

      // Convert target date to YYYY-MM-DD for day-level comparison
      const target = resolveDateValue(node.dateValue);
      const targetDateStr = target.toISOString().split('T')[0];

      // Compare as date strings (YYYY-MM-DD), not timestamps
      return compareValues(cardDateStr, node.operator, targetDateStr);
    }

    case 'customField': {
      const fields: Record<string, any>[] = card.customFields ?? card.custom_fields ?? [];
      const cf = fields.find(
        f => f.name?.toLowerCase() === node.fieldName.toLowerCase()
      );
      if (!cf) return false;
      const cfVal = String(cf.value ?? '');
      return compareValues(cfVal, node.operator, node.value);
    }

    default:
      return false;
  }
}

/**
 * A card's dependency edges.
 *
 * ponytail: a card carrying no `links` is read as having no dependencies —
 * `GET /cards` inlines them, so absence is absence. If a fetch path ever omits
 * them, `unblocked` would answer confidently about data it never saw; make the
 * caller prove they were requested before trusting it there.
 */
function linksOf(card: Record<string, any>): any[] {
  return card.links ?? card.dependencies ?? [];
}

/** Edges where the linked card comes before this one — this card's blockers. */
export function blockersOf(card: Record<string, any>): any[] {
  return linksOf(card).filter(l => l.isBefore === true);
}

/** Edges where the linked card comes after this one — cards this one blocks. */
export function blockedByThis(card: Record<string, any>): any[] {
  return linksOf(card).filter(l => l.isBefore !== true);
}

/**
 * The frontier: takeable now, board-agnostic.
 *
 * Says nothing about the column — *blocked* and *doing* are indistinguishable in
 * the column a human looks at, because the column carries open/closed. It does
 * exclude two things no column can excuse:
 *
 *   - **archived** cards, which are not work;
 *   - **forks** — an assignment entity with no `widgetCommonId`, hence no column
 *     and nothing to act on.
 *
 * A blocker counts as cleared only when `ctx.doneBlockers` proves it. Without
 * that proof every blocker blocks: over-blocking, never under.
 */
function isUnblocked(card: Record<string, any>, ctx: EvalContext): boolean {
  if (card.archived === true) return false;
  if (!card.widgetCommonId && !card.boardId) return false;
  const done = ctx.doneBlockers;
  return blockersOf(card).every(l => {
    const id = l.cardCommonId ?? l.cardId;
    return id !== undefined && done !== undefined && done.has(String(id));
  });
}

/** Match a dependency edge against a card reference, in any identifier shape. */
function linkMatches(link: Record<string, any>, ref: string): boolean {
  if (ref === 'true' || ref === '') return true; // bare `blocked-by` — any blocker
  const wanted = ref.trim().toLowerCase();
  return [link.cardId, link.cardCommonId, link.cardSequentialId]
    .some(id => id !== undefined && String(id).toLowerCase() === wanted);
}

function resolveFieldValue(field: string, card: Record<string, any>): any {
  // Only aliases live here. Every other field is read off the card by its own
  // name — `normalizeCard` passes them all through, so an entry that merely
  // repeated the field name was noise that outlived the field.
  const fieldMap: Record<string, string[]> = {
    'title': ['name', 'title'],
    'assignee': ['assignees', 'assignee'],
    'label': ['tags', 'labels'],
    'tag': ['tags', 'labels'],
    'due_date': ['dueDate', 'due_date'],
    'due_in': ['dueDate', 'due_date'],
    'due_before': ['dueDate', 'due_date'],
    'due_after': ['dueDate', 'due_date'],
    'created_at': ['createdAt', 'created_at'],
    'updated_at': ['updatedAt', 'updated_at'],
  };

  const aliases = fieldMap[field] ?? [field];
  for (const alias of aliases) {
    if (card[alias] !== undefined) return card[alias];
  }
  // Field names are matched lowercased; Favro's pass-through fields are
  // camelCase (`sequentialId`, `createdByUserId`), so the last look is one that
  // ignores case — otherwise a field the list accepts would read as undefined.
  const key = Object.keys(card).find(k => k.toLowerCase() === field);
  return key === undefined ? undefined : card[key];
}

function compareValues(cardValue: any, op: Operator, queryValue: string): boolean {
  // Handle array values (assignees, tags)
  if (Array.isArray(cardValue)) {
    if (op === 'in') {
      const list = queryValue.split(',').map(s => s.trim().toLowerCase());
      return cardValue.some(v => list.includes(String(v).toLowerCase()));
    }
    // For string ops on arrays, check if any element matches
    return cardValue.some(v => compareValues(String(v), op, queryValue));
  }

  const strCard = String(cardValue ?? '').toLowerCase();
  const strQuery = queryValue.toLowerCase();

  if (op === '~') return strCard.includes(strQuery);
  if (op === '=') return strCard === strQuery;
  if (op === 'in') {
    const list = queryValue.split(',').map(s => s.trim().toLowerCase());
    return list.includes(strCard);
  }

  // Numeric comparison
  const numCard = parseFloat(String(cardValue ?? ''));
  const numQuery = parseFloat(queryValue);
  if (!isNaN(numCard) && !isNaN(numQuery)) {
    return compareNumbers(numCard, op, numQuery);
  }

  // Lexicographic comparison for non-numeric
  if (op === '>') return strCard > strQuery;
  if (op === '<') return strCard < strQuery;
  if (op === '>=') return strCard >= strQuery;
  if (op === '<=') return strCard <= strQuery;

  return false;
}

function compareNumbers(a: number, op: Operator, b: number): boolean {
  switch (op) {
    case '=': return a === b;
    case '>': return a > b;
    case '<': return a < b;
    case '>=': return a >= b;
    case '<=': return a <= b;
    default: return false;
  }
}

function resolveDateValue(dv: DateValue): Date {
  const now = new Date();
  // Create date at local midnight (not UTC) to match test expectations and real-world usage
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (dv.type) {
    case 'absolute': return new Date(dv.iso!);
    case 'relative': return resolveRelativeKeyword(dv.keyword!, today);
    case 'relative-math': {
      const d = new Date(today);
      const offset = dv.offset ?? 0;
      switch (dv.unit) {
        case 'd': d.setDate(d.getDate() + offset); break;
        case 'w': d.setDate(d.getDate() + offset * 7); break;
        case 'm': d.setMonth(d.getMonth() + offset); break;
        case 'y': d.setFullYear(d.getFullYear() + offset); break;
      }
      return d;
    }
    case 'quarter': {
      const [year, q] = dv.keyword!.split('-Q');
      const startMonth = (parseInt(q) - 1) * 3;
      return new Date(parseInt(year), startMonth, 1);
    }
    case 'week': {
      const [yearStr, wkStr] = dv.keyword!.split('-W');
      const year = parseInt(yearStr);
      const wk = parseInt(wkStr);
      // ISO week 1 = week containing Jan 4
      const jan4 = new Date(year, 0, 4);
      const dayOfWeek = jan4.getDay() || 7;
      const weekStart = new Date(jan4);
      weekStart.setDate(jan4.getDate() - dayOfWeek + 1 + (wk - 1) * 7);
      return weekStart;
    }
    default: return today;
  }
}

function resolveRelativeKeyword(keyword: string, today: Date): Date {
  switch (keyword) {
    case 'today': return today;
    case 'yesterday': { const d = new Date(today); d.setDate(d.getDate() - 1); return d; }
    case 'tomorrow': { const d = new Date(today); d.setDate(d.getDate() + 1); return d; }
    case 'this-week': {
      const d = new Date(today);
      d.setDate(d.getDate() - (d.getDay() || 7) + 1); // Monday
      return d;
    }
    case 'next-week': {
      const d = new Date(today);
      d.setDate(d.getDate() - (d.getDay() || 7) + 1 + 7);
      return d;
    }
    case 'last-week': {
      const d = new Date(today);
      d.setDate(d.getDate() - (d.getDay() || 7) + 1 - 7);
      return d;
    }
    case 'this-month': return new Date(today.getFullYear(), today.getMonth(), 1);
    case 'next-month': return new Date(today.getFullYear(), today.getMonth() + 1, 1);
    case 'last-month': return new Date(today.getFullYear(), today.getMonth() - 1, 1);
    case 'overdue': return today; // date < today
    default:
      throw new ParseError(
        `Unknown date keyword: "${keyword}". Valid keywords: today, yesterday, tomorrow, this-week, next-week, last-week, this-month, next-month, last-month, overdue`
      );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ParseOptions {
  /**
   * The cards the filter will run against, when they are already in hand.
   * Widens the checked field list by what Favro actually sent; without them the
   * static floor plus the declared set still refuses a typo.
   */
  cards?: ReadonlyArray<Record<string, unknown>>;
}

/**
 * Parse a filter string into a Query AST.
 *
 * Fails closed: an unknown field or an unparseable token is a refusal, never a
 * title search that answers a plausible `0 rows`.
 *
 * @param filter  The query string, e.g. "status:in-progress AND assignee:john"
 * @returns       A Query object with the parsed AST.
 * @throws        ParseError, carrying a structured `detail`, on any refusal.
 *
 * @example
 * const q = parseQuery('status:done AND due_date<=today');
 * // q.ast.kind === 'and'
 *
 * @example
 * const q = parseQuery('(status:todo OR status:in-progress) AND assignee:john');
 *
 * @example
 * const q = parseQuery('customField:Priority=High');
 *
 * @example
 * const q = parseQuery('unblocked AND blocked-by:CLA-1804');
 *
 * @example
 * const q = parseQuery('due_in:7d');
 */
export function parseQuery(filter: string, options: ParseOptions = {}): Query {
  if (!filter || filter.trim() === '') {
    return { ast: null, raw: filter };
  }

  const parser = new Parser(filter.trim(), knownFields(options.cards));
  return { ast: parser.parse(), raw: filter };
}

/**
 * Apply a parsed query to a list of cards.
 * Returns only the cards that match the query.
 *
 * @param query   Parsed Query (from parseQuery())
 * @param cards   Array of card objects (duck-typed, works with Card from cards-api.ts)
 */
export function filterCards<T extends Record<string, any>>(
  query: Query,
  cards: T[],
  ctx: EvalContext = {},
): T[] {
  if (!query.ast) return cards; // no filter — return all
  return cards.filter(card => evaluateNode(query.ast!, card, ctx));
}

/**
 * Does the query name this field anywhere?
 *
 * Callers use it to decide whether a predicate's extra reads are worth paying
 * for — `unblocked` needs the blockers judged, and nothing else does.
 */
export function queryNames(query: Query, field: string): boolean {
  const walk = (node: QueryNode | null): boolean => {
    if (!node) return false;
    switch (node.kind) {
      case 'and':
      case 'or': return walk(node.left) || walk(node.right);
      case 'field':
      case 'date': return node.field === field;
      default: return false;
    }
  };
  return walk(query.ast);
}
