/**
 * A stub org for the `--filter` closed vocabularies (#83).
 *
 * `--filter` no longer takes a caller's word for a tag, a column or an
 * assignee: `resolveQuery` settles every one of them against Favro before the
 * query runs. So any test driving a filter needs an org to settle them
 * against, and two files needed the same one.
 *
 * The users are stubbed with `userId === email` on purpose. `assignee:` leaves
 * resolution as a `userId` and the card fixtures here carry emails in
 * `assignees`; making the two the same string keeps those fixtures matching
 * without a rewrite that has nothing to do with what they test.
 */
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

/** The board whose columns settle a `status:` value. */
export const STUB_BOARD = 'board-stub';

/** Column names the stub board has. Anything else refuses. */
export const STUB_COLUMNS = ['todo', 'in-progress', 'done'];

/** Tag names the stub org has. Anything else refuses. */
export const STUB_TAGS = ['bug', 'urgent', 'docs', 'release', 'high-priority'];

/** Users the stub org has, keyed the way the card fixtures spell them. */
export const STUB_USERS = ['alice', 'bob', 'carol'];

/** Minimal FavroHttpClient stand-in — only the reads the filter paths make. */
export function stubVocabularyClient(): any {
  const get = async (url: string) => {
    if (url === '/widgets') {
      return {
        entities: [
          {
            widgetCommonId: STUB_BOARD,
            name: 'Stub',
            type: 'board',
            columns: STUB_COLUMNS.map((name, i) => ({ columnId: `col-${i}`, name })),
          },
        ],
      };
    }
    if (url === '/tags') {
      return { entities: STUB_TAGS.map((name, i) => ({ tagId: `tag-${i}`, name })) };
    }
    if (url === '/users') {
      return {
        entities: STUB_USERS.map((name) => ({
          userId: `${name}@example.com`,
          name,
          email: `${name}@example.com`,
        })),
      };
    }
    throw new Error(`unexpected GET ${url}`);
  };
  return { get, organizationId: 'org-stub' };
}

/** The `ValueContext` a filter needs, pointed at the stub org. */
export function stubFilterContext(): { client: any; boardId: string } {
  return { client: stubVocabularyClient(), boardId: STUB_BOARD };
}

/**
 * Point the persistent name cache at a throwaway directory for this file's
 * tests, so a filter run never reads or writes the developer's `~/.favro`.
 */
export function useTempConfigDir(): void {
  const original = process.env.FAVRO_CONFIG_DIR;
  let dir: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'favro-filter-vocab-'));
    process.env.FAVRO_CONFIG_DIR = dir;
  });

  afterEach(async () => {
    if (original === undefined) delete process.env.FAVRO_CONFIG_DIR;
    else process.env.FAVRO_CONFIG_DIR = original;
    await fsp.rm(dir, { recursive: true, force: true });
  });
}
