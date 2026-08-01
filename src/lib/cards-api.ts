import FavroHttpClient from './http-client';
import { Tag } from './tags-api';
import ColumnDirectory, { ColumnResolutionError } from './column-directory';
import CardReferenceResolver, { CardResolutionError, isSequentialReference } from './card-reference';
import { cachedTags, invalidateCache } from './name-cache';
import { isUserId } from './users-api';
import { resolveAssignee } from './assignee';
import { RefusalError } from './refusal';

/**
 * The one wording for "the workspace holds no tag by that name". Shared by the
 * create and the update path so the two cannot drift — they refuse for the
 * identical reason (#62).
 */
export function unknownTagMessage(names: string[]): string {
  const listed = names.map((n) => `"${n}"`).join(', ');
  return (
    `Unknown tag ${listed} — no workspace tag has that name. Refusing to create it: ` +
    `on a write Favro treats an unknown name as a new tag, so a typo either invents a tag or ` +
    `403s the whole write depending on this key's permissions. ` +
    `Run 'favro tags list' to see the workspace tags, or 'favro tags create "${names[0]}"' to add it first.`
  );
}

/** Raw card shape returned directly by the Favro REST API */
interface RawCard {
  cardId: string;
  cardCommonId?: string;
  name: string;
  detailedDescription?: string;
  widgetCommonId?: string;
  columnId?: string;
  laneId?: string | null;
  archived?: boolean;
  assignments?: Array<{ userId: string; completed?: boolean }>;
  tags?: string[];
  startDate?: string;
  dueDate?: string;
  sequentialId?: number;
  createdByUserId?: string;
  createdAt?: string;
  customFields?: unknown[];
  dependencies?: RawDependency[];
  // Allow passthrough of extra fields
  parentCardId?: string;
  [key: string]: unknown;
}

/**
 * A dependency edge as `GET /cards` inlines it. The wire key `cardCommonId`
 * carries the **far** card's value; there is no `cardId` on an inlined edge.
 */
interface RawDependency {
  cardCommonId?: string;
  isBefore?: boolean;
  unique?: string;
  cardSequentialId?: string;
  [key: string]: unknown;
}

/**
 * Normalize a raw Favro API card response to our internal Card interface.
 *
 * This **passes fields through** rather than enumerating them: every field
 * Favro sends reaches the caller (`position`, `tasksDone`/`tasksTotal`,
 * `completed`, `timeOnColumns`/`timeOnBoard`, …), and a field Favro adds later
 * can never go invisible. Only aliases are computed on top — `description`,
 * `assignees`, `boardId`, `tagIds` and `links`.
 *
 * `status` is deliberately NOT read off the raw card: Favro sends no such
 * field. It is the column name, filled in by the caller from `columnId`.
 */
function normalizeCard(raw: RawCard): Card {
  const { detailedDescription, widgetCommonId, assignments, tags, dependencies, ...rest } = raw;
  const card: Card = {
    ...rest,
    cardId: raw.cardId,
    cardCommonId: raw.cardCommonId,
    name: raw.name,
    description: detailedDescription ?? (raw.description as string | undefined),
    // Map assignments[].userId → assignees[]; `assignments` itself passes through.
    assignees: (assignments ?? []).map((a) => a.userId),
    assignments,
    // Favro's `tags` on a card are tag **ids**. Keep them under `tagIds` — the
    // rollback path reads ids off a card and writes them back, and an unknown
    // *name* on a write is a tag creation, not a match.
    tagIds: tags ?? [],
    tags: tags ?? [],
    createdAt: raw.createdAt ?? '',
    // Map widgetCommonId → boardId for internal consistency; both are present.
    boardId: widgetCommonId ?? (raw.boardId as string | undefined),
    widgetCommonId,
    customFields: raw.customFields as Card['customFields'],
  };
  if (dependencies !== undefined) {
    card.links = dependencies.map(normalizeInlinedDependency);
    card.dependencies = dependencies;
  }
  return card;
}

/**
 * Map an inlined dependency onto a `CardLink`, keyed by `cardCommonId` with
 * `cardId` left undefined. The reverse lookup (cardCommonId → cardId) costs a
 * call and is ambiguous across board instances, so it is not faked here.
 */
function normalizeInlinedDependency(dep: RawDependency): CardLink {
  return {
    cardCommonId: dep.cardCommonId,
    isBefore: dep.isBefore === true,
    cardSequentialId: dep.cardSequentialId,
  };
}

export interface CustomField {
  fieldId: string;
  name: string;
  value: unknown;
  type?: string;
}

/**
 * A single dependency edge, as Favro actually returns it. Favro has no link
 * "types" — an edge carries one direction flag, `isBefore`, describing the
 * dependency card (`cardId`) relative to the card you queried. Reading an edge
 * from the far end returns it with `isBefore` inverted.
 */
export interface CardLink {
  /**
   * cardId of the dependency card (the other end of the edge).
   * Undefined on an edge inlined by `GET /cards`, which carries only
   * `cardCommonId` — the reverse lookup is the expensive, ambiguous
   * direction and is not faked.
   */
  cardId?: string;
  /** True when the dependency card comes before the card you queried. */
  isBefore: boolean;
  cardCommonId?: string;
  cardSequentialId?: string;
  /** cardId of the card you queried — the near end of the edge. */
  reverseCardId?: string;
  cardName?: string;
}

export interface CardComment {
  commentId: string;
  text: string;
  createdAt: string;
  author?: string;
}

export interface CardRelation {
  type: 'depends-on' | 'blocks' | 'related' | 'duplicates';
  cardId: string;
}

