/**
 * `favro propose` / `favro execute` — the two halves of the preview-then-apply
 * pair (#100).
 *
 * They are one contract: `propose` hands out a change id and a preview, and
 * `execute` applies exactly that. Both are covered here because the thing worth
 * pinning is the seam — the id `propose` prints is the id `execute` consumes,
 * and neither may report success on a failure.
 *
 * The real error classes are kept (only the two entry points are stubbed), so
 * the `instanceof` branches that render suggestions are the real ones.
 */
import { Command } from 'commander';
import { registerProposeCommand } from '../../commands/propose';
import { registerExecuteCommand } from '../../commands/execute';
import * as config from '../../lib/config';
import * as safety from '../../lib/safety';
import { proposeChange, executeChange, ValidationError } from '../../api/propose';
import { ActionParseError } from '../../lib/action-parser';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../lib/safety');
jest.mock('../../api/propose', () => ({
  ...jest.requireActual('../../api/propose'),
  proposeChange: jest.fn(),
  executeChange: jest.fn(),
}));

const mockPropose = proposeChange as jest.MockedFunction<typeof proposeChange>;
const mockExecute = executeChange as jest.MockedFunction<typeof executeChange>;

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
let exitSpy: jest.SpyInstance;

async function runCli(args: string[]): Promise<void> {
  const program = new Command();
  program.option('--verbose', 'Show stack traces');
  registerProposeCommand(program);
  registerExecuteCommand(program);
  program.exitOverride();
  await program.parseAsync(['node', 'favro', ...args]).catch((e) => {
    if (!(e instanceof ExitCalled)) throw e;
  });
}

const output = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
const errors = () => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
const printedJson = () => JSON.parse(logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.trim().startsWith('{'))!);

