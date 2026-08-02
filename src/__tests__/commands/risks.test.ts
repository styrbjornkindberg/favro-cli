/**
 * Tests for risks command
 * FAVRO-038: Release Check & Risk Dashboard
 *
 * Migrated to the command runner in #117 (step 5 of ADR-0002): JSON is the
 * default, `--json` is gone, and `riskLevel` carries the verdict the exit code
 * reports.
 */
import { Command } from 'commander';
import { registerRisksCommand, risksHandler } from '../../commands/risks';
import CardsAPI, { Card } from '../../lib/cards-api';
import * as config from '../../lib/config';

jest.mock('../../lib/cards-api');
jest.mock('../../lib/http-client');
jest.mock('../../lib/config');

const sampleCards: Card[] = [
  {
    cardId: 'card-1',
    name: 'Overdue task',
    status: 'In Progress',
    assignees: ['alice'],
    tags: [],
    dueDate: '2026-03-01', // Overdue
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-15T00:00:00Z',
  },
  {
    cardId: 'card-2',
    name: 'Blocked task',
    status: 'In Progress',
    assignees: ['bob'],
    tags: ['blocked'],
    dueDate: '2026-04-01',
    createdAt: '2026-03-02T00:00:00Z',
    updatedAt: '2026-03-20T00:00:00Z',
  },
  {
    cardId: 'card-3',
    name: 'Stale task',
    status: 'To Do',
    assignees: ['charlie'],
    tags: [],
    dueDate: '2027-05-01',
    createdAt: '2026-02-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
  },
  {
    cardId: 'card-4',
    name: 'Unassigned task',
    status: 'To Do',
    assignees: [],
    tags: [],
    dueDate: '2027-06-01',
    createdAt: '2026-03-03T00:00:00Z',
    updatedAt: '2026-03-20T00:00:00Z',
  },
  {
    cardId: 'card-5',
    name: 'Missing fields task',
    status: 'To Do',
    assignees: [],
    tags: [],
    dueDate: undefined,
    createdAt: '2026-03-04T00:00:00Z',
    updatedAt: '2026-03-20T00:00:00Z',
  },
  {
    cardId: 'card-6',
    name: 'Healthy task',
    status: 'In Progress',
    assignees: ['dave'],
    tags: [],
    dueDate: '2027-04-15',
    createdAt: '2026-03-05T00:00:00Z',
    updatedAt: new Date().toISOString(),
  },
];

let listCards: jest.Mock;

function buildProgram(): Command {
  const program = new Command();
  program.option('--verbose').option('--human').option('--pretty');
  // Before `.command()`, exactly as `cli.ts:134` does it.
  program.exitOverride();
  registerRisksCommand(program);
  return program;
}

const runCli = (args: string[]): Promise<unknown> =>
  buildProgram().parseAsync(['node', 'favro', ...args]);

