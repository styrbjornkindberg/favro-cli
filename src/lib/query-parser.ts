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
 *   - Relationship queries: blocks, depends, relates
 *   - Custom field queries: customField:name=value
 *   - Numeric operators: estimate:5, estimate>3
 *   - Enum validation against known Favro API values
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

export type RelationshipType = 'blocks' | 'depends' | 'relates';

export interface FieldPredicate {
  kind: 'field';
  field: string;
  operator: Operator;
  value: string;
}

export interface RelationshipPredicate {
  kind: 'relationship';
  type: RelationshipType;
  targetId?: string;
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
  | RelationshipPredicate
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
  /** Warnings produced during parsing (non-fatal) */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Known enum values (validated against Favro API)
// ---------------------------------------------------------------------------

export const VALID_RELATIONSHIP_TYPES: RelationshipType[] = ['blocks', 'depends', 'relates'];

export const VALID_FIELDS = [
  'status', 'assignee', 'label', 'tag', 'due_date', 'created_at', 'updated_at',
  'estimate', 'priority', 'title', 'name', 'description', 'created_by',
  'due_before', 'due_after', 'due_in', 'relationship', 'customField',
];

export const VALID_STATUS_VALUES = [
  'todo', 'in-progress', 'done', 'done-for-review', 'backlog', 'blocked',
  'in-review', 'cancelled', 'archived',
];

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