beforeEach(() => {
  jest.clearAllMocks();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitCalled(code ?? 0);
  }) as never);

  (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
  (config.readConfig as jest.Mock).mockResolvedValue({ scopeCollectionId: 'coll-1' });
  (safety.checkScope as jest.Mock).mockResolvedValue(undefined);
  (safety.confirmAction as jest.Mock).mockResolvedValue(true);

  mockPropose.mockResolvedValue({
    changeId: 'ch_abc123',
    boardName: 'Sprint 42',
    actionText: "move card 'Fix login' to Review",
    preview: [{ method: 'PUT', path: '/cards/card-1', description: 'move to Review' }] as never,
    expiresAt: 1_800_000_000_000,
  });
  mockExecute.mockResolvedValue({
    changeId: 'ch_abc123',
    status: 'executed',
    changes: [{ method: 'PUT', path: '/cards/card-1', description: 'move to Review', result: 'success' }],
    message: '1 change applied',
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('propose', () => {
  test('prints the change id, the preview, and the exact command that applies it', async () => {
    await runCli(['propose', 'Sprint 42', '--action', "move card 'Fix login' to Review"]);

    const out = printedJson();
    expect(out.changeId).toBe('ch_abc123');
    expect(out.preview).toEqual([{ method: 'PUT', path: '/cards/card-1', description: 'move to Review' }]);
    expect(out.expiresAt).toBe(1_800_000_000_000);
    expect(out.message).toBe('Preview ready. Run: favro execute Sprint 42 --change-id ch_abc123');
  });

  test('proposing is read-only — no confirm, no scope check, nothing written', async () => {
    await runCli(['propose', 'Sprint 42', '--action', 'close CLA-1']);

    expect(safety.confirmAction).not.toHaveBeenCalled();
    expect(safety.checkScope).not.toHaveBeenCalled();
  });

  test('defaults to compact JSON and only indents under --pretty', async () => {
    await runCli(['propose', 'Sprint 42', '--action', 'close CLA-1']);
    const compact = String(logSpy.mock.calls[0][0]);
    logSpy.mockClear();

    await runCli(['propose', 'Sprint 42', '--action', 'close CLA-1', '--pretty']);
    const pretty = String(logSpy.mock.calls[0][0]);

    expect(compact).not.toContain('\n');
    expect(pretty).toContain('\n');
    expect(JSON.parse(pretty)).toEqual(JSON.parse(compact));
  });

  test('a validation failure lists the suggestions it came with', async () => {
    mockPropose.mockRejectedValue(new ValidationError('Card "Fix logon" not found', ['Fix login', 'Fix logout']));

    await runCli(['propose', 'Sprint 42', '--action', "close 'Fix logon'"]);

    expect(errors()).toContain('Error: Card "Fix logon" not found');
    expect(errors()).toContain('- Fix login');
    expect(errors()).toContain('- Fix logout');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('an unparseable action names the vocabulary instead of a stack trace', async () => {
    mockPropose.mockRejectedValue(new ActionParseError('Could not parse "frobnicate the card"'));

    await runCli(['propose', 'Sprint 42', '--action', 'frobnicate the card']);

    expect(errors()).toContain('Parse error: Could not parse "frobnicate the card"');
    expect(errors()).toContain('Supported actions:');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('execute', () => {
  test('applies the named change and prints the result', async () => {
    await runCli(['execute', 'Sprint 42', '--change-id', 'ch_abc123', '-y']);

    expect(mockExecute).toHaveBeenCalledWith('ch_abc123', expect.anything());
    expect(printedJson()).toMatchObject({ changeId: 'ch_abc123', status: 'executed' });
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  test('takes the scope lock on the board before asking, and before applying', async () => {
    await runCli(['execute', 'Sprint 42', '--change-id', 'ch_abc123', '-y']);

    expect(safety.checkScope).toHaveBeenCalledWith('Sprint 42', expect.anything(), { scopeCollectionId: 'coll-1' }, undefined);
    const check = (safety.checkScope as jest.Mock).mock.invocationCallOrder[0];
    const confirm = (safety.confirmAction as jest.Mock).mock.invocationCallOrder[0];
    expect(check).toBeLessThan(confirm);
    expect(check).toBeLessThan(mockExecute.mock.invocationCallOrder[0]);
  });

  test('a board outside the lock applies nothing', async () => {
    (safety.checkScope as jest.Mock).mockRejectedValue(new Error('Scope violation: Sprint 42'));

    await runCli(['execute', 'Sprint 42', '--change-id', 'ch_abc123', '-y']);

    expect(mockExecute).not.toHaveBeenCalled();
    expect(errors()).toContain('Scope violation');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('declining applies nothing and exits 0', async () => {
    (safety.confirmAction as jest.Mock).mockResolvedValue(false);

    await runCli(['execute', 'Sprint 42', '--change-id', 'ch_abc123']);

    expect(mockExecute).not.toHaveBeenCalled();
    expect(output()).toContain('Aborted.');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test('--force reaches the lock', async () => {
    await runCli(['execute', 'Sprint 42', '--change-id', 'ch_abc123', '-y', '--force']);

    expect(safety.checkScope).toHaveBeenCalledWith('Sprint 42', expect.anything(), expect.anything(), true);
  });

  test('a failed execution still prints the per-call detail, then exits 1', async () => {
    mockExecute.mockResolvedValue({
      changeId: 'ch_abc123',
      status: 'failed',
      changes: [
        { method: 'PUT', path: '/cards/card-1', description: 'move to Review', result: 'failed', error: '409' },
      ],
      message: 'no changes applied',
    });

    await runCli(['execute', 'Sprint 42', '--change-id', 'ch_abc123', '-y']);

    expect(printedJson().changes[0]).toMatchObject({ result: 'failed', error: '409' });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('an expired change id is reported as such, not as a crash', async () => {
    mockExecute.mockRejectedValue(
      new ValidationError('Change ID "ch_stale" not found or has expired', ['Run `favro propose` again']),
    );

    await runCli(['execute', 'Sprint 42', '--change-id', 'ch_stale', '-y']);

    expect(errors()).toContain('has expired');
    expect(errors()).toContain('- Run `favro propose` again');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
