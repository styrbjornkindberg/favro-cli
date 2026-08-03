/**
 * Tests for the browse command registration, and for the Ctrl+C path.
 *
 * The Ctrl+C half is the one that carries logic. `enquirer@2.4.1` rejects with
 * the empty STRING when the user interrupts a prompt — measured under a pty,
 * see `src/lib/prompt-cancelled.ts`. The guard here used to read
 * `error?.message === ''`, which is `undefined === ''` for a string and so had
 * never fired: interrupting `favro browse` took the failure path and exited 1.
 */
import { Command } from 'commander';
import { registerBrowseCommand, browseHandler } from '../../commands/browse';
import type { Ctx } from '../../lib/run';

jest.mock('enquirer', () => ({
  Select: jest.fn().mockImplementation(() => ({ run: () => promptResult() })),
}));

/** What the next prompt does. Ctrl+C is a rejection with the bare `''`. */
let promptResult: () => Promise<string> = () => Promise.reject('');

describe('browse command', () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    program.exitOverride(); // prevent process.exit in tests
    promptResult = () => Promise.reject('');
  });

  it('registers the browse command', () => {
    registerBrowseCommand(program);
    const browse = program.commands.find(c => c.name() === 'browse');
    expect(browse).toBeDefined();
    expect(browse!.description()).toContain('Interactive browser');
  });

  it('accepts --board option', () => {
    registerBrowseCommand(program);
    const browse = program.commands.find(c => c.name() === 'browse');
    expect(browse).toBeDefined();
    const boardOpt = browse!.options.find(o => o.long === '--board');
    expect(boardOpt).toBeDefined();
    expect(boardOpt).toBeTruthy();
  });

  it('includes usage examples in description', () => {
    registerBrowseCommand(program);
    const browse = program.commands.find(c => c.name() === 'browse');
    expect(browse!.description()).toContain('favro browse');
    expect(browse!.description()).toContain('--board');
  });

  it('says goodbye on Ctrl+C instead of reporting a failure', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const ctx = {
      api: { collections: { listCollections: jest.fn().mockResolvedValue([{ collectionId: 'c-1', name: 'One' }]) } },
    } as unknown as Ctx;

    // Resolves rather than rejecting: a throw here reaches the runner's error
    // boundary, which is `{"error":{"message":""}}` and exit 1 for a user who
    // simply pressed Ctrl+C.
    await expect(browseHandler(ctx, {})).resolves.toBeUndefined();
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('Goodbye!');

    logSpy.mockRestore();
  });

  it('still reports a real failure rather than swallowing it as a cancellation', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const ctx = {
      api: { collections: { listCollections: jest.fn().mockRejectedValue(new Error('403 Forbidden')) } },
    } as unknown as Ctx;

    await expect(browseHandler(ctx, {})).rejects.toThrow('403 Forbidden');
  });
});
