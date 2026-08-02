/**
 * `favro init` — behaviour (#100).
 *
 * It writes one file, and that file is what every later agent reads instead of
 * asking Favro again. So what matters is the CONTENT: which boards, which
 * custom fields survive the client-side filter, which users survive the
 * collection filter — plus the two guards around the write itself (refuse to
 * clobber, and keep `.favro/` out of git, because the file carries emails).
 */
import { Command } from 'commander';
import * as fs from 'fs/promises';
import { registerInitCommand } from '../../commands/init';
import * as config from '../../lib/config';
import * as clientFactory from '../../lib/client-factory';
import BoardsAPI from '../../lib/boards-api';
import { ColumnsAPI } from '../../lib/columns-api';
import CollectionsAPI from '../../lib/collections-api';
import { CustomFieldsAPI } from '../../lib/custom-fields-api';
import { FavroApiClient } from '../../api/members';

jest.mock('fs/promises');
jest.mock('../../lib/config');
jest.mock('../../lib/client-factory');
jest.mock('../../lib/boards-api');
jest.mock('../../lib/columns-api');
jest.mock('../../lib/collections-api');
jest.mock('../../lib/custom-fields-api');
jest.mock('../../api/members');

const mockFs = fs as jest.Mocked<typeof fs>;
const MockBoards = BoardsAPI as jest.MockedClass<typeof BoardsAPI>;
const MockColumns = ColumnsAPI as jest.MockedClass<typeof ColumnsAPI>;
const MockCollections = CollectionsAPI as jest.MockedClass<typeof CollectionsAPI>;
const MockFields = CustomFieldsAPI as jest.MockedClass<typeof CustomFieldsAPI>;
const MockMembers = FavroApiClient as jest.MockedClass<typeof FavroApiClient>;

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

let errorSpy: jest.SpyInstance;
let stdoutSpy: jest.SpyInstance;
let exitSpy: jest.SpyInstance;
let clientGet: jest.Mock;

async function runCli(args: string[]): Promise<void> {
  const program = new Command();
  program.option('--verbose', 'Show stack traces');
  registerInitCommand(program);
  program.exitOverride();
  await program.parseAsync(['node', 'favro', ...args]).catch((e) => {
    if (!(e instanceof ExitCalled)) throw e;
  });
}

/** The context.json the command actually wrote. */
function writtenContext(): any {
  const call = mockFs.writeFile.mock.calls.find(([p]) => String(p).endsWith('context.json'));
  return JSON.parse(String(call![1]));
}

