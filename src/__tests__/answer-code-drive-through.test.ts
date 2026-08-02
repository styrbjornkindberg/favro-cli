/**
 * The three answer-code commands, driven through the REAL `buildProgram()`
 * (#117, step 5 of ADR-0002).
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE PER-COMMAND TESTS
 * Each per-command test builds a little program of its own: root flags, then
 * `register…Command`. That is enough to check the handler and the render, and it
 * is NOT enough to check the two things this step keeps getting wrong.
 *
 *   1. **A successful dispatch that prints nothing.** #113's own review found the
 *      runner's success path silent — the ADR-0002 failure the runner exists to
 *      prevent, relocated onto the success path. So every command here is driven
 *      on success, on empty and on refusal, in BOTH output modes, and every one
 *      of the twelve cells asserts that something reached a stream.
 *   2. **Root flags resolved by the root's own `parseOptions`.** `cli.ts` enables
 *      neither `_enablePositionalOptions` nor `_passThroughOptions`, so the ROOT
 *      scans the whole argv and swallows any flag it declared, wherever it
 *      appears. `--human` after a positional is the case that broke on eight
 *      commands for several merges, and only the real root can show it.
 *
 * The wire is mocked at the API class, not below it: this file is about the
 * command surface, and `pagination-wire.test.ts` owns the wire.
 */
import { buildProgram } from '../cli';
import CardsAPI from '../lib/cards-api';
import * as contextApi from '../api/context';
import * as config from '../lib/config';

jest.mock('../lib/cards-api');
jest.mock('../lib/http-client');
jest.mock('../lib/config');
jest.mock('../api/context');

const MockContextAPI = contextApi.ContextAPI as jest.MockedClass<typeof contextApi.ContextAPI>;

const CLEAN_CARD = {
  cardId: 'card-1',
  name: 'Feature A',
  status: 'Done',
  assignees: ['alice'],
  tags: [],
  dueDate: '2027-03-20',
  createdAt: '2026-03-01T00:00:00Z',
};
const BLOCKED_CARD = { ...CLEAN_CARD, cardId: 'card-2', name: 'Feature B', tags: ['blocked'] };

const emptySnapshot = (unreachable?: contextApi.BoardContextSnapshot['unreachable']) =>
  ({
    board: { id: 'boards-1', name: 'Sprint 42', description: '', type: 'kanban', collection: '', members: [] },
    columns: [],
    workflow: [],
    customFields: [],
    members: [],
    cards: [],
    stats: { total: 0, by_status: {}, by_owner: {} },
    generatedAt: '2026-03-28T12:00:00.000Z',
    ...(unreachable ? { unreachable } : {}),
  }) as contextApi.BoardContextSnapshot;

let listCards: jest.Mock;
let out: string[];
let err: string[];

async function cli(...argv: string[]): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(['node', 'favro', ...argv]).catch(() => {});
}

beforeEach(() => {
  jest.clearAllMocks();
  listCards = jest.fn().mockResolvedValue([CLEAN_CARD]);
  (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => ({ listCards } as any));
  MockContextAPI.prototype.getSnapshot.mockResolvedValue(emptySnapshot());
  (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
  out = [];
  err = [];
  jest.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.map(String).join(' ')); });
  jest.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.map(String).join(' ')); });
  jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  process.exitCode = undefined;
});

afterEach(() => {
  jest.restoreAllMocks();
  process.exitCode = undefined;
});

const stdout = () => out.join('\n');
const stderr = () => err.join('\n');

/**
 * ADR-0002's floor: a command that ran never prints nothing. Asserted per cell
 * rather than once, because the silent path is always ONE branch — the success
 * one, the empty one, or the refusal one — and a single spot-check finds it only
 * by luck.
 */
const spoke = () => expect((stdout() + stderr()).trim().length).toBeGreaterThan(0);

describe('release-check speaks in every cell', () => {
  it('JSON · success', async () => {
    await cli('release-check', 'board-1');
    spoke();
    expect(JSON.parse(stdout()).status).toBe('ready');
    expect(process.exitCode).toBe(0);
  });

  it('JSON · negative finding', async () => {
    listCards.mockResolvedValue([BLOCKED_CARD]);
    await cli('release-check', 'board-1');
    spoke();
    expect(JSON.parse(stdout()).status).toBe('blocked');
    expect(process.exitCode).toBe(1);
  });

  it('JSON · empty board', async () => {
    listCards.mockResolvedValue([]);
    await cli('release-check', 'board-1');
    spoke();
    const report = JSON.parse(stdout());
    expect(report.totalCards).toBe(0);
    expect(report.status).toBe('ready');
  });

  it('JSON · refusal', async () => {
    listCards.mockRejectedValue(new Error('nope'));
    await cli('release-check', 'board-1');
    spoke();
    expect(JSON.parse(stdout()).error.message).toBe('nope');
    expect(process.exitCode).toBe(1);
  });

  it('--human · success, empty and refusal all reach a stream', async () => {
    await cli('release-check', 'board-1', '--human');
    spoke();
    expect(stdout()).toContain('Release Status: ✅ READY');

    out = [];
    listCards.mockResolvedValue([]);
    await cli('release-check', 'board-1', '--human');
    spoke();
    expect(stdout()).toContain('Total cards:        0');

    out = [];
    err = [];
    listCards.mockRejectedValue(new Error('nope'));
    await cli('release-check', 'board-1', '--human');
    spoke();
    expect(stderr()).toContain('nope');
    expect(stdout()).toBe('');
  });
});

