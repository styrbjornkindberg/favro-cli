/**
 * `favro cards find <url>` — behaviour (#100).
 *
 * A read-only command whose whole job is: hand the URL to the resolver, and
 * turn what comes back into one row. The interesting case is the miss —
 * "no card for this URL" must be an error and a non-zero exit, not an empty
 * table that reads like success.
 */
import { Command } from 'commander';
import { registerCardsFindCommand } from '../../commands/cards-find';
import * as config from '../../lib/config';
import CardsAPI from '../../lib/cards-api';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../lib/cards-api');

const MockCardsAPI = CardsAPI as jest.MockedClass<typeof CardsAPI>;
const URL_ = 'https://favro.com/organization/org-1/board?card=Squ-8850';

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
let tableSpy: jest.SpyInstance;
let exitSpy: jest.SpyInstance;

async function runCli(args: string[]): Promise<void> {
  const program = new Command();
  // The three flags `cli.ts` declares on the root. `--human` has to be here or
  // the migrated command dies at parse (#114); `.exitOverride()` has to run
  // before `.command()`, because that is when subcommands inherit it.
  program.option('--verbose', 'Show stack traces').option('--human').option('--pretty');
  program.exitOverride();
  const cardsCmd = program.command('cards');
  registerCardsFindCommand(cardsCmd);
  await program.parseAsync(['node', 'favro', 'cards', ...args]).catch((e) => {
    if (!(e instanceof ExitCalled)) throw e;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.exitCode = undefined;
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  tableSpy = jest.spyOn(console, 'table').mockImplementation(() => {});
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitCalled(code ?? 0);
  }) as never);

  (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
  (config.readConfig as jest.Mock).mockResolvedValue({});
  MockCardsAPI.prototype.findCardByUrl = jest.fn().mockResolvedValue({
    cardId: 'card-1',
    name: 'Fix login',
    status: 'In Progress',
    assignees: ['alice', 'bob'],
    tags: ['bug'],
    dueDate: '2026-01-31',
    createdAt: '2025-12-01T10:22:33.000Z',
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  process.exitCode = undefined;
});

describe('cards find', () => {
  test('hands the URL through untouched and renders one row', async () => {
    await runCli(['find', URL_, '--human']);

    expect(MockCardsAPI.prototype.findCardByUrl).toHaveBeenCalledWith(URL_);
    expect(tableSpy).toHaveBeenCalledWith([
      {
        ID: 'card-1',
        Title: 'Fix login',
        Status: 'In Progress',
        Assignees: 'alice, bob',
        Tags: 'bug',
        'Due Date': '2026-01-31',
        Created: '2025-12-01',
      },
    ]);
  });

  test('renders an em dash for every absent field rather than "undefined"', async () => {
    MockCardsAPI.prototype.findCardByUrl = jest.fn().mockResolvedValue({ cardId: 'card-1' });

    await runCli(['find', URL_, '--human']);

    expect(tableSpy).toHaveBeenCalledWith([
      {
        ID: 'card-1',
        Title: '—',
        Status: '—',
        Assignees: '—',
        Tags: '—',
        'Due Date': '—',
        Created: '—',
      },
    ]);
  });

  test('a miss is an error and a non-zero exit, not an empty table', async () => {
    MockCardsAPI.prototype.findCardByUrl = jest.fn().mockResolvedValue(null);

    await runCli(['find', URL_, '--human']);

    expect(tableSpy).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('No card found for URL');
    expect(process.exitCode).toBe(1);
  });

  test('a miss in JSON mode is an envelope on stdout, still exit 1', async () => {
    MockCardsAPI.prototype.findCardByUrl = jest.fn().mockResolvedValue(null);

    await runCli(['find', URL_]);

    expect(tableSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(JSON.parse(logSpy.mock.calls[0][0]).error.message).toContain('No card found for URL');
    expect(process.exitCode).toBe(1);
  });

  test('with no flags it prints the card untouched and skips the table', async () => {
    await runCli(['find', URL_]);

    expect(tableSpy).not.toHaveBeenCalled();
    expect(JSON.parse(logSpy.mock.calls[0][0])).toMatchObject({ cardId: 'card-1', name: 'Fix login' });
  });

  test('an unparseable URL surfaces the resolver\'s own error and exits 1', async () => {
    MockCardsAPI.prototype.findCardByUrl = jest.fn().mockRejectedValue(new Error('No card= parameter in URL'));

    await runCli(['find', 'https://favro.com/organization/org-1/board', '--human']);

    expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('No card= parameter in URL');
    expect(process.exitCode).toBe(1);
  });
});
