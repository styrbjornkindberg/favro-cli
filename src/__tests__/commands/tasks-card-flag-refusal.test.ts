/**
 * The refusal for a task write that named no card says `--card` (#126).
 *
 * `tasks update|complete|delete` name a `taskId` and nothing else, so under a
 * scope lock the board resolves to `''` and the shared check refuses. Correct,
 * and until now it refused with `assertScope`'s GENERIC boardless wording, whose
 * two causes are both false here and whose remedy — `favro cards get
 * <cardCommonId>` — cannot be run from a taskId. The flag the caller actually
 * needs appeared nowhere in it.
 *
 * `safety.ts` is NOT mocked in this file, and that is the point. A stubbed
 * `checkScope` would let every assertion below pass against a hand-built error,
 * proving that a `ScopeError` somebody constructed renders nicely rather than
 * that the lock produces one. `card-child-scope.test.ts` stubs it deliberately —
 * it is asking which board reached the lock — so the wording it would have to
 * assert is asserted here instead, against the real `assertScope`.
 *
 * Four arms, because a message test is the easiest unfalsifiable test to write
 * and `toContain('--card')` alone would pass on a `--help` dump:
 *
 *   1. FLAG      — lock, no `--card`: the new wording, pinned to the error object
 *                  that actually reached the reporter, and NOT equal to the shared
 *                  guard's own boardless message.
 *   2. OMIT      — no lock, no `--card`: no refusal at all, and the write runs.
 *                  The other polarity of arm 1's "the write did not happen".
 *   3. FOREIGN   — lock, `--card` at an out-of-lock board: the real out-of-lock
 *                  refusal, byte for byte.
 *   4. UNREADABLE— lock, `--card` at a card that cannot be read: the GENERIC
 *                  boardless refusal, byte for byte. Both of its causes are live
 *                  here, so this is the arm the new wording must stay out of.
 *
 * Arms 3 and 4 compare against what `assertScope` itself returns for the same
 * input rather than against a copied string literal. Byte-for-byte either way,
 * but drift-proof: `safety.ts` may reword freely and these keep asserting the
 * claim that matters — the CLI's refusal IS the shared guard's refusal.
 */
import { Command } from 'commander';
import { registerTasksCommands } from '../../commands/tasks';
import * as config from '../../lib/config';
import { assertScope, ScopeError } from '../../lib/safety';
import { retryAdvice } from '../../lib/dispatch';
import { RefusalError } from '../../lib/refusal';
import { logError } from '../../lib/error-handler';
import FavroHttpClient from '../../lib/http-client';
import CardsAPI from '../../lib/cards-api';
import TasksAPI from '../../lib/tasks-api';
import { FavroConfig } from '../../lib/config';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../lib/cards-api');
jest.mock('../../lib/tasks-api');

// The reporter, recorded AND called through. `logError` is the single funnel every
// legacy `catch` in `tasks.ts` uses, so its first argument is the error object the
// user's refusal was rendered from — and rendering still happens, so the stream
// assertions below are about real output rather than a swallowed call.
jest.mock('../../lib/error-handler', () => {
  const real = jest.requireActual('../../lib/error-handler');
  return { ...real, logError: jest.fn(real.logError) };
});

const MockHttpClient = FavroHttpClient as jest.MockedClass<typeof FavroHttpClient>;
const MockCardsAPI = CardsAPI as jest.MockedClass<typeof CardsAPI>;
const MockTasksAPI = TasksAPI as jest.MockedClass<typeof TasksAPI>;
const reported = logError as jest.Mock;

const LOCK = {
  apiKey: 'k',
  email: 'a@b.c',
  organizationId: 'org-1',
  scopeCollectionId: 'coll-locked',
  scopeCollectionName: 'Locked',
} as FavroConfig;

/** Every write named only by a taskId, with the flag omitted. */
const WRITES: Array<[string, string[], () => jest.Mock]> = [
  ['update', ['tasks', 'update', 'task-1', '--name', 'X', '--yes'], () => MockTasksAPI.prototype.updateTask as jest.Mock],
  ['complete', ['tasks', 'complete', 'task-1', '--yes'], () => MockTasksAPI.prototype.updateTask as jest.Mock],
  ['delete', ['tasks', 'delete', 'task-1', '--yes'], () => MockTasksAPI.prototype.deleteTask as jest.Mock],
];

let consoleLog: jest.SpyInstance;
let consoleError: jest.SpyInstance;
let exit: jest.SpyInstance;

async function runCli(args: string[]): Promise<void> {
  const program = new Command();
  program.option('--verbose', 'Show stack traces');
  registerTasksCommands(program);
  program.exitOverride();
  await program.parseAsync(['node', 'favro', ...args]);
}

/** The one error that reached the reporter. Fails loudly on none, or on two. */
function refusal(): Error {
  expect(reported).toHaveBeenCalledTimes(1);
  return reported.mock.calls[0][0] as Error;
}

