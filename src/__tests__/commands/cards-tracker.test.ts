/**
 * `cards claim` / `cards resolve` / `cards retag` — the CLI surface of three
 * tracker intents (#100).
 *
 * The intents themselves are covered at the dispatch layer. What was not: the
 * commander wiring (which flags reach the table, in what shape) and the
 * confirmation the docs promise on every write.
 *
 * The three `"process.exit"` string-matches these actions carried are gone with
 * #119 — they existed only to stop a MOCKED exit being re-logged as a command
 * failure, and `run()` neither exits nor throws, so there is nothing to survive.
 * The abort arms below therefore assert what they always meant: nothing
 * dispatched, "Aborted." printed, and no error dressed up around it.
 *
 * `reportDispatch` is deliberately NOT mocked: the rendered line is the
 * observable behaviour under test.
 */
import { Command } from 'commander';
import { registerCardsTrackerCommands } from '../../commands/cards-tracker';
import { dispatch } from '../../lib/dispatch';
import * as clientFactory from '../../lib/client-factory';
import * as config from '../../lib/config';
import * as safety from '../../lib/safety';

jest.mock('../../lib/dispatch');
jest.mock('../../lib/client-factory');
jest.mock('../../lib/config');
jest.mock('../../lib/safety');

const mockDispatch = dispatch as jest.MockedFunction<typeof dispatch>;

let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

/** The human path — `--human`, since JSON is the default (ADR-0002). */
async function runCli(args: string[]): Promise<unknown> {
  return drive(['--human', ...args]);
}

/** The machine path — the DEFAULT for a real invocation. */
async function runJson(args: string[]): Promise<unknown> {
  return drive(args);
}

async function drive(args: string[]): Promise<unknown> {
  const program = new Command();
  program.option('--human').option('--pretty').option('--verbose', 'Show stack traces');
  const cardsCmd = program.command('cards');
  registerCardsTrackerCommands(cardsCmd);
  program.exitOverride();
  const [first, ...rest] = args;
  return first === '--human'
    ? program.parseAsync(['node', 'favro', '--human', 'cards', ...rest])
    : program.parseAsync(['node', 'favro', 'cards', ...args]);
}

const ok = (value: unknown) => ({ intent: 'claim', outcome: 'ok' as const, retryable: false, value });

beforeEach(() => {
  jest.clearAllMocks();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = undefined;
  jest.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit must not be called under run()');
  }) as never);

  (clientFactory.createFavroClient as jest.Mock).mockResolvedValue({});
  (config.readConfig as jest.Mock).mockResolvedValue({ scopeCollectionId: 'coll-1' });
  (safety.confirmAction as jest.Mock).mockResolvedValue(true);
  mockDispatch.mockResolvedValue(ok({ cardId: 'card-1', columnId: 'col-active', assignee: 'alice' }));
});

afterEach(() => {
  process.exitCode = undefined;
  jest.restoreAllMocks();
});

const output = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
const errors = () => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');

