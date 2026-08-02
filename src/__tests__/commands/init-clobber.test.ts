/**
 * `favro init` refuses to clobber an existing context.json — on a REAL disk (#131).
 *
 * WHY THIS IS NOT JUST ANOTHER CASE IN `init.test.ts`
 * That file mocks `fs/promises` wholesale, so its clobber test proves only that
 * `writeFile` was not *called*. The thing the guard actually protects is a file
 * on disk carrying team emails, and the check that decides whether to protect
 * it is a real `fs.access` against a real path. Mocked, neither of those runs.
 * So this suite writes a sentinel file, invokes the command, and reads the
 * bytes back.
 *
 * It is also the test the bug made impossible. The guard's `process.exit(1)`
 * used to sit inside a `catch {}` that meant "no file yet"; a `process.exit`
 * stub — the pattern the rest of the suite relies on precisely because a
 * returning stub lets code run past a refusal — was swallowed by it, and
 * execution fell through into the write.
 *
 * EVERY API IS STUBBED TO SUCCEED, AND THAT IS THE POINT
 * The first draft of this file stubbed only the client factory, with an inert
 * client. Deleting the guard did not turn it red: the run died resolving the
 * collection, long before the write, so the sentinel survived for a reason that
 * had nothing to do with the guard. It asserted "the file is intact" while
 * proving only "the command crashed early" — the same shape of dead test #131
 * exists to kill. Stubbing the whole pipeline to succeed means the write is
 * reached, so the guard is the only thing that can stop it. `writes the file
 * when there is nothing in the way` is the control that keeps it that way: it
 * fails the moment this pipeline stops reaching the write.
 *
 * ISOLATION
 * `FAVRO_CONFIG_DIR` is pointed at a temp dir before anything is required, so
 * `readConfig()` cannot reach the developer's own `~/.favro`. The repo the
 * command thinks it is in is a second temp dir, handed over by stubbing
 * `process.cwd()` rather than by `chdir` — a real chdir leaks into every other
 * suite sharing the worker. Both are removed after the run.
 */
import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'favro-cli-init-config-'));
fs.writeFileSync(path.join(CONFIG_DIR, 'config.json'), JSON.stringify({ scopeCollectionId: 'coll-1' }));
process.env.FAVRO_CONFIG_DIR = CONFIG_DIR;

// `fs/promises` is deliberately NOT mocked — the disk is the subject here.
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

/** The sentinel. Deliberately not valid context.json — any rewrite changes it. */
const SENTINEL = '{"do-not":"clobber me"}\n';

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

let repoDir: string;
let contextFile: string;
let exitSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();

  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'favro-cli-init-repo-'));
  contextFile = path.join(repoDir, '.favro', 'context.json');
  fs.mkdirSync(path.dirname(contextFile));
  fs.writeFileSync(contextFile, SENTINEL);

  jest.spyOn(process, 'cwd').mockReturnValue(repoDir);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  // Throwing, not returning: a returning stub cannot distinguish "the guard
  // stopped the run" from "the guard was ignored and the run finished".
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

test('leaves an existing context.json byte-for-byte unchanged and exits non-zero', async () => {
  await runInit();

  expect(fs.readFileSync(contextFile, 'utf-8')).toBe(SENTINEL);
  expect(exitSpy).toHaveBeenCalledWith(1);
  expect(exitSpy.mock.calls.every(([code]) => code !== 0)).toBe(true);
});

test('the refusal names the file in the way and both ways past it', async () => {
  await runInit();

  const stderr = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
  expect(stderr).toContain('.favro/context.json already exists');
  expect(stderr).toContain('--refresh');
  expect(stderr).toContain('--json');
});

test('writes the file when there is nothing in the way — the guard is the only thing stopping it', async () => {
  fs.rmSync(contextFile);

  await runInit();

  expect(JSON.parse(fs.readFileSync(contextFile, 'utf-8')).scope.collectionId).toBe('coll-1');
  expect(exitSpy).not.toHaveBeenCalled();
});

test('--refresh overwrites the real file on disk', async () => {
  await runInit('--refresh');

  expect(fs.readFileSync(contextFile, 'utf-8')).not.toBe(SENTINEL);
  expect(exitSpy).not.toHaveBeenCalled();
});
