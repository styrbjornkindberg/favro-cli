/**
 * Persistent name↔id cache (#39).
 *
 * One JSON file in the config dir, keyed by organizationId, one 15-minute TTL
 * for every kind. FAVRO_CONFIG_DIR is read at call time (same expression as
 * config.ts) so `favro-mcp-http` gives each tenant its own cache file by
 * setting the env before the process starts.
 *
 * Best-effort: any read/write failure degrades to "no cache", never throws.
 *
 * A leaf: it imports no API class. Callers pass their own `fetch` (#122), which
 * is what keeps `tags-api`/`users-api` out of a cycle with this module.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

/** The one knob. */
export const CACHE_TTL_MS = 15 * 60 * 1000;

export type CacheKind = 'columns' | 'tags' | 'users' | 'boards' | 'collections';

export interface CacheRecord<T> {
  fetchedAt: number;
  entries: T[];
}

type CacheFile = Record<string, Partial<Record<CacheKind, CacheRecord<unknown>>>>;

/** Path of the cache file. Resolved per call so FAVRO_CONFIG_DIR is honoured. */
export function cacheFilePath(): string {
  const dir = process.env.FAVRO_CONFIG_DIR || path.join(os.homedir(), '.favro');
  return path.join(dir, 'name-cache.json');
}

/**
 * The parsed file, keyed by the path it was parsed from.
 *
 * Keying by resolved path is load-bearing, not decoration: `favro-mcp-http`
 * gives each tenant its own file via FAVRO_CONFIG_DIR and `cacheFilePath()`
 * re-reads the env per call to honour that, so a bare module global would serve
 * one tenant's cache to another.
 *
 * ponytail: one entry, not a Map. Two tenants alternating just thrash back to
 * the old read-every-call behaviour, which is correct if slower; a Map would
 * grow unbounded in a long-lived server for a win nobody has measured.
 *
 * WIDENS AN ACCEPTED RISK, deliberately. ADR-0003 records the posture as "a
 * second CLI process writing the cache mid-command is not seen". Only THIS
 * process's `writeFile` clears the memo, so for a long-lived `favro-mcp-http`
 * that window is no longer one command but the life of the server, bounded by
 * the 15-minute TTL: another shell running `favro tags create` used to be
 * visible on the next read and now is not. TTL-bounded, so stale at worst,
 * never lost. Cheapest fix if that bites is an `fs.stat` mtime check before
 * trusting the memo — more code than the win, today.
 */
let memo: { path: string; data: CacheFile } | undefined;

/**
 * Parse the cache file once per path. Every read funnels through here, so a
 * resolution sweep over N columns costs one parse instead of N.
 */
async function readFile(): Promise<CacheFile> {
  const file = cacheFilePath();
  if (memo && memo.path === file) return memo.data;

  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch {
    // Absent, or a transient EACCES/EMFILE. NOT memoized: pinning "no cache"
    // for the life of the process over one failed open is a bad trade, and the
    // no-file case is one cheap ENOENT per read.
    return {};
  }

  let data: CacheFile = {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') data = parsed as CacheFile;
  } catch {
    // Corrupt reads as "no cache". Memoized: re-parsing the same bad bytes
    // cannot start succeeding.
  }
  memo = { path: file, data };
  return data;
}

// ponytail: last-writer-wins whole-file rewrite. Fine for a per-user cache;
// switch to per-org files if concurrent CLI processes start clobbering.
async function writeFile(data: CacheFile): Promise<void> {
  memo = undefined;
  try {
    const file = cacheFilePath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(data), { mode: 0o600 });
  } catch {
    // Cache is an optimization — never fail a command over it.
  }
}

/** Raw record for an org+kind, TTL ignored. Undefined when absent. */
export async function readCacheRecord<T>(
  organizationId: string | undefined,
  kind: CacheKind
): Promise<CacheRecord<T> | undefined> {
  if (!organizationId) return undefined;
  const record = (await readFile())[organizationId]?.[kind];
  if (!record || typeof record.fetchedAt !== 'number' || !Array.isArray(record.entries)) {
    return undefined;
  }
  return record as CacheRecord<T>;
}

/** Cached entries for an org+kind, or undefined when missing or older than the TTL. */
export async function readCache<T>(
  organizationId: string | undefined,
  kind: CacheKind
): Promise<T[] | undefined> {
  const record = await readCacheRecord<T>(organizationId, kind);
  if (!record) return undefined;
  if (Date.now() - record.fetchedAt >= CACHE_TTL_MS) return undefined;
  return record.entries;
}

/**
 * Store entries for an org+kind. `fetchedAt` defaults to now; pass the previous
 * timestamp when topping up an existing entry so a partial refill does not
 * extend the TTL of the rest.
 */
export async function writeCache<T>(
  organizationId: string | undefined,
  kind: CacheKind,
  entries: T[],
  fetchedAt: number = Date.now()
): Promise<void> {
  if (!organizationId) return;
  const data = await readFile();
  data[organizationId] = { ...data[organizationId], [kind]: { fetchedAt, entries } };
  await writeFile(data);
}

/**
 * Drop one kind, one org, or — only when called with NO arguments at all — the
 * whole cache.
 *
 * `invalidateCache(undefined, 'tags')` used to discard the `kind` and truncate
 * the file for EVERY org. No caller means that: all three pass a kind, and all
 * three read `organizationId` from saved auth, which `favro auth` explicitly
 * warns may be absent ("Organization ID not saved"). A named kind with no org
 * is a no-op — nothing was cached under a missing org, so there is nothing to
 * drop.
 */
export async function invalidateCache(organizationId?: string, kind?: CacheKind): Promise<void> {
  if (!organizationId) {
    if (!kind) await writeFile({});
    return;
  }
  const data = await readFile();
  if (kind) {
    delete data[organizationId]?.[kind];
  } else {
    delete data[organizationId];
  }
  await writeFile(data);
}

/** Cached entries, fetching and storing them on miss. */
export async function cachedList<T>(
  organizationId: string | undefined,
  kind: CacheKind,
  fetch: () => Promise<T[]>
): Promise<T[]> {
  const cached = await readCache<T>(organizationId, kind);
  if (cached) return cached;
  const fresh = await fetch();
  await writeCache(organizationId, kind, fresh);
  return fresh;
}
