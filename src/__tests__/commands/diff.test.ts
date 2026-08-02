/**
 * Tests for commands/diff.ts — board diff over time.
 *
 * Migrated to the command runner in #117 (step 5 of ADR-0002). The find here was
 * not the migration: `diff` reads `ContextAPI.getSnapshot`, which #116 taught to
 * RECORD its per-facet holes — and `diff` then ignored them, so a 403 on the
 * cards facet printed "No changes detected in this period." and exited 0. That
 * is the fail-open ADR-0002 exists to kill, on a command whose whole output is a
 * verdict.
 */
import { Command } from 'commander';
import { registerDiffCommand, diffHandler } from '../../commands/diff';
import * as contextApi from '../../api/context';
import * as config from '../../lib/config';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../api/context');

const MockContextAPI = contextApi.ContextAPI as jest.MockedClass<typeof contextApi.ContextAPI>;

const HOUR = 3600000;

/** A snapshot carrying `cards`, which is all `diff` reads besides the name. */
function snapshot(cards: contextApi.ContextCard[], unreachable?: contextApi.BoardContextSnapshot['unreachable']) {
  return {
    board: { id: 'boards-1', name: 'Sprint 42', description: '', type: 'kanban', collection: '', members: [] },
    columns: [],
    workflow: [],
    customFields: [],
    members: [],
    cards,
    stats: { total: cards.length, by_status: {}, by_owner: {} },
    generatedAt: '2026-03-28T12:00:00.000Z',
    ...(unreachable ? { unreachable } : {}),
  } as contextApi.BoardContextSnapshot;
}

const card = (id: string, createdAt?: string): contextApi.ContextCard => ({
  id,
  title: `Card ${id}`,
  status: 'In Progress',
  owner: 'alice@ex.com',
  assignees: [],
  blockedBy: [],
  blocking: [],
  createdAt,
});

function buildProgram(): Command {
  const program = new Command();
  program.option('--verbose').option('--human').option('--pretty');
  // Before `.command()`, exactly as `cli.ts:134` does it.
  program.exitOverride();
  registerDiffCommand(program);
  return program;
}

const runCli = (args: string[]): Promise<unknown> =>
  buildProgram().parseAsync(['node', 'favro', ...args]);

