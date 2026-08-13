/**
 * Filter values fail closed on the closed vocabularies (#46).
 *
 * Driven through the real persistent cache (a temp FAVRO_CONFIG_DIR) so the
 * refill-before-refuse rule is exercised, not mocked away.
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { parseQuery, ParseError, FieldPredicate } from '../../lib/query-parser';
import { validateQueryValues, refuseEmpty } from '../../lib/query-values';
import { writeCache } from '../../lib/name-cache';

const WIDGETS = [
  {
    widgetCommonId: 'board-1',
    name: 'Dev',
    type: 'board',
    columns: [
      { columnId: 'col-1', name: 'To Do' },
      { columnId: 'col-2', name: 'Doing' },
    ],
  },
];

const TAGS = [
  { tagId: 'tag-1', name: 'urgent' },
  { tagId: 'tag-2', name: 'backend' },
];

const USERS = [
  { userId: 'aaaaaaaaaaaaaaaaa', name: 'John Doe', email: 'john@example.com' },
];

/** Minimal FavroHttpClient stand-in — only the reads these paths make. */
function makeClient(overrides: { tags?: any[]; users?: any[] } = {}) {
  const get = jest.fn(async (url: string) => {
    if (url === '/widgets') return { entities: WIDGETS };
    if (url === '/tags') return { entities: overrides.tags ?? TAGS };
    if (url === '/users') return { entities: overrides.users ?? USERS };
    throw new Error(`unexpected GET ${url}`);
  });
  return { client: { get, organizationId: 'org-a' } as any, get };
}

const originalConfigDir = process.env.FAVRO_CONFIG_DIR;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'favro-qvals-test-'));
  process.env.FAVRO_CONFIG_DIR = tmpDir;
});

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.FAVRO_CONFIG_DIR;
  else process.env.FAVRO_CONFIG_DIR = originalConfigDir;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const pred = (node: any): FieldPredicate => node as FieldPredicate;

describe('tag: against the org tag list', () => {
  test('a known tag passes', async () => {
    const { client } = makeClient();
    const q = await validateQueryValues(parseQuery('tag:urgent'), { client });
    expect(pred(q.ast).value).toBe('urgent');
  });

  test('a typo refuses, naming the tags that exist', async () => {
    const { client } = makeClient();
    await expect(validateQueryValues(parseQuery('tag:urgnt'), { client }))
      .rejects.toThrow(/No tag matching "urgnt"/);
  });

  test('the refusal names the tag list, and `label:` refuses as `tag:`', async () => {
    const { client } = makeClient();
    try {
      await validateQueryValues(parseQuery('label:nope'), { client });
      throw new Error('expected a refusal');
    } catch (err) {
      const e = err as Error;
      expect(e).toBeInstanceOf(ParseError);
      expect(e.name).toBe('ParseError');
      // `label:` is the tag vocabulary under another spelling — the refusal has
      // to be the TAG one, word for word, including the sorted org list. This
      // replaces the `detail.kind`/`field`/`candidates` assertions #140 deleted;
      // the message is where all three were readable all along.
      expect(e.message).toBe(
        `No tag matching "nope" — it is missing or not visible to your key. ` +
          `Run 'favro tags list' to see them. The org's tags:\n  backend\n  urgent`
      );
    }
  });

  test('refills before refusing — a tag added since the cache filled passes', async () => {
    // Cache says two tags; the org now has three. Refusing on the cache alone
    // would refuse a tag that exists.
    await writeCache('org-a', 'tags', TAGS);
    const { client, get } = makeClient({ tags: [...TAGS, { tagId: 'tag-3', name: 'infra' }] });
    const q = await validateQueryValues(parseQuery('tag:infra'), { client });
    expect(pred(q.ast).value).toBe('infra');
    expect(get).toHaveBeenCalledWith('/tags', expect.anything());
  });

  test('every value of an in(…) list is checked', async () => {
    const { client } = makeClient();
    await expect(validateQueryValues(parseQuery('tag in(urgent,ghost)'), { client }))
      .rejects.toThrow(/No tag matching "ghost"/);
  });

  // Not one accented character is written out below; each is built from its
  // code point, because a normalising editor rewriting one side of these
  // assertions into the other would make them pass for the wrong reason (#141).
  describe('the same name in two normalisation forms (#141)', () => {
    const cp = (...codes: number[]) => String.fromCodePoint(...codes);
    /** cafe-acute, precomposed — one code point for the accented e. */
    const NFC = `caf${cp(0x00e9)}`;
    /** cafe-acute, decomposed — plain e plus a combining acute. */
    const NFD = `cafe${cp(0x0301)}`;

    test('a decomposed input matches a precomposed tag', async () => {
      const { client } = makeClient({ tags: [{ tagId: 't', name: NFC }] });
      const q = await validateQueryValues(parseQuery(`tag:${NFD}`), { client });
      // The TYPED value comes back, unnormalised: the fold is for comparison,
      // and the canonical spelling belongs to Favro.
      expect(pred(q.ast).value).toBe(NFD);
    });

    test('a precomposed input matches a decomposed tag', async () => {
      const { client } = makeClient({ tags: [{ tagId: 't', name: NFD }] });
      const q = await validateQueryValues(parseQuery(`tag:${NFC}`), { client });
      expect(pred(q.ast).value).toBe(NFC);
    });

    test('the ~ operator folds too', async () => {
      const { client } = makeClient({ tags: [{ tagId: 't', name: `${NFC} au lait` }] });
      const q = await validateQueryValues(parseQuery(`tag~${NFD}`), { client });
      expect(pred(q.ast).value).toBe(NFD);
    });

    test('a refusal still lists the org spelling byte-for-byte', async () => {
      const { client } = makeClient({ tags: [{ tagId: 't', name: NFD }] });
      try {
        await validateQueryValues(parseQuery('tag:ghost'), { client });
        throw new Error('expected a refusal');
      } catch (err) {
        // Byte-for-byte: the message lists the org's DECOMPOSED spelling, and
        // must not have normalised it into the precomposed one on the way out.
        // (`detail.candidates` used to carry this; nothing read it — #140.)
        const message = (err as Error).message;
        expect(message).toContain(NFD);
        expect(message).not.toContain(NFC);
      }
    });
  });
});

