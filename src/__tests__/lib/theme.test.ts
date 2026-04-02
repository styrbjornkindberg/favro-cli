/**
 * Tests for lib/theme.ts — Color system and formatting utilities
 */
import { c, stripAnsi, padEnd, kv, tableHeader, tableRow, box } from '../../lib/theme';

describe('theme', () => {
  // ─── stripAnsi ────────────────────────────────────────

  describe('stripAnsi', () => {
    test('removes ANSI codes from colored string', () => {
      const colored = c.success('hello');
      expect(stripAnsi(colored)).toBe('hello');
    });

    test('returns plain text unchanged', () => {
      expect(stripAnsi('plain text')).toBe('plain text');
    });

    test('handles empty string', () => {
      expect(stripAnsi('')).toBe('');
    });

    test('strips multiple color codes', () => {
      const multi = `${c.error('err')} ${c.success('ok')}`;
      expect(stripAnsi(multi)).toBe('err ok');
    });
  });

  // ─── padEnd ───────────────────────────────────────────

  describe('padEnd', () => {
    test('pads plain string to width', () => {
      expect(padEnd('hi', 10)).toBe('hi        ');
    });

    test('pads colored string correctly (ignoring ANSI width)', () => {
      const colored = c.success('hi');
      const padded = padEnd(colored, 10);
      expect(stripAnsi(padded)).toBe('hi        ');
    });

    test('does not truncate strings longer than width', () => {
      const result = padEnd('hello world', 5);
      expect(stripAnsi(result)).toBe('hello world');
    });
  });

  // ─── Symbols ──────────────────────────────────────────

  describe('symbols', () => {
    test('ok symbol contains checkmark', () => {
      expect(stripAnsi(c.ok)).toBe('✓');
    });

    test('fail symbol contains X', () => {
      expect(stripAnsi(c.fail)).toBe('✗');
    });

    test('arrow symbol contains arrow', () => {
      expect(stripAnsi(c.arrow)).toBe('→');
    });
  });

  // ─── Semantic formatters ──────────────────────────────

  describe('semantic formatters', () => {
    test('heading produces text', () => {
      const h = c.heading('My Board');
      expect(stripAnsi(h)).toBe('My Board');
    });

    test('status.done colors text', () => {
      const done = c.status.done('Complete');
      expect(stripAnsi(done)).toBe('Complete');
    });

    test('status.blocked colors text', () => {
      const blocked = c.status.blocked('Stuck');
      expect(stripAnsi(blocked)).toBe('Stuck');
    });

    test('priority.high makes text bold colored', () => {
      const high = c.priority.high('P1');
      expect(stripAnsi(high)).toBe('P1');
    });

    test('dryRun wraps text', () => {
      const dr = c.dryRun('dry-run');
      expect(stripAnsi(dr)).toContain('dry-run');
    });
  });

  // ─── Layout helpers ───────────────────────────────────

  describe('kv', () => {
    test('formats key-value pair', () => {
      const result = kv('Status', 'Done');
      expect(stripAnsi(result)).toBe('Status: Done');
    });
  });

  describe('tableHeader', () => {
    test('produces header and rule lines', () => {
      const header = tableHeader(
        { label: 'Name', width: 20 },
        { label: 'Status', width: 10 },
      );
      const lines = header.split('\n');
      expect(lines).toHaveLength(2);
      expect(stripAnsi(lines[0])).toContain('Name');
      expect(stripAnsi(lines[0])).toContain('Status');
    });
  });

  describe('tableRow', () => {
    test('produces row with padded cells', () => {
      const row = tableRow(
        { text: 'Card A', width: 20 },
        { text: 'Done', width: 10 },
      );
      expect(stripAnsi(row)).toContain('Card A');
      expect(stripAnsi(row)).toContain('Done');
    });
  });

  describe('box', () => {
    test('wraps content in a box', () => {
      const result = box('Title', ['Line 1', 'Line 2']);
      expect(stripAnsi(result)).toContain('Title');
      expect(stripAnsi(result)).toContain('Line 1');
      expect(stripAnsi(result)).toContain('╭');
      expect(stripAnsi(result)).toContain('╰');
    });
  });

  // ─── Diff styles ──────────────────────────────────────

  describe('diff styles', () => {
    test('added prefix', () => {
      expect(stripAnsi(c.added('new card'))).toBe('+ new card');
    });

    test('removed prefix', () => {
      expect(stripAnsi(c.removed('old card'))).toBe('- old card');
    });

    test('changed prefix', () => {
      expect(stripAnsi(c.changed('modified'))).toBe('~ modified');
    });
  });
});
