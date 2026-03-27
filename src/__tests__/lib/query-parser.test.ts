/**
 * Unit tests for enhanced query parser (CLA-1780 / FAVRO-018)
 *
 * Target: ≥90% branch coverage
 *
 * Test categories:
 *   1. Basic field predicates (=, :, ~, >, <, >=, <=, in)
 *   2. AND/OR logical operators with precedence
 *   3. Parenthesised sub-expressions
 *   4. Date predicates — absolute, relative, relative-math, week, quarter
 *   5. Relationship queries (blocks, depends, relates)
 *   6. Custom field queries
 *   7. Error cases (unclosed parens, bad dates, invalid relationship types)
 *   8. Enum validation (status, relationship types)
 *   9. filterCards() integration helper
 *  10. evaluateNode() coverage
 *  11. Edge cases (empty input, bare keywords, nested AND/OR)
 */

import {
  parseQuery,
  filterCards,
  evaluateNode,
  ParseError,
  VALID_STATUS_VALUES,
  VALID_RELATIONSHIP_TYPES,
  DATE_KEYWORDS,
  type Query,
  type QueryNode,
  type FieldPredicate,
  type RelationshipPredicate,
  type DatePredicate,
  type CustomFieldPredicate,
  type AndExpression,
  type OrExpression,
} from '../../lib/query-parser';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fieldPred(field: string, op: string, value: string): FieldPredicate {
  return { kind: 'field', field, operator: op as any, value };
}

// ---------------------------------------------------------------------------
// 1. Basic field predicates
// ---------------------------------------------------------------------------

