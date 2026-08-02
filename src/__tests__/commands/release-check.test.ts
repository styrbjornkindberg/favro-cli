/**
 * Tests for release-check command
 * FAVRO-038: Release Check & Risk Dashboard
 *
 * Migrated to the command runner in #117 (step 5 of ADR-0002). Two things the
 * older version of this file could not express, and which are the point of the
 * step:
 *
 *   - JSON is the DEFAULT; `--human` opts out. The `--json` flag is gone.
 *   - The verdict is DECLARED DATA (`status`) and the exit code is derived from
 *     it, so "this command failed" and "this command's answer is negative" are
 *     distinguishable by stdout and not only by the code.
 */
import { Command } from 'commander';
import { registerReleaseCheckCommand, releaseCheckHandler } from '../../commands/release-check';
import CardsAPI, { Card } from '../../lib/cards-api';
import * as config from '../../lib/config';

jest.mock('../../lib/cards-api');
jest.mock('../../lib/http-client');
jest.mock('../../lib/config');

const sampleCards: Card[] = [
  {
    cardId: 'card-1',
    name: 'Feature A',
    status: 'Done',
    assignees: ['alice'],
    tags: [],
    dueDate: '2026-03-20',
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-15T00:00:00Z',
  },
  {
    cardId: 'card-2',
    name: 'Feature B',
    status: 'Review',
    assignees: ['bob'],
    tags: [],
    dueDate: '2026-03-25',
    createdAt: '2026-03-02T00:00:00Z',
    updatedAt: '2026-03-16T00:00:00Z',
  },
  {
    cardId: 'card-3',
    name: 'Feature C',
    status: 'Review',
    assignees: [], // Missing assignees
    tags: [],
    dueDate: '2026-03-30',
    createdAt: '2026-03-03T00:00:00Z',
    updatedAt: '2026-03-17T00:00:00Z',
  },
  {
    cardId: 'card-4',
    name: 'Feature D',
    status: 'Done',
    assignees: ['charlie'],
    tags: ['blocked'], // Blocked
    dueDate: undefined,
    createdAt: '2026-03-04T00:00:00Z',
    updatedAt: '2026-03-18T00:00:00Z',
  },
  {
    cardId: 'card-5',
    name: 'In Progress Task',
    status: 'In Progress',
    assignees: ['dave'],
    tags: [],
    dueDate: '2026-04-01',
    createdAt: '2026-03-05T00:00:00Z',
    updatedAt: '2026-03-19T00:00:00Z',
  },
];

let listCards: jest.Mock;

function buildProgram(): Command {
  const program = new Command();
  // The three flags the runner owns, declared where `cli.ts` declares them.
  program.option('--verbose').option('--human').option('--pretty');
  // Before `.command()`, exactly as `cli.ts:134` does it: `copyInheritedSettings`
  // hands the callback to each subcommand at CREATION time, so registering first
  // would leave the leaf still hard-exiting on a parse error.
  program.exitOverride();
  registerReleaseCheckCommand(program);
  return program;
}

const runCli = (args: string[]): Promise<unknown> =>
  buildProgram().parseAsync(['node', 'favro', ...args]);

