/**
 * `favro scope set|show|clear` — the user-facing surface of the scope lock (#100).
 *
 * The lock is the guardrail every write rests on, so what matters here is not
 * that the command prints something: it is that `set` only persists a
 * collection it could VERIFY, that `clear` actually removes both keys, and that
 * `show` reports the state the config is really in.
 */
import { Command } from 'commander';
import { registerScopeCommand } from '../../commands/scope';
import * as config from '../../lib/config';
import * as clientFactory from '../../lib/client-factory';
import CollectionsAPI from '../../lib/collections-api';

jest.mock('../../lib/config');
jest.mock('../../lib/client-factory');
jest.mock('../../lib/collections-api');

const MockCollections = CollectionsAPI as jest.MockedClass<typeof CollectionsAPI>;

let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
let exitSpy: jest.SpyInstance;
let stored: Record<string, unknown>;

function written(): Record<string, unknown> | undefined {
  const calls = (config.writeConfig as jest.Mock).mock.calls;
  return calls.length ? (calls[calls.length - 1][0] as Record<string, unknown>) : undefined;
}

async function runCli(args: string[]): Promise<void> {
  const program = new Command();
  program.option('--verbose', 'Show stack traces');
  registerScopeCommand(program);
  program.exitOverride();
  await program.parseAsync(['node', 'favro', ...args]);
}

beforeEach(() => {
  jest.clearAllMocks();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

  stored = {};
  (config.readConfig as jest.Mock).mockImplementation(async () => stored);
  (config.writeConfig as jest.Mock).mockResolvedValue(undefined);
  (clientFactory.createFavroClient as jest.Mock).mockResolvedValue({});
  MockCollections.mockImplementation(
    () => ({ getCollection: jest.fn().mockResolvedValue({ collectionId: 'coll-1', name: 'Platform' }) } as any),
  );
});

afterEach(() => {
  jest.restoreAllMocks();
});

const output = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');

describe('scope set', () => {
  test('persists the id AND the verified name, and says what is now locked', async () => {
    await runCli(['scope', 'set', 'coll-1']);

    expect(written()).toMatchObject({ scopeCollectionId: 'coll-1', scopeCollectionName: 'Platform' });
    expect(output()).toContain('Platform');
    expect(output()).toContain('coll-1');
  });

  test('an unverifiable collection locks NOTHING — the config is never written', async () => {
    MockCollections.mockImplementation(
      () => ({ getCollection: jest.fn().mockRejectedValue(new Error('404 collection not found')) } as any),
    );

    await runCli(['scope', 'set', 'ghost']);

    expect(config.writeConfig).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('404 collection not found');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('scope show', () => {
  test('reports the locked collection by name when one is set', async () => {
    stored = { scopeCollectionId: 'coll-1', scopeCollectionName: 'Platform' };

    await runCli(['scope', 'show']);

    expect(output()).toContain('Platform');
    expect(output()).toContain('coll-1');
  });

  test('falls back to the id when only the id was stored', async () => {
    stored = { scopeCollectionId: 'coll-1' };

    await runCli(['scope', 'show']);

    expect(output()).toContain('coll-1');
    expect(output()).not.toContain('undefined');
  });

  test('says writes are unrestricted when no lock is set — silence would read as locked', async () => {
    stored = {};

    await runCli(['scope', 'show']);

    expect(output()).toMatch(/No scope set|unrestricted/);
  });
});

describe('scope clear', () => {
  test('removes both keys rather than blanking them', async () => {
    stored = { scopeCollectionId: 'coll-1', scopeCollectionName: 'Platform', email: 'a@b.c' };

    await runCli(['scope', 'clear']);

    const after = written()!;
    expect('scopeCollectionId' in after).toBe(false);
    expect('scopeCollectionName' in after).toBe(false);
    // Unrelated config survives — clear unlocks, it does not reset.
    expect(after.email).toBe('a@b.c');
    expect(output()).toContain('cleared');
  });

  test('is a no-op when nothing is locked — no config rewrite', async () => {
    stored = {};

    await runCli(['scope', 'clear']);

    expect(config.writeConfig).not.toHaveBeenCalled();
    expect(output()).toContain('No scope lock currently set.');
  });
});