export interface Card {
  cardId: string;
  /** cardCommonId — stable ID across widgets; used for comments API */
  cardCommonId?: string;
  name: string;
  description?: string;
  /** The column name. Favro has no `status` field — the column IS the status. */
  status?: string;
  assignees?: string[];
  /** Tag names. */
  tags?: string[];
  /** Tag ids, exactly as Favro sends them on the card. */
  tagIds?: string[];
  dueDate?: string;
  createdAt: string;
  /** boardId — our alias for widgetCommonId */
  boardId?: string;
  widgetCommonId?: string;
  assignments?: Array<{ userId: string; completed?: boolean }>;
  columnId?: string;
  collectionId?: string;
  archived?: boolean;
  sequentialId?: number;
  /** Parent card ID for hierarchical card relationships */
  parentCardId?: string;
  // Populated via --include flags
  board?: { boardId: string; name: string; [key: string]: unknown };
  collection?: { collectionId: string; name: string; [key: string]: unknown };
  customFields?: CustomField[];
  links?: CardLink[];
  comments?: CardComment[];
  relations?: CardRelation[];
  /**
   * Every other field Favro sends passes through untouched — `position`,
   * `tasksDone`/`tasksTotal`, `completed`, `timeOnBoard`/`timeOnColumns`,
   * `dependencies`, and anything Favro adds after this was written.
   */
  [key: string]: unknown;
}

/**
 * `POST /cards` is **one atomic validated call** (#48). Every composite below
 * rides the same POST — Favro validates each one and 403s the whole create with
 * **no card created** on a bad tag, assignee, column or dependency target, which
 * is what makes these flags safe without a compensation entry.
 *
 * The same fields are refused on `PUT`: `dependencies` is a silent no-op,
 * `parentCardId` answers 202 `Access denied`, `assignees`/`assignmentIds` are
 * silent no-ops. So this shape is create-only by measurement, not by taste.
 */
export interface CreateCardRequest {
  name: string;
  description?: string;
  /**
   * Column name or `columnId`. Favro has no `status` field — resolved here to
   * `columnId`, which `POST /cards` honours and validates (bogus → `403 Invalid
   * column`). A name needs `widgetCommonId`/`boardId`.
   */
  status?: string;
  /** widgetCommonId — the board (widget) to create the card on */
  widgetCommonId?: string;
  /** @deprecated Use widgetCommonId instead */
  boardId?: string;
  columnId?: string;
  /**
   * Assignee references — name, email, `userId` or `@me`. Resolved to `userId`s
   * and sent as `assignmentIds`, the only assignment field `POST /cards`
   * honours (`assignees` is a silent no-op on both verbs).
   */
  assignees?: string[];
  /**
   * A `sequentialId` (`CLA-1804`) or a `cardId`. Same board only.
   *
   * **Not** a `cardCommonId`: `toCardId` is shape-first and passes a
   * non-sequential reference through uncalled, so a `cardCommonId` reaches the
   * wire as a `cardId` and Favro 403s the whole create. Escalating it would cost
   * a read per reference on every create, including the correct ones — so the
   * keyspace is stated instead of guessed at.
   */
  parentCardId?: string;
  /**
   * Tag **names**. Pre-validated against the org tag list CLI-side, because an
   * unknown name is a tag *creation* — which only 403s on a key that lacks that
   * permission, so auto-create-on-typo would be permission-dependent. Names go
   * to the wire unresolved: Favro's own casing resolution does not always pick
   * the byte-exact match, so writing a `tagId` we chose could write an id Favro
   * never selects.
   */
  tags?: string[];
  /**
   * Cards that must come **before** this one (`isBefore: true`). Same keyspace
   * rule as `parentCardId`: `sequentialId` or `cardId`, not `cardCommonId`.
   */
  blockedBy?: string[];
  /** Cards this one comes before (`isBefore: false`). Same keyspace rule. */
  blocks?: string[];
}