const errors = () => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {}); // progress chatter — silenced, not asserted
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitCalled(code ?? 0);
  }) as never);
  jest.spyOn(process, 'cwd').mockReturnValue('/repo');

  (config.readConfig as jest.Mock).mockResolvedValue({ scopeCollectionId: 'coll-1', scopeCollectionName: 'Fallback' });
  clientGet = jest.fn().mockResolvedValue({ sharedToUsers: [{ userId: 'u-1' }] });
  (clientFactory.createFavroClient as jest.Mock).mockResolvedValue({ get: clientGet });

  // No context.json yet.
  mockFs.access.mockRejectedValue(new Error('ENOENT'));
  mockFs.mkdir.mockResolvedValue(undefined as never);
  mockFs.writeFile.mockResolvedValue(undefined);
  mockFs.appendFile.mockResolvedValue(undefined);
  mockFs.readFile.mockResolvedValue('node_modules/\n' as never);

  MockCollections.prototype.getCollection = jest.fn().mockResolvedValue({ collectionId: 'coll-1', name: 'Platform' });
  MockBoards.prototype.listBoardsByCollection = jest
    .fn()
    .mockResolvedValue([{ boardId: 'board-a', name: 'Sprint 42', type: 'backlog' }]);
  MockColumns.prototype.listColumns = jest.fn().mockResolvedValue([
    { columnId: 'col-1', name: 'Backlog' },
    { columnId: 'col-2', name: 'Done' },
  ]);
  MockFields.prototype.listFields = jest.fn().mockResolvedValue([]);
  MockMembers.prototype.getMembers = jest
    .fn()
    .mockResolvedValue([{ id: 'u-1', name: 'Alice', email: 'alice@example.com', role: 'admin' }]);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('init — resolving the collection', () => {
  test('uses the locked collection when no --collection is given', async () => {
    await runCli(['init']);

    expect(MockBoards.prototype.listBoardsByCollection).toHaveBeenCalledWith('coll-1');
    expect(writtenContext().scope).toEqual({ collectionId: 'coll-1', collectionName: 'Platform' });
  });

  test('--collection overrides the lock', async () => {
    await runCli(['init', '--collection', 'coll-9']);

    expect(MockBoards.prototype.listBoardsByCollection).toHaveBeenCalledWith('coll-9');
  });

  test('with no collection anywhere it refuses and points at `scope set`', async () => {
    (config.readConfig as jest.Mock).mockResolvedValue({});

    await runCli(['init']);

    expect(mockFs.writeFile).not.toHaveBeenCalled();
    expect(errors()).toContain('favro scope set');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('an unreadable collection falls back to the stored name rather than failing', async () => {
    MockCollections.prototype.getCollection = jest.fn().mockRejectedValue(new Error('403'));

    await runCli(['init']);

    expect(writtenContext().scope.collectionName).toBe('Fallback');
  });
});

describe('init — the file it writes', () => {
  test('keys boards by a slug and turns columns into a linked workflow', async () => {
    await runCli(['init']);

    const ctx = writtenContext();
    expect(Object.keys(ctx.boards)).toEqual(['sprint-42']);
    expect(ctx.boards['sprint-42']).toMatchObject({ boardId: 'board-a', name: 'Sprint 42', type: 'backlog' });
    expect(ctx.boards['sprint-42'].workflow).toEqual([
      { columnId: 'col-1', name: 'Backlog', stage: expect.any(String), next: 'Done' },
      { columnId: 'col-2', name: 'Done', stage: expect.any(String), next: null },
    ]);
  });

  test('slugs fold Swedish vowels and cap the length, so a board name is always a legal key', async () => {
    MockBoards.prototype.listBoardsByCollection = jest
      .fn()
      .mockResolvedValue([{ boardId: 'b', name: 'Åtgärder & Förbättringar i Produktionsmiljön' }]);

    await runCli(['init']);

    const [slug] = Object.keys(writtenContext().boards);
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(slug.length).toBeLessThanOrEqual(30);
    expect(slug.startsWith('atgarder-forbattringar')).toBe(true);
  });

  test('a board whose columns cannot be read is still recorded, just without a workflow', async () => {
    MockColumns.prototype.listColumns = jest.fn().mockRejectedValue(new Error('400 no widgetCommonId'));

    await runCli(['init']);

    expect(writtenContext().boards['sprint-42'].workflow).toBeUndefined();
  });

  test('keeps only board-local custom fields belonging to our boards, and inlines their options', async () => {
    MockFields.prototype.listFields = jest.fn().mockResolvedValue([
      { fieldId: 'f-1', name: 'Priority', type: 'Single select', widgetCommonId: 'board-a', options: [{ name: 'High', optionId: 'o-1' }] },
      { fieldId: 'f-2', name: 'Other board', type: 'Number', widgetCommonId: 'board-z' },
      { fieldId: 'f-3', name: 'Org wide', type: 'Text' },
      { fieldId: 'f-4', type: 'Text', widgetCommonId: 'board-a' },
    ]);

    await runCli(['init']);

    const fields = writtenContext().customFields;
    expect(Object.keys(fields)).toEqual(['Priority']);
    expect(fields.Priority).toEqual({ fieldId: 'f-1', type: 'Single select', options: { High: 'o-1' } });
  });

  test('keeps only users the collection is shared with', async () => {
    MockMembers.prototype.getMembers = jest.fn().mockResolvedValue([
      { id: 'u-1', name: 'Alice', email: 'alice@example.com', role: 'admin' },
      { id: 'u-2', name: 'Bob', email: 'bob@example.com' },
    ]);

    await runCli(['init']);

    expect(Object.keys(writtenContext().team)).toEqual(['u-1']);
  });

  test('keeps everyone when the collection membership cannot be read', async () => {
    clientGet.mockRejectedValue(new Error('403'));
    MockMembers.prototype.getMembers = jest.fn().mockResolvedValue([
      { id: 'u-1', name: 'Alice', email: 'alice@example.com' },
      { id: 'u-2', name: 'Bob', email: 'bob@example.com' },
    ]);

    await runCli(['init']);

    expect(Object.keys(writtenContext().team)).toEqual(['u-1', 'u-2']);
  });
});

describe('init — the guards around the write', () => {
  test('refuses to clobber an existing context.json', async () => {
    mockFs.access.mockResolvedValue(undefined);

    await runCli(['init']);

    expect(mockFs.writeFile).not.toHaveBeenCalled();
    expect(errors()).toContain('already exists');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('--refresh overwrites it deliberately', async () => {
    mockFs.access.mockResolvedValue(undefined);

    await runCli(['init', '--refresh']);

    expect(mockFs.writeFile).toHaveBeenCalledWith('/repo/.favro/context.json', expect.any(String), 'utf-8');
  });

  test('adds .favro/ to .gitignore — the file carries team emails', async () => {
    await runCli(['init']);

    expect(mockFs.appendFile).toHaveBeenCalledWith('/repo/.gitignore', expect.stringContaining('.favro/'));
  });

  test('does not add it twice when it is already ignored', async () => {
    mockFs.readFile.mockResolvedValue('node_modules/\n.favro/\n' as never);

    await runCli(['init']);

    expect(mockFs.appendFile).not.toHaveBeenCalled();
  });

  test('creates a .gitignore when the repo has none', async () => {
    mockFs.readFile.mockRejectedValue(new Error('ENOENT'));

    await runCli(['init']);

    expect(mockFs.writeFile).toHaveBeenCalledWith('/repo/.gitignore', expect.stringContaining('.favro/'));
  });

  test('--json prints the context and touches no file at all', async () => {
    mockFs.access.mockResolvedValue(undefined);

    await runCli(['init', '--json']);

    expect(mockFs.writeFile).not.toHaveBeenCalled();
    expect(mockFs.mkdir).not.toHaveBeenCalled();
    const printed = JSON.parse(stdoutSpy.mock.calls.map((c) => String(c[0])).join(''));
    expect(printed.scope.collectionId).toBe('coll-1');
  });

  test('a failed board listing writes nothing and exits 1', async () => {
    MockBoards.prototype.listBoardsByCollection = jest.fn().mockRejectedValue(new Error('502 upstream'));

    await runCli(['init']);

    expect(mockFs.writeFile).not.toHaveBeenCalled();
    expect(errors()).toContain('502 upstream');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
