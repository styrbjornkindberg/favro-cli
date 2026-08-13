/**
 * Name→id resolution for boards and collections (#41).
 *
 * Matching is trimmed, case-insensitive and EXACT — never a substring, never a
 * "closest match". A name that lands on two ids is refused with every colliding
 * id listed, because picking one silently puts two resources behind one visible
 * name. An unresolvable name is refused with the ambiguous wording from #38:
 * the API withholds and deletes with the same answer, so "not found" would be a
 * claim we cannot make.
 *
 * Refusals are structured — candidate list plus the exact flag that
 * disambiguates, naming a command that exists today.
 *
 * Accepted risk (same as #39's column directory): names are not stable
 * identifiers, so a rename inside the cache TTL still mis-matches. Every lookup
 * that finds nothing refetches before answering "no", so a cache miss is never
 * evidence on its own.
 */
import FavroHttpClient from './http-client';
import { getAllPages } from './paginate';
import { CacheKind, readCache, writeCache } from './name-cache';
import { foldName } from './fold-name';
import { MISSING_WORDING } from './favro-error';
import { RefusalError } from './refusal';

/** One resolvable thing: an id and the name a human types for it. */
export interface NamedRef {
  id: string;
  name: string;
}

export type NameResolutionFailure = 'unknown' | 'ambiguous';

/**
 * Structured refusal from `resolveNameToId`.
 *
 * A `RefusalError`, so the dispatch table's one test reaches it: the same name
 * resolves the same way next time, and "retryable" would be a loop (#81).
 *
 * `candidates` is a FIELD, not prose to regex back out of the message — the
 * colliding entries on 'ambiguous', and whatever the key can see on 'unknown',
 * which is the same list the message spells out.
 */
export class NameResolutionError extends RefusalError {
  constructor(
    message: string,
    readonly kind: NameResolutionFailure,
    readonly value: string,
    readonly label: string,
    readonly candidates: NamedRef[] = []
  ) {
    super(message);
    this.name = 'NameResolutionError';
  }
}

/**
 * One shared fold, not a private copy: a board or collection name typed by a
 * human and the one Favro sent can be the same name in two normalisation
 * forms (#141). `looksLikeName` below deliberately does NOT use it — untrimmed
 * whitespace is evidence there, not noise.
 */
const norm = foldName;

/** How many candidates a refusal spells out before it defers to the list command. */
const MAX_LISTED = 10;

/**
 * True when the value cannot be a Favro id — it carries a character no id does.
 *
 * This is deliberately weak: a one-word board name ("Backlog") is not
 * distinguishable from an id by shape, so shape alone never decides. Callers
 * that read a single resource use this only to skip a pointless round trip, and
 * otherwise let the wire's own classified not-found trigger the name lookup.
 */
export function looksLikeName(value: string): boolean {
  // Not trimmed on purpose: surrounding whitespace is itself proof it is not an id.
  return /[^A-Za-z0-9_-]/.test(value);
}

export interface ResolveOptions {
  /** Cache partition key. Undefined disables the cache, never the lookup. */
  organizationId?: string;
  kind: CacheKind;
  /** Full listing for this kind. Called at most once per resolution. */
  fetch: () => Promise<NamedRef[]>;
  /** What the caller typed — a name or an id. */
  value: string;
  /** Singular, lowercase: 'board', 'collection'. */
  label: string;
  /** The command that lists this kind, e.g. 'favro boards list'. */
  listCommand: string;
  /** The exact invocation that takes an id, e.g. 'favro boards get <boardId>'. */
  useIdWith: string;
}

function describe(refs: NamedRef[]): string {
  const shown = refs.slice(0, MAX_LISTED).map(r => `  ${r.id}  ${r.name}`);
  if (refs.length > MAX_LISTED) shown.push(`  … and ${refs.length - MAX_LISTED} more`);
  return shown.join('\n');
}

/**
 * Resolve a name or an id to an id against one listing.
 *
 * An exact id match wins outright; otherwise the name must match exactly one
 * entry. Zero and many both throw — this never returns a guess.
 */
export async function resolveNameToId(options: ResolveOptions): Promise<string> {
  const wanted = norm(options.value);
  const match = (refs: NamedRef[]): NamedRef[] => {
    const byId = refs.filter(r => r.id === options.value.trim());
    return byId.length > 0 ? byId : refs.filter(r => norm(r.name) === wanted);
  };

  const cached = await readCache<NamedRef>(options.organizationId, options.kind);
  let entries = cached ?? [];
  let found = match(entries);

  if (found.length === 0) {
    // A cache miss is never the answer on its own — refetch, then decide.
    entries = await options.fetch();
    await writeCache(options.organizationId, options.kind, entries);
    found = match(entries);
  }

  if (found.length === 1) return found[0].id;

  if (found.length === 0) {
    throw new NameResolutionError(
      `No ${options.label} named "${options.value}" — it is ${MISSING_WORDING}.\n` +
        `Matching is exact (trimmed, case-insensitive). Run '${options.listCommand}' to see what your key can reach.` +
        (entries.length > 0 ? `\nVisible ${options.label}s:\n${describe(entries)}` : ''),
      'unknown',
      options.value,
      options.label,
      entries
    );
  }

  throw new NameResolutionError(
    `${found.length} ${options.label}s are named "${options.value}" — refusing to pick one.\n` +
      `${describe(found)}\n` +
      `Pass the id instead: ${options.useIdWith}`,
    'ambiguous',
    options.value,
    options.label,
    found
  );
}

/**
 * Settle a collection NAME or id to a `collectionId` — the one implementation,
 * called by `CollectionsAPI.resolveCollectionId` and by
 * `BoardsAPI.listBoardsByCollection` (#123).
 *
 * It existed twice, byte-identically. Hosting the survivor in `collections-api`
 * is a cycle `madge --circular` fails on — `boards-api` would have to import it,
 * and `collections-api` already imports `boards-api` for `Board`. `import type`
 * does not help: madge counts it, measured both ways. `boards-api` would NOT
 * cycle, measured too — that direction already exists. It is not there because a
 * collections resolver on the boards class is the wrong home, which is taste,
 * not a tooling verdict. Here it is a cycle for nobody and belongs to neither.
 *
 * ADR-0003's cycle argument is about API classes importing each other, and
 * `http-client` and `paginate` are not any: nothing they reach imports this.
 *
 * `useIdWith` names the caller's own flag, so the refusal points at a command
 * that exists rather than at a generic one.
 */
export async function resolveCollectionId(
  client: FavroHttpClient,
  collection: string,
  useIdWith = 'favro collections get <collectionId>'
): Promise<string> {
  return resolveNameToId({
    organizationId: client.organizationId,
    kind: 'collections',
    fetch: async () =>
      (await getAllPages<{ collectionId: string; name: string }>(client, '/collections', { limit: 100 }))
        .map(c => ({ id: c.collectionId, name: c.name })),
    value: collection,
    label: 'collection',
    listCommand: 'favro collections list',
    useIdWith,
  });
}
