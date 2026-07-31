/**
 * Persistent name↔id cache (#39).
 *
 * One JSON file in the config dir, keyed by organizationId, one 15-minute TTL
 * for every kind. FAVRO_CONFIG_DIR is read at call time (same expression as
 * config.ts) so `favro-mcp-http` gives each tenant its own cache file by
 * setting the env before the process starts.
 *
 * Best-effort: any read/write failure degrades to "no cache", never throws.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import FavroHttpClient from './http-client';
import TagsAPI, { Tag } from './tags-api';
import UsersAPI, { User } from './users-api';

/** The one knob. */
export const CACHE_TTL_MS = 15 * 60 * 1000;

export type CacheKind = 'columns' | 'tags' | 'users';

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

async function readFile(): Promise<CacheFile> {
  try {
    const raw = await fs.readFile(cacheFilePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as CacheFile) : {};
  } catch {
    return {};
  }
}

// ponytail: last-writer-wins whole-file rewrite. Fine for a per-user cache;
// switch to per-org files if concurrent CLI processes start clobbering.
async function writeFile(data: CacheFile): Promise<void> {
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

/** Drop one kind, one org, or the whole cache. */
export async function invalidateCache(organizationId?: string, kind?: CacheKind): Promise<void> {
  if (!organizationId) {
    await writeFile({});
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

/** Org tags, cached. */
export function cachedTags(client: FavroHttpClient, organizationId?: string): Promise<Tag[]> {
  const api = new TagsAPI(client);
  return cachedList<Tag>(organizationId, 'tags', () => api.listTags());
}

/** Org users, cached. */
export function cachedUsers(client: FavroHttpClient, organizationId?: string): Promise<User[]> {
  const api = new UsersAPI(client);
  return cachedList<User>(organizationId, 'users', () => api.listUsers());
}
