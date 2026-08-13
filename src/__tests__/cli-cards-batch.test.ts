/**
 * `favro cards update --from-csv`, after #110 routed it through the `update`
 * intent and deleted `BulkTransaction`.
 *
 * What this file pins is the CSV-SPECIFIC half: that the whole file becomes ONE
 * dispatch rather than one per row (a dispatch per row would silently give back
 * the whole-batch refusal and the cap), and that each column reaches the field it
 * names. The removed spellings are in `commands/removed.test.ts`, all six
 * together, because the thing worth comparing is that they refuse alike.
 *
 * The guardrails themselves — the cap, the straddle refusal, the boardless
 * refusal, the part-way unwind — are pinned against a real socket in
 * `cards-update-intent-wire.test.ts`, where they are observable rather than
 * mocked. Asserting them again here would be a second, weaker copy.
 *
 * That claim was FALSE for the multi-row unwind when #110 first shipped: every
 * unwind arm in that file dispatched a single card, so the row-12-unwinds-1-to-11
 * behaviour this command headlines was pinned nowhere once the deleted
 * `cli-cards-batch :: "atomically rolls back on failure and exits 1"` went with
 * `BulkTransaction`. It is pinned there now, on the PUT sequence across two
 * cards, and still not here — the socket is where a compensating write is
 * observable.
 */
import * as fsPromises from 'fs/promises';
import { buildProgram } from '../cli';
import { Command } from 'commander';
import CardsAPI, { Card } from '../lib/cards-api';
import FavroHttpClient from '../lib/http-client';
import * as config from '../lib/config';
import { MULTI_WRITE_CAP } from '../lib/dispatch';

jest.mock('../lib/client-factory', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const stub = async () => require('../test-support/filter-vocabulary').stubVocabularyClient();
  return { __esModule: true, createFavroClient: jest.fn(stub), default: jest.fn(stub) };
});

jest.mock('../lib/cards-api');
jest.mock('../lib/http-client');
jest.mock('../lib/config');
jest.mock('fs/promises');