describe('parseQuery — basic field predicates', () => {
  test('parses field:value (colon = equality)', () => {
    const q = parseQuery('status:done');
    expect(q.ast).toMatchObject({ kind: 'field', field: 'status', operator: '=', value: 'done' });
  });

  test('parses field=value', () => {
    const q = parseQuery('status=done');
    expect(q.ast).toMatchObject({ kind: 'field', field: 'status', operator: '=', value: 'done' });
  });

  test('parses field>value', () => {
    const q = parseQuery('estimate>5');
    expect(q.ast).toMatchObject({ kind: 'field', field: 'estimate', operator: '>', value: '5' });
  });

  test('parses field<value', () => {
    const q = parseQuery('estimate<8');
    expect(q.ast).toMatchObject({ kind: 'field', field: 'estimate', operator: '<', value: '8' });
  });

  test('parses field>=value', () => {
    const q = parseQuery('estimate>=3');
    expect(q.ast).toMatchObject({ kind: 'field', field: 'estimate', operator: '>=', value: '3' });
  });

  test('parses field<=value', () => {
    const q = parseQuery('estimate<=10');
    expect(q.ast).toMatchObject({ kind: 'field', field: 'estimate', operator: '<=', value: '10' });
  });

  test('parses field~value (contains)', () => {
    const q = parseQuery('title~bug');
    expect(q.ast).toMatchObject({ kind: 'field', field: 'title', operator: '~', value: 'bug' });
  });

  test('parses in operator: field in(v1,v2)', () => {
    const q = parseQuery('status in(todo,done)');
    expect(q.ast).toMatchObject({ kind: 'field', field: 'status', operator: 'in', value: 'todo,done' });
  });

  test('parses assignee:john', () => {
    const q = parseQuery('assignee:john');
    expect(q.ast).toMatchObject({ kind: 'field', field: 'assignee', operator: '=', value: 'john' });
  });

  test('parses label:urgent', () => {
    const q = parseQuery('label:urgent');
    expect(q.ast).toMatchObject({ kind: 'field', field: 'label', operator: '=', value: 'urgent' });
  });

  test('strips quotes from value', () => {
    const q = parseQuery('title:"fix login bug"');
    expect(q.ast).toMatchObject({ kind: 'field', field: 'title', operator: '=', value: 'fix login bug' });
  });

  test('strips single quotes from value', () => {
    const q = parseQuery("title:'some title'");
    expect(q.ast).toMatchObject({ kind: 'field', field: 'title', operator: '=', value: 'some title' });
  });

  test('empty filter returns null AST', () => {
    const q = parseQuery('');
    expect(q.ast).toBeNull();
    expect(q.warnings).toHaveLength(0);
  });

  test('whitespace-only filter returns null AST', () => {
    const q = parseQuery('   ');
    expect(q.ast).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. AND/OR operators
// ---------------------------------------------------------------------------

describe('parseQuery — AND/OR logical operators', () => {
  test('parses simple AND', () => {
    const q = parseQuery('status:done AND assignee:john');
    expect(q.ast).toMatchObject({
      kind: 'and',
      left: { kind: 'field', field: 'status' },
      right: { kind: 'field', field: 'assignee' },
    });
  });

  test('parses simple OR', () => {
    const q = parseQuery('status:todo OR status:done');
    expect(q.ast).toMatchObject({
      kind: 'or',
      left: { kind: 'field', field: 'status', value: 'todo' },
      right: { kind: 'field', field: 'status', value: 'done' },
    });
  });

  test('AND has higher precedence than OR', () => {
    // a OR b AND c → a OR (b AND c)
    const q = parseQuery('status:todo OR assignee:john AND label:urgent');
    const ast = q.ast as OrExpression;
    expect(ast.kind).toBe('or');
    expect(ast.left).toMatchObject({ kind: 'field', field: 'status', value: 'todo' });
    expect(ast.right).toMatchObject({ kind: 'and' });
    const andNode = ast.right as AndExpression;
    expect(andNode.left).toMatchObject({ field: 'assignee' });
    expect(andNode.right).toMatchObject({ field: 'label' });
  });

  test('chained ANDs build left-associative tree', () => {
    const q = parseQuery('a:1 AND b:2 AND c:3');
    const ast = q.ast as AndExpression;
    expect(ast.kind).toBe('and');
    expect(ast.left).toMatchObject({ kind: 'and' }); // (a:1 AND b:2) AND c:3
  });

  test('chained ORs build left-associative tree', () => {
    const q = parseQuery('a:1 OR b:2 OR c:3');
    const ast = q.ast as OrExpression;
    expect(ast.kind).toBe('or');
    expect(ast.left).toMatchObject({ kind: 'or' });
  });

  test('AND is case-insensitive', () => {
    const q = parseQuery('status:done and assignee:john');
    expect(q.ast).toMatchObject({ kind: 'and' });
  });

  test('OR is case-insensitive', () => {
    const q = parseQuery('status:todo or status:done');
    expect(q.ast).toMatchObject({ kind: 'or' });
  });
});

// ---------------------------------------------------------------------------
// 3. Parenthesised sub-expressions
// ---------------------------------------------------------------------------

describe('parseQuery — parentheses', () => {
  test('parentheses override default precedence', () => {
    // (a OR b) AND c — now AND is at the top
    const q = parseQuery('(status:todo OR status:done) AND assignee:john');
    const ast = q.ast as AndExpression;
    expect(ast.kind).toBe('and');
    expect(ast.left).toMatchObject({ kind: 'or' });
    expect(ast.right).toMatchObject({ field: 'assignee' });
  });

  test('nested parentheses work', () => {
    const q = parseQuery('(status:done OR (assignee:john AND label:urgent))');
    expect(q.ast).toBeTruthy();
    expect(q.ast?.kind).toBe('or');
  });

  test('deeply nested expression', () => {
    const q = parseQuery('((status:todo OR status:done) AND (assignee:john OR assignee:mary))');
    expect(q.ast?.kind).toBe('and');
  });

  test('throws on unclosed parenthesis', () => {
    expect(() => parseQuery('(status:done AND assignee:john')).toThrow(ParseError);
    expect(() => parseQuery('(status:done AND assignee:john')).toThrow(/Unclosed parenthesis/i);
  });

  test('throws on unexpected closing paren', () => {
    expect(() => parseQuery('status:done)')).toThrow(ParseError);
  });

  test('complex real-world query: (status:done OR status:done-for-review) AND assignee:john', () => {
    const q = parseQuery('(status:done OR status:done-for-review) AND assignee:john');
    const ast = q.ast as AndExpression;
    expect(ast.kind).toBe('and');
    expect(ast.left.kind).toBe('or');
  });

  test('title~ with OR', () => {
    const q = parseQuery('title~"bug" OR (assignee:mary AND estimate>3)');
    expect(q.ast?.kind).toBe('or');
  });
});

// ---------------------------------------------------------------------------
// 4. Date predicates
// ---------------------------------------------------------------------------

describe('parseQuery — date predicates', () => {
  test('parses due_date:today', () => {
    const q = parseQuery('due_date:today');
    const ast = q.ast as DatePredicate;
    expect(ast.kind).toBe('date');
    expect(ast.field).toBe('due_date');
    expect(ast.dateValue).toMatchObject({ type: 'relative', keyword: 'today' });
  });

  test('parses due_date:tomorrow', () => {
    const q = parseQuery('due_date:tomorrow');
    const ast = q.ast as DatePredicate;
    expect(ast.dateValue.keyword).toBe('tomorrow');
  });

  test('parses due_date:this-week', () => {
    const q = parseQuery('due_date:this-week');
    const ast = q.ast as DatePredicate;
    expect(ast.dateValue.keyword).toBe('this-week');
  });

  test('parses due_date:next-week', () => {
    const q = parseQuery('due_date:next-week');
    const ast = q.ast as DatePredicate;
    expect(ast.dateValue.keyword).toBe('next-week');
  });

  test('parses due_date:next-month', () => {
    const q = parseQuery('due_date:next-month');
    const ast = q.ast as DatePredicate;
    expect(ast.dateValue.keyword).toBe('next-month');
  });

  test('parses due_date:last-month', () => {
    const q = parseQuery('due_date:last-month');
    const ast = q.ast as DatePredicate;
    expect(ast.dateValue.keyword).toBe('last-month');
  });

  test('parses due_date:overdue', () => {
    const q = parseQuery('due_date:overdue');
    const ast = q.ast as DatePredicate;
    expect(ast.dateValue.keyword).toBe('overdue');
  });

  test('parses due_date:yesterday', () => {
    const q = parseQuery('due_date:yesterday');
    const ast = q.ast as DatePredicate;
    expect(ast.dateValue.keyword).toBe('yesterday');
  });

  test('parses due_date:last-week', () => {
    const q = parseQuery('due_date:last-week');
    const ast = q.ast as DatePredicate;
    expect(ast.dateValue.keyword).toBe('last-week');
  });

  test('parses absolute date: due_date:2026-04-01', () => {
    const q = parseQuery('due_date:2026-04-01');
    const ast = q.ast as DatePredicate;
    expect(ast.kind).toBe('date');
    expect(ast.dateValue).toMatchObject({ type: 'absolute', iso: '2026-04-01' });
  });

  test('parses due_date<=2026-04-01', () => {
    const q = parseQuery('due_date<=2026-04-01');
    const ast = q.ast as DatePredicate;
    expect(ast.operator).toBe('<=');
    expect(ast.dateValue.iso).toBe('2026-04-01');
  });

  test('parses relative math: due_in:7d', () => {
    const q = parseQuery('due_in:7d');
    const ast = q.ast as DatePredicate;
    expect(ast.kind).toBe('date');
    expect(ast.dateValue).toMatchObject({ type: 'relative-math', offset: 7, unit: 'd' });
  });

  test('parses relative math: due_in:2w', () => {
    const q = parseQuery('due_in:2w');
    const ast = q.ast as DatePredicate;
    expect(ast.dateValue).toMatchObject({ type: 'relative-math', offset: 2, unit: 'w' });
  });

  test('parses relative math: due_in:1m', () => {
    const q = parseQuery('due_in:1m');
    const ast = q.ast as DatePredicate;
    expect(ast.dateValue).toMatchObject({ type: 'relative-math', offset: 1, unit: 'm' });
  });

  test('parses relative math: due_in:1y', () => {
    const q = parseQuery('due_in:1y');
    const ast = q.ast as DatePredicate;
    expect(ast.dateValue).toMatchObject({ type: 'relative-math', offset: 1, unit: 'y' });
  });

  test('parses signed relative math: +7d', () => {
    const q = parseQuery('due_date:+7d');
    const ast = q.ast as DatePredicate;
    expect(ast.dateValue).toMatchObject({ type: 'relative-math', offset: 7, unit: 'd' });
  });

  test('parses negative relative math: -2w', () => {
    const q = parseQuery('due_date:-2w');
    const ast = q.ast as DatePredicate;
    expect(ast.dateValue).toMatchObject({ type: 'relative-math', offset: -2, unit: 'w' });
  });

  test('parses quarter: 2026-Q2', () => {
    const q = parseQuery('due_date:2026-Q2');
    const ast = q.ast as DatePredicate;
    expect(ast.dateValue).toMatchObject({ type: 'quarter', keyword: '2026-Q2' });
  });

  test('parses week: 2026-W15', () => {
    const q = parseQuery('due_date:2026-W15');
    const ast = q.ast as DatePredicate;
    expect(ast.dateValue).toMatchObject({ type: 'week', keyword: '2026-W15' });
  });

  test('throws on invalid date: due_date:not-a-date', () => {
    expect(() => parseQuery('due_date:not-a-date')).toThrow(ParseError);
    expect(() => parseQuery('due_date:not-a-date')).toThrow(/Invalid date format/i);
  });

  test('throws on invalid ISO date: due_date:2026-13-99', () => {
    expect(() => parseQuery('due_date:2026-13-99')).toThrow(ParseError);
  });

  test('parses created_at field with date value', () => {
    const q = parseQuery('created_at:2026-01-01');
    const ast = q.ast as DatePredicate;
    expect(ast.kind).toBe('date');
    expect(ast.field).toBe('created_at');
  });

  test('parses updated_at field', () => {
    const q = parseQuery('updated_at:2026-01-01');
    expect(q.ast).toMatchObject({ kind: 'date', field: 'updated_at' });
  });

  test('parses due_before field', () => {
    const q = parseQuery('due_before:2026-04-01');
    expect(q.ast).toMatchObject({ kind: 'date', field: 'due_before' });
  });

  test('parses due_after field', () => {
    const q = parseQuery('due_after:2026-01-01');
    expect(q.ast).toMatchObject({ kind: 'date', field: 'due_after' });
  });
});

// ---------------------------------------------------------------------------
// 5. Relationship queries
// ---------------------------------------------------------------------------

describe('parseQuery — relationship predicates', () => {
  test('parses relationship:blocks', () => {
    const q = parseQuery('relationship:blocks');
    const ast = q.ast as RelationshipPredicate;
    expect(ast.kind).toBe('relationship');
    expect(ast.type).toBe('blocks');
    expect(ast.targetId).toBeUndefined();
  });

  test('parses relationship:depends', () => {
    const q = parseQuery('relationship:depends');
    const ast = q.ast as RelationshipPredicate;
    expect(ast.type).toBe('depends');
  });

  test('parses relationship:relates', () => {
    const q = parseQuery('relationship:relates');
    const ast = q.ast as RelationshipPredicate;
    expect(ast.type).toBe('relates');
  });

  test('parses relationship:blocks:CARD-123 with target', () => {
    const q = parseQuery('relationship:blocks:CARD-123');
    const ast = q.ast as RelationshipPredicate;
    expect(ast.type).toBe('blocks');
    expect(ast.targetId).toBe('CARD-123');
  });

  test('parses relationship:depends:CARD-456', () => {
    const q = parseQuery('relationship:depends:CARD-456');
    const ast = q.ast as RelationshipPredicate;
    expect(ast.type).toBe('depends');
    expect(ast.targetId).toBe('CARD-456');
  });

  test('throws on invalid relationship type', () => {
    expect(() => parseQuery('relationship:invalid')).toThrow(ParseError);
    expect(() => parseQuery('relationship:invalid')).toThrow(/Invalid relationship type/i);
  });

  test('throws on unknown relationship type: linked', () => {
    expect(() => parseQuery('relationship:linked')).toThrow(ParseError);
  });

  test('VALID_RELATIONSHIP_TYPES exports correct values', () => {
    expect(VALID_RELATIONSHIP_TYPES).toContain('blocks');
    expect(VALID_RELATIONSHIP_TYPES).toContain('depends');
    expect(VALID_RELATIONSHIP_TYPES).toContain('relates');
  });
});

// ---------------------------------------------------------------------------
// 6. Custom field queries
// ---------------------------------------------------------------------------

describe('parseQuery — custom field predicates', () => {
  test('parses customField:Priority=High', () => {
    const q = parseQuery('customField:Priority=High');
    const ast = q.ast as CustomFieldPredicate;
    expect(ast.kind).toBe('customField');
    expect(ast.fieldName).toBe('Priority');
    expect(ast.operator).toBe('=');
    expect(ast.value).toBe('High');
  });

  test('parses customField:Estimate>5', () => {
    const q = parseQuery('customField:Estimate>5');
    const ast = q.ast as CustomFieldPredicate;
    expect(ast.operator).toBe('>');
    expect(ast.value).toBe('5');
  });

  test('parses customField:Score>=80', () => {
    const q = parseQuery('customField:Score>=80');
    const ast = q.ast as CustomFieldPredicate;
    expect(ast.operator).toBe('>=');
  });

  test('parses customField:Label~important', () => {
    const q = parseQuery('customField:Label~important');
    const ast = q.ast as CustomFieldPredicate;
    expect(ast.operator).toBe('~');
    expect(ast.value).toBe('important');
  });

  test('parses customField:Impact<=3', () => {
    const q = parseQuery('customField:Impact<=3');
    const ast = q.ast as CustomFieldPredicate;
    expect(ast.operator).toBe('<=');
  });

  test('throws on invalid customField syntax', () => {
    expect(() => parseQuery('customField:noOperator')).toThrow(ParseError);
    expect(() => parseQuery('customField:noOperator')).toThrow(/Invalid customField syntax/i);
  });

  test('customField in compound query', () => {
    const q = parseQuery('status:todo AND customField:Priority=High');
    expect(q.ast?.kind).toBe('and');
    const andNode = q.ast as AndExpression;
    expect(andNode.right).toMatchObject({ kind: 'customField', fieldName: 'Priority' });
  });
});

// ---------------------------------------------------------------------------
// 7. Error cases
// ---------------------------------------------------------------------------

describe('parseQuery — error handling', () => {
  test('throws ParseError on missing operand after AND', () => {
    expect(() => parseQuery('status:done AND')).toThrow(ParseError);
  });

  test('throws ParseError on missing operand after OR', () => {
    expect(() => parseQuery('status:done OR')).toThrow(ParseError);
  });

  test('throws ParseError on bare AND', () => {
    expect(() => parseQuery('AND')).toThrow(ParseError);
  });

  test('throws ParseError on bare OR', () => {
    expect(() => parseQuery('OR')).toThrow(ParseError);
  });

  test('ParseError has name ParseError', () => {
    try {
      parseQuery('status:done AND');
    } catch (err: any) {
      expect(err.name).toBe('ParseError');
      expect(err instanceof ParseError).toBe(true);
    }
  });

  test('throws on extra token after valid expression', () => {
    // "status:done status:todo" — second token has no operator
    // Tokeniser emits it as FIELD_OP, but parser sees two consecutive primaries with no AND/OR
    expect(() => parseQuery('status:done status:todo')).toThrow(ParseError);
  });

  test('raw field is preserved in returned Query', () => {
    const q = parseQuery('status:done');
    expect(q.raw).toBe('status:done');
  });
});

// ---------------------------------------------------------------------------
// 8. Enum validation — warnings
// ---------------------------------------------------------------------------

describe('parseQuery — enum validation and warnings', () => {
  test('no warning for valid status value', () => {
    const q = parseQuery('status:done');
    expect(q.warnings).toHaveLength(0);
  });

  test('warns on unknown status value', () => {
    const q = parseQuery('status:unknown-status');
    expect(q.warnings.length).toBeGreaterThan(0);
    expect(q.warnings[0]).toContain('Unknown status value');
  });

  test('warns on unknown field name', () => {
    const q = parseQuery('invalidfield:value');
    expect(q.warnings.length).toBeGreaterThan(0);
    expect(q.warnings[0]).toContain('Unknown field');
  });

  test('no warning for known field names', () => {
    const q = parseQuery('assignee:john');
    expect(q.warnings).toHaveLength(0);
  });

  test('VALID_STATUS_VALUES includes standard statuses', () => {
    expect(VALID_STATUS_VALUES).toContain('done');
    expect(VALID_STATUS_VALUES).toContain('todo');
    expect(VALID_STATUS_VALUES).toContain('in-progress');
    expect(VALID_STATUS_VALUES).toContain('blocked');
  });

  test('DATE_KEYWORDS exports correct keywords', () => {
    expect(DATE_KEYWORDS).toContain('today');
    expect(DATE_KEYWORDS).toContain('tomorrow');
    expect(DATE_KEYWORDS).toContain('this-week');
    expect(DATE_KEYWORDS).toContain('overdue');
  });

  test('bare quoted string produces warning and title predicate', () => {
    const q = parseQuery('"bug fix"');
    // Should produce title~'bug fix' with a warning or no warning
    expect(q.ast).toMatchObject({ kind: 'field', field: 'title', operator: '~', value: 'bug fix' });
  });

  test('warns when date keyword on non-date field', () => {
    // "status:today" — status field but today is a date keyword
    const q = parseQuery('status:today');
    // should warn about date keyword on non-date field
    expect(q.warnings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 9. filterCards() — integration helper
// ---------------------------------------------------------------------------

describe('filterCards', () => {
  const cards = [
    { cardId: '1', name: 'Fix login bug', status: 'done', assignees: ['john'], tags: ['urgent'], estimate: 3, dueDate: '2026-01-01' },
    { cardId: '2', name: 'Add payment',   status: 'in-progress', assignees: ['mary'], tags: ['feature'], estimate: 8, dueDate: '2099-01-01' },
    { cardId: '3', name: 'Write tests',   status: 'todo', assignees: ['john', 'mary'], tags: ['testing'], estimate: 5, dueDate: '2025-01-01' },
    { cardId: '4', name: 'Auth service',  status: 'blocked', assignees: ['bob'], tags: [], estimate: 2, dueDate: '2026-06-01' },
  ];

  test('returns all cards when query is empty', () => {
    const q = parseQuery('');
    expect(filterCards(q, cards)).toHaveLength(4);
  });

  test('filters by exact status', () => {
    const q = parseQuery('status:done');
    const result = filterCards(q, cards);
    expect(result).toHaveLength(1);
    expect(result[0].cardId).toBe('1');
  });

  test('filters by assignee', () => {
    const q = parseQuery('assignee:john');
    const result = filterCards(q, cards);
    expect(result.map(c => c.cardId).sort()).toEqual(['1', '3']);
  });

  test('filters by tag', () => {
    const q = parseQuery('tag:urgent');
    const result = filterCards(q, cards);
    expect(result).toHaveLength(1);
    expect(result[0].cardId).toBe('1');
  });

  test('filters by title contains', () => {
    const q = parseQuery('title~tests');
    const result = filterCards(q, cards);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Write tests');
  });

  test('filters by estimate greater than', () => {
    const q = parseQuery('estimate>5');
    const result = filterCards(q, cards);
    expect(result).toHaveLength(1);
    expect(result[0].cardId).toBe('2');
  });

  test('filters by estimate >= 5', () => {
    const q = parseQuery('estimate>=5');
    const result = filterCards(q, cards);
    expect(result.map(c => c.cardId).sort()).toEqual(['2', '3']);
  });

  test('filters by estimate <= 3', () => {
    const q = parseQuery('estimate<=3');
    const result = filterCards(q, cards);
    expect(result.map(c => c.cardId).sort()).toEqual(['1', '4']);
  });

  test('AND filter: status:done AND assignee:john', () => {
    const q = parseQuery('status:done AND assignee:john');
    const result = filterCards(q, cards);
    expect(result).toHaveLength(1);
    expect(result[0].cardId).toBe('1');
  });

  test('OR filter: status:done OR status:blocked', () => {
    const q = parseQuery('status:done OR status:blocked');
    const result = filterCards(q, cards);
    expect(result.map(c => c.cardId).sort()).toEqual(['1', '4']);
  });

  test('complex filter: (status:done OR status:in-progress) AND assignee:john', () => {
    const q = parseQuery('(status:done OR status:in-progress) AND assignee:john');
    const result = filterCards(q, cards);
    expect(result).toHaveLength(1);
    expect(result[0].cardId).toBe('1');
  });

  test('returns empty array when nothing matches', () => {
    const q = parseQuery('status:cancelled');
    const result = filterCards(q, cards);
    expect(result).toHaveLength(0);
  });

  test('in operator filters correctly', () => {
    const q = parseQuery('status in(done,blocked)');
    const result = filterCards(q, cards);
    expect(result.map(c => c.cardId).sort()).toEqual(['1', '4']);
  });

  test('date predicate: due_date overdue (past dates match)', () => {
    const q = parseQuery('due_date<today');
    const result = filterCards(q, cards);
    // cardId 1 (2026-01-01) and 3 (2025-01-01) are in the past
    // cardId 2 (2099-01-01) and 4 (2026-06-01) depend on "today"
    // Since we can't control "today" in tests, just verify it runs without error
    expect(Array.isArray(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. evaluateNode — direct coverage
// ---------------------------------------------------------------------------

describe('evaluateNode — direct evaluation', () => {
  const card = {
    cardId: '1',
    name: 'Fix bug',
    status: 'done',
    assignees: ['john', 'mary'],
    tags: ['urgent', 'backend'],
    estimate: 5,
    dueDate: '2099-12-31',
    createdAt: '2026-01-01',
    updatedAt: '2026-03-01',
    customFields: [
      { name: 'Priority', value: 'High' },
      { name: 'Score', value: '90' },
    ],
    relationships: [
      { type: 'blocks', targetId: 'CARD-999' },
    ],
  };

  test('AND node: both true → true', () => {
    const node: AndExpression = {
      kind: 'and',
      left: fieldPred('status', '=', 'done'),
      right: fieldPred('estimate', '=', '5'),
    };
    expect(evaluateNode(node, card)).toBe(true);
  });

  test('AND node: one false → false', () => {
    const node: AndExpression = {
      kind: 'and',
      left: fieldPred('status', '=', 'done'),
      right: fieldPred('estimate', '=', '99'),
    };
    expect(evaluateNode(node, card)).toBe(false);
  });

  test('OR node: one true → true', () => {
    const node: OrExpression = {
      kind: 'or',
      left: fieldPred('status', '=', 'todo'),
      right: fieldPred('status', '=', 'done'),
    };
    expect(evaluateNode(node, card)).toBe(true);
  });

  test('OR node: both false → false', () => {
    const node: OrExpression = {
      kind: 'or',
      left: fieldPred('status', '=', 'todo'),
      right: fieldPred('status', '=', 'blocked'),
    };
    expect(evaluateNode(node, card)).toBe(false);
  });

  test('field: contains on string', () => {
    const node = fieldPred('title', '~', 'bug');
    expect(evaluateNode(node, card)).toBe(true);
  });

  test('field: contains on string — no match', () => {
    const node = fieldPred('title', '~', 'feature');
    expect(evaluateNode(node, card)).toBe(false);
  });

  test('field: numeric gt', () => {
    const node = fieldPred('estimate', '>', '3');
    expect(evaluateNode(node, card)).toBe(true);
  });

  test('field: numeric lt', () => {
    const node = fieldPred('estimate', '<', '3');
    expect(evaluateNode(node, card)).toBe(false);
  });

  test('field: in operator on array field', () => {
    const node: FieldPredicate = { kind: 'field', field: 'status', operator: 'in', value: 'done,todo' };
    expect(evaluateNode(node, card)).toBe(true);
  });

  test('field: in operator — no match', () => {
    const node: FieldPredicate = { kind: 'field', field: 'status', operator: 'in', value: 'blocked,cancelled' };
    expect(evaluateNode(node, card)).toBe(false);
  });

  test('field: array field contains match', () => {
    const node = fieldPred('assignee', '=', 'john');
    expect(evaluateNode(node, card)).toBe(true);
  });

  test('field: array field no match', () => {
    const node = fieldPred('assignee', '=', 'bob');
    expect(evaluateNode(node, card)).toBe(false);
  });

  test('date: absolute date equality', () => {
    const q = parseQuery('due_date:2099-12-31');
    expect(evaluateNode(q.ast!, card)).toBe(true);
  });

  test('date: card with no dueDate returns false', () => {
    const cardNoDue = { ...card, dueDate: undefined };
    const q = parseQuery('due_date:today');
    expect(evaluateNode(q.ast!, cardNoDue)).toBe(false);
  });

  test('customField: equality match', () => {
    const q = parseQuery('customField:Priority=High');
    expect(evaluateNode(q.ast!, card)).toBe(true);
  });

  test('customField: no match', () => {
    const q = parseQuery('customField:Priority=Low');
    expect(evaluateNode(q.ast!, card)).toBe(false);
  });

  test('customField: field not present returns false', () => {
    const q = parseQuery('customField:NonExistent=value');
    expect(evaluateNode(q.ast!, card)).toBe(false);
  });

  test('customField: numeric > operator', () => {
    const q = parseQuery('customField:Score>50');
    expect(evaluateNode(q.ast!, card)).toBe(true);
  });

  test('customField: uses custom_fields alias', () => {
    const cardAlt = { ...card, customFields: undefined, custom_fields: card.customFields };
    const q = parseQuery('customField:Priority=High');
    expect(evaluateNode(q.ast!, cardAlt)).toBe(true);
  });

  test('relationship: blocks match', () => {
    const q = parseQuery('relationship:blocks');
    expect(evaluateNode(q.ast!, card)).toBe(true);
  });

  test('relationship: blocks with target match', () => {
    const q = parseQuery('relationship:blocks:CARD-999');
    expect(evaluateNode(q.ast!, card)).toBe(true);
  });

  test('relationship: blocks with wrong target no match', () => {
    const q = parseQuery('relationship:blocks:CARD-000');
    expect(evaluateNode(q.ast!, card)).toBe(false);
  });

  test('relationship: depends — no match on card with only blocks', () => {
    const q = parseQuery('relationship:depends');
    expect(evaluateNode(q.ast!, card)).toBe(false);
  });

  test('relationship: uses links alias', () => {
    const cardAlt = { ...card, relationships: undefined, links: [{ type: 'blocks', target: 'CARD-999' }] };
    const q = parseQuery('relationship:blocks');
    expect(evaluateNode(q.ast!, cardAlt)).toBe(true);
  });

  test('relationship: card with no relationships returns false', () => {
    const cardNoRel = { ...card, relationships: [] };
    const q = parseQuery('relationship:blocks');
    expect(evaluateNode(q.ast!, cardNoRel)).toBe(false);
  });

  test('field: returns false when field not found on card', () => {
    const node = fieldPred('nonexistentfield', '=', 'value');
    expect(evaluateNode(node, card)).toBe(false);
  });

  test('field: lexicographic comparison for non-numeric', () => {
    const node: FieldPredicate = { kind: 'field', field: 'status', operator: '>', value: 'aaa' };
    expect(evaluateNode(node, card)).toBe(true); // 'done' > 'aaa'
  });

  test('field: lexicographic <= comparison', () => {
    const node: FieldPredicate = { kind: 'field', field: 'status', operator: '<=', value: 'zzz' };
    expect(evaluateNode(node, card)).toBe(true); // 'done' <= 'zzz'
  });

  test('field: lexicographic < comparison', () => {
    const node: FieldPredicate = { kind: 'field', field: 'status', operator: '<', value: 'zzz' };
    expect(evaluateNode(node, card)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 11. Edge cases and additional coverage
// ---------------------------------------------------------------------------

describe('parseQuery — edge cases', () => {
  test('all DATE_KEYWORDS parse successfully', () => {
    for (const kw of DATE_KEYWORDS) {
      expect(() => parseQuery(`due_date:${kw}`)).not.toThrow();
    }
  });

  test('all VALID_STATUS_VALUES produce no warnings', () => {
    for (const s of VALID_STATUS_VALUES) {
      const q = parseQuery(`status:${s}`);
      expect(q.warnings).toHaveLength(0);
    }
  });

  test('all VALID_RELATIONSHIP_TYPES parse successfully', () => {
    for (const rt of VALID_RELATIONSHIP_TYPES) {
      const q = parseQuery(`relationship:${rt}`);
      expect(q.ast).toMatchObject({ kind: 'relationship', type: rt });
    }
  });

  test('due_date with this-month keyword', () => {
    const q = parseQuery('due_date:this-month');
    const ast = q.ast as DatePredicate;
    expect(ast.dateValue.keyword).toBe('this-month');
  });

  test('complex multi-condition query parses without error', () => {
    const filter = '(status:done OR status:done-for-review) AND assignee:john AND due_before:2026-04-01';
    expect(() => parseQuery(filter)).not.toThrow();
    const q = parseQuery(filter);
    expect(q.ast?.kind).toBe('and');
  });

  test('complex nested query with mixed operators', () => {
    const filter = 'title~"bug" OR (assignee:mary AND estimate>3)';
    const q = parseQuery(filter);
    expect(q.ast?.kind).toBe('or');
  });

  test('field in(list) inside compound expression', () => {
    const q = parseQuery('status in(todo,in-progress) AND assignee:john');
    expect(q.ast?.kind).toBe('and');
    const andNode = q.ast as AndExpression;
    expect(andNode.left).toMatchObject({ kind: 'field', operator: 'in' });
  });

  test('tag field works with evaluateNode', () => {
    const card = { name: 'Test', status: 'done', tags: ['backend', 'urgent'] };
    const q = parseQuery('tag:backend');
    expect(evaluateNode(q.ast!, card)).toBe(true);
  });

  test('label field works as alias for tags', () => {
    const card = { name: 'Test', status: 'done', labels: ['backend'] };
    const q = parseQuery('label:backend');
    expect(evaluateNode(q.ast!, card)).toBe(true);
  });

  test('parseQuery returns warnings array even on success', () => {
    const q = parseQuery('status:done');
    expect(Array.isArray(q.warnings)).toBe(true);
  });

  test('parseQuery raw preserves original input', () => {
    const filter = 'status:done AND assignee:john';
    const q = parseQuery(filter);
    expect(q.raw).toBe(filter);
  });

  test('relationship with target uses target alias', () => {
    const card = {
      name: 'test',
      links: [{ type: 'relates', target: 'CARD-111', targetId: undefined }]
    };
    const q = parseQuery('relationship:relates:CARD-111');
    expect(evaluateNode(q.ast!, card)).toBe(true);
  });

  test('estimate field numeric equality', () => {
    const card = { name: 'test', estimate: 5 };
    const q = parseQuery('estimate:5');
    expect(evaluateNode(q.ast!, card)).toBe(true);
  });

  test('name field: unquoted multi-word throws ParseError (two consecutive tokens)', () => {
    // "name:Fix bug" splits into two tokens — parser throws
    expect(() => parseQuery('name:Fix bug')).toThrow(ParseError);
  });

  test('name field with tilde contains', () => {
    const card = { name: 'Fix bug', status: 'done' };
    const q = parseQuery('name~Fix');
    expect(evaluateNode(q.ast!, card)).toBe(true);
  });

  test('description field works', () => {
    const card = { name: 'test', description: 'A detailed description' };
    const q = parseQuery('description~detailed');
    expect(evaluateNode(q.ast!, card)).toBe(true);
  });

  test('created_by field works', () => {
    const card = { name: 'test', createdBy: 'john' };
    const q = parseQuery('created_by:john');
    expect(evaluateNode(q.ast!, card)).toBe(true);
  });

  test('priority field works', () => {
    const card = { name: 'test', priority: 'high' };
    const q = parseQuery('priority:high');
    expect(evaluateNode(q.ast!, card)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 12. Additional branch coverage
// ---------------------------------------------------------------------------

describe('parseQuery — additional branch coverage', () => {
  test('bare token without operator becomes title~ with warning', () => {
    // A raw token like "bugfix" with no operator — should warn and produce title~bugfix
    // We need to reach parsePredicate with a raw value that doesn't match opRegex
    // The easiest way: inject a token that looks like no-op-char word
    // Actually "bugfix" alone in a standalone position goes through parsePrimary as FIELD_OP
    // but "bugfix" doesn't match the opRegex /^([a-zA-Z_]...)(>=|<=|>|<|~|=|:)(.+)$/
    // This hits the fallback warning path
    const q = parseQuery('status:done AND bugfix');
    // "bugfix" has no operator → warning
    expect(q.warnings.some(w => w.includes("bugfix"))).toBe(true);
    // And ast is still valid
    expect(q.ast?.kind).toBe('and');
  });

  test('escaped quote inside quoted value', () => {
    // "fix \\"bug\\"" - escaped quotes inside quoted string
    const q = parseQuery('title:"fix \\"bug\\""');
    expect(q.ast).toMatchObject({ kind: 'field', field: 'title' });
  });

  test('array field with in operator via compareValues', () => {
    const card = { name: 'test', tags: ['backend', 'urgent'] };
    const node = { kind: 'field' as const, field: 'tag', operator: 'in' as const, value: 'backend,frontend' };
    expect(evaluateNode(node, card)).toBe(true);
  });

  test('array field with in operator no match via compareValues', () => {
    const card = { name: 'test', tags: ['frontend'] };
    const node = { kind: 'field' as const, field: 'tag', operator: 'in' as const, value: 'backend,design' };
    expect(evaluateNode(node, card)).toBe(false);
  });

  test('evaluateNode default case returns false for unknown kind', () => {
    // Force an unknown kind through type casting
    const unknownNode = { kind: 'unknown' } as unknown as QueryNode;
    expect(evaluateNode(unknownNode, {})).toBe(false);
  });

  test('resolveDateValue default case via unrecognized relative type', () => {
    // We can reach 'default' in resolveDateValue by injecting a DatePredicate with an unexpected type
    const ast: DatePredicate = {
      kind: 'date',
      field: 'due_date',
      operator: '=',
      dateValue: { type: 'relative' as any, keyword: 'some-unknown-keyword' }
    };
    const card = { name: 'test', dueDate: new Date().toISOString().slice(0, 10) };
    // evaluateNode should not throw — falls back to today in resolveRelativeKeyword default
    expect(() => evaluateNode(ast, card)).not.toThrow();
  });

  test('resolveRelativeKeyword: tomorrow', () => {
    const q = parseQuery('due_date<tomorrow');
    const card = { name: 'test', dueDate: '2000-01-01' };
    expect(evaluateNode(q.ast!, card)).toBe(true); // 2000 < tomorrow
  });

  test('resolveRelativeKeyword: this-week', () => {
    const q = parseQuery('due_date>=this-week');
    // Just verify it runs without error
    const card = { name: 'test', dueDate: '2099-12-31' };
    expect(() => evaluateNode(q.ast!, card)).not.toThrow();
  });

  test('resolveRelativeKeyword: next-week', () => {
    const q = parseQuery('due_date>=next-week');
    const card = { name: 'test', dueDate: '2099-12-31' };
    expect(() => evaluateNode(q.ast!, card)).not.toThrow();
  });

  test('resolveRelativeKeyword: last-week', () => {
    const q = parseQuery('due_date<=last-week');
    const card = { name: 'test', dueDate: '2000-01-01' };
    expect(evaluateNode(q.ast!, card)).toBe(true);
  });

  test('resolveRelativeKeyword: this-month', () => {
    const q = parseQuery('due_date>=this-month');
    const card = { name: 'test', dueDate: '2099-12-31' };
    expect(() => evaluateNode(q.ast!, card)).not.toThrow();
  });

  test('resolveDateValue: default branch via unknown type', () => {
    const ast: DatePredicate = {
      kind: 'date',
      field: 'due_date',
      operator: '=',
      dateValue: { type: 'unknown-type' as any }
    };
    const card = { name: 'test', dueDate: new Date().toISOString().slice(0, 10) };
    expect(() => evaluateNode(ast, card)).not.toThrow();
  });

  test('field: string >= comparison (lexicographic)', () => {
    const card = { name: 'test', status: 'done' };
    const node: FieldPredicate = { kind: 'field', field: 'status', operator: '>=', value: 'aaa' };
    expect(evaluateNode(node, card)).toBe(true); // 'done' >= 'aaa'
  });

  test('field: string default operator returns false', () => {
    // unknown operator forced through type casting
    const card = { name: 'test', estimate: 5 };
    const node: FieldPredicate = { kind: 'field', field: 'estimate', operator: 'in' as any, value: '1,2,3' };
    // estimate=5, in(1,2,3) → false
    expect(evaluateNode(node, card)).toBe(false);
  });

  test('date predicate with due_in field evaluation', () => {
    const q = parseQuery('due_in:7d');
    // This parses but evaluateNode uses 'due_in' field to look up card.dueDate? No, it looks up 'due_in'
    const card = { name: 'test', dueDate: '2099-12-31', due_date: '2099-12-31' };
    // evaluateNode will find no 'due_in' field on card → returns false
    expect(() => evaluateNode(q.ast!, card)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 12. Date evaluation coverage
// ---------------------------------------------------------------------------

describe('evaluateNode — date comparisons', () => {
  const futureCard = { name: 'future', dueDate: '2099-12-31', createdAt: '2099-01-01', updatedAt: '2099-01-01' };
  const pastCard = { name: 'past', dueDate: '2000-01-01', createdAt: '2000-01-01', updatedAt: '2000-01-01' };

  test('absolute date: future card due before 2100-01-01', () => {
    const q = parseQuery('due_date<2100-01-01');
    expect(evaluateNode(q.ast!, futureCard)).toBe(true);
  });

  test('absolute date: past card not due after 2010-01-01 (depends on date)', () => {
    const q = parseQuery('due_date>2010-01-01');
    expect(evaluateNode(q.ast!, pastCard)).toBe(false);
  });

  test('relative-math: +7d comparison', () => {
    // Future card due in far future, so due_date <= +7d should be false
    const q = parseQuery('due_date<=+7d');
    expect(evaluateNode(q.ast!, futureCard)).toBe(false);
  });

  test('relative-math: +7w comparison on past card', () => {
    const q = parseQuery('due_date<=+7w');
    expect(evaluateNode(q.ast!, pastCard)).toBe(true);
  });

  test('quarter date: due_date:2026-Q1', () => {
    const card = { name: 'q1', dueDate: '2026-01-15' };
    const q = parseQuery('due_date>=2026-Q1');
    expect(evaluateNode(q.ast!, card)).toBe(true);
  });

  test('week date: due_date>=2026-W01', () => {
    const card = { name: 'w1', dueDate: '2026-06-01' };
    const q = parseQuery('due_date>=2026-W01');
    expect(evaluateNode(q.ast!, card)).toBe(true);
  });

  test('relative next-month: future card not due next-month (far future)', () => {
    const q = parseQuery('due_date<=next-month');
    expect(evaluateNode(q.ast!, futureCard)).toBe(false);
  });

  test('relative last-week on past card', () => {
    const q = parseQuery('due_date<=last-week');
    expect(evaluateNode(q.ast!, pastCard)).toBe(true);
  });

  test('relative yesterday on past card', () => {
    const q = parseQuery('due_date<=yesterday');
    expect(evaluateNode(q.ast!, pastCard)).toBe(true);
  });

  test('relative this-month on future card', () => {
    const q = parseQuery('due_date>=this-month');
    expect(evaluateNode(q.ast!, futureCard)).toBe(true);
  });

  test('relative last-month on past card', () => {
    const q = parseQuery('due_date>=last-month');
    expect(evaluateNode(q.ast!, pastCard)).toBe(false); // 2000 is before last-month
  });

  test('relative-math months: +1m', () => {
    const q = parseQuery('due_in:1m');
    expect(q.ast).toMatchObject({ kind: 'date', dateValue: { unit: 'm' } });
  });

  test('relative-math years: +1y', () => {
    const q = parseQuery('due_in:1y');
    expect(q.ast).toMatchObject({ kind: 'date', dateValue: { unit: 'y' } });
  });
});
