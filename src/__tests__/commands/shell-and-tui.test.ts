/**
 * `favro shell` and `favro board` — registration, and the two places where
 * #118 replaced a hard `process.exit(0)` with a promise that resolves.
 *
 * The second half is the part that carries risk. Both commands used to END THE
 * PROCESS from inside an event handler, which terminates before a pending
 * stdout write flushes (ADR-0002 rule 2) and is banned under the runner. What
 * replaces it is "resolve the promise the handler is awaiting", and the failure
 * mode of getting that wrong is not a wrong answer — it is a CLI that never
 * returns. Nothing else in the suite would catch that, so it is pinned here:
 * both tests await the parse, and a missing resolve hangs them.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

// Before any require that might touch the real ~/.favro — the runner reads the
// config before every handler.
process.env.FAVRO_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'favro-shell-tui-'));

import { Command } from 'commander';
import * as readline from 'readline';
import { ContextAPI } from '../../api/context';
import { registerShellCommand } from '../../commands/shell';
import { registerBoardTuiCommand } from '../../commands/board-tui';

jest.mock('fs');
jest.mock('readline');
jest.mock('../../lib/http-client');
jest.mock('../../lib/client-factory');
jest.mock('../../api/context');

const MockContextAPI = ContextAPI as jest.MockedClass<typeof ContextAPI>;

let exitSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  process.exitCode = undefined;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit must not be called under run()');
  }) as never);
});

afterEach(() => {
  process.exitCode = undefined;
  jest.restoreAllMocks();
});

/** A root carrying the flags the runner owns, the way `cli.ts` declares them. */
function buildRoot(): Command {
  const program = new Command();
  program.option('--human').option('--pretty').option('--verbose');
  program.exitOverride();
  return program;
}

describe('shell command', () => {
  test('registers shell command', () => {
    const program = buildRoot();
    registerShellCommand(program);

    const shellCmd = program.commands.find(c => c.name() === 'shell');
    expect(shellCmd).toBeDefined();
    expect(shellCmd!.description()).toContain('Interactive');
  });

  test('shell command has --board option', () => {
    const program = buildRoot();
    registerShellCommand(program);

    const shellCmd = program.commands.find(c => c.name() === 'shell');
    const optNames = shellCmd!.options.map((o: any) => o.long);
    expect(optNames).toContain('--board');
  });

  test('the action returns when readline closes, rather than exiting the process', async () => {
    // A fake interface that is a real EventEmitter, so `close` reaches the
    // listener the handler attaches. `rl.close()` on `exit`/`quit` emits it in
    // the real thing; here the test emits it directly.
    const rl = Object.assign(new EventEmitter(), {
      prompt: jest.fn(),
      setPrompt: jest.fn(),
      close: jest.fn(),
    });
    (readline.createInterface as jest.Mock).mockReturnValue(rl);

    const program = buildRoot();
    registerShellCommand(program);
    let settled = false;
    const parsed = program.parseAsync(['node', 'favro', 'shell']).then(() => { settled = true; });

    // Wait for the handler to attach its `close` listener — the runner reads
    // the config first, so one tick is not enough and an early emit would be a
    // no-op that hangs the test for the wrong reason.
    while (rl.listenerCount('close') === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    // The half that bites. The old shape resolved as soon as the listeners were
    // attached and let `process.exit(0)` in the close handler end the run; that
    // shape passes every assertion below, so the pending check is what
    // distinguishes it.
    expect(settled).toBe(false);

    rl.emit('close');
    // …and this is the other half: no resolve at all and it never settles.
    await parsed;
    expect(settled).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});

describe('board-tui command', () => {
  const snapshot = {
    board: { id: 'b1', name: 'Board A', members: [] },
    columns: [{ id: 'col-1', name: 'Doing' }],
    workflow: [],
    customFields: [],
    members: [],
    cards: [],
    stats: { total: 0, by_status: {}, by_owner: {}, by_tag: {} },
    generatedAt: '2026-07-31T00:00:00.000Z',
  };

  test('registers board command', () => {
    const program = buildRoot();
    registerBoardTuiCommand(program);

    const boardCmd = program.commands.find(c => c.name() === 'board');
    expect(boardCmd).toBeDefined();
    expect(boardCmd!.description()).toContain('kanban');
  });

  test('board command has --compact, --watch, --ids, --json options', () => {
    const program = buildRoot();
    registerBoardTuiCommand(program);

    const boardCmd = program.commands.find(c => c.name() === 'board');
    const optNames = boardCmd!.options.map((o: any) => o.long);
    expect(optNames).toContain('--compact');
    expect(optNames).toContain('--watch');
    expect(optNames).toContain('--ids');
    expect(optNames).toContain('--json');
  });

  test('--watch stops on Ctrl+C and returns, rather than exiting the process', async () => {
    MockContextAPI.prototype.getSnapshot.mockResolvedValue(snapshot as any);

    const program = buildRoot();
    registerBoardTuiCommand(program);
    // An hour, so the interval can never fire inside the test: what ends this
    // run is the interrupt, not a timeout.
    const parsed = program.parseAsync(['node', 'favro', 'board', 'b1', '--watch', '3600']);

    // Wait for the handler to reach its own SIGINT listener — emitting before
    // it is attached would be a no-op and the test would hang for the wrong
    // reason.
    const before = process.listenerCount('SIGINT');
    while (process.listenerCount('SIGINT') === before) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    process.emit('SIGINT');

    await parsed;
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});
