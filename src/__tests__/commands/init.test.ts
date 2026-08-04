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

let errorSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;
let stdoutSpy: jest.SpyInstance;
let exitSpy: jest.SpyInstance;
let clientGet: jest.Mock;

async function runCli(args: string[]): Promise<void> {
  const program = new Command();
  program.option('--human').option('--pretty').option('--verbose', 'Show stack traces');
  registerInitCommand(program);
  program.exitOverride();
  await program.parseAsync(['node', 'favro', '--human', ...args]);
}

/** The same run without `--human`: the machine path, which is the default. */
async function runJson(args: string[]): Promise<void> {
  const program = new Command();
  program.option('--human').option('--pretty').option('--verbose');
  registerInitCommand(program);
  program.exitOverride();
  await program.parseAsync(['node', 'favro', ...args]);
}

/** The context.json the command actually wrote. */
function writtenContext(): any {
  const call = mockFs.writeFile.mock.calls.find(([p]) => String(p).endsWith('context.json'));
  return JSON.parse(String(call![1]));
}

const errors = () => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');

beforeEach(() => {
  jest.clearAllMocks();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {}); // progress chatter — silenced, mostly not asserted
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  process.exitCode = undefined;
  exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit must not be called under run()');
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
  process.exitCode = undefined;
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
    expect(process.exitCode).toBe(1);
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

  test('the slug is the same whichever normalisation form the board name arrives in', async () => {
    // The slug is a KEY in context.json. A decomposed `Å` is a plain `A` plus a
    // combining ring: `[åä]` never saw it and `[^a-z0-9]+` turned it into a
    // separator, so the same visible board name produced two different keys
    // depending on where it was typed (#141).
    const name = 'Åtgärder & Förbättringar';
    MockBoards.prototype.listBoardsByCollection = jest
      .fn()
      .mockResolvedValue([{ boardId: 'b', name: name.normalize('NFD') }]);

    await runCli(['init']);

    expect(Object.keys(writtenContext().boards)).toEqual(['atgarder-forbattringar']);
  });

  test('a board with NO columns is recorded with no `workflow` key at all', async () => {
    // The absent half of the pair below. `/columns` ANSWERED and this board has
    // none, so the omission is a measurement — and it is an omission, not a
    // `workflow: null`: asserted with `in` rather than `toBeUndefined`, which
    // passes identically for a missing key and a key holding `undefined` and so
    // cannot tell absent from empty (the trap #149 hit at eight sites).
    MockColumns.prototype.listColumns = jest.fn().mockResolvedValue([]);

    await runCli(['init']);

    const board = writtenContext().boards['sprint-42'];
    expect('workflow' in board).toBe(false);
    expect(board.boardId).toBe('board-a');
    expect(process.exitCode).toBeUndefined();
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

  test('a malformed field stops the write instead of silently truncating the map', async () => {
    // The `catch {}` used to wrap the whole 20-line transform, not just the
    // fetch it was written for. `customFields[field.name] = entry` mutates the
    // outer object INSIDE the loop, so a throw at field N left 1..N-1 in the
    // map, swallowed the error, and fell through to `writeFile`. The result
    // was a context.json that looked complete while missing every custom field
    // after the bad one — and every agent reading it later could not set those
    // fields and had no way to know they existed.
    MockFields.prototype.listFields = jest.fn().mockResolvedValue([
      { fieldId: 'f-1', name: 'First', type: 'Text', widgetCommonId: 'board-a' },
      { fieldId: 'f-2', name: 'Bad', type: 'Single select', widgetCommonId: 'board-a', options: [null] },
      { fieldId: 'f-3', name: 'Third', type: 'Text', widgetCommonId: 'board-a' },
    ]);

    await runCli(['init']);

    expect(mockFs.writeFile).not.toHaveBeenCalledWith(
      '/repo/.favro/context.json',
      expect.any(String),
      'utf-8',
    );
    expect(process.exitCode).toBe(1);
  });

  test('an org with NO board-local custom fields writes an empty map, and that is a finding', async () => {
    // The other absent/empty pair. `listFields` ANSWERED with rows, none of
    // which survive the board-local filter, so `{}` here means "none" — which
    // is only true because a FAILED read can no longer produce the same `{}`
    // (see the refusal arms below).
    MockFields.prototype.listFields = jest
      .fn()
      .mockResolvedValue([{ fieldId: 'f-9', name: 'Org wide', type: 'Text' }]);

    await runCli(['init']);

    const ctx = writtenContext();
    expect('customFields' in ctx).toBe(true);
    expect(ctx.customFields).toEqual({});
    expect(process.exitCode).toBeUndefined();
  });

  test('a column with no name keeps the rest of the board’s workflow', async () => {
    // `detectStage(name)` called `name.toLowerCase()` unguarded, so a nameless
    // column threw a TypeError that the surrounding `catch {}` swallowed —
    // taking the WHOLE board's workflow with it, with no warning and exit 0.
    MockColumns.prototype.listColumns = jest.fn().mockResolvedValue([
      { columnId: 'col-1', name: 'Backlog' },
      { columnId: 'col-2' },
      { columnId: 'col-3', name: 'Done' },
    ]);

    await runCli(['init']);

    const workflow = writtenContext().boards['sprint-42'].workflow;
    expect(workflow).toHaveLength(3);
    expect(workflow[1].stage).toBe('queued');
    // `next` is declared `string | null`, so a nameless neighbour is null —
    // not `undefined`, which JSON drops and which the type does not allow.
    expect(workflow[0].next).toBeNull();
  });

  test('keeps only users the collection is shared with', async () => {
    MockMembers.prototype.getMembers = jest.fn().mockResolvedValue([
      { id: 'u-1', name: 'Alice', email: 'alice@example.com', role: 'admin' },
      { id: 'u-2', name: 'Bob', email: 'bob@example.com' },
    ]);

    await runCli(['init']);

    expect(Object.keys(writtenContext().team)).toEqual(['u-1']);
  });

  // This test used to read "keeps everyone when the collection membership
  // cannot be read", and it passed. That was the bug, asserted: the `catch {}`
  // around the membership fetch left `collectionUserIds` undefined, the loop
  // below applied NO filter, and a 403 on `/collections/:id` turned "the six
  // people on this collection" into "all 140 people in the org, with emails,
  // written to a file this same command force-adds to .gitignore".
  //
  // A privacy filter that cannot run must not be skipped. The command still
  // completes — one sub-fetch failing should not block a bootstrap — but it
  // completes with nobody rather than everybody, says so on stderr, and
  // records the reason in the file so an agent reading it does not conclude
  // the collection is empty.
  test('writes NOBODY, loudly, when the collection membership cannot be read', async () => {
    clientGet.mockRejectedValue(new Error('403'));
    MockMembers.prototype.getMembers = jest.fn().mockResolvedValue([
      { id: 'u-1', name: 'Alice', email: 'alice@example.com' },
      { id: 'u-2', name: 'Bob', email: 'bob@example.com' },
    ]);

    await runCli(['init']);

    const written = writtenContext();
    expect(written.team).toEqual({});
    expect(JSON.stringify(written)).not.toContain('bob@example.com');
    expect(errors()).toMatch(/could not read.*membership/i);
    expect(written.notes.team).toMatch(/could not be read/i);
  });

  test('a membership response with no sharedToUsers is also treated as unreadable', async () => {
    // `sharedToUsers` absent is not "shared with everyone" — it is the same
    // unknown as a 403, and it used to take the same fail-open path.
    clientGet.mockResolvedValue({});
    MockMembers.prototype.getMembers = jest.fn().mockResolvedValue([
      { id: 'u-1', name: 'Alice', email: 'alice@example.com' },
    ]);

    await runCli(['init']);

    expect(writtenContext().team).toEqual({});
  });

  test('a readable EMPTY membership is a real answer, not a failure', async () => {
    // Distinct from the two above: the filter RAN and matched nobody. No
    // warning, no note — the file is correct as written.
    clientGet.mockResolvedValue({ sharedToUsers: [] });

    await runCli(['init']);

    expect(writtenContext().team).toEqual({});
    expect(writtenContext().notes.team).toBeUndefined();
  });
});

/**
 * The three reads that used to answer a rejection with `[]` (#154).
 *
 * Each arm fails ONE read and leaves the other two HEALTHY — deliberately not a
 * blanket rejection, which cannot tell a handler that propagates from one that
 * swallows, because under a blanket rejection every arm dies at the first read
 * either way. So each arm carries a message unique to its own read and asserts
 * that message reached stderr: that is what pins WHICH read propagated, rather
 * than merely that the run did not finish.
 *
 * The counterpart assertion — that the healthy two thirds of the fetch did not
 * reach disk — is `writeFile` not called with `context.json`. On a real disk,
 * asserted in both polarities, that lives in `init-clobber.test.ts`.
 */
/** A read that answered 403 — classified, so deterministic. */
const forbidden = (what: string) =>
  Object.assign(new Error(`403 ${what} forbidden`), {
    isAxiosError: true,
    response: { status: 403, data: { message: `403 ${what} forbidden` } },
  });

/** A read that never got a response at all — the transient family. */
const reset = () => Object.assign(new Error('ECONNRESET socket hang up'), { isAxiosError: true });

const FACETS: [string, (e: Error) => void, string][] = [
  ['columns', (e) => { MockColumns.prototype.listColumns = jest.fn().mockRejectedValue(e); }, 'columns'],
  ['custom fields', (e) => { MockFields.prototype.listFields = jest.fn().mockRejectedValue(e); }, 'customfields'],
  ['team members', (e) => { MockMembers.prototype.getMembers = jest.fn().mockRejectedValue(e); }, 'users'],
];

describe.each(FACETS)('init — an unreadable %s facet is never written as an empty one', (_facet, failWith, what) => {
  const breakIt = () => failWith(forbidden(what));
  const breakTransport = () => failWith(reset());
  const wording = `403 ${what} forbidden`;

  test('writes no context.json, exits 1, and says which read failed', async () => {
    breakIt();

    await runCli(['init']);

    expect(mockFs.writeFile).not.toHaveBeenCalledWith(
      '/repo/.favro/context.json',
      expect.any(String),
      'utf-8',
    );
    expect(errors()).toContain(wording);
    expect(process.exitCode).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test('a TRANSPORT failure on the same read is reported RETRYABLE', async () => {
    // Why the errors propagate RAW instead of being wrapped in a
    // `RefusalError`, and the one arm where the two differ. A `RefusalError`
    // asserts `retryable: false` unconditionally; a socket reset is the case
    // where that is a lie, and `retryAdvice` gets it right only if the axios
    // stamp survives to the boundary. (A classified 403 comes out `false` either
    // way, which is why this arm uses a transport failure and not the 403
    // above.) Machine mode is the default, so the envelope is on stdout.
    breakTransport();

    await runJson(['init']);

    const envelope = JSON.parse(
      logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.trimStart().startsWith('{'))!,
    );
    expect(envelope.error.message).toContain('ECONNRESET');
    expect(envelope.error.retryable).toBe(true);
  });
});

describe('init — the guards around the write', () => {
  test('all three reads healthy still writes the file — the control for the arms above', async () => {
    // Without this, every arm above could be passing because the pipeline never
    // reaches the write at all.
    await runCli(['init']);

    expect(mockFs.writeFile).toHaveBeenCalledWith(
      '/repo/.favro/context.json',
      expect.any(String),
      'utf-8',
    );
    expect(process.exitCode).toBeUndefined();
  });

  test('refuses to clobber an existing context.json', async () => {
    mockFs.access.mockResolvedValue(undefined);

    await runCli(['init']);

    expect(mockFs.writeFile).not.toHaveBeenCalled();
    expect(errors()).toContain('already exists');
    expect(process.exitCode).toBe(1);
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
    // `code`, not just a message: only ENOENT reads as "there is no file,
    // create one" now, and every other read failure propagates rather than
    // writing two lines over a file it could not see (#144).
    mockFs.readFile.mockRejectedValue(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }));

    await runCli(['init']);

    expect(mockFs.writeFile).toHaveBeenCalledWith('/repo/.gitignore', expect.stringContaining('.favro/'));
  });

  test('--json prints the context and touches no file at all', async () => {
    mockFs.access.mockResolvedValue(undefined);

    // The one arm of `init` that is not `void`: the context is returned as an
    // `item` and the RUNNER writes it, so it lands on `console.log` rather than
    // the bare `process.stdout.write` this command used to do for itself (#118).
    await runJson(['init', '--json']);

    expect(mockFs.writeFile).not.toHaveBeenCalled();
    expect(mockFs.mkdir).not.toHaveBeenCalled();
    const printed = JSON.parse(
      logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.trimStart().startsWith('{'))!,
    );
    expect(printed.scope.collectionId).toBe('coll-1');
  });

  test('a failed board listing writes nothing and exits 1', async () => {
    MockBoards.prototype.listBoardsByCollection = jest.fn().mockRejectedValue(new Error('502 upstream'));

    await runCli(['init']);

    expect(mockFs.writeFile).not.toHaveBeenCalled();
    expect(errors()).toContain('502 upstream');
    expect(process.exitCode).toBe(1);
  });
});