describe('diff command', () => {
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  const stdout = (): string => consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
  const json = (): any => JSON.parse(stdout());

  beforeEach(() => {
    jest.clearAllMocks();
    (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
    MockContextAPI.prototype.getSnapshot.mockResolvedValue(snapshot([]));
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    process.exitCode = undefined;
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
    process.exitCode = undefined;
  });

  // ─── registration ──────────────────────────────────────────────────────────

  it('registers with --since required and --limit optional, and no --json', () => {
    const diff = buildProgram().commands.find((c) => c.name() === 'diff')!;
    const longs = diff.options.map((o) => o.long);

    expect(longs).toContain('--since');
    expect(longs).toContain('--limit');
    expect(longs).not.toContain('--json');
    expect(diff.registeredArguments.map((a) => a.name())).toEqual(['boardRef']);
  });

  it('refuses --json, which JSON-by-default replaced', async () => {
    await expect(runCli(['diff', 'board-1', '--since', '1d', '--json'])).rejects.toThrow(
      /unknown option/i,
    );
  });

  // ─── the JSON default and the verdict ──────────────────────────────────────

  it('emits the report as JSON and exits 0 when nothing changed', async () => {
    MockContextAPI.prototype.getSnapshot.mockResolvedValue(
      snapshot([card('c1', new Date(Date.now() - 100 * HOUR).toISOString())]),
    );

    await runCli(['diff', 'board-1', '--since', '1d']);

    const report = json();
    expect(report.board).toBe('Sprint 42');
    expect(report.changes).toEqual([]);
    expect(report.summary.added).toBe(0);
    expect(report.unreachable).toBeUndefined();
    expect(process.exitCode).toBe(0);
  });

  it('exits 1 when there is drift, and names it', async () => {
    MockContextAPI.prototype.getSnapshot.mockResolvedValue(
      snapshot([card('c1', new Date(Date.now() - 2 * HOUR).toISOString())]),
    );

    await runCli(['diff', 'board-1', '--since', '1d']);

    const report = json();
    expect(report.changes).toHaveLength(1);
    expect(report.changes[0]).toMatchObject({ type: 'added', cardId: 'c1', title: 'Card c1' });
    expect(report.summary.added).toBe(1);
    expect(process.exitCode).toBe(1);
  });

  it('resolves --since into an ISO boundary the report states', async () => {
    await runCli(['diff', 'board-1', '--since', '2h']);

    const since = new Date(json().since).getTime();
    expect(Date.now() - since).toBeGreaterThanOrEqual(2 * HOUR - 5000);
    expect(Date.now() - since).toBeLessThanOrEqual(2 * HOUR + 5000);
  });

  // ─── the fail-open hole this step closes (#116/#117) ───────────────────────

  it('carries the snapshot’s unreachable facets, and refuses to answer 0', async () => {
    // The cards facet failed. `cards: []` alone would render as "No changes
    // detected in this period." and exit 0 — a clean bill of health from a read
    // that never happened.
    MockContextAPI.prototype.getSnapshot.mockResolvedValue(
      snapshot([], [{ id: 'cards', reason: 'Request failed with status code 403' }]),
    );

    await runCli(['diff', 'board-1', '--since', '1d']);

    const report = json();
    expect(report.changes).toEqual([]);
    expect(report.unreachable).toEqual([
      { id: 'cards', reason: 'Request failed with status code 403' },
    ]);
    expect(process.exitCode).toBe(1);
  });

  it('says the read was incomplete under --human, above the verdict', async () => {
    MockContextAPI.prototype.getSnapshot.mockResolvedValue(
      snapshot([], [{ id: 'cards', reason: 'Request timed out' }]),
    );

    await runCli(['diff', 'board-1', '--since', '1d', '--human']);

    const text = stdout();
    expect(text).toContain('Incomplete — 1 part(s) of this board could not be read:');
    expect(text).toContain('cards — Request timed out');
    // Order matters: a footnote under "No changes detected" does not undo it.
    expect(text.indexOf('could not be read')).toBeLessThan(text.indexOf('No changes detected'));
  });

  // ─── refusals and failures ─────────────────────────────────────────────────

  it('refuses a malformed --since as a non-retryable refusal', async () => {
    await runCli(['diff', 'board-1', '--since', 'yesterday']);

    const envelope = json();
    expect(envelope.error.message).toContain('Invalid --since format');
    // A bare Error would come back `retryable: true`, telling an agent to loop
    // on a typo forever (#134).
    expect(envelope.error.retryable).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(MockContextAPI.prototype.getSnapshot).not.toHaveBeenCalled();
  });

  it('a wire failure is an error envelope, not a report', async () => {
    MockContextAPI.prototype.getSnapshot.mockRejectedValue(new Error('Board not found'));

    await runCli(['diff', 'board-1', '--since', '1d']);

    const envelope = json();
    expect(envelope.error.message).toBe('Board not found');
    expect(envelope.changes).toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  // ─── --limit ───────────────────────────────────────────────────────────────

  it('takes whole digits for --limit and nothing else', async () => {
    await runCli(['diff', 'board-1', '--since', '1d', '--limit', '250']);
    expect(MockContextAPI.prototype.getSnapshot).toHaveBeenCalledWith('board-1', 250);

    // `parseInt` stopped at the first non-digit, so `1e9` meant ONE card (#143).
    await runCli(['diff', 'board-1', '--since', '1d', '--limit', '1e9']);
    expect(MockContextAPI.prototype.getSnapshot).toHaveBeenLastCalledWith('board-1', 1000);
  });

  it('the handler returns the report, the formatter and the exit code', async () => {
    const getSnapshot = jest.fn().mockResolvedValue(
      snapshot([card('c1', new Date(Date.now() - 2 * HOUR).toISOString())]),
    );

    const result = await diffHandler(
      { api: { context: { getSnapshot } } } as never,
      'board-1',
      { since: '1d' },
    );

    expect(getSnapshot).toHaveBeenCalledWith('board-1', 1000);
    expect(result.item.changes).toHaveLength(1);
    expect(result.exitCode).toBe(1);
    expect(typeof result.human).toBe('function');
  });
});
