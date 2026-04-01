/**
 * Tests for git-integration.ts
 * Slug generation, branch name generation, card ID extraction, project config
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  slugify,
  generateBranchName,
  extractCardIdFromBranch,
  readProjectConfig,
  writeProjectConfig,
  FavroProjectConfig,
} from '../../lib/git-integration';

// ─── slugify Tests ────────────────────────────────────────────────────────────

describe('slugify', () => {
  test('converts title to lowercase slug', () => {
    expect(slugify('Fix Login Bug')).toBe('fix-login-bug');
  });

  test('removes special characters', () => {
    expect(slugify('Add dark mode (v2)')).toBe('add-dark-mode-v2');
  });

  test('collapses multiple hyphens', () => {
    expect(slugify('Fix -- the -- bug')).toBe('fix-the-bug');
  });

  test('trims leading/trailing hyphens', () => {
    expect(slugify('  -Fix this-  ')).toBe('fix-this');
  });

  test('truncates to 50 chars', () => {
    const longTitle = 'This is an extremely long card title that exceeds the maximum slug length allowed';
    expect(slugify(longTitle).length).toBeLessThanOrEqual(50);
  });

  test('handles empty string', () => {
    expect(slugify('')).toBe('');
  });

  test('handles unicode characters', () => {
    expect(slugify('Ådd dörk möde')).toBe('dd-drk-mde');
  });
});

// ─── generateBranchName Tests ─────────────────────────────────────────────────

describe('generateBranchName', () => {
  test('generates default feature branch', () => {
    expect(generateBranchName('abc123', 'Fix Login Bug'))
      .toBe('feature/abc123-fix-login-bug');
  });

  test('uses custom pattern', () => {
    expect(generateBranchName('abc123', 'Fix Bug', 'fix/{{cardId}}-{{slug}}'))
      .toBe('fix/abc123-fix-bug');
  });

  test('handles long card titles', () => {
    const branch = generateBranchName('id', 'A very long title that should be truncated to keep branch names reasonable');
    expect(branch.length).toBeLessThan(100);
  });
});

// ─── extractCardIdFromBranch Tests ────────────────────────────────────────────

describe('extractCardIdFromBranch', () => {
  test('extracts from feature/<id>-slug pattern', () => {
    expect(extractCardIdFromBranch('feature/abc123def456-fix-login')).toBe('abc123def456');
  });

  test('extracts from fix/<id>-slug pattern', () => {
    expect(extractCardIdFromBranch('fix/abc123def456-urgent-bug')).toBe('abc123def456');
  });

  test('extracts with custom prefix', () => {
    expect(extractCardIdFromBranch('feature/CARD-42-fix-login', 'CARD')).toBe('CARD-42');
  });

  test('extracts hex ID from branch', () => {
    const hexId = 'a1b2c3d4e5f6a1b2c3d4';
    expect(extractCardIdFromBranch(`feature/${hexId}-some-work`)).toBe(hexId);
  });

  test('returns null for branches without card ID', () => {
    expect(extractCardIdFromBranch('main')).toBeNull();
    expect(extractCardIdFromBranch('develop')).toBeNull();
  });

  test('extracts from bugfix/ prefix', () => {
    expect(extractCardIdFromBranch('bugfix/abc123def456-crash')).toBe('abc123def456');
  });

  test('extracts long hex ID from anywhere in branch', () => {
    const hexId = 'a1b2c3d4e5f6a1b2c3d4';
    expect(extractCardIdFromBranch(`random-${hexId}-branch`)).toBe(hexId);
  });
});

// ─── Project Config Tests ─────────────────────────────────────────────────────

describe('project config', () => {
  const testDir = path.join(os.tmpdir(), `favro-git-test-${Date.now()}`);

  beforeAll(() => {
    fs.mkdirSync(testDir, { recursive: true });
    // Create a .git dir so findProjectRoot works
    fs.mkdirSync(path.join(testDir, '.git'), { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('writes and reads project config', () => {
    const config: FavroProjectConfig = {
      boardId: 'board-123',
      boardName: 'Sprint 42',
      cardPrefix: 'CARD',
      branches: { 'feature/CARD-1-fix': 'card-1' },
    };

    writeProjectConfig(config, testDir);

    const read = readProjectConfig(testDir);
    expect(read).not.toBeNull();
    expect(read!.boardId).toBe('board-123');
    expect(read!.boardName).toBe('Sprint 42');
    expect(read!.cardPrefix).toBe('CARD');
    expect(read!.branches?.['feature/CARD-1-fix']).toBe('card-1');
  });

  test('returns null when config does not exist', () => {
    const emptyDir = path.join(os.tmpdir(), `favro-empty-${Date.now()}`);
    fs.mkdirSync(emptyDir, { recursive: true });
    const result = readProjectConfig(emptyDir);
    expect(result).toBeNull();
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });
});