export interface UpdateCardRequest {
  name?: string;
  description?: string;
  /**
   * Column name or `columnId` — on a write, `status` IS a column move. Favro has
   * no status field, and `PUT {status}` 200s and changes nothing, so `updateCard`
   * resolves the name against the card's **own** board (or `boardId`, when the
   * same write moves boards) and sends `columnId`. An unknown name is refused
   * with that board's real columns listed (`ColumnResolutionError`).
   */
  status?: string;
  /**
   * Whole-array assignee replacement, as **userIds** — a name is refused rather
   * than diffed into "remove everyone, add a string Favro has never seen"
   * (resolve names through `resolveAssignees` first). Favro has no such field on PUT: both
   * `assignees` and `assignmentIds` answer 200 and change nothing, and only
   * `add`/`removeAssignmentIds` are honoured — so this is diffed into them at
   * the cost of one card read. Pass those directly to skip the read.
   */
  assignees?: string[];
  /** userIds to assign. Pass-through, zero extra reads. Re-adding is a 200 no-op. */
  addAssignmentIds?: string[];
  /** userIds to unassign. Pass-through, zero extra reads. Removing an absent one is a 200 no-op. */
  removeAssignmentIds?: string[];
  /**
   * Whole-array tag replacement, by tag name or tagId. Favro has no such field —
   * `updateCard` diffs it into `addTags`/`addTagIds`/`removeTagIds` (see
   * `tagReplacement`), which costs one extra card read and one tag list.
   * Pass `addTags`/`removeTags` instead to hit the wire shape directly.
   */
  tags?: string[];
  /** Tag names to add. Favro creates a name it does not know — or 403s if the key may not. */
  addTags?: string[];
  /** Tag names to remove. */
  removeTags?: string[];
  /**
   * Tag **ids** to add. Zero-extra-read pass-through, and the shape a rollback
   * wants: a card reads its tags back as ids, so restoring a captured pre-state
   * means writing ids, never names.
   */
  addTagIds?: string[];
  /** Tag **ids** to remove. Same reason as `addTagIds`. */
  removeTagIds?: string[];
  /** Due date in YYYY-MM-DD format. Supported by Favro API updateCard endpoint. */
  dueDate?: string;
  /** Target board ID when moving a card between boards. Supported by Favro API updateCard endpoint. */
  boardId?: string;
  /** Target column ID when moving a card between columns on a board. */
  columnId?: string;
  /**
   * Move the card across the archive line. `true` archives, `false` un-archives.
   *
   * **The write field is `archive`. The field a card reads BACK is `archived`.**
   * That asymmetry is the whole hazard here, because the read-side spelling is
   * the one a future reader reaches for — and it silently does nothing. Probed
   * live (#75):
   *
   * - `PUT {archive: true}`   → **honoured.** The card crosses the archive line
   *                             and the response echoes `archived: true`.
   * - `PUT {archive: false}`  → **honoured.** Genuinely reversible in both
   *                             directions, which is what lets `TxCards
   *                             .setArchived` carry a real compensation entry
   *                             where `deleteCard` can carry none.
   * - `PUT {archived: true}`  → **200 and a silent no-op.** Same family as
   *                             `status`, `assignees` and a whole-array `tags`:
   *                             a green write that changed nothing. NEVER send
   *                             it, and never "helpfully" forward a caller's
   *                             `archived` here.
   * - `?archive=true` / `?archived=true` with an empty body → 200, silent no-op.
   *   Unlike `descriptionFormat` (#17), this one does **not** ride the query
   *   string; it is a body field only.
   *
   * Unlike `status` / `assignees` / `tags` it needs no translation — it passes
   * straight through, and it composes: `{archive: true, name: '…'}` in one PUT is
   * honoured for both fields.
   *
   * Read the archive line back with `Card.archived`, or select a side of it with
   * `listCards({ archived })` — both are read-side only (#14).
   */
  archive?: boolean;
}

/**
 * Paginated response from Favro API.
 * The API uses cursor-based pagination via requestId + page cursor.
 */
export interface PaginatedResponse<T> {
  entities: T[];
  requestId?: string;
  page?: number;
  pages?: number;
  limit?: number;
}

export interface GetCardOptions {
  /** List of include keys: board, collection, custom-fields, links, comments, relations */
  include?: string[];
  /**
   * Board (widgetCommonId) to resolve the card against. Only needed when a
   * card lives on more than one board — resolution refuses rather than
   * picking an instance, and names this as the disambiguating flag.
   */
  board?: string;
}

export interface LinkCardRequest {
  toCardId: string;
  /** True when `toCardId` comes before `cardId` (i.e. `cardId` depends on it). */
  isBefore: boolean;
}

export interface MoveCardRequest {
  toBoardId: string;
  position?: 'top' | 'bottom';
}

/** `--archived`: which side of the archive line to read. */
export type ArchivedSelector = 'true' | 'false' | 'all';

export interface ListCardsOptions {
  boardId?: string;
  collectionId?: string;
  unique?: boolean;
  /**
   * Which cards to select, defaulting to `'false'` — live cards only.
   *
   * `archived` is a Favro **selector**, not an exclusion: Favro's own default
   * list INCLUDES archived cards, so they used to arrive silently mixed in and
   * every caller paid a client-side filtering tax. `'all'` sends nothing and
   * restores Favro's mixed default; `'true'` reads the archive alone.
   */
  archived?: ArchivedSelector;
  /**
   * Column name or `columnId` to narrow to, filtered on the wire. A name
   * requires `boardId`; an id is validated against `boardId` when both are
   * given. Mutually exclusive with `collectionId` — validating a column
   * across a collection is a per-board loop, so it is refused rather than
   * answered about the wrong board.
   */
  status?: string;
}

/** Parsed components of a Favro card web URL. */
export interface ParsedCardUrl {
  /** Organization ID from the URL path */
  organizationId?: string;
  /** Board (widget) or collection ID from the URL path */
  widgetCommonId?: string;
  /** Raw `card=` query value, e.g. "Squ-8850" */
  cardSequentialIdLabel: string;
  /** Numeric sequential ID parsed from the label, e.g. 8850 */
  sequentialId: number;
}

/**
 * Parse a Favro card web URL into its components.
 * Expected shape:
 *   https://favro.com/organization/<orgId>/<widgetOrCollectionId>?card=<Prefix>-<number>
 * The `card=` query value (e.g. "Squ-8850") encodes the card's human-readable
 * sequential ID; the trailing number is the Favro API `cardSequentialId`.
 *
 * @throws if the URL is malformed or has no parseable card sequential ID.
 */