/** What the shared guard says, unaided, for this board id under this lock. */
async function sharedGuardSays(boardId: string): Promise<string> {
  try {
    await assertScope(boardId, new MockHttpClient({} as never), LOCK);
  } catch (error: any) {
    return error.message;
  }
  throw new Error(`assertScope did not refuse board "${boardId}" — the fixture is wrong`);
}

beforeEach(() => {
  jest.clearAllMocks();
  consoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  exit = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

  (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
  (config.readConfig as jest.Mock).mockResolvedValue(LOCK);

  // `board-x` sits in `coll-other`; nothing sits in `coll-locked`.
  MockHttpClient.prototype.get = jest
    .fn()
    .mockResolvedValue({ name: 'Other Board', collectionIds: ['coll-other'] });
  MockCardsAPI.prototype.getCard = jest.fn().mockResolvedValue({ cardId: 'card-1', boardId: 'board-x' });
  MockTasksAPI.prototype.updateTask = jest.fn().mockResolvedValue({ taskId: 'task-1', name: 'X' });
  MockTasksAPI.prototype.deleteTask = jest.fn().mockResolvedValue(undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ─── arm 1: the flag arm ─────────────────────────────────────────────────────

describe.each(WRITES)('tasks %s under a lock with --card omitted', (_name, argv, writeFn) => {
  it('refuses with a ScopeError every reader still keys on', async () => {
    await runCli(argv);

    const error = refusal();
    // Not `toThrow(ScopeError)`: jest matches that by CONSTRUCTOR NAME up the
    // chain, so a renamed bare `Error` would satisfy it. Each property below is
    // one a real reader reads.
    expect(error).toBeInstanceOf(ScopeError);
    expect(error).toBeInstanceOf(RefusalError);
    // `error-handler.ts` heads the line `Scope violation:` off `.name`, by name
    // and not by instanceof, because importing the class back would be a cycle.
    expect(error.name).toBe('ScopeError');
    // The lock is configuration: the identical call refuses identically until
    // someone runs `favro scope set` (#120).
    expect(retryAdvice('rolled-back', error)).toBe(false);
    expect((error as ScopeError).boardId).toBe('');
    expect((error as ScopeError).scopeCollectionId).toBe('coll-locked');
  });

  it('names --card, and drops the remedy that cannot be run from a taskId', async () => {
    await runCli(argv);

    const message = refusal().message;
    expect(message).toContain('--card <cardCommonId>');
    // `favro cards get` takes a cardCommonId. The caller has a taskId.
    expect(message).not.toContain('cards get');
  });

  it('names the lock that is refusing, by name and not by id', async () => {
    // The generic message names it, and a refusal that will not say WHICH lock
    // stopped the write is a refusal the user cannot act on. Survived a mutation
    // that replaced the interpolation with a literal until this arm existed.
    await runCli(argv);

    expect(refusal().message).toContain('("Locked")');
  });

  it('describes itself the way every other scope refusal does', async () => {
    // `error-handler.ts` heads the line off `.name` AND de-duplicates the
    // message's own prefix, on the documented assumption that the two agree. A
    // message that dropped the prefix would still render almost identically here
    // — `tasks` is unmigrated — and then reach a migrated caller's envelope as
    // the one `ScopeError` in the codebase that does not name itself.
    //
    // Compared against the shared guard's own prefix rather than a literal, so
    // this asserts agreement rather than a spelling.
    await runCli(argv);

    const heading = (m: string) => m.slice(0, m.indexOf(':') + 1);
    expect(heading(refusal().message)).toBe(heading(await sharedGuardSays('')));
    // And printed once, not twice, because the de-duplication depends on it.
    const rendered = consoleError.mock.calls.map((c) => String(c[0])).join('\n');
    expect(rendered.match(/Scope violation:/g)).toHaveLength(1);
  });

  it('is not the shared guard\'s generic boardless wording', async () => {
    // THE DISCRIMINATING ASSERTION. Arm 4 proves that wording still ships where
    // it is true; this proves the reword actually happened rather than the two
    // messages having quietly converged.
    await runCli(argv);

    const generic = await sharedGuardSays('');
    expect(refusal().message).not.toBe(generic);
    expect(generic).not.toContain('--card');
  });

  it('writes the refusal to stderr and exits 1, with nothing on stdout', async () => {
    await runCli(argv);

    // ADR-0002: `tasks` is still an unmigrated `catch { logError; exit(1) }`
    // caller, so its refusal renders to stderr rather than as a stdout envelope.
    // That is #115–#119's job, not this one's; the stream asserted is the one
    // measured on the built CLI.
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Scope violation'));
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('--card <cardCommonId>'));
    expect(consoleLog).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('refuses BEFORE the write, and spends no request resolving nothing', async () => {
    await runCli(argv);

    // Fail-closed. The other polarity of this exact expectation is arm 2, where
    // the same mock IS called — so neither reading is unfalsifiable.
    expect(writeFn()).not.toHaveBeenCalled();
    expect(MockCardsAPI.prototype.getCard).not.toHaveBeenCalled();
  });
});

describe('the lock the refusal names falls back the way the shared guard does', () => {
  // The other polarity of the assertion above: with no friendly name configured,
  // `scopeCollectionName ?? scopeCollectionId` has to reach the id rather than
  // print `undefined`. Both arms, so neither reading is unfalsifiable.
  it.each(WRITES)('tasks %s names the collection id when the lock has no name', async (_name, argv) => {
    (config.readConfig as jest.Mock).mockResolvedValue({
      apiKey: 'k',
      email: 'a@b.c',
      organizationId: 'org-1',
      scopeCollectionId: 'coll-locked',
    });

    await runCli(argv);

    expect(refusal().message).toContain('("coll-locked")');
    expect(refusal().message).not.toContain('undefined');
  });
});

// ─── arm 2: the omit arm — no lock, so no refusal at all ──────────────────────

describe.each(WRITES)('tasks %s with no lock configured and --card omitted', (_name, argv, writeFn) => {
  it('does not refuse, and performs the write', async () => {
    (config.readConfig as jest.Mock).mockResolvedValue({ apiKey: 'k', email: 'a@b.c', organizationId: 'org-1' });

    await runCli(argv);

    expect(reported).not.toHaveBeenCalled();
    expect(writeFn()).toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalledWith(1);
    // #102/#104's criterion: no lock means no extra request on that path.
    expect(MockCardsAPI.prototype.getCard).not.toHaveBeenCalled();
  });
});

// ─── arm 3: the foreign arm — --card given, board outside the lock ────────────

describe.each(WRITES)('tasks %s with --card at a board outside the lock', (_name, argv, writeFn) => {
  it('gets the real out-of-lock refusal, byte for byte', async () => {
    await runCli([...argv, '--card', 'card-1']);

    const error = refusal();
    expect(error.message).toBe(await sharedGuardSays('board-x'));
    // A non-empty boardId is the proof the board RESOLVED and the out-of-lock
    // arm fired, rather than the write falling into the boardless arm again.
    expect((error as ScopeError).boardId).toBe('board-x');
    expect(error.message).not.toContain('--card <cardCommonId>');
    expect(error.message).not.toContain('names no card');
    expect(writeFn()).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });
});

// ─── arm 4: --card given but unreadable — the generic wording is right here ───

describe.each(WRITES)('tasks %s with --card at a card that cannot be read', (_name, argv, writeFn) => {
  it('keeps the generic boardless refusal, byte for byte', async () => {
    MockCardsAPI.prototype.getCard = jest.fn().mockRejectedValue(new Error('404 Not Found'));

    await runCli([...argv, '--card', 'gone']);

    const error = refusal();
    // Both of the generic message's causes are live here — a card WAS named and
    // WAS unreadable — and `cards get` is the right next command, so the new
    // wording must not reach this arm.
    expect(error.message).toBe(await sharedGuardSays(''));
    expect(error.message).toContain('cards get');
    expect(error.message).not.toContain('--card <cardCommonId>');
    // The "reported separately" promise the generic message makes, kept.
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('404 Not Found'));
    expect(writeFn()).not.toHaveBeenCalled();
  });
});

// ─── the type gate: a non-refusal from inside the guard passes through ───────

describe('a non-ScopeError raised inside the guard is not dressed up as one', () => {
  it.each(WRITES)('tasks %s rethrows it untouched', async (_name, argv) => {
    // `createFavroClient` reads config first (1), the guard reads it second (2).
    // Only the second read fails, so the throw happens INSIDE
    // `checkResolvedScope` — the one place the rethrow gate can be reached.
    //
    // The THIRD read resolves, and that is load-bearing rather than tidy: the
    // reword needs a config read of its own for the lock's name. With a blanket
    // `mockRejectedValue` that third read rejects too, so a build with the type
    // gate DELETED still ends up propagating an `Error('config read failed')` and
    // every assertion below passes against it. Mutation testing found exactly
    // that — this arm was unfalsifiable until the third read was made to succeed.
    (config.readConfig as jest.Mock)
      .mockResolvedValueOnce(LOCK)
      .mockRejectedValueOnce(new Error('config read failed'))
      .mockResolvedValue(LOCK);

    await runCli(argv);

    const error = refusal();
    expect(error).not.toBeInstanceOf(ScopeError);
    expect(error.name).toBe('Error');
    expect(error.message).toBe('config read failed');
    // Exactly two: the gate rethrew without reading config for a lock name it was
    // never going to print. A third read means the reword ran on a non-refusal.
    expect((config.readConfig as jest.Mock).mock.calls.length).toBe(2);
  });
});