describe('risks speaks in every cell', () => {
  it('JSON · success, negative, empty, refusal', async () => {
    await cli('risks', 'board-1');
    spoke();
    expect(JSON.parse(stdout()).riskLevel).toBe('healthy');
    expect(process.exitCode).toBe(0);

    out = [];
    process.exitCode = undefined;
    listCards.mockResolvedValue([{ ...CLEAN_CARD, dueDate: '2020-01-01' }]);
    await cli('risks', 'board-1');
    spoke();
    expect(JSON.parse(stdout()).riskLevel).toBe('critical');
    expect(process.exitCode).toBe(1);

    out = [];
    listCards.mockResolvedValue([]);
    await cli('risks', 'board-1');
    spoke();
    expect(JSON.parse(stdout()).totalCards).toBe(0);

    out = [];
    listCards.mockRejectedValue(new Error('nope'));
    await cli('risks', 'board-1');
    spoke();
    expect(JSON.parse(stdout()).error.message).toBe('nope');
  });

  it('--human · success, empty and refusal all reach a stream', async () => {
    await cli('risks', 'board-1', '--human');
    spoke();
    expect(stdout()).toContain('Overall Risk Level: ✅ HEALTHY');

    out = [];
    listCards.mockResolvedValue([]);
    await cli('risks', 'board-1', '--human');
    spoke();
    expect(stdout()).toContain('RISK DASHBOARD REPORT');

    out = [];
    err = [];
    listCards.mockRejectedValue(new Error('nope'));
    await cli('risks', 'board-1', '--human');
    spoke();
    expect(stderr()).toContain('nope');
    expect(stdout()).toBe('');
  });
});

describe('diff speaks in every cell', () => {
  it('JSON · success, negative, unreadable, refusal', async () => {
    await cli('diff', 'board-1', '--since', '1d');
    spoke();
    expect(JSON.parse(stdout()).changes).toEqual([]);
    expect(process.exitCode).toBe(0);

    out = [];
    process.exitCode = undefined;
    MockContextAPI.prototype.getSnapshot.mockResolvedValue({
      ...emptySnapshot(),
      cards: [{ id: 'c1', title: 'New', status: 'x', owner: '', assignees: [], blockedBy: [], blocking: [], createdAt: new Date().toISOString() }],
    });
    await cli('diff', 'board-1', '--since', '1d');
    spoke();
    expect(JSON.parse(stdout()).changes).toHaveLength(1);
    expect(process.exitCode).toBe(1);

    out = [];
    process.exitCode = undefined;
    MockContextAPI.prototype.getSnapshot.mockResolvedValue(
      emptySnapshot([{ id: 'cards', reason: 'Request failed with status code 403' }]),
    );
    await cli('diff', 'board-1', '--since', '1d');
    spoke();
    expect(JSON.parse(stdout()).unreachable).toHaveLength(1);
    expect(process.exitCode).toBe(1);

    out = [];
    await cli('diff', 'board-1', '--since', 'never');
    spoke();
    expect(JSON.parse(stdout()).error.retryable).toBe(false);
  });

  it('--human · success, empty and refusal all reach a stream', async () => {
    await cli('diff', 'board-1', '--since', '1d', '--human');
    spoke();
    expect(stdout()).toContain('Board Diff');
    expect(stdout()).toContain('No changes detected');

    out = [];
    err = [];
    await cli('diff', 'board-1', '--since', 'never', '--human');
    spoke();
    expect(stderr()).toContain('Invalid --since format');
    expect(stdout()).toBe('');
  });
});

/**
 * The #115 trap, measured rather than reasoned about: the root declares
 * `--human` and `--pretty`, and the root's `parseOptions` scans the whole argv.
 * A leaf re-declaring either would shadow the root's; none of these three do, so
 * the flag has to work in every position.
 */
describe('the root flags resolve wherever they appear', () => {
  it('--human works before and after the positional, on all three', async () => {
    for (const argv of [
      ['release-check', 'board-1', '--human'],
      ['--human', 'release-check', 'board-1'],
      ['risks', 'board-1', '--human'],
      ['--human', 'risks', 'board-1'],
      ['diff', 'board-1', '--since', '1d', '--human'],
      ['--human', 'diff', 'board-1', '--since', '1d'],
    ]) {
      out = [];
      await cli(...argv);
      // Human mode, not JSON: the first line is never a JSON object.
      expect(stdout()).not.toMatch(/^\{/);
      expect(stdout().trim().length).toBeGreaterThan(0);
    }
  });

  it('--pretty indents on all three, declared only at the root', async () => {
    for (const argv of [
      ['release-check', 'board-1', '--pretty'],
      ['risks', 'board-1', '--pretty'],
      ['diff', 'board-1', '--since', '1d', '--pretty'],
    ]) {
      out = [];
      await cli(...argv);
      expect(stdout()).toContain('\n  "board":');
    }
  });

  it('none of the three declares --json any more', () => {
    const program = buildProgram();
    for (const name of ['release-check', 'risks', 'diff']) {
      const cmd = program.commands.find((c) => c.name() === name)!;
      expect(cmd.options.map((o) => o.long)).not.toContain('--json');
    }
  });
});
