/**
 * Persistent name↔id cache (#39): TTL, org keying, FAVRO_CONFIG_DIR honouring,
 * and the parsed-file memo (#122).
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  CACHE_TTL_MS,
  cacheFilePath,
  cachedList,
  invalidateCache,
  readCache,
  writeCache,
} from '../../lib/name-cache';

const originalConfigDir = process.env.FAVRO_CONFIG_DIR;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'favro-cache-test-'));
  process.env.FAVRO_CONFIG_DIR = tmpDir;
});

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.FAVRO_CONFIG_DIR;
  else process.env.FAVRO_CONFIG_DIR = originalConfigDir;
  await fs.rm(tmpDir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

describe('cacheFilePath', () => {
  test('honours FAVRO_CONFIG_DIR', () => {
    expect(cacheFilePath()).toBe(path.join(tmpDir, 'name-cache.json'));
  });

  test('falls back to ~/.favro when FAVRO_CONFIG_DIR is unset', () => {
    delete process.env.FAVRO_CONFIG_DIR;
    expect(cacheFilePath()).toBe(path.join(os.homedir(), '.favro', 'name-cache.json'));
  });

  test('is resolved per call, so a tenant switch changes the file', async () => {
    await writeCache('org-a', 'tags', [{ tagId: 't1' }]);
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'favro-cache-test-'));
    process.env.FAVRO_CONFIG_DIR = other;
    expect(await readCache('org-a', 'tags')).toBeUndefined();
    process.env.FAVRO_CONFIG_DIR = tmpDir;
    expect(await readCache('org-a', 'tags')).toEqual([{ tagId: 't1' }]);
    await fs.rm(other, { recursive: true, force: true });
  });
});

// Every readCache / readCacheRecord / writeCache / invalidateCache funnelled
// through an unmemoized `fs.readFile` + `JSON.parse` of the whole file, so
// resolving N columns in a sweep cost N full parses (#122).
describe('the parsed file is memoized', () => {
  // `fs/promises` exports are non-configurable, so the parse count is not
  // spyable. Deleting the file mid-sweep proves the same thing harder: a lookup
  // that still answers cannot have gone to disk for it.
  test('a resolution sweep parses the file once, not once per lookup', async () => {
    await writeCache('org-a', 'columns', [{ columnId: 'c1' }]);
    await writeCache('org-a', 'tags', [{ tagId: 't1' }]);
    await writeCache('org-a', 'users', [{ userId: 'u1' }]);

    expect(await readCache('org-a', 'columns')).toEqual([{ columnId: 'c1' }]);
    await fs.rm(cacheFilePath());
    expect(await readCache('org-a', 'tags')).toEqual([{ tagId: 't1' }]);
    expect(await readCache('org-a', 'users')).toEqual([{ userId: 'u1' }]);
  });

  test('a write clears it, so the next read sees what was written', async () => {
    await writeCache('org-a', 'tags', [{ tagId: 'first' }]);
    expect(await readCache('org-a', 'tags')).toEqual([{ tagId: 'first' }]);
    await writeCache('org-a', 'tags', [{ tagId: 'second' }]);
    expect(await readCache('org-a', 'tags')).toEqual([{ tagId: 'second' }]);
  });

  test('an invalidation clears it too', async () => {
    await writeCache('org-a', 'tags', [{ tagId: 'a' }]);
    expect(await readCache('org-a', 'tags')).toEqual([{ tagId: 'a' }]);
    await invalidateCache('org-a', 'tags');
    expect(await readCache('org-a', 'tags')).toBeUndefined();
  });

  // `readFile` memoizes the two outcomes DIFFERENTLY, on purpose, and neither
  // half had a test: memoizing the absent case passed all 3062 tests. Both arms
  // are asserted together so the test cannot pass by never memoizing OR by
  // always memoizing — only by the split the module actually declares.
  //
  // Each arm writes the file DIRECTLY rather than through `writeCache`, so
  // `writeFile`'s memo clear is not what makes it pass.
  test('an absent read is NOT memoized — a file that appears later is seen', async () => {
    // Pinning "no cache" for the life of the process over one failed open is a
    // bad trade: nothing has written through this module, so nothing would ever
    // clear it. For a long-lived favro-mcp-http the tenant dir being provisioned
    // a moment after first read would go unseen until the process wrote.
    expect(await readCache('org-a', 'tags')).toBeUndefined();

    await fs.writeFile(
      cacheFilePath(),
      JSON.stringify({ 'org-a': { tags: { fetchedAt: Date.now(), entries: [{ tagId: 'appeared' }] } } })
    );

    expect(await readCache('org-a', 'tags')).toEqual([{ tagId: 'appeared' }]);
  });

  test('a corrupt read IS memoized — the same bad bytes are not re-parsed', async () => {
    await fs.writeFile(cacheFilePath(), '{ not json');
    expect(await readCache('org-a', 'tags')).toBeUndefined();

    // Repairing the file from outside is NOT picked up, because the corrupt
    // parse was memoized. Measured, and the cost is real: the next write is
    // computed off that empty parse, so it DISCARDS the repaired content rather
    // than merging with it. Already the declared posture — "corrupt reads as no
    // cache" plus a last-writer-wins whole-file rewrite — and TTL-bounded
    // nowhere, so pinned here rather than left for someone to rediscover.
    await fs.writeFile(
      cacheFilePath(),
      JSON.stringify({ 'org-a': { tags: { fetchedAt: Date.now(), entries: [{ tagId: 'repaired' }] } } })
    );
    expect(await readCache('org-a', 'tags')).toBeUndefined();

    await writeCache('org-a', 'users', [{ userId: 'u1' }]);
    expect(await readCache('org-a', 'tags')).toBeUndefined();
    expect(await readCache('org-a', 'users')).toEqual([{ userId: 'u1' }]);
  });

  // FAVRO_CONFIG_DIR is re-read per call so favro-mcp-http can give each tenant
  // its own file. A memo keyed on anything but the resolved path would serve one
  // tenant's cache to another.
  test('it is keyed by path — a tenant switch never crosses over', async () => {
    await writeCache('org-a', 'tags', [{ tagId: 'tenant-a' }]);
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'favro-cache-test-'));
    process.env.FAVRO_CONFIG_DIR = other;
    await writeCache('org-a', 'tags', [{ tagId: 'tenant-b' }]);

    // Same org key, same kind, different file — and reads alternate, so a memo
    // that ignored the path would answer at least one of these with the other
    // tenant's data.
    expect(await readCache('org-a', 'tags')).toEqual([{ tagId: 'tenant-b' }]);
    process.env.FAVRO_CONFIG_DIR = tmpDir;
    expect(await readCache('org-a', 'tags')).toEqual([{ tagId: 'tenant-a' }]);
    process.env.FAVRO_CONFIG_DIR = other;
    expect(await readCache('org-a', 'tags')).toEqual([{ tagId: 'tenant-b' }]);

    await fs.rm(other, { recursive: true, force: true });
  });
});

describe('TTL', () => {
  test('returns entries inside the 15-minute window', async () => {
    await writeCache('org-a', 'users', [{ userId: 'u1' }]);
    expect(await readCache('org-a', 'users')).toEqual([{ userId: 'u1' }]);
  });

  test('returns undefined once the entry is older than the TTL', async () => {
    await writeCache('org-a', 'users', [{ userId: 'u1' }], Date.now() - CACHE_TTL_MS - 1);
    expect(await readCache('org-a', 'users')).toBeUndefined();
  });

  test('one knob: the same TTL governs every kind', async () => {
    const stale = Date.now() - CACHE_TTL_MS - 1;
    await writeCache('org-a', 'columns', [{ columnId: 'c1' }], stale);
    await writeCache('org-a', 'tags', [{ tagId: 't1' }], stale);
    await writeCache('org-a', 'users', [{ userId: 'u1' }], stale);
    expect(await readCache('org-a', 'columns')).toBeUndefined();
    expect(await readCache('org-a', 'tags')).toBeUndefined();
    expect(await readCache('org-a', 'users')).toBeUndefined();
  });
});

describe('org keying', () => {
  test('keeps organizations apart', async () => {
    await writeCache('org-a', 'tags', [{ tagId: 'a' }]);
    await writeCache('org-b', 'tags', [{ tagId: 'b' }]);
    expect(await readCache('org-a', 'tags')).toEqual([{ tagId: 'a' }]);
    expect(await readCache('org-b', 'tags')).toEqual([{ tagId: 'b' }]);
  });

  test('an unknown org is a miss, not another org’s data', async () => {
    await writeCache('org-a', 'tags', [{ tagId: 'a' }]);
    expect(await readCache('org-c', 'tags')).toBeUndefined();
  });

  test('no organizationId means no caching at all', async () => {
    await writeCache(undefined, 'tags', [{ tagId: 'a' }]);
    expect(await readCache(undefined, 'tags')).toBeUndefined();
  });
});

describe('cachedList', () => {
  test('fetches on miss and serves the second call from cache', async () => {
    const fetch = jest.fn().mockResolvedValue([{ tagId: 't1' }]);
    expect(await cachedList('org-a', 'tags', fetch)).toEqual([{ tagId: 't1' }]);
    expect(await cachedList('org-a', 'tags', fetch)).toEqual([{ tagId: 't1' }]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('refetches once the entry expires', async () => {
    const fetch = jest.fn().mockResolvedValue([{ tagId: 't1' }]);
    await writeCache('org-a', 'tags', [{ tagId: 'old' }], Date.now() - CACHE_TTL_MS - 1);
    expect(await cachedList('org-a', 'tags', fetch)).toEqual([{ tagId: 't1' }]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('always fetches when there is no organizationId', async () => {
    const fetch = jest.fn().mockResolvedValue([{ tagId: 't1' }]);
    await cachedList(undefined, 'tags', fetch);
    await cachedList(undefined, 'tags', fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('resilience', () => {
  test('a corrupted cache file reads as a miss', async () => {
    await fs.writeFile(cacheFilePath(), '{ not json');
    expect(await readCache('org-a', 'tags')).toBeUndefined();
  });

  test('an unwritable config dir does not throw', async () => {
    const blocker = path.join(tmpDir, 'blocker');
    await fs.writeFile(blocker, 'not a directory');
    process.env.FAVRO_CONFIG_DIR = path.join(blocker, 'nested');
    await expect(writeCache('org-a', 'tags', [{ tagId: 't1' }])).resolves.toBeUndefined();
    expect(await readCache('org-a', 'tags')).toBeUndefined();
  });

  test('invalidateCache drops one kind, one org, or everything', async () => {
    await writeCache('org-a', 'tags', [{ tagId: 'a' }]);
    await writeCache('org-a', 'users', [{ userId: 'a' }]);
    await writeCache('org-b', 'tags', [{ tagId: 'b' }]);

    await invalidateCache('org-a', 'tags');
    expect(await readCache('org-a', 'tags')).toBeUndefined();
    expect(await readCache('org-a', 'users')).toEqual([{ userId: 'a' }]);

    await invalidateCache('org-a');
    expect(await readCache('org-a', 'users')).toBeUndefined();
    expect(await readCache('org-b', 'tags')).toEqual([{ tagId: 'b' }]);

    await invalidateCache();
    expect(await readCache('org-b', 'tags')).toBeUndefined();
  });

  // Every caller passes a kind and reads its org from saved auth, which may not
  // hold one ("Organization ID not saved"). Discarding the kind and wiping the
  // file for every org is not what any of them asked for — it was observed live
  // as a 2-byte `~/.favro/name-cache.json`.
  test('a kind with no organizationId is a no-op, not a whole-file wipe', async () => {
    await writeCache('org-a', 'tags', [{ tagId: 'a' }]);
    await writeCache('org-b', 'users', [{ userId: 'b' }]);

    await invalidateCache(undefined, 'tags');

    expect(await readCache('org-a', 'tags')).toEqual([{ tagId: 'a' }]);
    expect(await readCache('org-b', 'users')).toEqual([{ userId: 'b' }]);
  });
});
