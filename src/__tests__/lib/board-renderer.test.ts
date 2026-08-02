/**
 * Tests for lib/board-renderer.ts — Kanban board rendering
 */
import { renderBoard, renderCardList, renderStatusBar, snapshotToColumns, RenderColumn, RenderCard } from '../../lib/board-renderer';
import { ContextCard } from '../../api/context';
import { stripAnsi } from '../../lib/theme';

const sampleCards: RenderCard[] = [
  { id: 'card-1', title: 'Fix login bug', assignee: 'alice', status: 'In Progress', tags: ['bug'] },
  { id: 'card-2', title: 'Add dark mode', assignee: 'bob', status: 'Todo' },
  { id: 'card-3', title: 'Deploy v2', status: 'Done' },
  { id: 'card-4', title: 'Blocked feature', status: 'Blocked', blocked: true },
];

const sampleColumns: RenderColumn[] = [
  { name: 'Todo', cards: [sampleCards[1]] },
  { name: 'In Progress', cards: [sampleCards[0]] },
  { name: 'Done', cards: [sampleCards[2]] },
];

describe('board-renderer', () => {
  // ─── renderBoard ──────────────────────────────────────

  describe('renderBoard', () => {
    test('renders columns side by side', () => {
      const output = renderBoard(sampleColumns, { columnWidth: 30 });
      const plain = stripAnsi(output);
      expect(plain).toContain('Todo');
      expect(plain).toContain('In Progress');
      expect(plain).toContain('Done');
    });

    test('renders card titles', () => {
      const output = renderBoard(sampleColumns, { columnWidth: 30 });
      const plain = stripAnsi(output);
      expect(plain).toContain('Fix login bug');
      expect(plain).toContain('Add dark mode');
      expect(plain).toContain('Deploy v2');
    });

    test('shows board title when provided', () => {
      const output = renderBoard(sampleColumns, { title: 'Sprint 42', columnWidth: 30 });
      const plain = stripAnsi(output);
      expect(plain).toContain('Sprint 42');
    });

    test('compact mode renders shorter output', () => {
      const compact = renderBoard(sampleColumns, { compact: true, columnWidth: 30 });
      const full = renderBoard(sampleColumns, { compact: false, columnWidth: 30 });
      expect(compact.split('\n').length).toBeLessThanOrEqual(full.split('\n').length);
    });

    test('shows card IDs when requested', () => {
      const output = renderBoard(sampleColumns, { showIds: true, columnWidth: 40 });
      const plain = stripAnsi(output);
      expect(plain).toContain('card-1');
    });

    test('shows card count per column', () => {
      const output = renderBoard(sampleColumns, { columnWidth: 30 });
      const plain = stripAnsi(output);
      expect(plain).toContain('(1)');
    });

    test('handles empty columns', () => {
      const cols: RenderColumn[] = [
        { name: 'Empty', cards: [] },
        { name: 'Has Cards', cards: [sampleCards[0]] },
      ];
      const output = renderBoard(cols, { columnWidth: 25 });
      const plain = stripAnsi(output);
      expect(plain).toContain('(empty)');
    });

    test('truncates when maxCards exceeded', () => {
      const manyCards = Array.from({ length: 10 }, (_, i) => ({
        id: `c-${i}`,
        title: `Card ${i}`,
        status: 'Todo',
      }));
      const cols: RenderColumn[] = [{ name: 'Big Column', cards: manyCards }];
      const output = renderBoard(cols, { maxCards: 3, columnWidth: 30 });
      const plain = stripAnsi(output);
      expect(plain).toContain('+7 more');
    });
  });

  // ─── renderCardList ───────────────────────────────────

  describe('renderCardList', () => {
    test('renders a flat list of cards', () => {
      const output = renderCardList(sampleCards);
      const plain = stripAnsi(output);
      expect(plain).toContain('Fix login bug');
      expect(plain).toContain('Add dark mode');
      expect(plain).toContain('Deploy v2');
    });

    test('shows title when provided', () => {
      const output = renderCardList(sampleCards, { title: 'My Cards' });
      expect(stripAnsi(output)).toContain('My Cards');
    });

    test('handles empty list', () => {
      const output = renderCardList([]);
      expect(stripAnsi(output)).toContain('No cards found');
    });
  });

  // ─── renderStatusBar ──────────────────────────────────

  describe('renderStatusBar', () => {
    test('renders status counts with percentages', () => {
      const stats = { Done: 5, 'In Progress': 3, Todo: 2 };
      const output = renderStatusBar(stats, 10);
      const plain = stripAnsi(output);
      expect(plain).toContain('Done');
      expect(plain).toContain('5');
      expect(plain).toContain('50%');
      expect(plain).toContain('In Progress');
      expect(plain).toContain('3');
    });

    test('handles zero total', () => {
      const output = renderStatusBar({}, 0);
      expect(output).toBe('');
    });
  });

  // ─── Card status indicators ───────────────────────────

  describe('status indicators', () => {
    test('blocked card shows blocked indicator', () => {
      const cols: RenderColumn[] = [{ name: 'Test', cards: [sampleCards[3]] }];
      const output = renderBoard(cols, { columnWidth: 40 });
      const plain = stripAnsi(output);
      expect(plain).toContain('Blocked feature');
    });
  });

  // ─── snapshotToColumns ────────────────────────────────
  // The one home (#89) — `board` and the interactive menu each held this
  // placement algorithm.

  describe('snapshotToColumns', () => {
    const ctxCard = (over: Partial<ContextCard> & { id: string }): ContextCard =>
      ({ title: `card ${over.id}`, ...over }) as ContextCard;

    test('places cards by columnId and keeps the board column order', () => {
      const columns = snapshotToColumns({
        columns: [{ id: 'k1', name: 'Todo' }, { id: 'k2', name: 'Done' }],
        cards: [ctxCard({ id: 'a', columnId: 'k2' }), ctxCard({ id: 'b', columnId: 'k1' })],
      });

      expect(columns.map(col => col.name)).toEqual(['Todo', 'Done']);
      expect(columns[0].cards.map(c => c.id)).toEqual(['b']);
      expect(columns[1].cards.map(c => c.id)).toEqual(['a']);
    });

    test('keeps an empty column rather than dropping it', () => {
      const columns = snapshotToColumns({
        columns: [{ id: 'k1', name: 'Todo' }, { id: 'k2', name: 'Done' }],
        cards: [ctxCard({ id: 'a', columnId: 'k1' })],
      });

      expect(columns[1]).toEqual({ name: 'Done', cards: [] });
    });

    test('falls back to status for a card whose columnId is not on the board', () => {
      const columns = snapshotToColumns({
        columns: [{ id: 'k1', name: 'Todo' }],
        cards: [ctxCard({ id: 'a', columnId: 'gone', status: 'Review' })],
      });

      expect(columns.find(col => col.name === 'Review')!.cards.map(c => c.id)).toEqual(['a']);
    });

    test('groups by status when the board declares no columns', () => {
      const columns = snapshotToColumns({
        columns: [],
        cards: [ctxCard({ id: 'a', status: 'Todo' }), ctxCard({ id: 'b', status: 'Todo' })],
      });

      expect(columns).toHaveLength(1);
      expect(columns[0].name).toBe('Todo');
      expect(columns[0].cards.map(c => c.id)).toEqual(['a', 'b']);
    });

    test('files a card with neither column nor status under "Unknown"', () => {
      const columns = snapshotToColumns({ columns: [], cards: [ctxCard({ id: 'a' })] });
      expect(columns).toEqual([{ name: 'Unknown', cards: [expect.objectContaining({ id: 'a' })] }]);
    });

    test('never asserts `blocked` off an unjudged edge (#61)', () => {
      const columns = snapshotToColumns({
        columns: [{ id: 'k1', name: 'Todo' }],
        cards: [ctxCard({ id: 'a', columnId: 'k1', blockedBy: ['x'] })],
      });

      expect(columns[0].cards[0].blocked).toBeUndefined();
    });

    test('carries owner across as the render card assignee', () => {
      const columns = snapshotToColumns({
        columns: [{ id: 'k1', name: 'Todo' }],
        cards: [ctxCard({ id: 'a', columnId: 'k1', owner: 'ada', tags: ['bug'], due: '2026-08-02' })],
      });

      expect(columns[0].cards[0]).toEqual({
        id: 'a', title: 'card a', assignee: 'ada', tags: ['bug'], status: undefined, due: '2026-08-02',
      });
    });
  });
});