describe('cards claim', () => {
  test('dispatches the claim intent and renders what the intent returned', async () => {
    await runCli(['claim', 'CLA-1804', '--assignee', 'alice@example.com']);

    expect(mockDispatch).toHaveBeenCalledWith(
      'claim',
      { card: 'CLA-1804', assignee: 'alice@example.com' },
      expect.objectContaining({ config: { scopeCollectionId: 'coll-1' }, force: undefined, dryRun: undefined }),
    );
    expect(output()).toContain('✓ Claimed card-1 for alice (column col-active)');
  });

  test('asks before writing, naming the card and the assignee', async () => {
    await runCli(['claim', 'CLA-1804', '--assignee', 'alice@example.com']);

    expect(safety.confirmAction).toHaveBeenCalledWith(
      'Claim card CLA-1804 for alice@example.com?',
      { yes: undefined },
    );
  });

  test('declining writes nothing — the intent never reaches the table', async () => {
    (safety.confirmAction as jest.Mock).mockResolvedValue(false);

    await runCli(['claim', 'CLA-1804']);

    expect(mockDispatch).not.toHaveBeenCalled();
    expect(output()).toContain('Aborted.');
    // A decline is not a failure: exit 0, which under `run()` is the code
    // nobody set. It used to be a literal `process.exit(0)`.
    expect(process.exitCode).toBeUndefined();
  });

  test('the abort is not logged as a command failure', async () => {
    // This used to pin the `"process.exit"` string-match in the catch: without
    // it, the mocked exit's own Error was caught and the clean abort came out
    // as "Error: …" at exit 1. #119 deleted the workaround with the catch, and
    // what the arm was always about — a decline is not a failure — is what is
    // left to assert.
    (safety.confirmAction as jest.Mock).mockResolvedValue(false);

    await runCli(['claim', 'CLA-1804']);

    expect(errors()).not.toMatch(/Error:/);
    expect(process.exitCode).toBeUndefined();
  });

  test('-y skips the prompt but still dispatches', async () => {
    await runCli(['claim', 'CLA-1804', '-y']);

    expect(safety.confirmAction).toHaveBeenCalledWith(expect.any(String), { yes: true });
    expect(mockDispatch).toHaveBeenCalled();
  });

  test('--dry-run does not prompt — previewing is not writing — and prints the preview', async () => {
    mockDispatch.mockResolvedValue({
      intent: 'claim',
      outcome: 'ok',
      retryable: false,
      preview: ['assign alice to card-1', 'move card-1 to col-active'],
    });

    await runCli(['claim', 'CLA-1804', '--dry-run']);

    expect(safety.confirmAction).not.toHaveBeenCalled();
    expect(mockDispatch).toHaveBeenCalledWith('claim', expect.anything(), expect.objectContaining({ dryRun: true }));
    expect(output()).toContain('[dry-run] assign alice to card-1');
    expect(output()).toContain('[dry-run] move card-1 to col-active');
  });

  test('--force reaches the dispatch context, where the scope lock reads it', async () => {
    await runCli(['claim', 'CLA-1804', '--force', '-y']);

    expect(mockDispatch).toHaveBeenCalledWith('claim', expect.anything(), expect.objectContaining({ force: true }));
  });

  test('the machine DEFAULT prints the intent value, with nothing ahead of it', async () => {
    // `--json` left the leaf with #119. It used to print the value AFTER the
    // `✓ Claimed …` line, on the same stream — a live smoke run measured
    // exactly that shape failing `JSON.parse` on the real API. The ✓ is on the
    // `human` formatter now, so stdout is one document.
    await runJson(['claim', 'CLA-1804', '-y']);

    expect(JSON.parse(output())).toEqual({ cardId: 'card-1', columnId: 'col-active', assignee: 'alice' });
    expect(output()).not.toContain('✓');
  });

  test('a failed intent exits 1 with the table\'s retry advice, not a success line', async () => {
    mockDispatch.mockResolvedValue({
      intent: 'claim',
      outcome: 'rolled-back',
      retryable: false,
      error: 'card is not on the tracker board',
    });

    await runCli(['claim', 'CLA-1804', '-y']);

    expect(errors()).toContain('✗ claim failed: card is not on the tracker board');
    expect(errors()).toContain('Do NOT retry it unchanged.');
    expect(output()).not.toContain('✓ Claimed');
    expect(process.exitCode).toBe(1);
  });

  test('a thrown refusal is logged and exits 1', async () => {
    mockDispatch.mockRejectedValue(new Error('Scope violation: board board-x is outside the locked collection'));

    await runCli(['claim', 'CLA-1804', '-y']);

    expect(errors()).toContain('Scope violation');
    expect(process.exitCode).toBe(1);
  });
});

describe('cards resolve', () => {
  test('dispatches the resolve intent with only the card', async () => {
    mockDispatch.mockResolvedValue(ok({ cardId: 'card-1', columnId: 'col-done' }));

    await runCli(['resolve', 'CLA-1804', '-y']);

    expect(mockDispatch).toHaveBeenCalledWith('resolve', { card: 'CLA-1804' }, expect.anything());
    expect(output()).toContain('✓ Resolved card-1 (column col-done)');
  });

  test('renders an em dash when the intent reports no column', async () => {
    mockDispatch.mockResolvedValue(ok({ cardId: 'card-1' }));

    await runCli(['resolve', 'CLA-1804', '-y']);

    expect(output()).toContain('✓ Resolved card-1 (column —)');
  });
});

describe('cards retag', () => {
  test('passes both role axes through to the intent', async () => {
    mockDispatch.mockResolvedValue(ok({ cardId: 'card-1', category: 'bug', state: 'needs-info', tags: ['bug'] }));

    await runCli(['retag', 'CLA-1804', '--category', 'bug', '--state', 'needs-info', '-y']);

    expect(mockDispatch).toHaveBeenCalledWith(
      'retag',
      { card: 'CLA-1804', category: 'bug', state: 'needs-info' },
      expect.anything(),
    );
    expect(output()).toContain('✓ Retagged card-1: category=bug state=needs-info');
  });

  test('an omitted axis arrives as undefined, so the intent can keep the role already on the card', async () => {
    mockDispatch.mockResolvedValue(ok({ cardId: 'card-1', category: 'bug', state: 'needs-info', tags: [] }));

    await runCli(['retag', 'CLA-1804', '--state', 'needs-info', '-y']);

    expect(mockDispatch).toHaveBeenCalledWith(
      'retag',
      { card: 'CLA-1804', category: undefined, state: 'needs-info' },
      expect.anything(),
    );
  });

  test('lists the legal role vocabulary in its help, so an unknown role is not guesswork', async () => {
    const program = new Command();
    const cardsCmd = program.command('cards');
    registerCardsTrackerCommands(cardsCmd);
    const retag = cardsCmd.commands.find((c) => c.name() === 'retag')!;

    expect(retag.description()).toContain('needs-triage');
    expect(retag.description()).toContain('bug');
  });
});
