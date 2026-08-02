/**
 * `cards claim` / `cards resolve` / `cards retag` — the CLI surface of three
 * tracker intents (#100).
 *
 * The intents themselves are covered at the dispatch layer. What was not:
 * the commander wiring (which flags reach the table, in what shape), the
 * confirmation the docs promise on every write, and the `process.exit`-string
 * workaround in the catch — a swallowed re-throw there would turn a clean
 * "Aborted." into a logged error.
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
let exitSpy: jest.SpyInstance;

/** `process.exit` really does stop the action; a returning stub does not. */
class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

async function runCli(args: string[]): Promise<unknown> {
  const program = new Command();
  program.option('--verbose', 'Show stack traces');
  const cardsCmd = program.command('cards');
  registerCardsTrackerCommands(cardsCmd);
  program.exitOverride();
  return program.parseAsync(['node', 'favro', 'cards', ...args]).catch((e) => e);
}

const ok = (value: unknown) => ({ intent: 'claim', outcome: 'ok' as const, retryable: false, value });

beforeEach(() => {
  jest.clearAllMocks();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitCalled(code ?? 0);
  }) as never);

  (clientFactory.createFavroClient as jest.Mock).mockResolvedValue({});
  (config.readConfig as jest.Mock).mockResolvedValue({ scopeCollectionId: 'coll-1' });
  (safety.confirmAction as jest.Mock).mockResolvedValue(true);
  mockDispatch.mockResolvedValue(ok({ cardId: 'card-1', columnId: 'col-active', assignee: 'alice' }));
});

afterEach(() => {
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
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test('the abort exit is re-thrown, not logged as a command failure', async () => {
    // The catch matches on the `process.exit` message prefix. If that guard
    // regressed, the clean abort above would be dressed up as "Error: …" and
    // the process would exit 1 instead of 0.
    (safety.confirmAction as jest.Mock).mockResolvedValue(false);

    await runCli(['claim', 'CLA-1804']);

    expect(errors()).not.toMatch(/Error:/);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
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

  test('--json prints the intent value as JSON alongside the human line', async () => {
    await runCli(['claim', 'CLA-1804', '--json', '-y']);

    const printed = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.trim().startsWith('{'));
    expect(JSON.parse(printed!)).toEqual({ cardId: 'card-1', columnId: 'col-active', assignee: 'alice' });
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
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('a thrown refusal is logged and exits 1', async () => {
    mockDispatch.mockRejectedValue(new Error('Scope violation: board board-x is outside the locked collection'));

    await runCli(['claim', 'CLA-1804', '-y']);

    expect(errors()).toContain('Scope violation');
    expect(exitSpy).toHaveBeenCalledWith(1);
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
