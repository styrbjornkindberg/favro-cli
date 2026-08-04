/**
 * `favro query <board> <query...>` — behaviour (#100).
 *
 * The parser and the matcher are covered under `__tests__/api/query.test.ts`.
 * What was not: the command layer — that a multi-word query survives commander's
 * variadic argument as ONE string, and that a
 * zero-match run prints the explanation rather than nothing at all.
 */
import { Command } from 'commander';
import { registerQueryCommand } from '../../commands/query';
import * as config from '../../lib/config';
import QueryAPI from '../../api/query';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../api/query');

const MockQueryAPI = QueryAPI as jest.MockedClass<typeof QueryAPI>;

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
  // The runner's three flags live on the root (ADR-0002).
  program.option('--verbose', 'Show stack traces').option('--human').option('--pretty');
  registerQueryCommand(program);
  program.exitOverride();
  await program.parseAsync(['node', 'favro', ...args]).catch((e) => {
    if (!(e instanceof ExitCalled)) throw e;
  });
}

const output = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
const errors = () => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');

const result = (over: Record<string, unknown> = {}) => ({
  // A `ContextCard`, not a `{ card, matchReason }` wrapper: #95 deleted
  // `QueryMatch` with the parser that produced the reason string.
  matches: [
    {
      id: 'c-1',
      title: 'Fix login',
      status: 'In Progress',
      assignees: ['alice', 'bob'],
      tags: ['bug', 'urgent'],
    },
  ],
  total: 12,
  filter: { ast: null, raw: 'status:done' },
  summary: '1 of 12 cards match',
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitCalled(code ?? 0);
  }) as never);

  (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
  (config.readConfig as jest.Mock).mockResolvedValue({});
  MockQueryAPI.prototype.execute = jest.fn().mockResolvedValue(result());
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('query', () => {
  test('rejoins the variadic query into one string, and searches the whole board', async () => {
    await runCli(['query', 'Sprint 42', 'high', 'priority', 'status:In', 'Progress']);

    expect(MockQueryAPI.prototype.execute).toHaveBeenCalledWith('Sprint 42', 'high priority status:In Progress');
  });

  test('renders the summary, then one line per match', async () => {
    await runCli(['query', 'Sprint 42', 'status:done', '--human']);

    expect(output()).toContain('1 of 12 cards match');
    expect(output()).toContain('• Fix login [In Progress] — alice, bob #bug #urgent');
    // The per-row `matchReason` line is GONE (#95). Under one fail-closed
    // grammar the reason every row matched is the query, which the summary
    // states once — a per-row copy of the same sentence is not information, and
    // the old parser's reason string was assembled as it scraped.
    expect(output()).not.toMatch(/^\s+\(.*\)$/m);
  });

  test('omits the bracket, the dash and the hashes when the card carries none of them', async () => {
    MockQueryAPI.prototype.execute = jest.fn().mockResolvedValue(
      result({ matches: [{ id: 'c-2', title: 'Bare card' }] }),
    );

    await runCli(['query', 'Sprint 42', 'bare', '--human']);

    // The whole line, so a stray bracket, dash or hash after the title fails.
    // `toContain('• Bare card\n')` used to say this and stopped once the
    // `matchReason` line below it went away (#95) — the title is now last.
    expect(output()).toMatch(/^ {2}• Bare card$/m);
    expect(output()).not.toContain('undefined');
  });

  test('a zero-match run still prints the explanation — silence would read as a crash', async () => {
    MockQueryAPI.prototype.execute = jest.fn().mockResolvedValue(
      result({ matches: [], summary: 'No cards match "status:done". The board has no Done column.' }),
    );

    await runCli(['query', 'Sprint 42', 'status:done', '--human']);

    expect(output()).toContain('No cards match "status:done". The board has no Done column.');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  // `--limit` is gone: it rode `execute` into `getSnapshot`'s `cardLimit`, which
  // nothing read, so the query always searched the whole board. It now declines
  // by name — proved in `limit-fail-closed-coverage.test.ts`.
  test('a query with no cap spends no second argument on one', async () => {
    await runCli(['query', 'Sprint 42', 'x']);
    expect(MockQueryAPI.prototype.execute).toHaveBeenCalledWith('Sprint 42', 'x');
  });

  test('JSON is the default: the whole result, no human rendering', async () => {
    // `--json` is gone from the leaf (#116) — the machine shape is what you get
    // unless you ask for `--human`.
    await runCli(['query', 'Sprint 42', 'status:done']);

    const printed = JSON.parse(output());
    expect(printed.total).toBe(12);
    expect(printed.matches).toHaveLength(1);
    expect(output()).not.toContain('•');
  });

  test('an unresolvable board answers an error envelope on stdout and exits 1', async () => {
    MockQueryAPI.prototype.execute = jest.fn().mockRejectedValue(new Error("Board 'Ghost' not found"));

    await runCli(['query', 'Ghost', 'anything']);

    expect(JSON.parse(output()).error.message).toBe("Board 'Ghost' not found");
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  test('an incomplete snapshot is named in --human, never hidden behind the summary', async () => {
    // The composite read's hole (#116): "no cards match" over a board whose
    // card fetch died is a claim about what we could see, not about the board.
    MockQueryAPI.prototype.execute = jest.fn().mockResolvedValue(
      result({
        matches: [],
        summary: 'No cards match "status:done".',
        unreachable: [{ id: 'cards', reason: 'Request timed out' }],
      }),
    );

    await runCli(['query', 'Sprint 42', 'status:done', '--human']);

    expect(output()).toContain('1 part(s) could not be read');
    expect(output()).toContain('cards — Request timed out');
  });

  test('the help says free text is title~"…" and points at the one grammar', async () => {
    const program = new Command();
    registerQueryCommand(program);
    const query = program.commands.find((c) => c.name() === 'query')!;

    // #95's headline, which the old help contradicted by advertising "Free text
    // — Title/tag search" as a supported pattern.
    expect(query.description()).toContain('Free text is `title~"…"` and nothing else');
    expect(query.description()).toContain('favro cards list --help');
    // `unblocked` is still not answered here, and the help still names where it is.
    expect(query.description()).toContain('--filter "unblocked"');
  });
});