describe('status: against the board’s columns', () => {
  test('requires --board', async () => {
    const { client } = makeClient();
    try {
      await validateQueryValues(parseQuery('status:Doing'), { client });
      throw new Error('expected a refusal');
    } catch (err) {
      const e = err as Error;
      expect(e).toBeInstanceOf(ParseError);
      expect(e.name).toBe('ParseError');
      // The `status:`-with-no-board refusal specifically, not merely "it threw":
      // ColumnDirectory has a --board refusal of its own, and reaching THAT one
      // would mean a read was attempted before the board was known.
      expect(e.message).toBe(
        `'status:Doing' needs a board — a column name is only unique within one. ` +
          `Pass --board <board>, or filter on 'columnId:' instead.`
      );
    }
  });

  test('a real column resolves to its canonical name', async () => {
    const { client } = makeClient();
    const q = await validateQueryValues(parseQuery('status:doing'), { client, boardId: 'board-1' });
    expect(pred(q.ast).value).toBe('Doing');
  });

  test('a columnId is rewritten to the name the cards carry', async () => {
    const { client } = makeClient();
    const q = await validateQueryValues(parseQuery('status:col-1'), { client, boardId: 'board-1' });
    expect(pred(q.ast).value).toBe('To Do');
  });

  test('a column that board does not have refuses, listing the ones it does', async () => {
    const { client } = makeClient();
    await expect(validateQueryValues(parseQuery('status:Shipped'), { client, boardId: 'board-1' }))
      .rejects.toThrow(/No column named "Shipped" on board board-1/);
  });
});

describe('assignee: through the one resolution home', () => {
  test('a name becomes the userId the cards actually carry', async () => {
    const { client } = makeClient();
    const q = await validateQueryValues(parseQuery('assignee:"John Doe"'), { client });
    expect(pred(q.ast).value).toBe('aaaaaaaaaaaaaaaaa');
  });

  test('an unknown assignee refuses instead of comparing text to userIds', async () => {
    const { client } = makeClient();
    await expect(validateQueryValues(parseQuery('assignee:nobody'), { client }))
      .rejects.toThrow(/Unknown assignee "nobody"/);
  });
});

