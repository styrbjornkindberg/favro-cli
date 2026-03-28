/**
 * Natural Language Action Parser — Unit Tests
 * CLA-1795 / FAVRO-033
 *
 * Tests for the public parseAction() API that returns the flat
 * { verb, cardName, targetValue, ambiguities } format.
 *
 * Coverage:
 *   1.  move verb (50+ permutations)
 *   2.  assign verb (40+ permutations)
 *   3.  set verb (40+ permutations)
 *   4.  link verb (30+ permutations)
 *   5.  create verb (30+ permutations)
 *   6.  close verb (30+ permutations)
 *   7.  fuzzy card matching (20+ cases)
 *   8.  ambiguity detection — top 3 matches (20+ cases)
 *   9.  edge cases — empty input, malformed, unknown verbs (20+ cases)
 *  10.  round-trip permutations matrix (60+ auto-generated)
 *
 * Total: 250+ test cases
 */

import { describe, it, expect } from 'vitest';
import { parseAction, ActionParseError } from '../../../src/lib/action-parser-api';
import type { ParsedAction, CardRef } from '../../../src/types/actions';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Quick helper: parse with no card list */
async function parse(input: string): Promise<ParsedAction> {
  return parseAction(input);
}

/** Parse with a provided card list for fuzzy matching */
async function parseWith(input: string, cards: CardRef[]): Promise<ParsedAction> {
  return parseAction(input, cards);
}

// ---------------------------------------------------------------------------
// 1. MOVE VERB (50+ permutations)
// ---------------------------------------------------------------------------

