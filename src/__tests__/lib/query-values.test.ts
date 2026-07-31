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
import { validateQueryValues } from '../../lib/query-values';
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

  test('the refusal carries a structured payload', async () => {
    const { client } = makeClient();
    try {
      await validateQueryValues(parseQuery('label:nope'), { client });
      throw new Error('expected a refusal');
    } catch (err) {
      const e = err as ParseError;
      expect(e.detail.kind).toBe('unknown-value');
      expect(e.detail.field).toBe('tag');
      expect(e.detail.candidates).toEqual(['backend', 'urgent']);
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
});

describe('status: against the board’s columns', () => {
  test('requires --board', async () => {
    const { client } = makeClient();
    try {
      await validateQueryValues(parseQuery('status:Doing'), { client });
      throw new Error('expected a refusal');
    } catch (err) {
      const e = err as ParseError;
      expect(e.detail.kind).toBe('missing-board');
      expect(e.message).toMatch(/--board/);
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