describe('refuseEmpty', () => {
  // Its three existing arms are CLI-level (`cli-cards-list-vocabulary`,
  // `batch-filter-fail-closed-wire`, `write-echo-wire`) and see only the printed
  // line, so they pin the wording but not the class. #140 deleted this site's
  // `{ kind: 'unknown-value', field, value }`, which leaves the class and the
  // prose as the whole contract — both asserted here.
  test('an empty value refuses as a ParseError, naming the flag', () => {
    expect(() => refuseEmpty('filter', '')).toThrow(ParseError);
    try {
      refuseEmpty('filter', '   ');
      throw new Error('expected a refusal');
    } catch (err) {
      const e = err as Error;
      expect(e).toBeInstanceOf(ParseError);
      expect(e.name).toBe('ParseError');
      expect(e.message).toBe(
        `--filter was passed with an empty value — it narrows nothing, and ignoring ` +
          `it would answer the whole board. Pass a value, or drop the flag.`
      );
    }
  });

  test('an ABSENT flag is not an empty one', () => {
    expect(() => refuseEmpty('filter', undefined)).not.toThrow();
  });

  test('a non-empty value passes', () => {
    expect(() => refuseEmpty('tag', 'bug')).not.toThrow();
  });
});

/**
 * `blocked-by:`/`blocks:` take a card reference, and one spelling of it —
 * a sequentialId label — matches no key a dependency edge carries. Favro has
 * never been measured sending `cardSequentialId` on either dependency shape,
 * so `blocked-by:CLA-1804` (documented at `query-parser.ts:361`) matched
 * nothing at all, silently, for as long as it has been documented (#162).
 *
 * It is resolved here now, to a `cardCommonId` — board-independent, so it still
 * matches an edge onto a card that lives on several boards.
 */
describe('blocked-by: / blocks: settle a sequentialId reference (#162)', () => {
  const CARD = { cardId: 'card-hex-1', cardCommonId: 'common-hex-1', widgetCommonId: 'board-1' };

  function makeCardClient(entities: unknown[]) {
    const get = jest.fn(async (url: string) => {
      if (url === '/cards') return { entities };
      throw new Error(`unexpected GET ${url}`);
    });
    return { client: { get, organizationId: 'org-a' } as any, get };
  }

  test.each(['blocked-by', 'blocks'])('%s:CLA-1804 resolves to the card\'s cardCommonId', async (field) => {
    const { client, get } = makeCardClient([CARD]);
    const q = await validateQueryValues(parseQuery(`${field}:CLA-1804`), { client });
    expect(pred(q.ast).value).toBe(CARD.cardCommonId);
    // Favro's own filter is the NUMBER; the label prefix is ours.
    expect(get).toHaveBeenCalledWith('/cards', {
      params: expect.objectContaining({ cardSequentialId: 1804 }),
    });
  });

  test('a reference that resolves to nothing REFUSES instead of matching nothing', async () => {
    const { client } = makeCardClient([]);
    await expect(validateQueryValues(parseQuery('blocked-by:CLA-9999'), { client }))
      .rejects.toThrow(/CLA-9999/);
  });

  test('a hex id is passed through untouched and costs no call', async () => {
    // An edge carries BOTH `cardId` and `cardCommonId`, so either settles
    // locally — paying a round-trip to convert between them would buy nothing.
    for (const ref of [CARD.cardId, CARD.cardCommonId]) {
      const { client, get } = makeCardClient([]);
      const q = await validateQueryValues(parseQuery(`blocked-by:${ref}`), { client });
      expect(pred(q.ast).value).toBe(ref);
      expect(get).not.toHaveBeenCalled();
    }
  });

  test('`blocked-by:true` still means "any blocker", and makes no call', async () => {
    const { client, get } = makeCardClient([]);
    const q = await validateQueryValues(parseQuery('blocked-by:true'), { client });
    expect(pred(q.ast).value).toBe('true');
    expect(get).not.toHaveBeenCalled();
  });

  test('the BARE spelling refuses at parse — `unblocked` is the only bare keyword', () => {
    expect(() => parseQuery('blocked-by')).toThrow(ParseError);
  });
});

describe('everything else passes through', () => {
  test('an open-vocabulary field is untouched', async () => {
    const { client } = makeClient();
    const q = await validateQueryValues(parseQuery('title~bug AND due_in:7d'), { client });
    expect(q.ast?.kind).toBe('and');
  });

  test('an empty query is returned as-is', async () => {
    const { client, get } = makeClient();
    const q = await validateQueryValues(parseQuery(''), { client });
    expect(q.ast).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});
