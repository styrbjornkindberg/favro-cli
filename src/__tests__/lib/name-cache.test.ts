/**
 * Persistent name↔id cache (#39): TTL, org keying, FAVRO_CONFIG_DIR honouring.
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
