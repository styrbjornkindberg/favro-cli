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
 *   5. Dependency predicates (unblocked, blocks:, blocked-by:)
 *   6. customField: refusal
 *   7. Error cases (unclosed parens, bad dates, unknown fields)
 *   8. Fail-closed field validation
 *   9. filterCards() integration helper
 *  10. evaluateNode() coverage
 *  11. Edge cases (empty input, bare keywords, nested AND/OR)
 */

import {
  parseQuery,
  filterCards,
  evaluateNode,
  ParseError,
  DATE_KEYWORDS,
  type Query,
  type QueryNode,
  type FieldPredicate,
  type DatePredicate,
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
    const q = parseQuery('sequentialId>5');
    expect(q.ast).toMatchObject({ kind: 'field', field: 'sequentialid', operator: '>', value: '5' });
  });

  test('parses field<value', () => {
    const q = parseQuery('sequentialId<8');
    expect(q.ast).toMatchObject({ kind: 'field', field: 'sequentialid', operator: '<', value: '8' });
  });

  test('parses field>=value', () => {
    const q = parseQuery('sequentialId>=3');
    expect(q.ast).toMatchObject({ kind: 'field', field: 'sequentialid', operator: '>=', value: '3' });
  });

  test('parses field<=value', () => {
    const q = parseQuery('sequentialId<=10');
    expect(q.ast).toMatchObject({ kind: 'field', field: 'sequentialid', operator: '<=', value: '10' });
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
    const q = parseQuery('status:1 AND title:2 AND tag:3');
    const ast = q.ast as AndExpression;
    expect(ast.kind).toBe('and');
    expect(ast.left).toMatchObject({ kind: 'and' }); // (a:1 AND b:2) AND c:3
  });

  test('chained ORs build left-associative tree', () => {
    const q = parseQuery('status:1 OR title:2 OR tag:3');
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
    const q = parseQuery('title~"bug" OR (assignee:mary AND sequentialId>3)');
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

describe('parseQuery — dependency predicates', () => {
  // Favro has no link "types" — one edge, one `isBefore` flag. `relationship:`
  // named three types Favro cannot store and read them off a `card.relationships`
  // that never exists, so it is gone; these three replace it.

  test('refuses relationship: — Favro stores no such thing', () => {
    expect(() => parseQuery('relationship:blocks')).toThrow(ParseError);
    expect(() => parseQuery('relationship:blocks')).toThrow(/Unknown filter field 'relationship'/);
  });

  test('parses bare unblocked as a whole predicate', () => {
    const q = parseQuery('unblocked');
    expect(q.ast).toMatchObject({ kind: 'field', field: 'unblocked' });
  });

  test('parses blocked-by:<ref>', () => {
    const q = parseQuery('blocked-by:CLA-1804');
    expect(q.ast).toMatchObject({ kind: 'field', field: 'blocked-by', value: 'CLA-1804' });
  });

  test('parses blocks:<ref>', () => {
    const q = parseQuery('blocks:CLA-1804');
    expect(q.ast).toMatchObject({ kind: 'field', field: 'blocks', value: 'CLA-1804' });
  });

  test('unblocked is true only when no unfinished edge comes before the card', () => {
    // A real card always carries `widgetCommonId`. One that does not is a FORK
    // (an assignment entity with no column), and a fork is never takeable — so
    // these fixtures have to be board instances to mean anything (#47).
    const board = { widgetCommonId: 'board-1' };
    // Edges carry `cardCommonId`, never a `cardSequentialId` — see the note on
    // `EDGE` below, and #162.
    const blocked = { ...board, name: 'a', links: [{ isBefore: true, cardCommonId: 'common-1' }] };
    const blocking = { ...board, name: 'b', links: [{ isBefore: false, cardCommonId: 'common-2' }] };
    const q = parseQuery('unblocked');
    expect(evaluateNode(q.ast!, blocked)).toBe(false);
    expect(evaluateNode(q.ast!, blocking)).toBe(true);
    expect(evaluateNode(q.ast!, { ...board, name: 'c' })).toBe(true);
  });

  test('a blocker clears only on proof it is done — no proof means blocked', () => {
    const card = {
      widgetCommonId: 'board-1',
      links: [{ isBefore: true, cardCommonId: 'blocker-1' }],
    };
    // No context at all: the blocker blocks. Over-blocking, never under.
    expect(evaluateNode(parseQuery('unblocked').ast!, card)).toBe(false);
    // A context that judged some OTHER card does not clear this one either.
    expect(evaluateNode(parseQuery('unblocked').ast!, card, {
      doneBlockers: new Set(['blocker-9']),
    })).toBe(false);
    expect(evaluateNode(parseQuery('unblocked').ast!, card, {
      doneBlockers: new Set(['blocker-1']),
    })).toBe(true);
  });

  test('unblocked excludes archived cards and forks whatever their edges say', () => {
    const q = parseQuery('unblocked');
    expect(evaluateNode(q.ast!, { widgetCommonId: 'board-1', archived: true })).toBe(false);
    // A fork: assigning a card produces a second entity with no widgetCommonId
    // and no columnId. Nothing to act on, so it is never on the frontier.
    expect(evaluateNode(q.ast!, { cardId: 'c1', name: 'fork' })).toBe(false);
  });

  // The two arms below used to assert over a hand-written `links` array that
  // omitted the `cardId` Favro puts on every edge and invented a
  // `cardSequentialId` Favro has never been measured sending. They were green
  // across the whole of #162 item 3 — proving the predicate over a shape that
  // does not exist, which reads as coverage of the exact defect. The fixture is
  // now the MEASURED edge (live, 2026-08-13, board abf5860049452d51cacb8162),
  // and the paired-polarity arm that enters through `normalizeCard` lives in
  // `cards-api-dependencies-wire.test.ts`.
  const EDGE = {
    cardId: '621a8a2e7a2eb278bf008484',
    isBefore: true,
    cardCommonId: 'ed952c352c7022ead230856c',
    reverseCardId: 'b9303e90cb9db9e78ce6f9bf',
  };

  test('blocked-by matches an incoming edge by cardId AND by cardCommonId', () => {
    const card = { name: 'a', links: [EDGE] };
    expect(evaluateNode(parseQuery(`blocked-by:${EDGE.cardId}`).ast!, card)).toBe(true);
    expect(evaluateNode(parseQuery(`blocked-by:${EDGE.cardCommonId}`).ast!, card)).toBe(true);
    // The NEAR end is not the far end: an edge must not match the card it hangs
    // off, or `blocked-by:<self>` would answer with every card that has an edge.
    expect(evaluateNode(parseQuery(`blocked-by:${EDGE.reverseCardId}`).ast!, card)).toBe(false);
    expect(evaluateNode(parseQuery('blocked-by:e02593ea450619b793f7d610').ast!, card)).toBe(false);
  });

  test('blocks reads the same edge from the other end, on both identifiers', () => {
    const card = { name: 'a', links: [{ ...EDGE, isBefore: false }] };
    for (const id of [EDGE.cardId, EDGE.cardCommonId]) {
      expect(evaluateNode(parseQuery(`blocks:${id}`).ast!, card)).toBe(true);
      expect(evaluateNode(parseQuery(`blocked-by:${id}`).ast!, card)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Custom field queries
// ---------------------------------------------------------------------------

describe('parseQuery — customField: is refused, not parsed', () => {
  /**
   * Every spelling reaches the one refusal. The `in(` form matters on its own:
   * it returns from a branch ABOVE the operator parse, so it would otherwise
   * have escaped through `validateField` as an unknown field.
   */
  test.each([
    'customField:Priority=High',
    'customField:Estimate>5',
    'customField:Score>=80',
    'customField:Label~important',
    'customField:Impact<=3',
    'customField:noOperator',
    'customField in(High,Low)',
    'CUSTOMFIELD:Priority=High',
    // The PLURAL is the card's own key, and it was the refusal's one-letter
    // escape: it parsed, and `customFields~object` matched every card.
    'customFields:Status',
    'customFields~Todo',
    'customFields~object',
    'customFields in(a,b)',
    'status:todo AND customField:Priority=High',
  ])('refuses %s', (filter) => {
    expect(() => parseQuery(filter)).toThrow(ParseError);
    expect(() => parseQuery(filter)).toThrow(/'customField' \/ 'customFields' filters are refused/);
  });

  test('the refusal points at two commands that exist', () => {
    // `standup.ts:59` printing `favro unblocked` is the defect this repo
    // remembers; both of these are registered commands.
    expect(() => parseQuery('customField:Priority=High'))
      .toThrow(/favro custom-fields list <board>/);
    expect(() => parseQuery('customField:Priority=High'))
      .toThrow(/favro cards list <board> --include custom-fields/);
  });

  test('the refused spellings are struck from the "Known fields" list a typo prints', () => {
    // Otherwise the refusal for some other typo advertises a field that refuses.
    // `customfields` is in `CARD_FIELDS` and is a key on every card, so it
    // reaches the list from two directions.
    expect(() => parseQuery('statuz:done')).toThrow(/Known fields:/);
    expect(() => parseQuery('statuz:done')).not.toThrow(/customfield/);
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

describe('parseQuery — fails closed on the field list', () => {
  // These six replace the `warnings` assertions that stood here. Every one of
  // them asserted the bug: an unknown field was recorded in an array nothing in
  // `src/` ever read, and the query ran anyway.

  test('a known field parses', () => {
    expect(parseQuery('status:done').ast).toMatchObject({ kind: 'field', field: 'status' });
  });

  test('an unknown field REFUSES, naming the field and the whole known list', () => {
    expect(() => parseQuery('invalidfield:value')).toThrow(ParseError);
    try {
      parseQuery('invalidfield:value');
      throw new Error('expected a refusal');
    } catch (err) {
      const e = err as Error;
      // `toThrow(ParseError)` above matches by constructor NAME, so it is
      // satisfied by any error that happens to be called that. These pin the
      // class and the wording, which is what #140 left as the whole contract
      // once the unread `detail.kind`/`value`/`candidates` payload went.
      expect(e).toBeInstanceOf(ParseError);
      expect(e.name).toBe('ParseError');
      expect(e.message).toMatch(
        /^Unknown filter field 'invalidfield' at position 0 — refusing to run a query that cannot mean what you asked\. Known fields: /
      );
      // The candidate list is IN the prose — that is where it always had to be.
      expect(e.message).toContain('status');
      expect(e.message).toContain('title');

      // …and it is SORTED. `detail.candidates` carried the sorted array as a
      // machine-readable second copy; with that copy gone (#140) the prose is
      // the only place the ordering can be read, and nothing pinned it —
      // dropping the `.sort()` in `query-parser.ts` left 3161 tests green while
      // handing the user an unordered list to scan.
      const listed = e.message.replace(/^.*Known fields: /, '').replace(/\.$/, '').split(', ');
      expect(listed.length).toBeGreaterThan(10);
      expect(listed).toEqual([...listed].sort());
    }
  });

  test('the refusal names the OFFSET of the unknown field, not just position 0', () => {
    // The `detail.position` this replaces was only ever asserted on a query
    // whose bad field sat at offset 0, so hardcoding `position 0` in the prose
    // passed. A nested query is the only arm that can tell the two apart.
    try {
      parseQuery('status:done AND invalidfield:value');
      throw new Error('expected a refusal');
    } catch (err) {
      expect((err as Error).message).toContain(
        "Unknown filter field 'invalidfield' at position 16 —"
      );
    }
  });

  test('the fields the old VALID_FIELDS list kept alive are refused', () => {
    // On no card Favro sends: refusing them is the point of deriving the list.
    for (const dead of ['estimate:5', 'priority:high', 'created_by:john', 'relationship:blocks']) {
      expect(() => parseQuery(dead)).toThrow(/Unknown filter field/);
    }
  });

  test('the computed fields the old list would have refused are accepted', () => {
    for (const live of ['unblocked', 'blocked-by:CLA-1', 'blocks:CLA-1', 'due_in:7d']) {
      expect(() => parseQuery(live)).not.toThrow();
    }
  });

  test('a pass-through field Favro sends is accepted once a card carries it', () => {
    // Derived, not enumerated: nothing here names `position`.
    expect(() => parseQuery('position>0')).toThrow(ParseError);
    expect(() => parseQuery('position>0', { cards: [{ cardId: '1', position: 3 }] })).not.toThrow();
  });

  test('the Card floor still refuses a typo when zero cards came back', () => {
    expect(() => parseQuery('statuz:done', { cards: [] })).toThrow(/Unknown filter field/);
    expect(() => parseQuery('status:done', { cards: [] })).not.toThrow();
  });

  test('a status value is not validated against a global vocabulary', () => {
    // `status` is a column name and columns are board-specific. The board's real
    // columns settle it in `validateQueryValues`, not here.
    expect(() => parseQuery('status:whatever-this-board-calls-it')).not.toThrow();
  });

  test('DATE_KEYWORDS exports correct keywords', () => {
    expect(DATE_KEYWORDS).toContain('today');
    expect(DATE_KEYWORDS).toContain('tomorrow');
    expect(DATE_KEYWORDS).toContain('this-week');
    expect(DATE_KEYWORDS).toContain('overdue');
  });

  test('a bare quoted string REFUSES and points at the deliberate form', () => {
    expect(() => parseQuery('"bug fix"')).toThrow(ParseError);
    expect(() => parseQuery('"bug fix"')).toThrow(/title~"bug fix"/);
    // …which is accepted, and is the only free-text form.
    expect(parseQuery('title~"bug fix"').ast)
      .toMatchObject({ kind: 'field', field: 'title', operator: '~', value: 'bug fix' });
  });

  test('a date keyword on a non-date field is left to value validation', () => {
    // `status:today` is a column named "today" as far as parsing knows.
    expect(parseQuery('status:today').ast).toMatchObject({ field: 'status', value: 'today' });
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
    const q = parseQuery('estimate>5', { cards });
    const result = filterCards(q, cards);
    expect(result).toHaveLength(1);
    expect(result[0].cardId).toBe('2');
  });

  test('filters by estimate >= 5', () => {
    const q = parseQuery('estimate>=5', { cards });
    const result = filterCards(q, cards);
    expect(result.map(c => c.cardId).sort()).toEqual(['2', '3']);
  });

  test('filters by estimate <= 3', () => {
    const q = parseQuery('estimate<=3', { cards });
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

  /**
   * `due_date:overdue` and `due_date<today` are the SAME predicate, and both are
   * sensitive to which side of today a card falls on.
   *
   * The test this replaced parsed `due_date<today` against a fixture whose dates
   * straddle an uncontrollable "today" and asserted `Array.isArray(result)` — a
   * shape, which `() => []` and `() => cards` satisfy alike, so it could not
   * fail. Under it, `due_date:overdue` matched NOTHING on any board: `:` is `=`,
   * the keyword resolves to today, and the target is a local-midnight `Date` read
   * back through `toISOString()`, so it did not even match a card due today.
   *
   * Then it built its dates from `toISOString()` off the real clock, which named
   * the UTC day and made the answer depend on the hour the suite ran (#166): the
   * card called `today` was genuinely yesterday's, locally, after local midnight.
   * The clock is frozen here so the fixture and the filter cannot land on
   * opposite sides of local midnight, and every date below is built in the LOCAL
   * frame — the one the predicate compares in.
   *
   * The due instants are built at a local hour and serialised with
   * `toISOString()`, which is the measured wire shape (#132): a full ISO instant
   * whose time part encodes a local day boundary. Both hours that separate the
   * two frames are covered — local midnight falls on the previous UTC day east of
   * Greenwich, local 23:00 on the next UTC day west of it — so whichever side of
   * Greenwich this runs on, one of them is a day the old UTC truncation got
   * wrong. The ZONE cannot be pinned from inside a test: reassigning
   * `process.env.TZ` in a jest worker leaves `Date` on the zone the process
   * started with (measured — `new Date(iso).getHours()` is unchanged across the
   * assignment). Nor would pinning help under `TZ=UTC`, where the local and UTC
   * calendar days coincide and a 24-hour sweep was green against the unfixed
   * comparison: there is no defect there to catch. Measured against the unfixed
   * comparison, these arms are red — four of them — in Europe/London,
   * Europe/Stockholm, Asia/Kolkata, Pacific/Auckland, Pacific/Chatham,
   * America/Los_Angeles, America/Sao_Paulo and Pacific/Honolulu, and green in
   * UTC. The clock they run at is their own, so the hour of the run is not a
   * variable in any of them.
   */
  describe('overdue is a comparison, not a date', () => {
    const NOW = '2026-08-13T12:00:00.000Z';

    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(new Date(NOW));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    /** Four cards around today, one undated — the omit arm. */
    const dated = (localHour: number) => {
      const dueAt = (offsetDays: number): string => {
        const d = new Date();
        d.setDate(d.getDate() + offsetDays);
        d.setHours(localHour, 0, 0, 0);
        return d.toISOString();
      };
      return [
        { cardId: 'past', name: 'a', dueDate: dueAt(-3) },
        { cardId: 'today', name: 'b', dueDate: dueAt(0) },
        { cardId: 'future', name: 'c', dueDate: dueAt(3) },
        { cardId: 'none', name: 'd' },
      ];
    };

    const ids = (filter: string, cards: Record<string, any>[]): string[] =>
      filterCards(parseQuery(filter), cards).map(c => c.cardId);

    describe.each([[0], [23]])('for a card due at local %i:00', (localHour) => {
      test.each(['due_date:overdue', 'due_date<today'])('%s is past-due only', (filter) => {
        expect(ids(filter, dated(localHour))).toEqual(['past']);
      });

      test('the card due today is due today, by every spelling that says so', () => {
        const cards = dated(localHour);
        // `en-CA` is `YYYY-MM-DD` in the local zone — the day a user reads off
        // their own calendar, which is what they type as an absolute date.
        const localToday = new Date().toLocaleDateString('en-CA');
        expect(ids('due_date:today', cards)).toEqual(['today']);
        expect(ids('due_date<=today', cards)).toEqual(['past', 'today']);
        expect(ids('due_date>today', cards)).toEqual(['future']);
        expect(ids(`due_date:${localToday}`, cards)).toEqual(['today']);
        // `3d` lands the `future` card exactly on the window's far edge, which
        // is where `due_in`'s own bounds have to be in the same frame as the
        // card day: built from `toISOString()` off a local-midnight Date, the
        // edge named the day before and dropped the card sitting on it.
        expect(ids('due_in:3d', cards)).toEqual(['today', 'future']);
      });
    });

    test('the keyword carries `<`, so a typed `:` cannot make it mean "due today"', () => {
      const q = parseQuery('due_date:overdue');
      expect((q.ast as DatePredicate).operator).toBe('<');
      expect((q.ast as DatePredicate).dateValue.keyword).toBe('overdue');
    });

    test('every other date keyword keeps the operator the caller typed', () => {
      // The rewrite is scoped to `overdue`. `due_date:today` still means the
      // equality it reads as — the membership that follows is asserted per zone
      // above, where the clock and the frame are both pinned.
      expect((parseQuery('due_date:today').ast as DatePredicate).operator).toBe('=');
    });
  });
});

// ---------------------------------------------------------------------------
// 10. evaluateNode — direct coverage
// ---------------------------------------------------------------------------

describe('evaluateNode — direct evaluation', () => {
  const card = {
    cardId: '1',
    // A board instance, not a fork — `unblocked` refuses a card with no board.
    widgetCommonId: 'board-1',
    name: 'Fix bug',
    status: 'done',
    assignees: ['john', 'mary'],
    tags: ['urgent', 'backend'],
    estimate: 5,
    dueDate: '2099-12-31',
    createdAt: '2026-01-01',
    updatedAt: '2026-03-01',
    // The measured wire shape (#167): `{customFieldId, value}` — no `name`, and
    // a select's value is the option's ID. `customField:` is refused rather than
    // read; the paired-polarity arms over this shape live in
    // `custom-field-filter-wire.test.ts`, where the card enters via the wire.
    customFields: [
      { customFieldId: 'zxMLxD4zx4tSwJr75', value: ['YLanLiuXKA8JpvEsX'] },
    ],
    links: [
      // The measured edge shape, not an invented one (#162): a dependency
      // carries `cardId` and `cardCommonId`, and never a `cardSequentialId`.
      { isBefore: false, cardId: 'far-card-id', cardCommonId: 'far-common-id' },
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

  test('customField: refuses at parse time — nothing reaches evaluateNode', () => {
    // It used to build a predicate that read `f.name` off this card. The card
    // has no `name` key on the entry and holds an option id, so the predicate
    // returned false for a card that DOES carry the field.
    expect(() => parseQuery('customField:Status=Todo')).toThrow(ParseError);
  });

  test.each(['far-card-id', 'far-common-id'])('blocks: matches the outgoing edge by %s', (id) => {
    expect(evaluateNode(parseQuery(`blocks:${id}`).ast!, card)).toBe(true);
  });

  test('blocks: wrong target no match', () => {
    expect(evaluateNode(parseQuery('blocks:some-other-id').ast!, card)).toBe(false);
  });

  test('a card that only blocks is itself unblocked', () => {
    expect(evaluateNode(parseQuery('unblocked').ast!, card)).toBe(true);
    expect(evaluateNode(parseQuery('blocked-by:far-card-id').ast!, card)).toBe(false);
    expect(evaluateNode(parseQuery('blocked-by:far-common-id').ast!, card)).toBe(false);
  });

  test('reads dependencies when links has not been aliased', () => {
    const cardAlt = { ...card, links: undefined, dependencies: [{ isBefore: true, cardCommonId: 'abc' }] };
    expect(evaluateNode(parseQuery('blocked-by:abc').ast!, cardAlt)).toBe(true);
    expect(evaluateNode(parseQuery('unblocked').ast!, cardAlt)).toBe(false);
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
    const filter = 'title~"bug" OR (assignee:mary AND sequentialId>3)';
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

  test('a parsed query carries the AST and the raw string, and nothing else', () => {
    // `warnings` lived here. Nothing in src/ ever read it, so a degraded query
    // notified nobody — a refusal replaced it.
    expect(Object.keys(parseQuery('status:done')).sort()).toEqual(['ast', 'raw']);
  });

  test('parseQuery raw preserves original input', () => {
    const filter = 'status:done AND assignee:john';
    const q = parseQuery(filter);
    expect(q.raw).toBe(filter);
  });

  test('a derived field compares numerically', () => {
    const card = { name: 'test', estimate: 5 };
    const q = parseQuery('estimate:5', { cards: [card] });
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

  test('createdByUserId is read by the name Favro sends it under', () => {
    // `created_by` was an alias for a field no card has. The real one derives.
    const card = { name: 'test', createdByUserId: 'abc123' };
    expect(() => parseQuery('created_by:abc123')).toThrow(ParseError);
    const q = parseQuery('createdByUserId:abc123', { cards: [card] });
    expect(evaluateNode(q.ast!, card)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 12. Additional branch coverage
// ---------------------------------------------------------------------------

describe('parseQuery — additional branch coverage', () => {
  test('bare token without operator REFUSES the whole query', () => {
    // This asserted the headline bug: `bugfix` degraded into title~bugfix, the
    // rest of the query still ran, and the warning went into an array no
    // production code read.
    expect(() => parseQuery('status:done AND bugfix')).toThrow(ParseError);
    try {
      parseQuery('status:done AND bugfix');
      throw new Error('expected a refusal');
    } catch (err) {
      const e = err as Error;
      expect(e).toBeInstanceOf(ParseError);
      expect(e.name).toBe('ParseError');
      // Names the token, its position, and the spelling that WOULD have meant a
      // title search — the three things the deleted `detail` duplicated (#140).
      expect(e.message).toBe(
        `Unrecognised filter token 'bugfix' at position 16 — it names no field and carries no operator. ` +
          `Filters are field:value (see 'favro cards list --help'). For free text, say it: title~"bugfix".`
      );
    }
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

  test('resolveDateValue with unknown keyword should throw ParseError', () => {
    // Unknown keywords now throw ParseError instead of silently defaulting to today (DoS fix)
    expect(() => parseQuery('due_date:some-unknown-keyword')).toThrow();
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

  // FIX #4: Date math evaluation tests with real card objects
  test('filterCards with due_in:7d returns cards due within next 7 days', () => {
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const inThreeDays = new Date(today);
    inThreeDays.setDate(inThreeDays.getDate() + 3);
    const inTenDays = new Date(today);
    inTenDays.setDate(inTenDays.getDate() + 10);

    const cards = [
      { name: 'Soon', dueDate: tomorrow.toISOString().slice(0, 10) },
      { name: 'Soonish', dueDate: inThreeDays.toISOString().slice(0, 10) },
      { name: 'Far away', dueDate: inTenDays.toISOString().slice(0, 10) },
    ];

    const q = parseQuery('due_in:7d');
    const result = filterCards(q, cards);
    
    // Should include cards due within 7 days (tomorrow, in 3 days)
    expect(result.length).toBe(2);
    expect(result.map(c => c.name).sort()).toEqual(['Soon', 'Soonish']);
  });

  test('filterCards with due_in:1m returns cards due within next month', () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const nextWeek = new Date(today);
    nextWeek.setDate(nextWeek.getDate() + 7);
    const in25Days = new Date(today);
    in25Days.setDate(in25Days.getDate() + 25); // Well within 1 month
    const in60Days = new Date(today);
    in60Days.setDate(in60Days.getDate() + 60); // Beyond 1 month

    const cards = [
      { name: 'Next week', dueDate: nextWeek.toISOString().slice(0, 10) },
      { name: 'In 25 days', dueDate: in25Days.toISOString().slice(0, 10) },
      { name: 'In 60 days', dueDate: in60Days.toISOString().slice(0, 10) },
    ];

    const q = parseQuery('due_in:1m');
    const result = filterCards(q, cards);
    
    // Should include cards due within 1 month (30 days)
    expect(result.length).toBe(2);
    expect(result.map(c => c.name).sort()).toEqual(['In 25 days', 'Next week']);
  });

  test('filterCards with due_in:1y returns cards due within next year', () => {
    const today = new Date();
    const inSixMonths = new Date(today);
    inSixMonths.setMonth(inSixMonths.getMonth() + 6);
    const inThirteenMonths = new Date(today);
    inThirteenMonths.setMonth(inThirteenMonths.getMonth() + 13);

    const cards = [
      { name: 'Six months', dueDate: inSixMonths.toISOString().slice(0, 10) },
      { name: 'Thirteen months', dueDate: inThirteenMonths.toISOString().slice(0, 10) },
    ];

    const q = parseQuery('due_in:1y');
    const result = filterCards(q, cards);
    
    // Should include only card due within 1 year
    expect(result.length).toBe(1);
    expect(result[0].name).toBe('Six months');
  });


});
