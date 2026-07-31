import FavroHttpClient from './http-client';
import TagsAPI from './tags-api';
import ColumnDirectory from './column-directory';
import CardReferenceResolver, { CardResolutionError, isSequentialReference } from './card-reference';
import { cachedTags } from './name-cache';

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

export interface CreateCardRequest {
  name: string;
  description?: string;
  status?: string;
  /** widgetCommonId — the board (widget) to create the card on */
  widgetCommonId?: string;
  /** @deprecated Use widgetCommonId instead */
  boardId?: string;
  columnId?: string;
  assignees?: string[];
  /** Parent card ID — makes this card a child of the specified card */
  parentCardId?: string;
}

export interface UpdateCardRequest {
  name?: string;
  description?: string;
  status?: string;
  assignees?: string[];
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
  /** Due date in YYYY-MM-DD format. Supported by Favro API updateCard endpoint. */
  dueDate?: string;
  /** Target board ID when moving a card between boards. Supported by Favro API updateCard endpoint. */
  boardId?: string;
  /** Target column ID when moving a card between columns on a board. */
  columnId?: string;
  /** Parent card ID — sets or changes the parent card */
  parentCardId?: string;
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

export interface ListCardsOptions {
  boardId?: string;
  collectionId?: string;
  limit?: number;
  filter?: string;
  unique?: boolean;
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
   * List cards with automatic cursor-based pagination.
   * Fetches all pages until the limit is reached or no more pages exist.
   *
   * Accepts either an options object or legacy positional args:
   *   listCards({ boardId, collectionId, limit, filter, unique })
   *   listCards(boardId?, limit?, filter?)  // backward compat
   */
  async listCards(optsOrBoardId?: string | ListCardsOptions, limit?: number, filter?: string): Promise<Card[]> {
    // Normalize args: support both options object and legacy positional params
    let opts: ListCardsOptions;
    if (typeof optsOrBoardId === 'object' && optsOrBoardId !== null) {
      opts = optsOrBoardId;
    } else {
      opts = { boardId: optsOrBoardId ?? undefined, limit, filter };
    }

    const effectiveLimit = (isNaN(opts.limit!) || !opts.limit || opts.limit < 1) ? 25 : opts.limit;
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

    while (allCards.length < effectiveLimit && page < totalPages) {
      const params: Record<string, unknown> = {
        limit: Math.min(effectiveLimit - allCards.length, 100),
      };
      if (useMarkdownDescription) {
        params.descriptionFormat = 'markdown';
      }

      // Favro uses widgetCommonId to scope cards to a board
      if (opts.boardId) {
        params.widgetCommonId = opts.boardId;
      }

      // Collection-scoped cross-board queries
      if (opts.collectionId) {
        params.collectionId = opts.collectionId;
      }

      // Deduplicate cards that appear on multiple boards in the same collection
      if (opts.unique) {
        params.unique = true;
      }

      if (opts.filter) {
        params.filter = opts.filter;
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

    const cards = allCards.slice(0, effectiveLimit);
    await this.hydrateNames(cards);
    return cards;
  }

  /**
   * Get the raw detailedDescription for a card in markdown format,
   * preserving formatting for safe round-trips.
   * Fetches task list items separately and strips them from the markdown,
   * since Favro injects them into the GET response but they're separate objects.
   */
  async getRawDescription(cardRef: string): Promise<string> {
    const cardId = await this.references.toCardId(cardRef);
    let rawCard: RawCard;
    try {
      rawCard = await this.client.get<RawCard>(`/cards/${cardId}`, {
        params: { descriptionFormat: 'markdown' },
      });
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status !== 500) throw err;
      // Fall back to default format when markdown rendering crashes server-side
      rawCard = await this.client.get<RawCard>(`/cards/${cardId}`);
    }
    const md = rawCard.detailedDescription ?? '';
    const cardCommonId = rawCard.cardCommonId ?? rawCard.cardId;
    try {
      const tasks = await this.client.get<{ entities?: Array<{ name: string; completed?: boolean }> }>(
        `/tasks`, { params: { cardCommonId } }
      );
      const taskItems = tasks.entities ?? [];
      if (taskItems.length === 0) return md;
      // Build a set of task names for matching — Favro injects these as -[ ] or -[x] lines
      const taskNames = new Set(taskItems.map(t => t.name));
      // Only strip the TRAILING block of task items (Favro injects them at the end).
      // Don't touch task-like lines in the middle — those are real description content.
      const lines = md.split('\n');
      let cutIndex = lines.length;
      for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i].trim();
        if (trimmed === '') { cutIndex = i; continue; }
        const match = trimmed.match(/^\\?-\s*\\?\[[ x]\\?\]\s*(.+)$/);
        if (match && taskNames.has(match[1])) { cutIndex = i; continue; }
        break;
      }
      if (cutIndex < lines.length) {
        return lines.slice(0, cutIndex).join('\n').replace(/\n+$/, '');
      }
    } catch { /* best effort — return full markdown if tasks API fails */ }
    return md;
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

  async createCard(data: CreateCardRequest): Promise<Card> {
    // Map boardId → widgetCommonId for callers using the old field name
    const payload: Record<string, unknown> = { ...data };
    if (payload.boardId && !payload.widgetCommonId) {
      payload.widgetCommonId = payload.boardId;
      delete payload.boardId;
    }
    mapDescription(payload);
    return this.client.post<Card>('/cards', payload, MARKDOWN_BODY);
  }

  /**
   * Create several cards. Favro has **no bulk-create route** — `POST /cards/bulk`
   * was verified live and does not exist (it falls through to Favro's web app
   * and answers 200 with an HTML page, so the old `response.cards` read silently
   * yielded zero cards created). So this loops `createCard` one call per card.
   *
   * Fails fast: on the first error it throws, attaching the cards created so far
   * as `.created` so the caller can report or undo them.
   */
  async createCards(cards: CreateCardRequest[]): Promise<Card[]> {
    const created: Card[] = [];
    for (const card of cards) {
      try {
        created.push(await this.createCard(card));
      } catch (err: any) {
        throw Object.assign(
          new Error(`Failed creating card "${card.name}" (${created.length}/${cards.length} created): ${err.message}`),
          { created, cause: err },
        );
      }
    }
    return created;
  }

  async updateCard(cardRef: string, data: UpdateCardRequest): Promise<Card> {
    const cardId = await this.references.toCardId(cardRef);
    const payload: Record<string, unknown> = { ...data };
    mapDescription(payload);
    if (payload.boardId !== undefined) {
      payload.widgetCommonId = payload.boardId;
      delete payload.boardId;
    }
    // Favro API uses addAssignmentIds/removeAssignmentIds, not assignees
    if (payload.assignees !== undefined) {
      payload.addAssignmentIds = payload.assignees;
      delete payload.assignees;
    }
    // Favro ignores a whole-array `tags` on update (200, no change) — it only
    // honours add/remove. Translate the replacement into that shape.
    if (payload.tags !== undefined) {
      const desired = (payload.tags ?? []) as string[];
      delete payload.tags;
      Object.assign(payload, await this.tagReplacement(cardId, desired));
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
   * A desired name unknown to the org goes out as `addTags`, letting Favro create
   * it — or refuse with "User does not have correct permission level in
   * workspace". Either way it is a loud outcome, not a silent no-op.
   */
  private async tagReplacement(
    cardId: string,
    desired: string[],
  ): Promise<{ addTags?: string[]; addTagIds?: string[]; removeTagIds?: string[] }> {
    const [card, orgTags] = await Promise.all([
      this.getCard(cardId),
      new TagsAPI(this.client).listTags(),
    ]);

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
