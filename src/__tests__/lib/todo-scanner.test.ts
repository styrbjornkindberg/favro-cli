/**
 * Tests for todo-scanner.ts
 * Regex matching, file scanning, grouping, formatting
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  scanTodos,
  groupByFile,
  formatTodoAsCardDescription,
  todoToCardTitle,
  TodoItem,
} from '../../lib/todo-scanner';

// Same regex used internally by the scanner
const TODO_REGEX = /\b(TODO|FIXME|HACK|XXX)(?:\(([^)]+)\))?[:\s]+(.+)/i;

// ─── TODO_REGEX Tests ─────────────────────────────────────────────────────────

describe('TODO_REGEX', () => {
  const match = (line: string) => {
    const m = line.match(TODO_REGEX);
    return m ? { type: m[1], author: m[2] || null, text: m[3] } : null;
  };

  test('matches basic TODO', () => {
    const result = match('// TODO: fix this later');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('TODO');
    expect(result!.text).toBe('fix this later');
  });

  test('matches FIXME', () => {
    const result = match('# FIXME: broken edge case');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('FIXME');
    expect(result!.text).toBe('broken edge case');
  });

  test('matches HACK', () => {
    const result = match('// HACK: workaround for API bug');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('HACK');
  });

  test('matches XXX', () => {
    const result = match('// XXX: needs review');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('XXX');
  });

  test('matches with author', () => {
    const result = match('// TODO(alice): add retry logic');
    expect(result).not.toBeNull();
    expect(result!.author).toBe('alice');
    expect(result!.text).toBe('add retry logic');
  });

  test('case insensitive', () => {
    const result = match('// todo: lowercase');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('todo');
  });

  test('does not match random text', () => {
    expect(match('const x = 42;')).toBeNull();
  });

  test('matches with space after keyword', () => {
    const result = match('// TODO fix this');
    expect(result).not.toBeNull();
    expect(result!.text).toBe('fix this');
  });
});

// ─── scanTodos Tests ──────────────────────────────────────────────────────────

describe('scanTodos', () => {
  const testDir = path.join(os.tmpdir(), `favro-todo-test-${Date.now()}`);

  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true });

    // Create a .ts file with TODOs
    fs.writeFileSync(path.join(testDir, 'app.ts'), [
      'const x = 1;',
      '// TODO: implement feature',
      'function foo() {',
      '  // FIXME(alice): crash on empty input',
      '  return x;',
      '}',
    ].join('\n'));

    // Create a .js file with TODOs
    fs.writeFileSync(path.join(testDir, 'utils.js'), [
      '// HACK: workaround for upstream bug',
      'export function noop() {}',
    ].join('\n'));

    // Create a file that should be ignored
    const nodeModules = path.join(testDir, 'node_modules', 'pkg');
    fs.mkdirSync(nodeModules, { recursive: true });
    fs.writeFileSync(path.join(nodeModules, 'index.js'), '// TODO: not mine');

    // Create an unsupported extension
    fs.writeFileSync(path.join(testDir, 'image.png'), 'binary');
  });

  afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('finds TODOs in supported files', () => {
    const items = scanTodos({ root: testDir });
    expect(items.length).toBeGreaterThanOrEqual(3);
  });

  test('ignores node_modules', () => {
    const items = scanTodos({ root: testDir });
    const nmItems = items.filter(i => i.file.includes('node_modules'));
    expect(nmItems).toHaveLength(0);
  });

  test('captures correct item properties', () => {
    const items = scanTodos({ root: testDir });
    const fixme = items.find(i => i.type === 'FIXME');
    expect(fixme).toBeDefined();
    expect(fixme!.author).toBe('alice');
    expect(fixme!.text).toContain('crash on empty input');
  });

  test('captures file and line number', () => {
    const items = scanTodos({ root: testDir });
    const todo = items.find(i => i.text.includes('implement feature'));
    expect(todo).toBeDefined();
    expect(todo!.file).toContain('app.ts');
    expect(todo!.line).toBe(2);
  });
});

// ─── groupByFile Tests ────────────────────────────────────────────────────────

describe('groupByFile', () => {
  test('groups items by file path', () => {
    const items: TodoItem[] = [
      { file: 'a.ts', line: 1, type: 'TODO', text: 'one', fullLine: '// TODO: one' },
      { file: 'a.ts', line: 5, type: 'FIXME', text: 'two', fullLine: '// FIXME: two' },
      { file: 'b.ts', line: 3, type: 'TODO', text: 'three', fullLine: '// TODO: three' },
    ];

    const groups = groupByFile(items);
    expect(groups).toHaveLength(2);
    expect(groups.find(g => g.file === 'a.ts')!.items).toHaveLength(2);
    expect(groups.find(g => g.file === 'b.ts')!.items).toHaveLength(1);
  });

  test('handles empty array', () => {
    expect(groupByFile([])).toHaveLength(0);
  });
});

// ─── Formatting Tests ─────────────────────────────────────────────────────────

describe('formatting helpers', () => {
  const item: TodoItem = {
    file: 'src/app.ts',
    line: 42,
    type: 'TODO',
    text: 'add retry logic',
    author: 'alice',
    fullLine: '// TODO(alice): add retry logic',
  };

  test('todoToCardTitle produces a sensible title', () => {
    const title = todoToCardTitle(item);
    expect(title).toContain('TODO');
    expect(title).toContain('add retry logic');
  });

  test('formatTodoAsCardDescription includes file info', () => {
    const desc = formatTodoAsCardDescription(item);
    expect(desc).toContain('src/app.ts');
    expect(desc).toContain('42');
  });
});
