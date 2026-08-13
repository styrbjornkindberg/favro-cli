/**
 * The `--from-csv` reader (`lib/csv.ts`).
 *
 * Moved here from `lib/bulk.test.ts` when #110 deleted `BulkTransaction`: the
 * parse is the only half of that module that outlived the collapse onto the
 * dispatch table, so its arms outlive it too. The arms that went with the
 * deletion are named in the CHANGELOG rather than silently dropped.
 *
 * One arm is NEW and is the behaviour change: an unknown column refuses. The old
 * parser accepted `custom_field_*`, stored it, and sent none of it.
 */
import { parseCSVContent, parseCSVLine, UPDATE_CSV_COLUMNS } from '../../lib/csv';

describe('parseCSVLine', () => {
  it('parses simple comma-separated values', () => {
    expect(parseCSVLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('parses quoted fields with commas', () => {
    expect(parseCSVLine('"hello, world",b')).toEqual(['hello, world', 'b']);
  });

  it('handles escaped double-quotes inside quoted fields', () => {
    expect(parseCSVLine('"he said ""hi""",b')).toEqual(['he said "hi"', 'b']);
  });

  it('handles empty fields', () => {
    expect(parseCSVLine('a,,c')).toEqual(['a', '', 'c']);
  });

  it('handles trailing comma', () => {
    expect(parseCSVLine('a,b,')).toEqual(['a', 'b', '']);
  });
});

describe('parseCSVContent', () => {
  it('returns error for empty content', () => {
    const result = parseCSVContent('');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.rows.length).toBe(0);
  });

  it('returns error for header-only CSV', () => {
    const result = parseCSVContent('card_id,status,owner');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.rows.length).toBe(0);
  });

  it('returns error when card_id column is missing', () => {
    const result = parseCSVContent('status,owner\nDone,alice');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].field).toBe('card_id');
  });

  it('parses valid CSV with card_id', () => {
    const csv = 'card_id,status,owner\ncard-1,Done,alice\ncard-2,In Progress,bob';
    const result = parseCSVContent(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].card_id).toBe('card-1');
    expect(result.rows[0].status).toBe('Done');
    expect(result.rows[0].owner).toBe('alice');
    expect(result.rows[1].card_id).toBe('card-2');
  });

  it('parses CSV with due_date column', () => {
    const csv = 'card_id,due_date\ncard-1,2026-04-01';
    const result = parseCSVContent(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.rows[0].due_date).toBe('2026-04-01');
  });

  it('returns error for invalid due_date format', () => {
    const csv = 'card_id,due_date\ncard-1,04/01/2026';
    const result = parseCSVContent(csv);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].field).toBe('due_date');
  });

  it('skips rows with missing card_id but continues with valid rows', () => {
    const csv = 'card_id,status\n,Done\ncard-2,Backlog';
    const result = parseCSVContent(csv);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].card_id).toBe('card-2');
  });

  it('skips blank lines', () => {
    const csv = 'card_id,status\ncard-1,Done\n\ncard-3,Backlog';
    const result = parseCSVContent(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(2);
  });

  it('handles quoted fields in data rows', () => {
    const csv = 'card_id,status\n"card-1","In Progress"';
    const result = parseCSVContent(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.rows[0].card_id).toBe('card-1');
    expect(result.rows[0].status).toBe('In Progress');
  });

  it('handles Windows-style CRLF line endings', () => {
    const csv = 'card_id,status\r\ncard-1,Done\r\ncard-2,Backlog';
    const result = parseCSVContent(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(2);
  });

  it('handles 1000+ rows', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => `card-${i},Done`).join('\n');
    const result = parseCSVContent(`card_id,status\n${rows}`);
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(1000);
  });

  // ─── the closed column vocabulary (#110) ───────────────────────────────────

  it('accepts the camelCase aliases the export and the flags spell', () => {
    const csv = 'cardId,assignee,dueDate\ncard-1,alice,2026-12-31';
    const result = parseCSVContent(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.rows[0]).toEqual({
      card_id: 'card-1',
      owner: 'alice',
      due_date: '2026-12-31',
    });
  });

  it('REFUSES a custom_field_* column instead of storing and never sending it', () => {
    // The old parser answered `{ errors: [], rows: [{ custom_field_priority:
    // 'high' }] }` here and the transaction sent nothing for it, so the run
    // reported success having written no priority at all.
    const result = parseCSVContent('card_id,custom_field_priority\ncard-1,high');
    expect(result.rows).toHaveLength(0);
    expect(result.errors.map((e) => e.field)).toEqual(['custom_field_priority']);
    // The refusal names the columns that do exist, so it can be acted on.
    for (const column of UPDATE_CSV_COLUMNS) {
      expect(result.errors[0].message).toContain(column);
    }
  });

  it('refuses any unknown column, not only the custom_field_ prefix', () => {
    const result = parseCSVContent('card_id,name\ncard-1,Renamed');
    expect(result.errors.map((e) => e.field)).toEqual(['name']);
    expect(result.rows).toHaveLength(0);
  });

  it('reports every unknown column at once, not just the first', () => {
    const result = parseCSVContent('card_id,tags,priority\ncard-1,bug,high');
    expect(result.errors.map((e) => e.field)).toEqual(['tags', 'priority']);
  });
});