export function parseCardUrl(url: string): ParsedCardUrl {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid card URL: ${url}`);
  }

  const cardParam = parsed.searchParams.get('card');
  if (!cardParam) {
    throw new Error(`Card URL is missing the "card" query parameter: ${url}`);
  }

  // cardParam looks like "Squ-8850" — the trailing digits are the sequential ID.
  const match = cardParam.match(/(\d+)\s*$/);
  if (!match) {
    throw new Error(`Could not parse a sequential ID from card="${cardParam}"`);
  }
  const sequentialId = parseInt(match[1], 10);

  // Path: /organization/<orgId>/<widgetOrCollectionId>
  const segments = parsed.pathname.split('/').filter(Boolean);
  const orgIdx = segments.indexOf('organization');
  const organizationId = orgIdx >= 0 ? segments[orgIdx + 1] : undefined;
  const widgetCommonId = orgIdx >= 0 ? segments[orgIdx + 2] : undefined;

  return { organizationId, widgetCommonId, cardSequentialIdLabel: cardParam, sequentialId };
}

/**
 * Favro only runs its markdown parser when `descriptionFormat` rides the **query
 * string**. In the request body it is ignored: the body is escaped as literal
 * text with a zero-width space (U+200B) injected after every `[`, which destroys
 * every `- [ ]` checkbox — silently, with a 200. Verified byte-level live (#15,
 * #17). Also the response format flag, so it belongs on writes either way.
 *
 * An invalid value is worse than none: `md` and `plaintext` both answer 200 and
 * leave the card holding the new body concatenated *after* the old one. Only
 * `markdown` is ever sent, and `assertDescriptionFormat` refuses anything else a
 * caller smuggles in through the body.
 */
const MARKDOWN_BODY = { params: { descriptionFormat: 'markdown' } };

/**
 * Normalise the description field of a card write payload.
 *
 * `PUT /cards/:cardId {description: …}` is a silent no-op — 200, nothing written
 * (same class as `PUT {tags:[…]}` in #16). The real field is
 * `detailedDescription`, and the raw one must never reach the wire.
 */
function mapDescription(payload: Record<string, unknown>): void {
  if (payload.description !== undefined) {
    payload.detailedDescription = payload.description;
  }
  delete payload.description;
  if (payload.descriptionFormat !== undefined && payload.descriptionFormat !== 'markdown') {
    throw new Error(
      `Unsupported descriptionFormat "${payload.descriptionFormat}" — Favro accepts only "markdown" ` +
        `on a card write; anything else appends the new body to the old one and reports success.`,
    );
  }
  // Belongs on the query string (MARKDOWN_BODY), never in the body.
  delete payload.descriptionFormat;
}

export class CardsAPI {
  private columnDirectory?: ColumnDirectory;
  private referenceResolver?: CardReferenceResolver;

  constructor(private client: FavroHttpClient) {}

  /**
   * Every card-shaped argument on this class goes through here, so `CLA-1804`,
   * a `cardId` and a `cardCommonId` are interchangeable at every entry point —
   * and the MCP passthrough and the skill engine inherit that for free.
   */
  private get references(): CardReferenceResolver {
    this.referenceResolver ??= new CardReferenceResolver(this.client);
    return this.referenceResolver;
  }

  /** Translate a card reference to the `cardId` a path segment wants. */
  async resolveCardId(reference: string, options?: { widgetCommonId?: string }): Promise<string> {
    return this.references.toCardId(reference, options);
  }

  /** Translate a card reference to the `cardCommonId` comments/tasks/tasklists want. */
  async resolveCardCommonId(reference: string, options?: { widgetCommonId?: string }): Promise<string> {
    return this.references.toCardCommonId(reference, options);
  }

  private get columns(): ColumnDirectory {
    this.columnDirectory ??= new ColumnDirectory(this.client, this.client.organizationId);
    return this.columnDirectory;
  }

  /**
   * Settle a `--status` / `--column` argument to a `columnId`, through the one
   * shared column directory. Public so the tx write facade can record WHICH
   * column it wrote without a second resolver of its own.
   */
  async resolveColumnId(value: string, boardId?: string): Promise<string> {
    return this.columns.resolveColumnId(value, boardId);
  }

  /**
   * Fill in the two name-valued fields on a read card: `status` (the column
   * name — Favro has no status field, the column IS the status) and `tags`
   * (names; the ids stay on `tagIds`).
   *
   * Both sides come from the shared 15-minute cache, so this costs one fetch
   * per kind per TTL window regardless of how many cards were read.
   */
  private async hydrateNames(cards: Card[]): Promise<void> {
    if (cards.length === 0) return;

    const columnIds = new Set(cards.map((c) => c.columnId).filter((id): id is string => Boolean(id)));
    for (const columnId of columnIds) {
      const name = await this.columns.nameOf(columnId);
      if (!name) continue;
      for (const card of cards) {
        if (card.columnId === columnId) card.status = name;
      }
    }

    if (!cards.some((c) => (c.tagIds ?? []).length > 0)) return;
    const tags = await cachedTags(this.client, this.client.organizationId);
    const nameById = new Map(tags.map((t) => [t.tagId, t.name]));
    for (const card of cards) {
      card.tags = (card.tagIds ?? []).map((id) => nameById.get(id) ?? id);
    }
  }

  /**
   * List cards, paginating to **completion**.
   *
   * There is deliberately no `limit`: it used to truncate the *fetch*, so every
   * client-side filter downstream filtered a partial set and answered a
   * plausible wrong number (`limit` is ignored by `GET /cards` anyway — always
   * clamped to 100 per page). Capping output is the caller's last step, via
   * `capRows` in `read-shape`.
   *
   * Accepts an options object, or a bare boardId as shorthand:
   *   listCards({ boardId, collectionId, status, archived, unique })
   *   listCards(boardId?)
   */
  async listCards(optsOrBoardId?: string | ListCardsOptions): Promise<Card[]> {
    const opts: ListCardsOptions =
      typeof optsOrBoardId === 'object' && optsOrBoardId !== null
        ? optsOrBoardId
        : { boardId: optsOrBoardId ?? undefined };

    // Refused before any call: a column and a collection cannot both scope one
    // read, and the wire would silently answer about the column's own board.
    if (opts.status && opts.collectionId) {
      throw new ColumnResolutionError(
        'A column and a collection cannot scope the same read: pass --status with --board, or --collection on its own.',
        opts.status,
      );
    }
    const columnId = opts.status
      ? await this.columns.resolveColumnId(opts.status, opts.boardId)
      : undefined;
    const path = '/cards';
    const allCards: Card[] = [];
    let page = 0;
    let totalPages = 1;
    let requestId: string | undefined;
    // Favro's API can 500 when descriptionFormat=markdown if any card on the
    // board has a description that crashes their markdown converter. Once we
    // detect this, drop the flag for the remainder of this call so we still
    // return cards (plain-text descriptions instead of markdown).
    let useMarkdownDescription = true;

    while (page < totalPages) {
      // Favro clamps this to 100 regardless; asking for the page maximum is the
      // only thing it affects.
      const params: Record<string, unknown> = { limit: 100 };
      if (useMarkdownDescription) {
        params.descriptionFormat = 'markdown';
      }

      // Favro uses widgetCommonId to scope cards to a board
      if (opts.boardId) {
        params.widgetCommonId = opts.boardId;
      }

      // Column narrowing rides the wire, not a client-side pass over one page.
      if (columnId) {
        params.columnId = columnId;
      }

      // Collection-scoped cross-board queries
      if (opts.collectionId) {
        params.collectionId = opts.collectionId;
      }

      // Deduplicate cards that appear on multiple boards in the same collection
      if (opts.unique) {
        params.unique = true;
      }

      // `archived` rides the wire. Favro's default includes archived cards, so
      // omitting it is what 'all' means — the live-only default is the ask.
      const archived = opts.archived ?? 'false';
      if (archived !== 'all') {
        params.archived = archived === 'true';
      }

      // On subsequent pages, use requestId to continue pagination
      if (requestId) {
        params.requestId = requestId;
        params.page = page;
      }

      let response: PaginatedResponse<Card>;
      try {
        response = await this.client.get<PaginatedResponse<Card>>(path, { params });
      } catch (err) {
        // Fall back to default (non-markdown) description format on 500 — works around
        // a Favro server-side markdown-converter crash triggered by certain card content.
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status === 500 && useMarkdownDescription) {
          useMarkdownDescription = false;
          delete params.descriptionFormat;
          response = await this.client.get<PaginatedResponse<Card>>(path, { params });
        } else {
          throw err;
        }
      }

      const entities = (response.entities as unknown as RawCard[] ?? []).map(normalizeCard);
      allCards.push(...entities);

      // Update pagination state from response
      if (response.requestId) {
        requestId = response.requestId;
        totalPages = response.pages ?? 1;
        page = (response.page ?? 0) + 1;
      } else {
        // No pagination info — single-page response
        break;
      }

      // Stop if we got fewer entities than requested (last page)
      if (entities.length === 0) break;
    }

    await this.hydrateNames(allCards);
    return allCards;
  }

  /**
   * Get a single card with optional includes (board, collection, custom-fields, links, comments).
   */
  async getCard(cardRef: string, options?: GetCardOptions): Promise<Card> {
    const scope = options?.board ? { widgetCommonId: options.board } : undefined;
    return this.references.escalateOnNotFound(cardRef, (cardId) => this.getCardById(cardId, options), scope);
  }

  private async getCardById(cardId: string, options?: GetCardOptions): Promise<Card> {
    const params: Record<string, unknown> = { descriptionFormat: 'markdown' };
    const includes = options?.include ?? [];
    if (includes.length > 0) {
      params.include = includes.join(',');
    }
    let rawCard: RawCard;
    try {
      rawCard = await this.client.get<RawCard>(`/cards/${cardId}`, { params });
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status !== 500) throw err;
      // Fall back to default format when markdown rendering crashes server-side
      delete params.descriptionFormat;
      rawCard = await this.client.get<RawCard>(`/cards/${cardId}`, { params });
    }
    const card = normalizeCard(rawCard);
    await this.hydrateNames([card]);

    // Hydrate board/collection if requested and not already present
    if (includes.includes('board') && card.boardId && !card.board) {
      try {
        const { BoardsAPI } = await import('./boards-api');
        const boardsApi = new BoardsAPI(this.client);
        card.board = await boardsApi.getBoard(card.boardId) as unknown as typeof card.board;
      } catch { /* best effort */ }
    }
    if (includes.includes('collection') && card.collectionId && !card.collection) {
      try {
        const { BoardsAPI } = await import('./boards-api');
        const boardsApi = new BoardsAPI(this.client);
        card.collection = await boardsApi.getCollection(card.collectionId) as unknown as typeof card.collection;
      } catch { /* best effort */ }
    }
    // Custom fields are returned inline on card responses from Favro API,
    // not via a separate endpoint.
    if (includes.includes('links') && !card.links) {
      try {
        // Favro: GET /cards/:cardId/dependencies
        const lnk = await this.client.get<{ dependencies: CardLink[] }>(`/cards/${cardId}/dependencies`);
        card.links = lnk.dependencies ?? [];
      } catch { /* best effort */ }
    }
    if ((includes.includes('comments') || includes.includes('relations')) && !card.comments) {
      try {
        // Favro: GET /comments?cardCommonId=<cardId>
        const cmt = await this.client.get<{ entities: CardComment[] }>('/comments', {
          params: { cardCommonId: cardId }
        });
        card.comments = cmt.entities ?? [];
      } catch { /* best effort */ }
    }
    return card;
  }

  /**
   * Get all links for a card.
   */
  async getCardLinks(cardRef: string): Promise<CardLink[]> {
    return this.references.escalateOnNotFound(cardRef, async (cardId) => {
      // Favro: GET /cards/:cardId/dependencies → { cardId, cardCommonId, dependencies: [...] }
      const res = await this.client.get<{ dependencies: CardLink[] }>(`/cards/${cardId}/dependencies`);
      return res.dependencies ?? [];
    });
  }

  /**
   * Add a dependency edge. Favro creates the mirror edge on the target card
   * automatically (with `isBefore` inverted) — no second call needed.
   * Re-adding an existing edge is rejected with 403 "Dependency already exists".
   */
  async linkCard(cardRef: string, req: LinkCardRequest): Promise<CardLink[]> {
    const cardId = await this.references.toCardId(cardRef);
    // A mutation fires once against a settled id — a 403 on a write never
    // escalates, because a refused write is not distinguishable from an
    // absent target.
    // Favro: POST /cards/:cardId/dependencies, body { dependencies: [{ cardId, isBefore }] }.
    // POST merges into the existing edge set; PUT would replace it.
    const res = await this.client.post<{ dependencies: CardLink[] }>(
      `/cards/${cardId}/dependencies`,
      { dependencies: [{ cardId: req.toCardId, isBefore: req.isBefore }] },
    );
    return res.dependencies ?? [];
  }

  /**
   * Remove a link between two cards.
   */
  /**
   * Remove a dependency edge. Verified live: 204 on success, 404 "Dependency
   * not found" when the edge is already gone. Either end of the edge works —
   * deleting via the mirror card removes the same edge.
   */
  async unlinkCard(cardRef: string, fromCardRef: string): Promise<void> {
    const [cardId, fromCardId] = await Promise.all([
      this.references.toCardId(cardRef),
      this.references.toCardId(fromCardRef),
    ]);
    await this.client.delete(`/cards/${cardId}/dependencies/${fromCardId}`);
  }

  /**
   * Remove all dependencies from a card.
   */
  async deleteAllDependencies(cardRef: string): Promise<void> {
    const cardId = await this.references.toCardId(cardRef);
    // Mutation: settled id, one attempt, no escalation.
    await this.client.delete(`/cards/${cardId}/dependencies`);
  }

  /**
   * Move a card to a different board.
   */
  async moveCard(cardRef: string, req: MoveCardRequest): Promise<Card> {
    const cardId = await this.references.toCardId(cardRef);
    // Favro uses PUT /cards/:cardId with widgetCommonId to move cards
    return this.client.put<Card>(`/cards/${cardId}`, {
      widgetCommonId: req.toBoardId,
      position: req.position,
    });
  }

  /**
   * Create a card — **one** POST carrying every composite.
   *
   * On create this is not composition: `parentCardId`, `dependencies`,
   * `columnId`, `tags` and `assignmentIds` are all honoured and validated by the
   * same call, and any bad value 403s the whole thing with no card created. So
   * there are no follow-up writes and nothing to compensate. Resolution happens
   * first, so a name that cannot be settled refuses before any card exists.
   */
  async createCard(data: CreateCardRequest): Promise<Card> {
    const { status, assignees, tags, blockedBy, blocks, ...rest } = data;
    // Map boardId → widgetCommonId for callers using the old field name
    const payload: Record<string, unknown> = { ...rest };
    if (payload.boardId && !payload.widgetCommonId) {
      payload.widgetCommonId = payload.boardId;
      delete payload.boardId;
    }
    mapDescription(payload);

    if (status !== undefined) {
      payload.columnId = await this.columns.resolveColumnId(
        status,
        payload.widgetCommonId as string | undefined,
      );
    }

    if (payload.parentCardId !== undefined) {
      payload.parentCardId = await this.references.toCardId(String(payload.parentCardId), {
        widgetCommonId: payload.widgetCommonId as string | undefined,
      });
    }

    if (assignees !== undefined && assignees.length > 0) {
      payload.assignmentIds = await Promise.all(
        assignees.map((ref) => resolveAssignee(this.client, ref)),
      );
    }

    if (tags !== undefined && tags.length > 0) {
      payload.tags = await this.validateTagNames(tags);
    }

    // Both directions live in ONE array — two edges per create, mirrored, and
    // undocumented. `isBefore` describes the far card relative to this one, so
    // "blocked by X" is X before us and "blocks Y" is Y after us.
    const edges = [
      ...(blockedBy ?? []).map((ref) => ({ ref, isBefore: true })),
      ...(blocks ?? []).map((ref) => ({ ref, isBefore: false })),
    ];
    if (edges.length > 0) {
      payload.dependencies = await Promise.all(
        edges.map(async ({ ref, isBefore }) => ({
          cardId: await this.references.toCardId(ref),
          isBefore,
        })),
      );
    }

    return this.client.post<Card>('/cards', payload, MARKDOWN_BODY);
  }

  /**
   * Refuse an unknown tag name **before** the create, and hand back the org's
   * own spelling of each name.
   *
   * Leaving this to the wire is not equivalent: to Favro an unknown name is a
   * tag *creation*, so a typo either silently creates a tag or 403s the whole
   * create, depending on whether this key holds that permission. Neither is an
   * answer an agent can act on. Ambiguity does **not** refuse here — we send the
   * name and let Favro resolve it, which is exactly why we must not send an id.
   */
  private async validateTagNames(names: string[]): Promise<string[]> {
    const key = (name: string) => name.trim().toLowerCase();
    const tags = await this.orgTags((known) => names.every((raw) => known.has(key(raw))));
    const byName = new Map(tags.map((t) => [key(t.name ?? ''), t.name]));

    return names.map((raw) => {
      const known = byName.get(key(raw));
      if (known === undefined) throw new RefusalError(unknownTagMessage([raw]));
      return known;
    });
  }

  /**
   * The org's tag list, cache-backed, refetched once when `answered` says the
   * cached copy cannot settle the question being asked of it.
   *
   * Never refuse on cache evidence alone — the read path settled this in
   * `query-values`' `checkTag`, and a false refusal costs more on a write.
   * Without the refill, the 15-minute TTL made the refusal's own advice useless:
   * `favro tags create` then a tag write still refused. `tags` is a whole-org
   * list, so the refill replaces nothing the message then lists.
   *
   * `answered` is handed the lower-cased names and the tagIds as SEPARATE sets,
   * because the two callers key differently — create validates names only,
   * update accepts either. One merged set made "known" mean two things at once:
   * a tagId satisfied the names-only predicate, skipped the refill, and then
   * failed the name lookup it had just claimed to answer.
   */
  private async orgTags(answered: (names: Set<string>, ids: Set<string>) => boolean): Promise<Tag[]> {
    const orgId = this.client.organizationId;
    const ask = (tags: Tag[]) =>
      answered(
        new Set(tags.map((t) => (t.name ?? '').trim().toLowerCase())),
        new Set(tags.map((t) => t.tagId)),
      );

    const tags = await cachedTags(this.client, orgId);
    // No orgId means nothing was cached, so the list just fetched IS live: a
    // refill would re-ask the same question, and the invalidate has nothing of
    // this org's to drop.
    if (!orgId || ask(tags)) return tags;
    await invalidateCache(orgId, 'tags');
    return cachedTags(this.client, orgId);
  }

  /**
   * Update a card.
   *
   * Three fields on `UpdateCardRequest` have no wire field of their own —
   * `status`, `assignees` and `tags` — and each is translated here rather than
   * forwarded, because Favro answers 200 and writes nothing to all three. The
   * translations that need the card's current state share **one** read.
   *
   * Note on descriptions: Favro injects a card's tasklist items into the
   * description it returns, so a caller-side read-modify-write of `description`
   * re-persists those `- [ ]` lines as literal body text, permanently doubling
   * the tasklist. Write a whole body you composed, never one you read back.
   */
  async updateCard(cardRef: string, data: UpdateCardRequest): Promise<Card> {
    const cardId = await this.references.toCardId(cardRef);
    const payload: Record<string, unknown> = { ...data };
    mapDescription(payload);
    if (payload.boardId !== undefined) {
      payload.widgetCommonId = payload.boardId;
      delete payload.boardId;
    }

    // At most one read, shared by every field that has to diff against the card.
    let current: Card | undefined;
    const currentCard = async (): Promise<Card> => (current ??= await this.getCard(cardId));

    // `status` on a write IS a column move: name → columnId, against the board
    // the card will be on (the target board when this write also moves boards).
    if (payload.status !== undefined) {
      const status = String(payload.status);
      delete payload.status;
      const boardId = (payload.widgetCommonId as string | undefined) ?? (await currentCard()).boardId;
      payload.columnId = await this.columns.resolveColumnId(status, boardId);
    }

    // Favro ignores both `assignees` and `assignmentIds` on PUT (200, no change)
    // and honours only the verb fields — which is also the only way an
    // assignment can be *removed*. Diff so the write stays minimal; the verbs
    // themselves are forgiving either way.
    if (payload.assignees !== undefined) {
      const desired = (payload.assignees ?? []) as string[];
      delete payload.assignees;
      // A name left raw would diff as "remove everyone, add a string Favro has
      // never seen" — a wipe reported as success. So this is the ONE place a
      // whole-array assignee write settles its names, the same closed vocabulary
      // `createCard` uses (#59, #60): every caller that can be handed a NAME —
      // batch-smart, bulk CSV `owner`, `cards update --assignee` — routes
      // through here, so resolving at the chokepoint beats a guard per call
      // site. An unresolvable name refuses (AssigneeError, a RefusalError)
      // before any PUT leaves.
      //
      // `TxCards.setAssignees` is the deliberate exception: it takes `userId`s
      // only and refuses any other shape up front, so it never reaches this
      // resolution. Same for the undo paths, which replay ids they read back.
      // Already-`userId`-shaped entries short-circuit: no extra read on the id
      // path, which is what tx-cards and the undo paths hand us.
      const desiredIds: string[] = [];
      for (const value of desired) {
        const id = isUserId(value) ? value : await resolveAssignee(this.client, value);
        if (!desiredIds.includes(id)) desiredIds.push(id);
      }
      const currentIds = (await currentCard()).assignees ?? [];
      const add = desiredIds.filter((id) => !currentIds.includes(id));
      const remove = currentIds.filter((id) => !desiredIds.includes(id));
      if (add.length > 0) payload.addAssignmentIds = add;
      if (remove.length > 0) payload.removeAssignmentIds = remove;
    }

    // Favro ignores a whole-array `tags` on update (200, no change) — it only
    // honours add/remove. Translate the replacement into that shape.
    if (payload.tags !== undefined) {
      const desired = (payload.tags ?? []) as string[];
      delete payload.tags;
      const delta = await this.tagReplacement(await currentCard(), desired);
      // A name the org does not hold would go out as `addTags`, which to Favro
      // is a tag CREATION — so on a key that holds the permission a typo on
      // `cards update --tags` permanently pollutes the workspace tag list, and
      // on one that does not it 403s the whole write. Refused here exactly as
      // `cards create --tag` refuses it (#62), and for the same reason: neither
      // wire outcome is one an agent can act on.
      const invented = delta.addTags ?? [];
      if (invented.length > 0) throw new RefusalError(unknownTagMessage(invented));
      Object.assign(payload, delta);
    }
    // Favro uses PUT for card updates, not PATCH
    return this.client.put<Card>(`/cards/${cardId}`, payload, MARKDOWN_BODY);
  }

  /**
   * Translate a whole-array `tags` replacement into Favro's card-update wire shape.
   *
   * `PUT /cards/:cardId {tags:[…]}` answers **200 and changes nothing** — probed
   * live (#14, #16). The endpoint only honours `addTags`/`removeTags` (tag
   * **names**) and `addTagIds`/`removeTagIds` (tag **ids**); cards read their tags
   * back as ids, so the diff is done on ids and removals are always by id.
   *
   * Each desired entry may be a tag name or a tagId — `Card.tags` is ids, so a
   * round-trip (read a card, write its tags back, as the batch undo path does)
   * hands us ids, while a human types names.
   *
   * A desired name unknown to the org comes back as `addTags` — the delta says
   * "this would be a tag CREATION" and leaves the decision to the caller. Every
   * caller refuses it: `updateCard` and `TxCards.setTags` both decline rather
   * than let the wire invent a workspace tag (#62). Reporting it rather than
   * throwing keeps this a pure diff, which is the whole reason it is shared.
   *
   * Public because the tx write facade needs the DELTA this computes, not just
   * its effect: a compensation entry compares per-element on our own delta, and
   * re-deriving it there would be a second tag resolver.
   */
  async tagReplacement(
    card: Card,
    desired: string[],
  ): Promise<{ addTags?: string[]; addTagIds?: string[]; removeTagIds?: string[] }> {
    const orgTags = await this.orgTags((names, ids) =>
      desired.every((entry) => ids.has(entry) || names.has(entry.trim().toLowerCase())),
    );

    const byName = new Map(orgTags.map((t) => [t.name.toLowerCase(), t.tagId]));
    const knownIds = new Set(orgTags.map((t) => t.tagId));

    const desiredIds = new Set<string>();
    const newNames: string[] = [];
    for (const entry of desired) {
      const asId = knownIds.has(entry) ? entry : byName.get(entry.toLowerCase());
      if (asId) desiredIds.add(asId);
      else newNames.push(entry);
    }

    // `card.tags` renders names; the ids the wire wants are on `tagIds`.
    const currentIds = card.tagIds ?? [];
    const out: { addTags?: string[]; addTagIds?: string[]; removeTagIds?: string[] } = {};
    const addTagIds = [...desiredIds].filter((id) => !currentIds.includes(id));
    const removeTagIds = currentIds.filter((id) => !desiredIds.has(id));
    if (newNames.length > 0) out.addTags = newNames;
    if (addTagIds.length > 0) out.addTagIds = addTagIds;
    if (removeTagIds.length > 0) out.removeTagIds = removeTagIds;
    return out;
  }

  async deleteCard(cardRef: string): Promise<void> {
    const cardId = await this.references.toCardId(cardRef);
    await this.client.delete(`/cards/${cardId}`);
  }

  /**
   * Find a card by its numeric sequential ID — the trailing number in a card's
   * human-readable label (e.g. 8850 in "Squ-8850"). Searches org-wide and
   * returns the first match, or null if none found.
   * Pass `widgetCommonId` to scope the lookup to a single board.
   */
  async findCardBySequentialId(
    sequentialId: number,
    options?: { widgetCommonId?: string },
  ): Promise<Card | null> {
    const params: Record<string, unknown> = {
      cardSequentialId: sequentialId,
      unique: true,
      descriptionFormat: 'markdown',
    };
    if (options?.widgetCommonId) {
      params.widgetCommonId = options.widgetCommonId;
    }

    let response: PaginatedResponse<Card>;
    try {
      response = await this.client.get<PaginatedResponse<Card>>('/cards', { params });
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status !== 500) throw err;
      // Fall back to default format when markdown rendering crashes server-side
      delete params.descriptionFormat;
      response = await this.client.get<PaginatedResponse<Card>>('/cards', { params });
    }

    const entities = ((response.entities as unknown as RawCard[]) ?? []).map(normalizeCard);
    // A forked card — an assignment entity with no `widgetCommonId` — has no
    // column and is unactionable, so it never takes part in resolution.
    const instances = entities.filter((c) => Boolean(c.widgetCommonId));
    if (instances.length === 0) return null;
    if (instances.length > 1) {
      const listed = instances.map((c) => `  ${c.cardId} (board ${c.boardId}, "${c.name}")`).join('\n');
      throw new CardResolutionError(
        `Card ${sequentialId} exists on ${instances.length} boards — pass --board <board> to say which:\n${listed}`,
        String(sequentialId),
        instances as never[],
        '--board <board>',
      );
    }
    const [card] = instances;
    await this.hydrateNames([card]);
    return card;
  }

  /**
   * Find a card from its Favro web URL, e.g.
   *   https://favro.com/organization/<orgId>/<board>?card=Squ-8850
   * Parses the URL and looks the card up via its sequential ID.
   * Returns null if no matching card exists.
   */
  async findCardByUrl(url: string): Promise<Card | null> {
    const { sequentialId } = parseCardUrl(url);
    return this.findCardBySequentialId(sequentialId);
  }

  async searchCards(query: string, limit: number = 50): Promise<Card[]> {
    let response: PaginatedResponse<Card>;
    try {
      response = await this.client.get<PaginatedResponse<Card>>('/cards/search', {
        params: { q: query, limit, descriptionFormat: 'markdown' }
      });
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status !== 500) throw err;
      // Fall back to default format when markdown rendering crashes server-side
      response = await this.client.get<PaginatedResponse<Card>>('/cards/search', {
        params: { q: query, limit }
      });
    }
    return response.entities ?? [];
  }
}

export default CardsAPI;
