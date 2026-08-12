/**
 * Tests for git-integration.ts
 * Slug generation, branch name generation, card ID extraction, project config,
 * and — #146 — that nothing in this module reaches /bin/sh.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import * as childProcess from 'child_process';
import {
  slugify,
  generateBranchName,
  extractCardIdFromBranch,
  readProjectConfig,
  writeProjectConfig,
  commitWithMessage,
  createBranch,
  listBranches,
  getCurrentBranch,
  getLastCommitMessage,
  hasStagedChanges,
  isGitRepo,
  getDefaultBranch,
  isBranchMerged,
  analyzeBranches,
  FavroProjectConfig,
} from '../../lib/git-integration';
import { RefusalError } from '../../lib/refusal';

// Node 22 makes child_process exports non-configurable, so jest.spyOn cannot
// wrap them. Delegate to the real implementation and record the argv.
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return { ...actual, execFileSync: jest.fn(actual.execFileSync) };
});
const execFileSyncMock = childProcess.execFileSync as unknown as jest.Mock;

// ─── slugify Tests ────────────────────────────────────────────────────────────

describe('slugify', () => {
  test('converts title to lowercase slug', () => {
    expect(slugify('Fix Login Bug')).toBe('fix-login-bug');
  });

  test('removes special characters', () => {
    expect(slugify('Add dark mode (v2)')).toBe('add-dark-mode-v2');
  });

  test('gives the same slug whichever normalisation form the title arrives in', () => {
    // The strip removes a combining mark but keeps the base letter under it, so
    // a decomposed title slugged to `cafe` while the precomposed one slugged to
    // `caf` — same title, two branch names, decided by where it was typed
    // (#141). Built from code points so no editor can rewrite one into the
    // other.
    const title = `Fix caf${String.fromCodePoint(0x00e9)} login`;

    expect(slugify(title.normalize('NFD'))).toBe(slugify(title));
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

// ─── #146: no shell, ever ─────────────────────────────────────────────────────

describe('git commands never reach /bin/sh', () => {
  let repo: string;
  let sentinel: string;
  let originalCwd: string;

  // Bypasses the module under test so a broken helper cannot fake a green.
  const rawGit = (args: string[]): string =>
    childProcess.execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();

  beforeEach(() => {
    originalCwd = process.cwd();
    // realpath: macOS tmpdir is a symlink, and findProjectRoot() walks up from
    // the resolved cwd — without this the repo root never matches.
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'favro-146-')));
    sentinel = path.join(repo, 'PWNED');
    rawGit(['init', '-q', '-b', 'main', '.']);
    rawGit(['config', 'user.email', 'test@example.invalid']);
    rawGit(['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hi\n');
    rawGit(['add', 'a.txt']);
    process.chdir(repo);
    execFileSyncMock.mockClear();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  // Card titles come from Favro — anyone with board write access authors them —
  // and favro_run lets an MCP agent compose these arguments. Both cross a trust
  // boundary before this module runs them.
  const hostileMessage = (target: string) =>
    `fix $(touch ${target}) the "thing" \`touch ${target}-tick\` 100% \\ done\nsecond line`;

  test('commit message reaches git as one verbatim argv entry', () => {
    const message = hostileMessage(sentinel);

    commitWithMessage(message);

    const commitCall = execFileSyncMock.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === 'commit'
    );
    expect(commitCall).toBeDefined();
    expect(commitCall![0]).toBe('git');
    expect(commitCall![1]).toEqual(['commit', '-m', message]);
  });

  test('a commit message containing $(), backticks and quotes is stored byte-identically and executes nothing', () => {
    const message = hostileMessage(sentinel);

    commitWithMessage(message);

    // %B is the raw body; git appends exactly one trailing newline.
    expect(rawGit(['log', '-1', '--format=%B'])).toBe(message);
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(fs.existsSync(`${sentinel}-tick`)).toBe(false);
  });

  test('a branch name containing ";" is a name, not a separator', () => {
    rawGit(['commit', '-m', 'first']);

    createBranch('evil;pwned');

    expect(getCurrentBranch()).toBe('evil;pwned');
    expect(listBranches()).toContain('evil;pwned');
  });

  test('a branch name carrying a shell command is rejected, not executed', () => {
    // Needs a real commit: on an unborn HEAD there are no refs to list, which
    // would make the "no `safe` branch" assertion pass for the wrong reason.
    rawGit(['commit', '-m', 'first']);

    // git refuses the space; the point is that nothing ran on the way there.
    expect(() => createBranch(`safe; touch ${sentinel}`)).toThrow();
    expect(fs.existsSync(sentinel)).toBe(false);
    // rawGit, not listBranches(): the module under test must not be the witness.
    expect(rawGit(['branch', '--list', '--format=%(refname:short)'])).toBe('main');
  });

  // `--format=%(refname:short)` is a syntax error to /bin/sh, so every branch
  // listing threw before the argv rewrite.
  test('listBranches survives the %(refname:short) format', () => {
    rawGit(['commit', '-m', 'first']);
    rawGit(['branch', 'other']);

    expect(listBranches().sort()).toEqual(['main', 'other']);
  });

  // execSync threw on non-zero exit; execFileSync must too, or the bare
  // catch blocks in this module silently invert.
  test('non-zero exit still throws, so the boolean probes keep their meaning', () => {
    expect(isGitRepo()).toBe(true);
    expect(hasStagedChanges()).toBe(true);

    commitWithMessage('plain message');
    expect(hasStagedChanges()).toBe(false);
    expect(getLastCommitMessage()).toBe('plain message');

    process.chdir(os.tmpdir());
    expect(isGitRepo()).toBe(false);
  });

  // listBranches() threw on every call before the argv rewrite, so everything
  // downstream of it was dead: getDefaultBranch()'s no-origin fallback, and
  // analyzeBranches() — which `favro git sync` uses to decide which cards get
  // moved to "Done". The fix makes that write path live for the first time, so
  // it needs a witness: a misclassified branch moves the wrong card.
  test('analyzeBranches classifies merged, open and current branches', () => {
    rawGit(['commit', '-m', 'first']);
    rawGit(['checkout', '-q', '-b', 'feature/aabbccddeeff0011-done']);
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    rawGit(['add', 'b.txt']);
    rawGit(['commit', '-m', 'done work']);
    rawGit(['checkout', '-q', 'main']);
    rawGit(['merge', '-q', '--no-ff', '-m', 'merge', 'feature/aabbccddeeff0011-done']);

    rawGit(['checkout', '-q', '-b', 'feature/1122334455667788-open']);
    fs.writeFileSync(path.join(repo, 'c.txt'), 'c\n');
    rawGit(['add', 'c.txt']);
    rawGit(['commit', '-m', 'open work']);

    // No origin/HEAD here, so this also exercises getDefaultBranch()'s fallback.
    expect(getDefaultBranch()).toBe('main');

    const byBranch = Object.fromEntries(
      analyzeBranches().map(m => [m.branch, m])
    );
    expect(Object.keys(byBranch).sort()).toEqual([
      'feature/1122334455667788-open',
      'feature/aabbccddeeff0011-done',
    ]);
    expect(byBranch['feature/aabbccddeeff0011-done']).toEqual({
      branch: 'feature/aabbccddeeff0011-done',
      cardId: 'aabbccddeeff0011',
      status: 'merged',
    });
    expect(byBranch['feature/1122334455667788-open']).toEqual({
      branch: 'feature/1122334455667788-open',
      cardId: '1122334455667788',
      status: 'current',
    });
  });

  /** The error a call threw, as a value — `toThrow(Class)` only matches a name. */
  const caught = (fn: () => unknown): unknown => {
    try {
      fn();
      return undefined;
    } catch (error) {
      return error;
    }
  };

  // The hole the classification witness above could not see: a merge check that
  // CANNOT RUN answered `false`, `analyzeBranches` spelled that as 'open', and
  // `favro git sync` PATCHes every 'open' card to "In Progress" — so a repo git
  // could not read moved finished work backwards, in volume.
  //
  // The first assertion is the DISCRIMINATOR. The same branch in the same repo is
  // first genuinely unmerged and then unreadable, so a fixture too thin to tell
  // those apart fails here rather than passing for both implementations.
  test('a merge check that cannot run reaches the caller instead of reading as "not merged"', () => {
    rawGit(['commit', '-m', 'first']);
    rawGit(['checkout', '-q', '-b', 'feature/1122334455667788-open']);
    fs.writeFileSync(path.join(repo, 'c.txt'), 'c\n');
    rawGit(['add', 'c.txt']);
    rawGit(['commit', '-m', 'open work']);
    rawGit(['checkout', '-q', 'main']);

    expect(isBranchMerged('feature/1122334455667788-open')).toBe(false);

    // A clone whose upstream default was deleted: origin/HEAD still resolves to a
    // NAME, so `getDefaultBranch()` succeeds and `git branch --merged <name>`
    // then exits non-zero for every branch at once.
    rawGit(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone']);
    expect(getDefaultBranch()).toBe('gone');

    expect((caught(() => isBranchMerged('feature/1122334455667788-open')) as Error).message)
      .toMatch(/malformed object name/);
    expect((caught(() => analyzeBranches()) as Error).message)
      .toMatch(/malformed object name/);
  });

  // The TRIGGER for that swallow, one hop earlier: `getDefaultBranch()` returned
  // 'main' unconditionally when it found neither main nor master, which is a
  // plausible ref name manufactured from a read that came back empty. Every merge
  // check in such a repo then failed at once.
  test('a repo with neither main nor master refuses instead of naming a branch it did not find', () => {
    rawGit(['commit', '-m', 'first']);
    rawGit(['branch', '-m', 'develop']);
    rawGit(['checkout', '-q', '-b', 'feature/aabbccddeeff0011-work']);
    fs.writeFileSync(path.join(repo, 'd.txt'), 'd\n');
    rawGit(['add', 'd.txt']);
    rawGit(['commit', '-m', 'more work']);
    rawGit(['checkout', '-q', 'develop']);

    // rawGit, not listBranches(): the module under test does not get to be the
    // witness for "there really is no main or master in this repo".
    expect(rawGit(['branch', '--list', '--format=%(refname:short)']).split('\n').sort())
      .toEqual(['develop', 'feature/aabbccddeeff0011-work']);

    const fromDefault = caught(() => getDefaultBranch());
    expect(fromDefault).toBeInstanceOf(RefusalError);
    expect((fromDefault as Error).message).toMatch(/no local `main` or `master`/);
    // The REMEDY, pinned separately (added in review). Deleting just the
    // `git remote set-head` sentence left every gate green: this arm matched the
    // diagnosis half only, so the actionable half — the whole reason this is a
    // refusal and not a failure — was decoration a later edit could drop.
    expect((fromDefault as Error).message).toMatch(/git remote set-head origin <branch>/);
    // …and it reaches the caller `favro git sync` reads, which is the only reason
    // the refusal matters: no status is produced, so no card is moved.
    expect(caught(() => analyzeBranches())).toBeInstanceOf(RefusalError);
  });
});