describe('release-check command', () => {
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  /** Everything written to stdout, joined — the runner writes one line. */
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
    listCards.mockResolvedValue(sampleCards.slice(0, 2));

    await runCli(['release-check', 'board-1']);

    // #44: the fetch is uncapped — 10000 was a fetch cap, not a real bound.
    expect(listCards).toHaveBeenCalledWith('board-1');
    const report = json();
    expect(report.board).toBe('board-1');
    expect(report.reviewAndDoneCards).toBe(2);
    expect(report.valid).toBe(2);
  });

  it('no longer declares --json', async () => {
    // Deleted in #117: JSON is the default, so the flag could only ever have
    // meant "yes, really". A leaf that still declared it would also shadow
    // nothing at the root, which is the #115 trap in reverse.
    const releaseCheck = buildProgram().commands.find((c) => c.name() === 'release-check')!;
    expect(releaseCheck.options.map((o) => o.long)).not.toContain('--json');

    await expect(runCli(['release-check', 'board-1', '--json'])).rejects.toThrow(
      /unknown option/i,
    );
  });

  it('--pretty indents, because the runner owns it at the root', async () => {
    listCards.mockResolvedValue(sampleCards.slice(0, 2));

    await runCli(['release-check', 'board-1', '--pretty']);

    expect(stdout()).toContain('\n  "board": "board-1"');
  });

  // ─── the verdict, as declared data ─────────────────────────────────────────

  it('declares status ready and exits 0 when nothing is wrong', async () => {
    listCards.mockResolvedValue(sampleCards.slice(0, 2));

    await runCli(['release-check', 'board-1']);

    expect(json().status).toBe('ready');
    expect(process.exitCode).toBe(0);
  });

  it('declares status blocked and exits 1 when a card is blocked', async () => {
    listCards.mockResolvedValue([sampleCards[3]]);

    await runCli(['release-check', 'board-1']);

    const report = json();
    expect(report.status).toBe('blocked');
    expect(report.summary.blockers).toBe(1);
    expect(process.exitCode).toBe(1);
  });

  it('declares status review-needed and exits 1 on a warning-only report', async () => {
    listCards.mockResolvedValue([sampleCards[2]]); // unassigned, not blocked

    await runCli(['release-check', 'board-1']);

    const report = json();
    expect(report.status).toBe('review-needed');
    expect(report.summary.blockers).toBe(0);
    expect(process.exitCode).toBe(1);
  });

  /**
   * The acceptance criterion of #117, stated as one test.
   *
   * Both a negative finding and a wire failure exit 1. What tells them apart is
   * STDOUT: a finding is the report, a failure is `{ error: … }`. An agent that
   * could only read the code would have to guess.
   */
  it('a negative finding and a wire failure are distinguishable by stdout', async () => {
    listCards.mockResolvedValue([sampleCards[3]]);
    await runCli(['release-check', 'board-1']);

    const finding = json();
    expect(process.exitCode).toBe(1);
    expect(finding.error).toBeUndefined();
    expect(finding.status).toBe('blocked');

    consoleLogSpy.mockClear();
    process.exitCode = undefined;
    listCards.mockRejectedValue(new Error('API failed'));
    await runCli(['release-check', 'board-1']);

    const failure = json();
    expect(process.exitCode).toBe(1);
    expect(failure.error.message).toBe('API failed');
    expect(failure.status).toBeUndefined();
    // ADR-0002: the runner sets the code, it never hard-exits.
    expect(exitSpy).not.toHaveBeenCalled();
  });

  // ─── the human render (#117: `--human` opts out) ───────────────────────────

  it('renders the report for a human under --human', async () => {
    listCards.mockResolvedValue(sampleCards.slice(0, 2));

    await runCli(['release-check', 'board-1', '--human']);

    const text = stdout();
    expect(text).toContain('RELEASE CHECK REPORT');
    expect(text).toContain('Valid for release:  2');
    expect(text).toContain('✓ All Review/Done cards are ready for release!');
    expect(text).toContain('Release Status: ✅ READY');
  });

  it('names unassigned cards under --human', async () => {
    listCards.mockResolvedValue([sampleCards[2]]);

    await runCli(['release-check', 'board-1', '--human']);

    const text = stdout();
    expect(text).toContain('Found 1 card(s) with issues');
    expect(text).toContain('Unassigned');
    expect(text).toContain('Release Status: ⚠️  REVIEW NEEDED');
  });

  it('separates blockers from warnings under --human', async () => {
    listCards.mockResolvedValue([sampleCards[3]]);

    await runCli(['release-check', 'board-1', '--human']);

    const text = stdout();
    expect(text).toContain('🔴 BLOCKERS (prevent release):');
    expect(text).toContain('Release Status: ❌ BLOCKED');
  });

  it('reports a wire failure on stderr under --human, not as a JSON envelope', async () => {
    listCards.mockRejectedValue(new Error('API failed'));

    await runCli(['release-check', 'board-1', '--human']);

    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(stdout()).not.toContain('"error"');
  });

  // ─── what the report counts ────────────────────────────────────────────────

  it('filters to Review/Done statuses only', async () => {
    await runCli(['release-check', 'board-1']);

    expect(json().reviewAndDoneCards).toBe(4); // card-1,2,3,4 — not the In Progress one
  });

  it('matches statuses exactly, never as a substring', async () => {
    const edge = (cardId: string, status: string): Card => ({
      cardId,
      name: cardId,
      status,
      assignees: ['alice'],
      tags: [],
      dueDate: '2026-03-20',
      createdAt: '2026-03-01T00:00:00Z',
      updatedAt: '2026-03-15T00:00:00Z',
    });
    listCards.mockResolvedValue([
      edge('exact-review', 'Review'),
      edge('reviewed-by-qa', 'Reviewed-by-QA'),
      edge('exact-done', 'Done'),
      edge('undone', 'Undone'),
    ]);

    await runCli(['release-check', 'board-1']);

    expect(json().reviewAndDoneCards).toBe(2);
  });

  it('the handler returns the report, the formatter and the exit code', async () => {
    // The seam ADR-0002 exists for: no commander, no stdout, no client.
    const result = await releaseCheckHandler(
      { api: { cards: { listCards: jest.fn().mockResolvedValue([sampleCards[3]]) } } } as never,
      'board-1',
    );

    expect(result.item.status).toBe('blocked');
    expect(result.exitCode).toBe(1);
    expect(typeof result.human).toBe('function');
  });
});
