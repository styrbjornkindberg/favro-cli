/**
 * `favro init` never rewrites an existing `.gitignore` — on a REAL disk (#144).
 *
 * WHAT THE BUG WAS
 * The handler's `catch` meant "there is no .gitignore, create one", but it
 * wrapped the `appendFile` too. A user with a 200-line `.gitignore` whose
 * append failed — transient EACCES, full disk, file held open — landed in that
 * catch and had the whole file replaced with two lines, under a success
 * message. This suite pins the file's bytes across a failing append.
 *
 * WHY A REAL DISK
 * `init.test.ts` mocks `fs/promises` wholesale, so it can only prove which
 * calls were made. The claim here is about bytes that survive, so the bytes
 * have to exist. `fs/promises` is replaced by a pass-through that forwards to
 * the real module — a spy is impossible, Node 22 makes those exports
 * non-configurable — and only the one call under test is ever made to fail.
 *
 * THE CONTROL
 * `writes context.json before it touches .gitignore` fails the moment this
 * pipeline stops reaching the gitignore step, which is the way the negative
 * tests could otherwise pass for the wrong reason (#131's lesson).
 *
 * ISOLATION
 * `FAVRO_CONFIG_DIR` points at a temp dir before anything is required, so
 * `readConfig()` cannot reach the developer's own `~/.favro`. The repo the
 * command thinks it is in is a second temp dir, handed over by stubbing
 * `process.cwd()` rather than by `chdir` — a real chdir leaks into every other
 * suite sharing the worker. Both are removed after the run.
 */
import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'favro-cli-init-gi-config-'));
fs.writeFileSync(path.join(CONFIG_DIR, 'config.json'), JSON.stringify({ scopeCollectionId: 'coll-1' }));
process.env.FAVRO_CONFIG_DIR = CONFIG_DIR;

// Every `fs/promises` call reaches the real disk. These two are routed through
// a jest.fn only so a single call can be made to fail on demand; `beforeEach`
// puts the real implementation back behind both.
const mockAppendFile = jest.fn();
const mockReadFile = jest.fn();
jest.mock('fs/promises', () => ({
  ...(jest.requireActual('fs/promises') as object),
  appendFile: (...args: unknown[]) => mockAppendFile(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));
const realFsp = jest.requireActual('fs/promises') as typeof import('fs/promises');

jest.mock('../../lib/client-factory');
jest.mock('../../lib/boards-api');
jest.mock('../../lib/columns-api');
jest.mock('../../lib/collections-api');
jest.mock('../../lib/custom-fields-api');
jest.mock('../../api/members');

import { registerInitCommand } from '../../commands/init';
import * as clientFactory from '../../lib/client-factory';
import BoardsAPI from '../../lib/boards-api';
import { ColumnsAPI } from '../../lib/columns-api';
import CollectionsAPI from '../../lib/collections-api';
import { CustomFieldsAPI } from '../../lib/custom-fields-api';
import { FavroApiClient } from '../../api/members';

const MockBoards = BoardsAPI as jest.MockedClass<typeof BoardsAPI>;
const MockColumns = ColumnsAPI as jest.MockedClass<typeof ColumnsAPI>;
const MockCollections = CollectionsAPI as jest.MockedClass<typeof CollectionsAPI>;
const MockFields = CustomFieldsAPI as jest.MockedClass<typeof CustomFieldsAPI>;
const MockMembers = FavroApiClient as jest.MockedClass<typeof FavroApiClient>;

/** A .gitignore worth more than the two lines that used to replace it. */
const EXISTING_GITIGNORE = [
  '# build output',
  'dist/',
  'coverage/',
  '',
  '# local env — not recoverable from git',
  '.env.local',
  '',
].join('\n');

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

let repoDir: string;
let gitignorePath: string;
let contextFile: string;
let exitSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  mockAppendFile.mockImplementation(realFsp.appendFile);
  mockReadFile.mockImplementation(realFsp.readFile);

  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'favro-cli-init-gi-repo-'));
  gitignorePath = path.join(repoDir, '.gitignore');
  contextFile = path.join(repoDir, '.favro', 'context.json');

  jest.spyOn(process, 'cwd').mockReturnValue(repoDir);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  // Throwing, not returning: a returning stub lets the run continue past a
  // refusal and cannot distinguish "stopped" from "ignored".
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitCalled(code ?? 0);
  }) as never);

  (clientFactory.createFavroClient as jest.Mock).mockResolvedValue({
    get: jest.fn().mockResolvedValue({ sharedToUsers: [{ userId: 'u-1' }] }),
  });
  MockCollections.prototype.getCollection = jest.fn().mockResolvedValue({ collectionId: 'coll-1', name: 'Platform' });
  MockBoards.prototype.listBoardsByCollection = jest.fn().mockResolvedValue([{ boardId: 'board-a', name: 'Sprint 42' }]);
  MockColumns.prototype.listColumns = jest.fn().mockResolvedValue([{ columnId: 'col-1', name: 'Done' }]);
  MockFields.prototype.listFields = jest.fn().mockResolvedValue([]);
  MockMembers.prototype.getMembers = jest
    .fn()
    .mockResolvedValue([{ id: 'u-1', name: 'Alice', email: 'alice@example.com' }]);
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(repoDir, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
});