describe('risks command', () => {
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  const stdout = (): string => consoleLogSpy.mock.calls.map((c) => String(c[0])).join('\n');
  const json = (): any => JSON.parse(stdout());

  beforeEach(() => {
    jest.clearAllMocks();
    listCards = jest.fn().mockResolvedValue(sampleCards);
    (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(
      () => ({ listCards } as any),
    );
    (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
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

  // ─── the JSON default (#113/#117) ──────────────────────────────────────────

  it('emits the report as JSON with no flag at all', async () => {
    listCards.mockResolvedValue([sampleCards[0]]);

    await runCli(['risks', 'board-1']);

    const report = json();
    expect(report.board).toBe('board-1');
    expect(report.summary.overdue).toBe(1);
    expect(report.risks.overdue[0].cardId).toBe('card-1');
  });

  it('no longer declares --json', async () => {
    const risks = buildProgram().commands.find((c) => c.name() === 'risks')!;
    expect(risks.options.map((o) => o.long)).not.toContain('--json');

    await expect(runCli(['risks', 'board-1', '--json'])).rejects.toThrow(/unknown option/i);
  });

  // ─── the verdict, as declared data ─────────────────────────────────────────

  it('declares riskLevel healthy and exits 0 on a clean board', async () => {
    listCards.mockResolvedValue([sampleCards[5]]);

    await runCli(['risks', 'board-1']);

    expect(json().riskLevel).toBe('healthy');
    expect(process.exitCode).toBe(0);
  });

  it('declares riskLevel critical and exits 1 when a card is overdue or blocked', async () => {
    listCards.mockResolvedValue([sampleCards[0], sampleCards[1]]);

    await runCli(['risks', 'board-1']);

    expect(json().riskLevel).toBe('critical');
    expect(process.exitCode).toBe(1);
  });

  it('declares riskLevel medium and exits 1 on soft risks alone', async () => {
    listCards.mockResolvedValue([sampleCards[3]]); // unassigned only

    await runCli(['risks', 'board-1']);

    const report = json();
    expect(report.riskLevel).toBe('medium');
    expect(report.summary.overdue).toBe(0);
    expect(report.summary.blocked).toBe(0);
    expect(process.exitCode).toBe(1);
  });

  it('declares riskLevel high when soft risks pass ten cards', async () => {
    listCards.mockResolvedValue(
      Array.from({ length: 11 }, (_, i) => ({ ...sampleCards[3], cardId: `card-${i}` })),
    );

    await runCli(['risks', 'board-1']);

    expect(json().riskLevel).toBe('high');
    expect(process.exitCode).toBe(1);
  });

  it('a negative finding and a wire failure are distinguishable by stdout', async () => {
    listCards.mockResolvedValue([sampleCards[0]]);
    await runCli(['risks', 'board-1']);

    expect(process.exitCode).toBe(1);
    expect(json().riskLevel).toBe('critical');
    expect(json().error).toBeUndefined();

    consoleLogSpy.mockClear();
    process.exitCode = undefined;
    listCards.mockRejectedValue(new Error('API failed'));
    await runCli(['risks', 'board-1']);

    expect(process.exitCode).toBe(1);
    expect(json().error.message).toBe('API failed');
    expect(json().riskLevel).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  // ─── the permanent hole (#86) ──────────────────────────────────────────────

  it('reports staleness as unreachable rather than flagging cards', async () => {
    listCards.mockResolvedValue([sampleCards[2]]);

    await runCli(['risks', 'board-1']);

    const report = json();
    expect(report.risks.stale).toEqual([]);
    expect(report.unreachable).toEqual([
      { id: 'stale', reason: expect.stringContaining('no last-modified field') },
    ]);
  });

  it('a healthy verdict still carries the staleness hole', async () => {
    // The check nobody can run does not move the verdict — `critical` turns on
    // overdue/blocked, both computable — but it is still stated, so "healthy"
    // never reads as "everything was checked".
    listCards.mockResolvedValue([sampleCards[5]]);

    await runCli(['risks', 'board-1']);

    expect(json().riskLevel).toBe('healthy');
    expect(json().unreachable).toHaveLength(1);
    expect(process.exitCode).toBe(0);
  });

  // ─── the human render ──────────────────────────────────────────────────────

  it('renders the dashboard under --human', async () => {
    listCards.mockResolvedValue([sampleCards[0]]);

    await runCli(['risks', 'board-1', '--human']);

    const text = stdout();
    expect(text).toContain('RISK DASHBOARD REPORT');
    expect(text).toContain('🔴 Overdue');
    expect(text).toContain('card-1');
    expect(text).toContain('Overdue task');
    expect(text).toContain('Overall Risk Level: 🔴 CRITICAL');
  });

  it('names the staleness hole under --human, in the shared wording', async () => {
    listCards.mockResolvedValue([sampleCards[3]]);

    await runCli(['risks', 'board-1', '--human']);

    expect(stdout()).toContain('⏳ STALE: unreachable — Favro sends no last-modified field');
  });

  it('says the board is healthy under --human when nothing is at risk', async () => {
    listCards.mockResolvedValue([sampleCards[5]]);

    await runCli(['risks', 'board-1', '--human']);

    const text = stdout();
    expect(text).toContain('✓ All cards are healthy!');
    expect(text).toContain('Overall Risk Level: ✅ HEALTHY');
  });

  it('still names the staleness hole under --human on a HEALTHY board, above the verdict', async () => {
    // The hole loop used to live inside the `else` of `total === 0`, so this
    // exact run printed "✓ All cards are healthy!" and never mentioned that
    // staleness had not been checked — while the JSON for the same run carried
    // `unreachable`. Two modes, one command, disagreeing about whether a check
    // ran, and the mode a human reads was the one that fail-opened.
    listCards.mockResolvedValue([sampleCards[5]]);

    await runCli(['risks', 'board-1', '--human']);

    const text = stdout();
    expect(text).toContain('⏳ STALE: unreachable —');
    // A footnote does not undo a headline: the hole is stated BEFORE the
    // all-clear and before the verdict line.
    expect(text.indexOf('⏳ STALE')).toBeLessThan(text.indexOf('✓ All cards are healthy!'));
    expect(text.indexOf('⏳ STALE')).toBeLessThan(text.indexOf('Overall Risk Level'));
  });

  it('lists every risk category a single card falls into', async () => {
    listCards.mockResolvedValue([{
      cardId: 'card-multi',
      name: 'Multiple risks',
      status: 'In Progress',
      assignees: [],
      tags: ['blocked'],
      dueDate: '2026-03-01',
      createdAt: '2026-03-01T00:00:00Z',
      updatedAt: '2026-03-01T00:00:00Z',
    } as Card]);

    await runCli(['risks', 'board-1']);

    const report = json();
    expect(report.summary.overdue).toBe(1);
    expect(report.summary.blocked).toBe(1);
    expect(report.summary.unassigned).toBe(1);
    expect(report.summary.missingFields).toBe(1);
    // One card, counted once.
    expect(report.summary.total).toBe(1);
  });

  it('handles an empty board', async () => {
    listCards.mockResolvedValue([]);

    await runCli(['risks', 'board-1']);

    const report = json();
    expect(report.totalCards).toBe(0);
    expect(report.riskLevel).toBe('healthy');
    expect(process.exitCode).toBe(0);
  });

  it('the handler returns the report, the formatter and the exit code', async () => {
    const result = await risksHandler(
      { api: { cards: { listCards: jest.fn().mockResolvedValue([sampleCards[0]]) } } } as never,
      'board-1',
    );

    expect(result.item.riskLevel).toBe('critical');
    expect(result.exitCode).toBe(1);
    expect(typeof result.human).toBe('function');
  });
});