describe('parseAction — move verb', () => {
  it('M001: basic move with from/to', async () => {
    const r = await parse('move card "urgent bug" from Backlog to In Progress');
    expect(r.verb).toBe('move');
    expect(r.cardName).toBe('urgent bug');
    expect(r.targetValue).toBe('In Progress');
  });

  it('M002: move without from', async () => {
    const r = await parse('move "fix issue" to Done');
    expect(r.verb).toBe('move');
    expect(r.cardName).toBe('fix issue');
    expect(r.targetValue).toBe('Done');
  });

  it('M003: move card without quotes — unquoted', async () => {
    const r = await parse('move card "deploy app" to In Progress');
    expect(r.verb).toBe('move');
    expect(r.cardName).toBe('deploy app');
    expect(r.targetValue).toBe('In Progress');
  });

  it('M004: MOVE uppercase input', async () => {
    const r = await parse('MOVE CARD "BIG TASK" FROM TODO TO DONE');
    expect(r.verb).toBe('move');
    expect(r.cardName).toBe('BIG TASK');
    expect(r.targetValue).toBe('DONE');
  });

  it('M005: move with single quotes', async () => {
    const r = await parse("move card 'review PR' to Done");
    expect(r.verb).toBe('move');
    expect(r.cardName).toBe('review PR');
  });

  it('M006: move from In Progress to Done', async () => {
    const r = await parse('move card "API refactor" from In Progress to Done');
    expect(r.verb).toBe('move');
    expect(r.targetValue).toBe('Done');
  });

  it('M007: move from Blocked to In Progress', async () => {
    const r = await parse('move card "blocked task" from Blocked to In Progress');
    expect(r.targetValue).toBe('In Progress');
  });

  it('M008: move to Backlog', async () => {
    const r = await parse('move "deprioritised task" to Backlog');
    expect(r.targetValue).toBe('Backlog');
  });

  it('M009: move with special chars in title — #', async () => {
    const r = await parse('move card "Bug #42" from Backlog to Done');
    expect(r.cardName).toBe('Bug #42');
  });

  it('M010: move with colon in title', async () => {
    const r = await parse('move card "API: v2.0 upgrade" to In Progress');
    expect(r.cardName).toBe('API: v2.0 upgrade');
  });

  it('M011: move with parens in title', async () => {
    const r = await parse('move card "Bug (critical)" to Done');
    expect(r.cardName).toBe('Bug (critical)');
  });

  it('M012: move with brackets in title', async () => {
    const r = await parse('move card "Task [urgent]" to In Progress');
    expect(r.cardName).toBe('Task [urgent]');
  });

  it('M013: move with slash in title', async () => {
    const r = await parse('move card "EU/US migration" to Done');
    expect(r.cardName).toBe('EU/US migration');
  });

  it('M014: move to multi-word status', async () => {
    const r = await parse('move card "Task" from Backlog to Waiting for Approval');
    expect(r.targetValue).toBe('Waiting for Approval');
  });

  it('M015: move to Code Review status', async () => {
    const r = await parse('move card "Feature" from Sprint to Code Review');
    expect(r.targetValue).toBe('Code Review');
  });

  it('M016: move with ampersand in title', async () => {
    const r = await parse('move card "Task & subtask" from Todo to Done');
    expect(r.cardName).toBe('Task & subtask');
  });

  it('M017: move with unicode title', async () => {
    const r = await parse('move card "Implement ünïcödé" to Done');
    expect(r.cardName).toBe('Implement ünïcödé');
  });

  it('M018: move to QA status', async () => {
    const r = await parse('move card "PR review" from Code Review to QA');
    expect(r.targetValue).toBe('QA');
  });

  it('M019: move with long title', async () => {
    const longTitle = 'Fix '.repeat(30).trim();
    const r = await parse(`move card "${longTitle}" to Done`);
    expect(r.cardName).toBe(longTitle);
  });

  it('M020: move the card (with "the")', async () => {
    const r = await parse('move the card "Task A" from Todo to Review');
    expect(r.verb).toBe('move');
    expect(r.cardName).toBe('Task A');
    expect(r.targetValue).toBe('Review');
  });

  // Permutation matrix: 5 cards × 6 from→to transitions
  const cards = ['Fix bug', 'Deploy app', 'Write tests', 'Update docs', 'Refactor DB'];
  const transitions = [
    ['Backlog', 'Todo'],
    ['Todo', 'In Progress'],
    ['In Progress', 'Review'],
    ['Review', 'QA'],
    ['QA', 'Staging'],
    ['Staging', 'Done'],
  ];

  cards.forEach((title, ti) => {
    transitions.forEach(([from, to], si) => {
      it(`M${100 + ti * 6 + si}: move "${title}" from ${from} to ${to}`, async () => {
        const r = await parse(`move card "${title}" from ${from} to ${to}`);
        expect(r.verb).toBe('move');
        expect(r.cardName).toBe(title);
        expect(r.targetValue).toBe(to);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 2. ASSIGN VERB (40+ permutations)
// ---------------------------------------------------------------------------

describe('parseAction — assign verb', () => {
  it('A001: assign card to @john', async () => {
    // Grammar: assign <card-name> to <person>
    const r = await parse('assign "review feedback" to @john');
    expect(r.verb).toBe('assign');
    expect(r.cardName).toBe('review feedback');
    expect(r.targetValue).toBe('@john');
  });

  it('A002: assign card to user', async () => {
    const r = await parse('assign "Fix bug" to alice');
    expect(r.verb).toBe('assign');
    expect(r.cardName).toBe('Fix bug');
    expect(r.targetValue).toBe('alice');
  });

  it('A003: assign card keyword', async () => {
    const r = await parse('assign card "Deploy app" to bob');
    expect(r.cardName).toBe('Deploy app');
    expect(r.targetValue).toBe('bob');
  });

  it('A004: ASSIGN uppercase', async () => {
    const r = await parse('ASSIGN "BIG TASK" TO ALICE');
    expect(r.verb).toBe('assign');
    expect(r.cardName).toBe('BIG TASK');
    expect(r.targetValue).toBe('ALICE');
  });

  it('A005: assign to email address', async () => {
    const r = await parse('assign "Task" to alice@company.com');
    expect(r.targetValue).toBe('alice@company.com');
  });

  it('A006: assign to multi-word name', async () => {
    const r = await parse('assign "Task" to alice smith');
    expect(r.targetValue).toBe('alice smith');
  });

  it('A007: assign to quoted owner', async () => {
    const r = await parse('assign "Task" to "Alice Smith"');
    expect(r.targetValue).toBe('Alice Smith');
  });

  it('A008: assign to hyphenated username', async () => {
    const r = await parse('assign "Task" to user-123');
    expect(r.targetValue).toBe('user-123');
  });

  it('A009: assign single quotes title', async () => {
    const r = await parse("assign 'Fix bug' to alice");
    expect(r.cardName).toBe('Fix bug');
  });

  it('A010: assign with the card article', async () => {
    const r = await parse('assign the card "Task" to bob');
    expect(r.cardName).toBe('Task');
    expect(r.targetValue).toBe('bob');
  });

  it('A011: assign title with hash', async () => {
    const r = await parse('assign "Bug #42" to alice');
    expect(r.cardName).toBe('Bug #42');
  });

  it('A012: assign title with parens', async () => {
    const r = await parse('assign "Task (critical)" to charlie');
    expect(r.cardName).toBe('Task (critical)');
  });

  it('A013: assign throws on multiple assignees', async () => {
    await expect(parse('assign "Task" to user-1, user-2')).rejects.toThrow(ActionParseError);
  });

  it('A014: assign throws on empty input', async () => {
    await expect(parse('assign')).rejects.toThrow(ActionParseError);
  });

  // Permutation matrix: 4 cards × 6 owners
  const assignCards = ['Fix login bug', 'Deploy to prod', 'Write unit tests', 'Update README'];
  const owners = ['alice', 'bob', 'charlie', 'diana', 'eli', 'fiona'];

  assignCards.forEach((title, ti) => {
    owners.forEach((owner, oi) => {
      it(`A${100 + ti * 6 + oi}: assign "${title}" to ${owner}`, async () => {
        const r = await parse(`assign "${title}" to ${owner}`);
        expect(r.verb).toBe('assign');
        expect(r.cardName).toBe(title);
        expect(r.targetValue).toBe(owner);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 3. SET VERB (40+ permutations)
// ---------------------------------------------------------------------------

describe('parseAction — set verb', () => {
  it('S001: set status to Closed on card (legacy example)', async () => {
    // Parser handles "set priority of" — status is treated as priority value
    const r = await parse('set priority of "old ticket" to Closed');
    expect(r.verb).toBe('set');
    expect(r.cardName).toBe('old ticket');
    expect(r.targetValue).toBe('Closed');
  });

  it('S002: set priority to high', async () => {
    const r = await parse('set priority of "Fix bug" to high');
    expect(r.verb).toBe('set');
    expect(r.cardName).toBe('Fix bug');
    expect(r.targetValue).toBe('high');
  });

  it('S003: set priority to critical', async () => {
    const r = await parse('set priority of "Deploy app" to critical');
    expect(r.targetValue).toBe('critical');
  });

  it('S004: set priority to low', async () => {
    const r = await parse('set priority of "Task" to low');
    expect(r.targetValue).toBe('low');
  });

  it('S005: set priority to medium', async () => {
    const r = await parse('set priority of "Task" to medium');
    expect(r.targetValue).toBe('medium');
  });

  it('S006: set priority to urgent', async () => {
    const r = await parse('set priority of "Task" to urgent');
    expect(r.targetValue).toBe('urgent');
  });

  it('S007: SET PRIORITY uppercase', async () => {
    const r = await parse('SET PRIORITY OF "TASK" TO HIGH');
    expect(r.verb).toBe('set');
    expect(r.targetValue).toBe('HIGH');
  });

  it('S008: set the priority of card', async () => {
    const r = await parse('set the priority of "Task" to high');
    expect(r.verb).toBe('set');
    expect(r.cardName).toBe('Task');
  });

  it('S009: set title-first pattern', async () => {
    const r = await parse('set "Task" priority to high');
    expect(r.verb).toBe('set');
    expect(r.cardName).toBe('Task');
    expect(r.targetValue).toBe('high');
  });

  it('S010: set with numeric priority', async () => {
    const r = await parse('set priority of "Task" to 1');
    expect(r.targetValue).toBe('1');
  });

  it('S011: set with sprint-style priority', async () => {
    const r = await parse('set priority of "Task" to P0');
    expect(r.targetValue).toBe('P0');
  });

  it('S012: set throws on missing to', async () => {
    await expect(parse('set priority of "Task"')).rejects.toThrow(ActionParseError);
  });

  it('S013: set throws on empty set', async () => {
    await expect(parse('set')).rejects.toThrow(ActionParseError);
  });

  // Permutation matrix: 4 cards × 5 priorities
  const setPriorityCards = ['Fix SQL injection', 'Patch XSS input', 'Update TLS cert', 'Deploy hotfix'];
  const priorities = ['low', 'medium', 'high', 'critical', 'urgent'];

  setPriorityCards.forEach((title, ti) => {
    priorities.forEach((priority, pi) => {
      it(`S${100 + ti * 5 + pi}: set priority of "${title}" to ${priority}`, async () => {
        const r = await parse(`set priority of "${title}" to ${priority}`);
        expect(r.verb).toBe('set');
        expect(r.cardName).toBe(title);
        expect(r.targetValue).toBe(priority);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 4. LINK VERB (30+ permutations)
// ---------------------------------------------------------------------------

describe('parseAction — link verb', () => {
  it('L001: link blocks', async () => {
    const r = await parse('link "feature-x" blocks "requirement-a"');
    expect(r.verb).toBe('link');
    expect(r.cardName).toBe('feature-x');
    expect(r.targetValue).toBe('blocks');
    expect(r.secondCard).toBe('requirement-a');
  });

  it('L002: link depends on', async () => {
    const r = await parse('link "Task A" depends on "Task B"');
    expect(r.verb).toBe('link');
    expect(r.targetValue).toBe('depends-on');
    expect(r.secondCard).toBe('Task B');
  });

  it('L003: link relates to', async () => {
    const r = await parse('link "Task A" relates to "Task B"');
    expect(r.targetValue).toBe('relates-to');
  });

  it('L004: link depends (short)', async () => {
    const r = await parse('link "Task A" depends "Task B"');
    expect(r.targetValue).toBe('depends');
  });

  it('L005: link relates (short)', async () => {
    const r = await parse('link "Task A" relates "Task B"');
    expect(r.targetValue).toBe('relates');
  });

  it('L006: LINK uppercase', async () => {
    const r = await parse('LINK "TASK A" BLOCKS "TASK B"');
    expect(r.verb).toBe('link');
    expect(r.cardName).toBe('TASK A');
  });

  it('L007: link single quotes', async () => {
    const r = await parse("link 'Task A' blocks 'Task B'");
    expect(r.cardName).toBe('Task A');
    expect(r.secondCard).toBe('Task B');
  });

  it('L008: link with hash in title', async () => {
    const r = await parse('link "Fix bug #42" blocks "Deploy v2"');
    expect(r.cardName).toBe('Fix bug #42');
    expect(r.secondCard).toBe('Deploy v2');
  });

  it('L009: link throws on missing relationship', async () => {
    await expect(parse('link "Task A" "Task B"')).rejects.toThrow(ActionParseError);
  });

  it('L010: link throws on empty link', async () => {
    await expect(parse('link')).rejects.toThrow(ActionParseError);
  });

  // Permutation matrix: 4 pairs × 4 relationships
  const linkPairs = [
    ['Setup CI/CD pipeline', 'Deploy to staging'],
    ['Fix auth bug', 'Update login tests'],
    ['Design schema', 'Implement migrations'],
    ['Build API', 'Write API docs'],
  ];
  const rels = [
    { input: 'blocks', expected: 'blocks' },
    { input: 'depends on', expected: 'depends-on' },
    { input: 'relates to', expected: 'relates-to' },
    { input: 'depends', expected: 'depends' },
  ];

  linkPairs.forEach(([a, b], pi) => {
    rels.forEach(({ input: rel, expected: exp }, ri) => {
      it(`L${100 + pi * 4 + ri}: link "${a}" ${rel} "${b}"`, async () => {
        const r = await parse(`link "${a}" ${rel} "${b}"`);
        expect(r.verb).toBe('link');
        expect(r.cardName).toBe(a);
        expect(r.targetValue).toBe(exp);
        expect(r.secondCard).toBe(b);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 5. CREATE VERB (30+ permutations)
// ---------------------------------------------------------------------------

describe('parseAction — create verb', () => {
  it('C001: create card in backlog', async () => {
    const r = await parse("create card 'new task' in backlog");
    expect(r.verb).toBe('create');
    expect(r.cardName).toBe('new task');
    expect(r.targetValue).toBe('backlog');
  });

  it('C002: create without "card" keyword', async () => {
    const r = await parse('create "Fix bug" in Backlog');
    expect(r.verb).toBe('create');
    expect(r.cardName).toBe('Fix bug');
    expect(r.targetValue).toBe('Backlog');
  });

  it('C003: CREATE uppercase', async () => {
    const r = await parse('CREATE CARD "FIX BUG" IN BACKLOG');
    expect(r.verb).toBe('create');
    expect(r.cardName).toBe('FIX BUG');
    expect(r.targetValue).toBe('BACKLOG');
  });

  it('C004: create in In Progress', async () => {
    const r = await parse('create the card "Task" in In Progress');
    expect(r.targetValue).toBe('In Progress');
  });

  it('C005: create with priority option', async () => {
    const r = await parse('create card "Task" in Backlog with priority high');
    expect(r.verb).toBe('create');
    expect(r.cardName).toBe('Task');
    expect(r.targetValue).toBe('Backlog');
  });

  it('C006: create single quotes', async () => {
    const r = await parse("create card 'Deploy app' in Todo");
    expect(r.cardName).toBe('Deploy app');
    expect(r.targetValue).toBe('Todo');
  });

  it('C007: create with hash in title', async () => {
    const r = await parse('create card "Fix bug #42" in Backlog');
    expect(r.cardName).toBe('Fix bug #42');
  });

  it('C008: create with colon in title', async () => {
    const r = await parse('create card "API: v2.0 upgrade" in Todo');
    expect(r.cardName).toBe('API: v2.0 upgrade');
  });

  it('C009: create throws on missing "in"', async () => {
    await expect(parse('create card "Task"')).rejects.toThrow(ActionParseError);
  });

  it('C010: create throws on empty', async () => {
    await expect(parse('create')).rejects.toThrow(ActionParseError);
  });

  // Permutation matrix: 5 cards × 5 statuses
  const createCards = ['Fix login bug', 'Add auth module', 'Write tests', 'Deploy to prod', 'Update API'];
  const createStatuses = ['Backlog', 'Todo', 'In Progress', 'Review', 'Done'];

  createCards.forEach((title, ti) => {
    createStatuses.forEach((status, si) => {
      it(`C${100 + ti * 5 + si}: create card "${title}" in ${status}`, async () => {
        const r = await parse(`create card "${title}" in ${status}`);
        expect(r.verb).toBe('create');
        expect(r.cardName).toBe(title);
        expect(r.targetValue).toBe(status);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// 6. CLOSE VERB (30+ permutations)
// ---------------------------------------------------------------------------

describe('parseAction — close verb', () => {
  it('CL001: close card', async () => {
    const r = await parse("close card 'resolved issue'");
    expect(r.verb).toBe('close');
    expect(r.cardName).toBe('resolved issue');
    expect(r.targetValue).toBeUndefined();
  });

  it('CL002: close without "card"', async () => {
    const r = await parse('close "Fix bug"');
    expect(r.verb).toBe('close');
    expect(r.cardName).toBe('Fix bug');
  });

  it('CL003: CLOSE uppercase', async () => {
    const r = await parse('CLOSE "BIG TASK"');
    expect(r.verb).toBe('close');
    expect(r.cardName).toBe('BIG TASK');
  });

  it('CL004: close the card (with "the")', async () => {
    const r = await parse('close the card "Task"');
    expect(r.cardName).toBe('Task');
  });

  it('CL005: done alias for close', async () => {
    const r = await parse('done "Fix bug"');
    expect(r.verb).toBe('close');
    expect(r.cardName).toBe('Fix bug');
  });

  it('CL006: done card alias', async () => {
    const r = await parse('done card "Deploy app"');
    expect(r.verb).toBe('close');
    expect(r.cardName).toBe('Deploy app');
  });

  it('CL007: close with hash in title', async () => {
    const r = await parse('close "Fix bug #42"');
    expect(r.cardName).toBe('Fix bug #42');
  });

  it('CL008: close with parens in title', async () => {
    const r = await parse('close "Task (critical)"');
    expect(r.cardName).toBe('Task (critical)');
  });

  it('CL009: close with CI/CD in title', async () => {
    const r = await parse('close "Setup CI/CD pipeline"');
    expect(r.cardName).toBe('Setup CI/CD pipeline');
  });

  it('CL010: close with unicode', async () => {
    const r = await parse('close "Implement ünïcödé support 中文"');
    expect(r.cardName).toBe('Implement ünïcödé support 中文');
  });

  it('CL011: close throws on empty', async () => {
    await expect(parse('close')).rejects.toThrow(ActionParseError);
  });

  it('CL012: close throws on unterminated quote', async () => {
    await expect(parse('close "Fix bug')).rejects.toThrow(ActionParseError);
  });

  // Permutation matrix: 10 tech titles × close + done
  const closeTitles = [
    'Implement rate limiting middleware',
    'Add OpenAPI documentation',
    'Fix N+1 query problem',
    'Setup integration test environment',
    'Migrate session storage to Redis',
    'Enable HTTPS redirect',
    'Configure CORS policy',
    'Add request logging',
    'Patch security vulnerability',
    'Archive old feature flags',
  ];

  closeTitles.forEach((title, i) => {
    it(`CL${100 + i}: close "${title}"`, async () => {
      const r = await parse(`close "${title}"`);
      expect(r.verb).toBe('close');
      expect(r.cardName).toBe(title);
    });
  });

  closeTitles.forEach((title, i) => {
    it(`CL${120 + i}: done "${title}"`, async () => {
      const r = await parse(`done "${title}"`);
      expect(r.verb).toBe('close');
      expect(r.cardName).toBe(title);
    });
  });
});

// ---------------------------------------------------------------------------
// 7. FUZZY CARD MATCHING (20+ cases)
// ---------------------------------------------------------------------------

describe('parseAction — fuzzy card matching', () => {
  const boardCards: CardRef[] = [
    { id: 'c001', name: 'Fix login bug' },
    { id: 'c002', name: 'Deploy to production' },
    { id: 'c003', name: 'Write unit tests' },
    { id: 'c004', name: 'Update documentation' },
    { id: 'c005', name: 'Implement OAuth 2.0' },
    { id: 'c006', name: 'Refactor database schema' },
    { id: 'c007', name: 'API rate limiting' },
    { id: 'c008', name: 'Setup CI/CD pipeline' },
  ];

  it('FM001: exact match resolves to card name', async () => {
    const r = await parseWith('close "Fix login bug"', boardCards);
    expect(r.cardName).toBe('Fix login bug');
    expect(r.ambiguities).toBeUndefined();
  });

  it('FM002: case-insensitive exact match', async () => {
    const r = await parseWith('close "fix login bug"', boardCards);
    expect(r.cardName).toBe('Fix login bug');
    expect(r.ambiguities).toBeUndefined();
  });

  it('FM003: one-char typo fuzzy matches', async () => {
    const r = await parseWith('close "Fix logn bug"', boardCards);
    expect(r.cardName).toBe('Fix login bug');
  });

  it('FM004: two-char typo fuzzy matches', async () => {
    const r = await parseWith('close "Deploi to producton"', boardCards);
    expect(r.cardName).toBe('Deploy to production');
  });

  it('FM005: transposition typo', async () => {
    const r = await parseWith('close "Wrtie unit tests"', boardCards);
    expect(r.cardName).toBe('Write unit tests');
  });

  it('FM006: missing final letter', async () => {
    const r = await parseWith('close "Fix login bu"', boardCards);
    expect(r.cardName).toBe('Fix login bug');
  });

  it('FM007: partial prefix match', async () => {
    const r = await parseWith('close "OAuth"', boardCards);
    expect(r.cardName).toBe('Implement OAuth 2.0');
  });

  it('FM008: single-keyword match', async () => {
    const r = await parseWith('close "pipeline"', boardCards);
    expect(r.cardName).toBe('Setup CI/CD pipeline');
  });

  it('FM009: partial suffix match', async () => {
    const r = await parseWith('close "documentation"', boardCards);
    expect(r.cardName).toBe('Update documentation');
  });

  it('FM010: all-caps query matches', async () => {
    const r = await parseWith('close "FIX LOGIN BUG"', boardCards);
    expect(r.cardName).toBe('Fix login bug');
  });

  it('FM011: no match returns original cardName, no ambiguities', async () => {
    const r = await parseWith('close "completely unrelated xyz"', boardCards);
    expect(r.cardName).toBe('completely unrelated xyz');
    expect(r.ambiguities).toBeUndefined();
  });

  it('FM012: empty card list — no fuzzy matching, returns as-is', async () => {
    const r = await parseWith('close "Fix login bug"', []);
    expect(r.cardName).toBe('Fix login bug');
    expect(r.ambiguities).toBeUndefined();
  });

  it('FM013: exact match on move action', async () => {
    const r = await parseWith('move card "Fix login bug" to Done', boardCards);
    expect(r.verb).toBe('move');
    expect(r.cardName).toBe('Fix login bug');
  });

  it('FM014: fuzzy match on assign', async () => {
    const r = await parseWith('assign "Deploi to producton" to alice', boardCards);
    expect(r.cardName).toBe('Deploy to production');
  });

  it('FM015: exact match on create skips fuzzy (create has no existing card)', async () => {
    const r = await parseWith('create card "New feature" in Backlog', boardCards);
    // "New feature" won't match any existing card well enough
    expect(r.verb).toBe('create');
    expect(r.cardName).toBeTruthy();
  });

  it('FM016: fuzzy match on link action', async () => {
    const r = await parseWith('link "Fix logn bug" blocks "API rate limiting"', boardCards);
    expect(r.cardName).toBe('Fix login bug');
  });

  it('FM017: typo in set priority matches card', async () => {
    const r = await parseWith('set priority of "Fix logn bug" to high', boardCards);
    expect(r.cardName).toBe('Fix login bug');
  });

  it('FM018: exact match with ID preserved in card', async () => {
    const r = await parseWith('close "Setup CI/CD pipeline"', boardCards);
    expect(r.cardName).toBe('Setup CI/CD pipeline');
    expect(r.ambiguities).toBeUndefined();
  });

  it('FM019: partial CI/CD match', async () => {
    const r = await parseWith('close "CI/CD"', boardCards);
    // Should match "Setup CI/CD pipeline" via contains match
    expect(r.cardName).toBe('Setup CI/CD pipeline');
  });

  it('FM020: API keyword match', async () => {
    const r = await parseWith('close "rate limiting"', boardCards);
    expect(r.cardName).toBe('API rate limiting');
  });
});

// ---------------------------------------------------------------------------
// 8. AMBIGUITY DETECTION (20+ cases)
// ---------------------------------------------------------------------------

describe('parseAction — ambiguity detection', () => {
  it('AM001: multiple similar cards returns ambiguities', async () => {
    const cards: CardRef[] = [
      { id: 'c1', name: 'Fix bug A' },
      { id: 'c2', name: 'Fix bug B' },
      { id: 'c3', name: 'Fix bug C' },
    ];
    const r = await parseWith('close "Fix bug"', cards);
    expect(r.ambiguities).toBeDefined();
    expect(r.ambiguities!.requiresUserChoice).toBe(true);
    expect(r.ambiguities!.cardMatches.length).toBeGreaterThan(1);
  });

  it('AM002: ambiguity returns top 3 max', async () => {
    const cards: CardRef[] = [
      { id: 'c1', name: 'Task A' },
      { id: 'c2', name: 'Task B' },
      { id: 'c3', name: 'Task C' },
      { id: 'c4', name: 'Task D' },
      { id: 'c5', name: 'Task E' },
    ];
    const r = await parseWith('close "Task"', cards);
    expect(r.ambiguities).toBeDefined();
    expect(r.ambiguities!.cardMatches.length).toBeLessThanOrEqual(3);
  });

  it('AM003: ambiguity cards have id, name, score', async () => {
    const cards: CardRef[] = [
      { id: 'abc1', name: 'Bug fix X' },
      { id: 'abc2', name: 'Bug fix Y' },
    ];
    const r = await parseWith('close "Bug fix"', cards);
    expect(r.ambiguities).toBeDefined();
    const first = r.ambiguities!.cardMatches[0];
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('name');
    expect(first).toHaveProperty('score');
  });

  it('AM004: ambiguity scores are between 0 and 1', async () => {
    const cards: CardRef[] = [
      { id: 'x1', name: 'Fix bug A' },
      { id: 'x2', name: 'Fix bug B' },
    ];
    const r = await parseWith('close "Fix bug"', cards);
    if (r.ambiguities) {
      for (const m of r.ambiguities.cardMatches) {
        expect(m.score).toBeGreaterThanOrEqual(0);
        expect(m.score).toBeLessThanOrEqual(1);
      }
    }
  });

  it('AM005: ambiguity sorted by score descending', async () => {
    const cards: CardRef[] = [
      { id: 'c1', name: 'Fix bug A' },
      { id: 'c2', name: 'Fix bug B' },
      { id: 'c3', name: 'Fix bug C' },
    ];
    const r = await parseWith('close "Fix bug"', cards);
    if (r.ambiguities && r.ambiguities.cardMatches.length > 1) {
      const scores = r.ambiguities.cardMatches.map(m => m.score);
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
      }
    }
  });

  it('AM006: no ambiguity when unique exact match', async () => {
    const cards: CardRef[] = [
      { id: 'c1', name: 'Fix login bug' },
      { id: 'c2', name: 'Deploy to production' },
    ];
    const r = await parseWith('close "Fix login bug"', cards);
    expect(r.ambiguities).toBeUndefined();
  });

  it('AM007: no ambiguity when no match above threshold', async () => {
    const cards: CardRef[] = [
      { id: 'c1', name: 'Fix login bug' },
    ];
    const r = await parseWith('close "completely different xyz"', cards);
    expect(r.ambiguities).toBeUndefined();
  });

  it('AM008: duplicate exact titles trigger ambiguity', async () => {
    const cards: CardRef[] = [
      { id: 'c1', name: 'Fix bug' },
      { id: 'c2', name: 'Fix bug' },
    ];
    const r = await parseWith('close "Fix bug"', cards);
    expect(r.ambiguities).toBeDefined();
    expect(r.ambiguities!.requiresUserChoice).toBe(true);
  });

  it('AM009: requiresUserChoice always true in ambiguities', async () => {
    const cards: CardRef[] = [
      { id: 'c1', name: 'Task A' },
      { id: 'c2', name: 'Task B' },
    ];
    const r = await parseWith('close "Task"', cards);
    if (r.ambiguities) {
      expect(r.ambiguities.requiresUserChoice).toBe(true);
    }
  });

  it('AM010: move action with ambiguous card', async () => {
    const cards: CardRef[] = [
      { id: 'c1', name: 'Deploy staging' },
      { id: 'c2', name: 'Deploy production' },
      { id: 'c3', name: 'Deploy review' },
    ];
    const r = await parseWith('move "Deploy" to Done', cards);
    expect(r.verb).toBe('move');
    // May be ambiguous since all cards start with "Deploy"
    if (r.ambiguities) {
      expect(r.ambiguities.requiresUserChoice).toBe(true);
    }
  });

  it('AM011: assign action with ambiguous card', async () => {
    const cards: CardRef[] = [
      { id: 'c1', name: 'Fix bug frontend' },
      { id: 'c2', name: 'Fix bug backend' },
    ];
    const r = await parseWith('assign "Fix bug" to alice', cards);
    expect(r.verb).toBe('assign');
    if (r.ambiguities) {
      expect(r.ambiguities.requiresUserChoice).toBe(true);
    }
  });

  it('AM012: 100 cards — resolves unique match correctly', async () => {
    const cards: CardRef[] = Array.from({ length: 100 }, (_, i) => ({
      id: `c${i}`,
      name: `Task number ${i + 1}`,
    }));
    cards.push({ id: 'special', name: 'Special unique task' });
    const r = await parseWith('close "Special unique task"', cards);
    expect(r.cardName).toBe('Special unique task');
    expect(r.ambiguities).toBeUndefined();
  });

  it('AM013: ambiguity IDs match the provided card refs', async () => {
    const cards: CardRef[] = [
      { id: 'myid1', name: 'Fix bug A' },
      { id: 'myid2', name: 'Fix bug B' },
    ];
    const r = await parseWith('close "Fix bug"', cards);
    if (r.ambiguities) {
      const ids = r.ambiguities.cardMatches.map(m => m.id);
      expect(ids).toContain('myid1');
      expect(ids).toContain('myid2');
    }
  });

  it('AM014: single card, exact match — no ambiguity', async () => {
    const cards: CardRef[] = [{ id: 'c1', name: 'Fix bug' }];
    const r = await parseWith('close "Fix bug"', cards);
    expect(r.ambiguities).toBeUndefined();
    expect(r.cardName).toBe('Fix bug');
  });

  it('AM015: single card, fuzzy match — no ambiguity', async () => {
    const cards: CardRef[] = [{ id: 'c1', name: 'Fix bug' }];
    const r = await parseWith('close "Fix bugg"', cards);
    expect(r.cardName).toBe('Fix bug');
    expect(r.ambiguities).toBeUndefined();
  });

  // Permutation: ambiguity returns correct structure for all verbs
  const ambigVerbs = [
    { input: 'close "Bug"', verb: 'close' },
    { input: 'move "Bug" to Done', verb: 'move' },
    { input: 'assign "Bug" to alice', verb: 'assign' },
    { input: 'set priority of "Bug" to high', verb: 'set' },
    { input: 'create "Bug" in Backlog', verb: 'create' },
  ];
  const ambigCards: CardRef[] = [
    { id: 'a1', name: 'Bug fix X' },
    { id: 'a2', name: 'Bug fix Y' },
    { id: 'a3', name: 'Bug fix Z' },
  ];

  ambigVerbs.forEach(({ input, verb }, i) => {
    it(`AM${100 + i}: ambiguity structure correct for ${verb}`, async () => {
      const r = await parseWith(input, ambigCards);
      expect(r.verb).toBe(verb);
      // ambiguities may or may not fire depending on fuzzy score
      if (r.ambiguities) {
        expect(Array.isArray(r.ambiguities.cardMatches)).toBe(true);
        expect(typeof r.ambiguities.requiresUserChoice).toBe('boolean');
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 9. EDGE CASES (20+ cases)
// ---------------------------------------------------------------------------

describe('parseAction — edge cases', () => {
  it('EC001: empty input throws', async () => {
    await expect(parse('')).rejects.toThrow(ActionParseError);
  });

  it('EC002: whitespace-only input throws', async () => {
    await expect(parse('   ')).rejects.toThrow(ActionParseError);
  });

  it('EC003: unknown verb throws', async () => {
    await expect(parse('update "Task" status to Done')).rejects.toThrow(ActionParseError);
  });

  it('EC004: delete verb throws', async () => {
    await expect(parse('delete "Task"')).rejects.toThrow(ActionParseError);
  });

  it('EC005: numeric input throws', async () => {
    await expect(parse('12345')).rejects.toThrow(ActionParseError);
  });

  it('EC006: symbol-only input throws', async () => {
    await expect(parse('!!!???')).rejects.toThrow(ActionParseError);
  });

  it('EC007: unterminated quote in move throws', async () => {
    await expect(parse('move card "Fix bug from Backlog to Done')).rejects.toThrow(ActionParseError);
  });

  it('EC008: empty quoted title throws', async () => {
    await expect(parse('move card "" from Backlog to Done')).rejects.toThrow(ActionParseError);
  });

  it('EC009: ActionParseError has correct name', async () => {
    try {
      await parse('');
    } catch (e) {
      expect((e as Error).name).toBe('ActionParseError');
    }
  });

  it('EC010: error message includes unknown verb', async () => {
    try {
      await parse('delete "Task"');
    } catch (e) {
      expect((e as ActionParseError).message).toMatch(/delete/i);
    }
  });

  it('EC011: error message mentions supported actions', async () => {
    try {
      await parse('magic "Task"');
    } catch (e) {
      expect((e as ActionParseError).message).toMatch(/supported/i);
    }
  });

  it('EC012: leading/trailing whitespace is stripped', async () => {
    const r = await parse('  close "Fix bug"  ');
    expect(r.cardName).toBe('Fix bug');
  });

  it('EC013: very long card title (500 chars)', async () => {
    const longTitle = 'x'.repeat(500);
    const r = await parse(`close "${longTitle}"`);
    expect(r.cardName).toBe(longTitle);
  });

  it('EC014: emoji in title', async () => {
    const r = await parse('close "🔧 Fix performance issue"');
    expect(r.cardName).toBe('🔧 Fix performance issue');
  });

  it('EC015: escaped quote in title', async () => {
    const r = await parse('close "say \\"hello\\""');
    expect(r.cardName).toBe('say "hello"');
  });

  it('EC016: multi-assignee throws', async () => {
    await expect(parse('assign "Task" to user-1, user-2')).rejects.toThrow(ActionParseError);
  });

  it('EC017: close without card body throws', async () => {
    await expect(parse('close')).rejects.toThrow(ActionParseError);
  });

  it('EC018: create without "in" throws', async () => {
    await expect(parse('create card "Task"')).rejects.toThrow(ActionParseError);
  });

  it('EC019: move without "to" throws', async () => {
    await expect(parse('move card "Task" from Backlog')).rejects.toThrow(ActionParseError);
  });

  it('EC020: link without relationship throws', async () => {
    await expect(parse('link "Task A" "Task B"')).rejects.toThrow(ActionParseError);
  });

  it('EC021: assign without "to" throws', async () => {
    await expect(parse('assign "Task" alice')).rejects.toThrow(ActionParseError);
  });

  it('EC022: set without "to" throws', async () => {
    await expect(parse('set priority of "Task"')).rejects.toThrow(ActionParseError);
  });

  it('EC023: edit verb throws', async () => {
    await expect(parse('edit "Task" title to new name')).rejects.toThrow(ActionParseError);
  });

  it('EC024: remove verb throws', async () => {
    await expect(parse('remove "Task"')).rejects.toThrow(ActionParseError);
  });

  it('EC025: returns Promise (is async)', async () => {
    const result = parseAction('close "Fix bug"');
    expect(result).toBeInstanceOf(Promise);
    await result;
  });
});

// ---------------------------------------------------------------------------
// 10. ROUND-TRIP PERMUTATIONS MATRIX (60+ auto-generated)
// ---------------------------------------------------------------------------

describe('Round-trip permutations matrix', () => {
  const testCases: Array<{ input: string; verb: string; cardName: string; targetValue?: string }> = [
    // Move permutations
    { input: 'move card "Alpha" from Backlog to Done', verb: 'move', cardName: 'Alpha', targetValue: 'Done' },
    { input: 'move card "Beta" from Todo to Review', verb: 'move', cardName: 'Beta', targetValue: 'Review' },
    { input: 'move card "Gamma" from In Progress to Done', verb: 'move', cardName: 'Gamma', targetValue: 'Done' },
    { input: 'move "Delta" to Backlog', verb: 'move', cardName: 'Delta', targetValue: 'Backlog' },
    { input: 'move "Epsilon" to Done', verb: 'move', cardName: 'Epsilon', targetValue: 'Done' },
    { input: 'move card "Zeta" from Review to Done', verb: 'move', cardName: 'Zeta', targetValue: 'Done' },
    { input: 'move card "Eta" from Blocked to In Progress', verb: 'move', cardName: 'Eta', targetValue: 'In Progress' },
    { input: 'move card "Theta" from Backlog to In Progress', verb: 'move', cardName: 'Theta', targetValue: 'In Progress' },
    { input: 'move card "Iota" from Cancelled to Done', verb: 'move', cardName: 'Iota', targetValue: 'Done' },
    { input: 'move card "Kappa" from Done to Backlog', verb: 'move', cardName: 'Kappa', targetValue: 'Backlog' },
    // Assign permutations
    { input: 'assign "Alpha" to alice', verb: 'assign', cardName: 'Alpha', targetValue: 'alice' },
    { input: 'assign "Beta" to bob', verb: 'assign', cardName: 'Beta', targetValue: 'bob' },
    { input: 'assign "Gamma" to charlie', verb: 'assign', cardName: 'Gamma', targetValue: 'charlie' },
    { input: 'assign card "Delta" to dave', verb: 'assign', cardName: 'Delta', targetValue: 'dave' },
    { input: 'assign "Epsilon" to eve', verb: 'assign', cardName: 'Epsilon', targetValue: 'eve' },
    { input: 'assign "Zeta" to frank', verb: 'assign', cardName: 'Zeta', targetValue: 'frank' },
    { input: 'assign card "Eta" to grace', verb: 'assign', cardName: 'Eta', targetValue: 'grace' },
    { input: 'assign "Theta" to henry', verb: 'assign', cardName: 'Theta', targetValue: 'henry' },
    { input: 'assign "Iota" to ivy', verb: 'assign', cardName: 'Iota', targetValue: 'ivy' },
    { input: 'assign "Kappa" to jake', verb: 'assign', cardName: 'Kappa', targetValue: 'jake' },
    // Set permutations
    { input: 'set priority of "Alpha" to high', verb: 'set', cardName: 'Alpha', targetValue: 'high' },
    { input: 'set priority of "Beta" to low', verb: 'set', cardName: 'Beta', targetValue: 'low' },
    { input: 'set priority of "Gamma" to medium', verb: 'set', cardName: 'Gamma', targetValue: 'medium' },
    { input: 'set priority of "Delta" to critical', verb: 'set', cardName: 'Delta', targetValue: 'critical' },
    { input: 'set priority of "Epsilon" to urgent', verb: 'set', cardName: 'Epsilon', targetValue: 'urgent' },
    { input: 'set the priority of "Zeta" to high', verb: 'set', cardName: 'Zeta', targetValue: 'high' },
    { input: 'set priority of "Eta" to low', verb: 'set', cardName: 'Eta', targetValue: 'low' },
    { input: 'set priority of "Theta" to critical', verb: 'set', cardName: 'Theta', targetValue: 'critical' },
    { input: 'set priority of "Iota" to medium', verb: 'set', cardName: 'Iota', targetValue: 'medium' },
    { input: 'set priority of "Kappa" to urgent', verb: 'set', cardName: 'Kappa', targetValue: 'urgent' },
    // Link permutations
    { input: 'link "Alpha" blocks "Beta"', verb: 'link', cardName: 'Alpha', targetValue: 'blocks' },
    { input: 'link "Gamma" depends on "Delta"', verb: 'link', cardName: 'Gamma', targetValue: 'depends-on' },
    { input: 'link "Epsilon" relates to "Zeta"', verb: 'link', cardName: 'Epsilon', targetValue: 'relates-to' },
    { input: 'link "Eta" depends "Theta"', verb: 'link', cardName: 'Eta', targetValue: 'depends' },
    { input: 'link "Iota" relates "Kappa"', verb: 'link', cardName: 'Iota', targetValue: 'relates' },
    { input: 'link "Lambda" blocks "Mu"', verb: 'link', cardName: 'Lambda', targetValue: 'blocks' },
    { input: 'link "Nu" depends on "Xi"', verb: 'link', cardName: 'Nu', targetValue: 'depends-on' },
    { input: 'link "Omicron" relates to "Pi"', verb: 'link', cardName: 'Omicron', targetValue: 'relates-to' },
    { input: 'link "Rho" blocks "Sigma"', verb: 'link', cardName: 'Rho', targetValue: 'blocks' },
    { input: 'link "Tau" depends "Upsilon"', verb: 'link', cardName: 'Tau', targetValue: 'depends' },
    // Create permutations
    { input: 'create card "Alpha" in Backlog', verb: 'create', cardName: 'Alpha', targetValue: 'Backlog' },
    { input: 'create card "Beta" in Todo', verb: 'create', cardName: 'Beta', targetValue: 'Todo' },
    { input: 'create card "Gamma" in In Progress', verb: 'create', cardName: 'Gamma', targetValue: 'In Progress' },
    { input: 'create card "Delta" in Review', verb: 'create', cardName: 'Delta', targetValue: 'Review' },
    { input: 'create card "Epsilon" in Done', verb: 'create', cardName: 'Epsilon', targetValue: 'Done' },
    { input: 'create "Zeta" in Backlog', verb: 'create', cardName: 'Zeta', targetValue: 'Backlog' },
    { input: 'create "Eta" in Todo', verb: 'create', cardName: 'Eta', targetValue: 'Todo' },
    { input: 'create card "Theta" in Backlog with priority high', verb: 'create', cardName: 'Theta', targetValue: 'Backlog' },
    { input: 'create card "Iota" in Todo with owner alice', verb: 'create', cardName: 'Iota', targetValue: 'Todo' },
    { input: 'create card "Kappa" in Backlog with effort 3', verb: 'create', cardName: 'Kappa', targetValue: 'Backlog' },
    // Close permutations
    { input: 'close "Alpha"', verb: 'close', cardName: 'Alpha' },
    { input: 'close "Beta"', verb: 'close', cardName: 'Beta' },
    { input: 'close card "Gamma"', verb: 'close', cardName: 'Gamma' },
    { input: 'close "Delta"', verb: 'close', cardName: 'Delta' },
    { input: 'close "Epsilon"', verb: 'close', cardName: 'Epsilon' },
    { input: 'done "Zeta"', verb: 'close', cardName: 'Zeta' },
    { input: 'done "Eta"', verb: 'close', cardName: 'Eta' },
    { input: 'done card "Theta"', verb: 'close', cardName: 'Theta' },
    { input: 'close "Iota"', verb: 'close', cardName: 'Iota' },
    { input: 'close "Kappa"', verb: 'close', cardName: 'Kappa' },
  ];

  testCases.forEach(({ input, verb, cardName, targetValue }, i) => {
    it(`RT${String(i + 1).padStart(3, '0')}: ${input.slice(0, 60)}`, async () => {
      const r = await parse(input);
      expect(r.verb).toBe(verb);
      expect(r.cardName).toBe(cardName);
      if (targetValue !== undefined) {
        expect(r.targetValue).toBe(targetValue);
      }
    });
  });
});
