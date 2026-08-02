/**
 * `cards list --tag` / `--assignee` obey the closed vocabulary (#84).
 *
 * WHAT IT GUARDS
 * `--filter "tag:x"` and `--tag x` are the same question in two spellings, and
 * they sat on the same flag row answering it two different ways: the first was
 * settled against Favro's own tag list before the fetch (#46), the second was a
 * raw lowercase `includes()` over the fetched cards with nothing behind it.
 *
 * Three failures, not one:
 *
 *   - AN UNKNOWN VALUE ANSWERED. `--tag typoo` returned zero rows while
 *     `--filter "tag:typoo"` refused and printed the org's tags. Zero rows is
 *     the plausible wrong answer #32/#44/#46 exist to abolish.
 *   - A SUBSTRING WON. `--tag bug` also matched `debug` and `bugfix`. That is
 *     worse than empty: it is populated and wrong. A substring that happens to
 *     match one tag today is right by luck and silently becomes wrong the day a
 *     second tag contains it.
 *   - `--assignee` MATCHED THE WRONG KEYSPACE. `card.assignees` holds `userId`s
 *     (`normalizeCard` maps `assignments[].userId`), so `--assignee ali`
 *     substring-matched an *id* — hitting Alice by accident here and nobody at
 *     all in an org whose ids are opaque base62-17.
 *
 * The fix is not two guards on two flags. Both flags are predicates in a
 * grammar that already fails closed, so they become `tag:` and `assignee:`
 * nodes and take the one resolution `--filter` takes — before the fetch, so a
 * typo never costs a board read.
 */
import { buildProgram } from '../cli';
import CardsAPI, { Card } from '../lib/cards-api';
import {
  STUB_BOARD,
  stubVocabularyClient,
  useTempConfigDir,
} from '../test-support/filter-vocabulary';

jest.mock('../lib/cards-api');
jest.mock('../lib/client-factory', () => {
  const { stubVocabularyClient: stub } = jest.requireActual('../test-support/filter-vocabulary');
  const createFavroClient = jest.fn(async () => stub());
  return { __esModule: true, createFavroClient, default: createFavroClient };
});

useTempConfigDir();

/**
 * `bug` and `debug` both exist in the stub org, which is the whole point: the
 * substring the old filter matched is a real tag name, so nothing about the
 * data hints that the answer is wrong.
 */
const CARDS: Card[] = [
  {
    cardId: 'c-bug',
    name: 'Fix login',
    tags: ['bug'],
    assignees: ['alice@example.com'],
  } as Card,
  {
    cardId: 'c-debug',
    name: 'Add debug logging',
    tags: ['debug'],
    assignees: ['bob@example.com'],
  } as Card,
];

let listCards: jest.Mock;
let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
let tableSpy: jest.SpyInstance;
let exitSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  listCards = jest.fn().mockResolvedValue(CARDS);
  (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(
    () => ({ listCards } as any)
  );
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  tableSpy = jest.spyOn(console, 'table').mockImplementation(() => {});
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit');
  });
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  tableSpy.mockRestore();
  exitSpy.mockRestore();
});

/** Run `cards list` with the given flags and read the JSON envelope back. */
async function list(...flags: string[]): Promise<{ rows: Array<{ cardId: string }> }> {
  await buildProgram().parseAsync([
    'node', 'cli', 'cards', 'list', STUB_BOARD, '--json', ...flags,
  ]);
  const line = logSpy.mock.calls
    .map((c) => String(c[0]))
    .filter((c) => c.startsWith('{"rows":'))
    .pop()!;
  return JSON.parse(line);
}

/** Run `cards list` expecting it to refuse, and hand back what it printed. */
async function refusal(...flags: string[]): Promise<string> {
  await expect(
    buildProgram().parseAsync(['node', 'cli', 'cards', 'list', STUB_BOARD, '--json', ...flags])
  ).rejects.toThrow('process.exit');
  return errorSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
}

describe('--tag resolves through the closed vocabulary', () => {
  test('an exact tag matches, and a card whose tag merely CONTAINS it does not', async () => {
    expect((await list('--tag', 'bug')).rows.map((r) => r.cardId)).toEqual(['c-bug']);
  });

  test('an unknown tag refuses and names the candidates, instead of answering zero rows', async () => {
    const printed = await refusal('--tag', 'typoo');
    expect(printed).toContain('typoo');
    expect(printed).toContain('bug');
  });

  test('a substring of a real tag is not a value — it refuses rather than matching by luck', async () => {
    expect(await refusal('--tag', 'bu')).toContain('bu');
  });

  test('the refusal lands before the board read, exactly as --filter does', async () => {
    await refusal('--tag', 'typoo');
    expect(listCards).not.toHaveBeenCalled();
  });

  test('--tag and --filter "tag:" answer identically', async () => {
    const byFlag = await list('--tag', 'bug');
    const byFilter = await list('--filter', 'tag:bug');
    expect(byFlag.rows.map((r) => r.cardId)).toEqual(byFilter.rows.map((r) => r.cardId));
  });
});

describe('--assignee resolves through the closed vocabulary', () => {
  test('a name resolves to the userId the card actually carries', async () => {
    expect((await list('--assignee', 'alice')).rows.map((r) => r.cardId)).toEqual(['c-bug']);
  });

  test('a substring of a real user refuses instead of matching one by accident', async () => {
    expect(await refusal('--assignee', 'ali')).toContain('ali');
  });

  test('an unknown assignee refuses and names a reachable next step', async () => {
    const printed = await refusal('--assignee', 'nobody');
    expect(printed).toContain('nobody');
    expect(printed).toContain('favro users');
  });
});

describe('the flags compose with each other and with --filter', () => {
  test('--tag and --assignee narrow together', async () => {
    expect((await list('--tag', 'bug', '--assignee', 'alice')).rows.map((r) => r.cardId))
      .toEqual(['c-bug']);
    expect((await list('--tag', 'bug', '--assignee', 'bob')).rows).toEqual([]);
  });

  test('a flag ANDs with --filter rather than replacing it', async () => {
    expect((await list('--filter', 'tag:bug', '--assignee', 'bob')).rows).toEqual([]);
  });

  test('no filtering flag at all still lists the board', async () => {
    expect((await list()).rows.map((r) => r.cardId)).toEqual(['c-bug', 'c-debug']);
  });
});
