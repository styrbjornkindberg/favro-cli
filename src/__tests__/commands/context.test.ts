/**
 * Unit tests — context CLI command
 * CLA-1796 / FAVRO-034: Board Context Snapshot Command
 */
import { Command } from 'commander';
import { registerContextCommand, contextHandler } from '../../commands/context';
import * as config from '../../lib/config';
import * as contextApi from '../../api/context';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../api/context');

const MockContextAPI = contextApi.default as jest.MockedClass<typeof contextApi.ContextAPI>;

const SAMPLE_SNAPSHOT: contextApi.BoardContextSnapshot = {
  board: {
    id: 'boards-1234',
    name: 'Sprint 42',
    description: 'Q1 Sprint',
    type: 'kanban',
    collection: 'col-001',
    members: ['alice@ex.com', 'bob@ex.com'],
  },
  columns: [
    { id: 'col-a', name: 'Backlog', cardCount: 3 },
    { id: 'col-b', name: 'In Progress', cardCount: 2 },
    { id: 'col-c', name: 'Done', cardCount: 1 },
  ],
  workflow: [
    { columnId: 'col-a', columnName: 'Backlog', position: 1, stage: 'backlog' as const, nextColumn: 'In Progress' },
    { columnId: 'col-b', columnName: 'In Progress', position: 2, stage: 'active' as const, nextColumn: 'Done' },
    { columnId: 'col-c', columnName: 'Done', position: 3, stage: 'done' as const },
  ],
  customFields: [
    { id: 'cf1', name: 'Priority', type: 'select', values: ['High', 'Medium', 'Low'] },
  ],
  members: [
    { id: 'u1', name: 'Alice', email: 'alice@ex.com', role: 'admin' },
    { id: 'u2', name: 'Bob', email: 'bob@ex.com', role: 'member' },
  ],
  cards: [
    {
      id: 'card-001',
      title: 'Fix login bug',
      status: 'In Progress',
      owner: 'alice@ex.com',
      assignees: ['alice@ex.com'],
      blockedBy: [],
      blocking: [],
    },
  ],
  stats: {
    total: 6,
    by_status: { 'In Progress': 2, Done: 1, Backlog: 3 },
    by_owner: { 'alice@ex.com': 4, 'bob@ex.com': 2 },
  },
  generatedAt: '2026-03-28T12:00:00.000Z',
};

function buildProgram(): Command {
  const program = new Command();
  // The three flags the runner owns, declared where `cli.ts` declares them —
  // `--pretty` left the leaf in #116 and lives on the root now.
  program.option('--verbose', 'Show stack traces').option('--human').option('--pretty');
  registerContextCommand(program);
  return program;
}

async function runCli(args: string[]): Promise<void> {
  const program = buildProgram();
  program.exitOverride();
  await program.parseAsync(['node', 'favro', ...args]);
}

beforeEach(() => {
  jest.clearAllMocks();
  (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
  MockContextAPI.prototype.getSnapshot.mockResolvedValue(SAMPLE_SNAPSHOT);
});

describe('favro context <board>', () => {
  let consoleSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    process.exitCode = undefined;
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
    process.exitCode = undefined;
  });

  it('calls getSnapshot with board name and outputs JSON', async () => {
    await runCli(['context', 'Sprint 42']);

    expect(MockContextAPI.prototype.getSnapshot).toHaveBeenCalledWith('Sprint 42', 1000);
    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(SAMPLE_SNAPSHOT));
  });

  it('accepts board ID as positional argument', async () => {
    await runCli(['context', 'boards-1234']);

    expect(MockContextAPI.prototype.getSnapshot).toHaveBeenCalledWith('boards-1234', 1000);
  });

  it('respects --limit option', async () => {
    await runCli(['context', 'boards-1234', '--limit', '500']);

    expect(MockContextAPI.prototype.getSnapshot).toHaveBeenCalledWith('boards-1234', 500);
  });

  it('uses default limit of 1000 when --limit not specified', async () => {
    await runCli(['context', 'boards-1234']);

    expect(MockContextAPI.prototype.getSnapshot).toHaveBeenCalledWith('boards-1234', 1000);
  });

  it('outputs pretty JSON with --pretty flag', async () => {
    await runCli(['context', 'boards-1234', '--pretty']);

    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(SAMPLE_SNAPSHOT, null, 2));
  });

  it('clamps invalid --limit to 1000', async () => {
    await runCli(['context', 'boards-1234', '--limit', 'abc']);

    expect(MockContextAPI.prototype.getSnapshot).toHaveBeenCalledWith('boards-1234', 1000);
  });

  it('fails with an error envelope on stdout when the API key is missing', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(null);

    await runCli(['context', 'boards-1234']).catch(() => {});

    // The runner sets `process.exitCode`; a hard `process.exit` is what #113
    // took away, so asserting the spy would assert the old behaviour back in.
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringMatching(/^\{"error":/));
  });

  it('fails with an error envelope on stdout when getSnapshot throws', async () => {
    MockContextAPI.prototype.getSnapshot.mockRejectedValue(new Error('Board not found'));

    await runCli(['context', 'unknown-board']).catch(() => {});

    expect(process.exitCode).toBe(1);
    const envelope = JSON.parse(
      consoleSpy.mock.calls.map((c) => c[0]).find((line: string) => line.startsWith('{"error"')),
    );
    expect(envelope.error.message).toBe('Board not found');
  });

  // ─── the composite read's hole (#116) ──────────────────────────────────────

  it('carries the snapshot\u2019s unreachable facets through to stdout', async () => {
    MockContextAPI.prototype.getSnapshot.mockResolvedValue({
      ...SAMPLE_SNAPSHOT,
      cards: [],
      unreachable: [{ id: 'cards', reason: 'Request timed out' }],
    });

    let output = '';
    consoleSpy.mockImplementation((msg: string) => { output = msg; });

    await runCli(['context', 'boards-1234']);

    const parsed = JSON.parse(output);
    // Rows AND the hole: the acceptance shape. An agent reading `cards: []`
    // alone would call the board empty.
    expect(parsed.cards).toEqual([]);
    expect(parsed.unreachable).toEqual([{ id: 'cards', reason: 'Request timed out' }]);
  });

  it('the handler returns the snapshot as a bare item', async () => {
    // The seam ADR-0002 exists for: no commander, no stdout.
    const getSnapshot = jest.fn().mockResolvedValue(SAMPLE_SNAPSHOT);
    const result = await contextHandler(
      { api: { context: { getSnapshot } } } as never,
      'Sprint 42',
      { limit: '250' },
    );

    expect(getSnapshot).toHaveBeenCalledWith('Sprint 42', 250);
    expect(result.item).toBe(SAMPLE_SNAPSHOT);
  });

  it('output JSON is valid and parseable', async () => {
    let output = '';
    consoleSpy.mockImplementation((msg: string) => { output = msg; });

    await runCli(['context', 'boards-1234']);

    const parsed = JSON.parse(output);
    expect(parsed.board.id).toBe('boards-1234');
    expect(parsed.cards).toHaveLength(1);
    expect(parsed.stats.total).toBe(6);
  });

  it('snapshot output includes all required top-level keys', async () => {
    let output = '';
    consoleSpy.mockImplementation((msg: string) => { output = msg; });

    await runCli(['context', 'boards-1234']);

    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty('board');
    expect(parsed).toHaveProperty('columns');
    expect(parsed).toHaveProperty('customFields');
    expect(parsed).toHaveProperty('members');
    expect(parsed).toHaveProperty('cards');
    expect(parsed).toHaveProperty('stats');
    expect(parsed).toHaveProperty('generatedAt');
  });
});