    // Standalone quoted string — treat as title~ predicate
    if (input[i] === '"' || input[i] === "'") {
      const quote = input[i++];
      let raw = '';
      while (i < n && input[i] !== quote) {
        if (input[i] === '\\' && i + 1 < n) { raw += input[i + 1]; i += 2; }
        else { raw += input[i++]; }
      }
      if (i < n) i++; // skip closing quote
      tokens.push({ type: 'FIELD_OP', value: `title~${raw}`, pos: start });
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
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(raw)) {
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
  public warnings: string[] = [];

  constructor(private input: string) {
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
      this.consume(); // consume '('
      const inner = this.parseOr();
      // Validate matching closing paren
      if (this.peek().type !== 'RPAREN') {
        throw new ParseError(`Unclosed parenthesis at position ${t.pos}`);
      }
      this.consume(); // consume ')'
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
   *   relationship:blocks
   *   relationship:depends:CARD-123
   *   due_in:7d
   *   due_date:today
   *   assignee in(john,mary)
   */
  private parsePredicate(raw: string, pos: number): QueryNode {
    // Handle "field in(v1,v2,...)" format — raw ends with part before in(...)
    // but we may have read it as a single token if no space; handle anyway
    const inMatch = raw.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s+in\((.+)\)$/i);
    if (inMatch) {
      const [, field, list] = inMatch;
      this.validateField(field, pos);
      return { kind: 'field', field, operator: 'in', value: list } as FieldPredicate;
    }

    // Parse field + operator + value
    // Operators to detect: >=, <=, >, <, ~, =, :
    const opRegex = /^([a-zA-Z_][a-zA-Z0-9_.]*)(>=|<=|>|<|~|=|:)(.+)$/;
    const m = raw.match(opRegex);
    if (!m) {
      // Could be a bare keyword — treat as title~keyword
      this.warnings.push(`Unknown token '${raw}' at position ${pos} — treating as title~'${raw}'`);
      return { kind: 'field', field: 'title', operator: '~', value: raw } as FieldPredicate;
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

    // --- Handle relationship:type[:targetId] ---
    if (fieldRaw.toLowerCase() === 'relationship') {
      const parts = valuePart.split(':');
      const relType = parts[0].toLowerCase();
      if (!VALID_RELATIONSHIP_TYPES.includes(relType as RelationshipType)) {
        throw new ParseError(
          `Invalid relationship type '${relType}' at position ${pos}. Valid types: ${VALID_RELATIONSHIP_TYPES.join(', ')}`
        );
      }
      return {
        kind: 'relationship',
        type: relType as RelationshipType,
        targetId: parts[1],
      } as RelationshipPredicate;
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

    // For non-date field with `:` — check for date keyword values on status-like fields
    if (DATE_KEYWORDS.includes(valuePart.toLowerCase())) {
      // e.g. "overdue" passed as a standalone to a date-ish context — emit warning but continue
      this.warnings.push(
        `Date keyword '${valuePart}' used on field '${fieldRaw}' — expected a date field like due_date`
      );
    }

    // --- Validate field name ---
    this.validateField(fieldRaw.toLowerCase(), pos);

    // --- Validate enum values for status ---
    if (fieldRaw.toLowerCase() === 'status') {
      const v = valuePart.toLowerCase();
      if (!VALID_STATUS_VALUES.includes(v)) {
        this.warnings.push(
          `Unknown status value '${valuePart}'. Valid values: ${VALID_STATUS_VALUES.join(', ')}`
        );
      }
    }

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
    if (!VALID_FIELDS.includes(field)) {
      this.warnings.push(
        `Unknown field '${field}' at position ${pos}. Valid fields: ${VALID_FIELDS.join(', ')}`
      );
    }
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

  throw new ParseError(`Invalid date format. Use YYYY-MM-DD`);
}

// ---------------------------------------------------------------------------
// ParseError
// ---------------------------------------------------------------------------

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

// ---------------------------------------------------------------------------
// Evaluation helpers — apply a parsed Query to a Card
// ---------------------------------------------------------------------------

/**
 * Evaluate a parsed QueryNode against a card object.
 * Returns true if the card matches the node.
 * Designed to work with the Card interface from cards-api.ts (duck-typed).
 */
export function evaluateNode(node: QueryNode, card: Record<string, any>): boolean {
  switch (node.kind) {
    case 'and': return evaluateNode(node.left, card) && evaluateNode(node.right, card);
    case 'or':  return evaluateNode(node.left, card) || evaluateNode(node.right, card);

    case 'field': {
      const v = resolveFieldValue(node.field, card);
      return compareValues(v, node.operator, node.value);
    }

    case 'date': {
      const raw = resolveFieldValue(node.field, card);
      const cardDate = new Date(String(raw ?? ''));
      const target = resolveDateValue(node.dateValue);
      if (!raw || isNaN(cardDate.getTime())) return false;
      return compareNumbers(cardDate.getTime(), node.operator, target.getTime());
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

    case 'relationship': {
      const rels: any[] = card.relationships ?? card.links ?? [];
      return rels.some(r => r.type?.toLowerCase() === node.type &&
        (!node.targetId || r.targetId === node.targetId || r.target === node.targetId)
      );
    }

    default:
      return false;
  }
}

function resolveFieldValue(field: string, card: Record<string, any>): any {
  const fieldMap: Record<string, string | string[]> = {
    'title': ['name', 'title'],
    'name': ['name', 'title'],
    'status': ['status'],
    'assignee': ['assignees', 'assignee'],
    'label': ['tags', 'labels'],
    'tag': ['tags', 'labels'],
    'due_date': ['dueDate', 'due_date'],
    'due_before': ['dueDate', 'due_date'],
    'due_after': ['dueDate', 'due_date'],
    'created_at': ['createdAt', 'created_at'],
    'updated_at': ['updatedAt', 'updated_at'],
    'description': ['description'],
    'estimate': ['estimate'],
    'priority': ['priority'],
    'created_by': ['createdBy', 'created_by'],
  };

  const aliases = fieldMap[field] ?? [field];
  for (const alias of aliases) {
    if (card[alias] !== undefined) return card[alias];
  }
  return undefined;
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
    default: return today;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a filter string into a Query AST.
 *
 * @param filter  The query string, e.g. "status:in-progress AND assignee:john"
 * @returns       A Query object with the parsed AST and any warnings.
 * @throws        ParseError on syntax errors (unclosed parens, invalid date formats, etc.)
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
 * const q = parseQuery('relationship:blocks:CARD-123');
 *
 * @example
 * const q = parseQuery('due_in:7d');
 */
export function parseQuery(filter: string): Query {
  if (!filter || filter.trim() === '') {
    return { ast: null, raw: filter, warnings: [] };
  }

  const parser = new Parser(filter.trim());
  const ast = parser.parse();

  return {
    ast,
    raw: filter,
    warnings: parser.warnings,
  };
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
  cards: T[]
): T[] {
  if (!query.ast) return cards; // no filter — return all
  return cards.filter(card => evaluateNode(query.ast!, card));
}