const mockResolveApiKey = config.resolveApiKey as jest.MockedFunction<typeof config.resolveApiKey>;
const mockReadConfig = config.readConfig as jest.MockedFunction<typeof config.readConfig>;
const mockFsReadFile = fsPromises.readFile as jest.MockedFunction<typeof fsPromises.readFile>;

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    cardId: 'card-default',
    name: 'Default Card',
    status: 'Backlog',
    assignees: [],
    tags: [],
    boardId: 'board-1',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('favro cards update --from-csv', () => {
  let program: Command;
  let mockApi: jest.Mocked<CardsAPI>;
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FAVRO_API_KEY = 'test-token';

    mockResolveApiKey.mockResolvedValue('test-token');
    // Nothing locked: the lock's own behaviour is pinned in
    // `cli-cards-csv-scope.test.ts`, and this file is about the rest.
    mockReadConfig.mockResolvedValue({} as any);

    const mockClient = new FavroHttpClient() as jest.Mocked<FavroHttpClient>;
    mockApi = new CardsAPI(mockClient) as jest.Mocked<CardsAPI>;
    (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => mockApi);

    // `TxCards` reads the card before and after every field write, so the stand
    // has to answer the write back or the confirming read reports a write that
    // did not take.
    const store = new Map<string, Card>();
    mockApi.getCard.mockImplementation(async (cardId: string) => {
      if (!store.has(cardId)) store.set(cardId, makeCard({ cardId, name: cardId }));
      return store.get(cardId)!;
    });
    mockApi.resolveColumnId.mockImplementation(async (name: string) => `col-${name}`);
    mockApi.updateCard.mockImplementation(async (cardId: string, data: any) => {
      const next = { ...store.get(cardId)!, ...data } as Card;
      store.set(cardId, next);
      return next;
    });

    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit must not be called under run()');
    }) as any);

    program = buildProgram();
    program.exitOverride();
  });

  afterEach(() => {
    delete process.env.FAVRO_API_KEY;
    process.exitCode = undefined;
    jest.restoreAllMocks();
  });

  const said = () =>
    consoleLogSpy.mock.calls.concat(consoleErrorSpy.mock.calls).map((c) => String(c[0])).join('\n');

  it('writes every row, through the spelling each field is honoured in', async () => {
    mockFsReadFile.mockResolvedValue('card_id,status\ncard-1,Done\ncard-2,In Progress' as any);

    await program.parseAsync(['node', 'favro', '--human', 'cards', 'update', '--from-csv', 'bulk.csv', '--yes']);

    // `{status}` is a measured 200-and-no-op; `moveColumn` is what writes.
    expect(mockApi.updateCard).toHaveBeenCalledWith('card-1', { columnId: 'col-Done' });
    expect(mockApi.updateCard).toHaveBeenCalledWith('card-2', { columnId: 'col-In Progress' });
    expect(said()).toContain('2 card(s) updated');
  });

  it('the camelCase aliases reach the fields they name', async () => {
    mockFsReadFile.mockResolvedValue('cardId,dueDate\ncard-1,2026-12-31' as any);

    await program.parseAsync(['node', 'favro', '--human', 'cards', 'update', '--from-csv', 'bulk.csv', '--yes']);

    expect(mockApi.updateCard).toHaveBeenCalledWith('card-1', { dueDate: '2026-12-31' });
    expect(said()).toContain('(dueDate)');
  });

  it('the whole file is ONE dispatch, so the cap refuses it as a whole', async () => {
    const rows = Array.from({ length: MULTI_WRITE_CAP + 1 }, (_, i) => `card-${i},Done`).join('\n');
    mockFsReadFile.mockResolvedValue(`card_id,status\n${rows}` as any);

    await program.parseAsync(['node', 'favro', '--human', 'cards', 'update', '--from-csv', 'bulk.csv', '--yes']);

    // A dispatch per row would have written the first twenty and then refused —
    // which is the outcome the cap exists to prevent.
    expect(mockApi.updateCard).not.toHaveBeenCalled();
    expect(said()).toContain(`capped at ${MULTI_WRITE_CAP}`);
    expect(process.exitCode).toBe(1);
  });

  it('a row naming no field refuses rather than reporting success over an untouched card', async () => {
    mockFsReadFile.mockResolvedValue('card_id,status\ncard-1,Done\ncard-2,' as any);

    await program.parseAsync(['node', 'favro', '--human', 'cards', 'update', '--from-csv', 'bulk.csv', '--yes']);

    expect(mockApi.updateCard).not.toHaveBeenCalled();
    expect(said()).toContain('Nothing to update on card-2');
    expect(process.exitCode).toBe(1);
  });

  it('an unknown column refuses, naming it, before any card is read', async () => {
    mockFsReadFile.mockResolvedValue('card_id,custom_field_priority\ncard-1,high' as any);

    await program.parseAsync(['node', 'favro', '--human', 'cards', 'update', '--from-csv', 'bulk.csv', '--yes']);

    expect(mockApi.getCard).not.toHaveBeenCalled();
    expect(said()).toContain('custom_field_priority');
    expect(process.exitCode).toBe(1);
  });

  it('dry-run with nothing locked previews and makes no request at all', async () => {
    mockFsReadFile.mockResolvedValue('card_id,status\ncard-1,Done\ncard-2,In Progress' as any);

    await program.parseAsync([
      'node', 'favro', '--human', 'cards', 'update', '--from-csv', 'bulk.csv', '--dry-run',
    ]);

    expect(mockApi.updateCard).not.toHaveBeenCalled();
    // #102/#104's price for an unlocked path: the preview is the intent's own
    // pure `preview()`, so it costs no reads either.
    expect(mockApi.getCard).not.toHaveBeenCalled();
    expect(said()).toContain('[dry-run] update card card-1');
  });

  it('exits 1 when the CSV file is missing', async () => {
    mockFsReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await program.parseAsync([
      'node', 'favro', '--human', 'cards', 'update', '--from-csv', 'missing.csv', '--yes',
    ]);

    expect(process.exitCode).toBe(1);
  });

  it('exits 1 for a CSV with no card_id column', async () => {
    mockFsReadFile.mockResolvedValue('status,owner\nDone,alice' as any);

    await program.parseAsync(['node', 'favro', '--human', 'cards', 'update', '--from-csv', 'bad.csv', '--yes']);

    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('validation errors'));
  });
});

// ─── the spellings #110 removed ──────────────────────────────────────────────

describe('the batch-only flags on this command', () => {
  // WHAT THEY REFUSE WITH is pinned in `commands/removed.test.ts`, alongside the
  // three `batch` subcommands and `batch-smart`, so all six removed spellings are
  // compared in one place. What is pinned HERE is the half that lives on this
  // command's declaration and nowhere else: the flags are still there.
  it('are still DECLARED, so none of them is an unknown option', () => {
    // The refusal is the point of keeping them. Commander cannot name a
    // replacement, and an agent reading `unknown option '--label'` cannot tell a
    // removal from a typo — it retries the same call spelled differently.
    const update = buildProgram()
      .commands.find((c) => c.name() === 'cards')!
      .commands.find((c) => c.name() === 'update')!;
    const flags = update.options.map((o) => o.long);
    expect(flags).toEqual(expect.arrayContaining(['--board', '--label', '--assignee']));
  });
});
