/**
 * Tests for skill-engine.ts
 * Variable interpolation, variable resolution, and step execution logic
 */
import { interpolate, resolveVariables } from '../../lib/skill-engine';
import { SkillVariable } from '../../lib/skill-store';

// ─── interpolate Tests ────────────────────────────────────────────────────────

describe('interpolate', () => {
  test('replaces single variable', () => {
    expect(interpolate('Board: {{board}}', { board: 'Sprint 42' })).toBe('Board: Sprint 42');
  });

  test('replaces multiple variables', () => {
    const result = interpolate('{{command}} on {{board}} by {{user}}', {
      command: 'standup',
      board: 'Sprint 42',
      user: 'alice',
    });
    expect(result).toBe('standup on Sprint 42 by alice');
  });

  test('preserves unresolved variables', () => {
    expect(interpolate('{{known}} and {{unknown}}', { known: 'yes' })).toBe('yes and {{unknown}}');
  });

  test('handles dotted variable names', () => {
    expect(interpolate('{{scope.board}}', { 'scope.board': 'my-board' })).toBe('my-board');
  });

  test('handles empty string values', () => {
    expect(interpolate('Result: {{val}}', { val: '' })).toBe('Result: ');
  });

  test('returns original when no variables', () => {
    expect(interpolate('No variables here', {})).toBe('No variables here');
  });

  test('handles multiple occurrences of same variable', () => {
    expect(interpolate('{{x}} and {{x}}', { x: 'A' })).toBe('A and A');
  });
});

// ─── resolveVariables Tests ───────────────────────────────────────────────────

describe('resolveVariables', () => {
  test('uses provided values first', () => {
    const defs: Record<string, SkillVariable> = {
      board: { prompt: 'Board?', default: 'default-board' },
    };
    const result = resolveVariables(defs, { board: 'user-board' });
    expect(result.board).toBe('user-board');
  });

  test('falls back to defaults when not provided', () => {
    const defs: Record<string, SkillVariable> = {
      board: { prompt: 'Board?', default: 'default-board' },
      since: { prompt: 'Since?', default: '1d' },
    };
    const result = resolveVariables(defs, {});
    expect(result.board).toBe('default-board');
    expect(result.since).toBe('1d');
  });

  test('passes through extra provided variables', () => {
    const result = resolveVariables({}, { extra: 'value' });
    expect(result.extra).toBe('value');
  });

  test('handles undefined variable definitions', () => {
    const result = resolveVariables(undefined, { board: 'test' });
    expect(result.board).toBe('test');
  });

  test('does not override provided with default', () => {
    const defs: Record<string, SkillVariable> = {
      board: { prompt: 'Board?', default: 'DEFAULT' },
    };
    const result = resolveVariables(defs, { board: 'OVERRIDE' });
    expect(result.board).toBe('OVERRIDE');
  });

  test('handles variable with no default', () => {
    const defs: Record<string, SkillVariable> = {
      board: { prompt: 'Board?' },
    };
    const result = resolveVariables(defs, {});
    expect(result.board).toBeUndefined();
  });
});