async function runInit(...args: string[]): Promise<void> {
  const program = new Command();
  program.option('--verbose', 'Show stack traces');
  registerInitCommand(program);
  program.exitOverride();
  await program.parseAsync(['node', 'favro', 'init', ...args]).catch((e) => {
    if (!(e instanceof ExitCalled)) throw e;
  });
}

/** The one failure the old `catch` could not tell apart from "no file yet". */
function makeAppendFail(): void {
  mockAppendFile.mockRejectedValue(
    Object.assign(new Error("EACCES: permission denied, open '.gitignore'"), { code: 'EACCES' }),
  );
}

test('a failing append leaves .gitignore byte-for-byte unchanged and exits non-zero', async () => {
  fs.writeFileSync(gitignorePath, EXISTING_GITIGNORE);
  makeAppendFail();

  await runInit();

  expect(fs.readFileSync(gitignorePath, 'utf-8')).toBe(EXISTING_GITIGNORE);
  expect(exitSpy).toHaveBeenCalledWith(1);
  expect(exitSpy.mock.calls.every(([code]) => code !== 0)).toBe(true);
});

test('writes context.json before it touches .gitignore — the append is genuinely reached', async () => {
  fs.writeFileSync(gitignorePath, EXISTING_GITIGNORE);
  makeAppendFail();

  await runInit();

  expect(mockAppendFile).toHaveBeenCalled();
  expect(JSON.parse(fs.readFileSync(contextFile, 'utf-8')).scope.collectionId).toBe('coll-1');
});

test('creates .gitignore when there is none', async () => {
  await runInit();

  expect(fs.readFileSync(gitignorePath, 'utf-8')).toContain('.favro/');
  expect(exitSpy).not.toHaveBeenCalled();
});

test('appends to an existing .gitignore, keeping every line already in it', async () => {
  fs.writeFileSync(gitignorePath, EXISTING_GITIGNORE);

  await runInit();

  const after = fs.readFileSync(gitignorePath, 'utf-8');
  expect(after.startsWith(EXISTING_GITIGNORE)).toBe(true);
  expect(after).toContain('.favro/');
  expect(exitSpy).not.toHaveBeenCalled();
});

test('leaves a .gitignore that already ignores .favro/ completely alone', async () => {
  const already = `${EXISTING_GITIGNORE}.favro/\n`;
  fs.writeFileSync(gitignorePath, already);

  await runInit();

  expect(fs.readFileSync(gitignorePath, 'utf-8')).toBe(already);
  expect(mockAppendFile).not.toHaveBeenCalled();
  expect(exitSpy).not.toHaveBeenCalled();
});

test('an unreadable .gitignore refuses rather than replacing it', async () => {
  fs.writeFileSync(gitignorePath, EXISTING_GITIGNORE);
  mockReadFile.mockImplementation((p: unknown, ...rest: unknown[]) =>
    String(p).endsWith('.gitignore')
      ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
      : (realFsp.readFile as (...a: unknown[]) => unknown)(p, ...rest),
  );

  await runInit();

  expect(fs.readFileSync(gitignorePath, 'utf-8')).toBe(EXISTING_GITIGNORE);
  expect(exitSpy).toHaveBeenCalledWith(1);
});
