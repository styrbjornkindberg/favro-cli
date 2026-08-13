import FavroHttpClient, { PaginatedResponse } from './http-client';
import { Getter, getAllPages } from './paginate';
import BoardsAPI from './boards-api';
import CollectionsAPI from './collections-api';
import { Tag, cachedTags } from './tags-api';
import ColumnDirectory, { ColumnResolutionError } from './column-directory';
import CardReferenceResolver, {
  CardResolutionError,
  isSequentialReference,
  pickOneInstance,
} from './card-reference';
import { foldName } from './fold-name';
import { invalidateCache } from './name-cache';
import { isUserId } from './id-shapes';
import { resolveAssignee } from './assignee';
import { RefusalError } from './refusal';
import { holeCollector, Unreachable } from './read-shape';

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
 * A dependency edge as `GET /cards` inlines it.
 *
 * MEASURED 2026-08-13 (#162), live, board `abf5860049452d51cacb8162`: the
 * inlined edge is **byte-identical** to what `/cards/:id/dependencies` returns —
 * `{cardId, isBefore, cardCommonId, reverseCardId}`. `cardId` and `cardCommonId`
 * both name the **far** card; `reverseCardId` is the near one. An earlier
 * version of this comment claimed the inlined edge carries no `cardId`, and
 * `normalizeInlinedDependency` was built on that premise — which is the whole of
 * the #162 item-3 defect.
 *
 * `cardSequentialId` is declared because `CardLink` has always declared it, and
 * it passes through if it ever arrives. **Neither endpoint has ever been
 * measured sending it.**
 */
interface RawDependency {
  cardId?: string;
  cardCommonId?: string;
  reverseCardId?: string;
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
 * Map an inlined dependency onto a `CardLink`, **passing every key through**.
 *
 * It enumerated three keys until #162 and dropped the `cardId` Favro puts on
 * every edge. `linksOf` in `query-parser.ts` reads `card.links ?? card.dependencies`
 * and `normalizeCard` always sets `links`, so the intact raw array was
 * unreachable on every list path: `blocked-by:`/`blocks:` matched a
 * `cardCommonId` and answered zero rows for the `cardId` that `cards list`
 * prints as the card's own identity.
 *
 * Only `isBefore` is computed, and only to make the direction flag a definite
 * boolean rather than `undefined` — every predicate here reads it with `===`.
 */
function normalizeInlinedDependency(dep: RawDependency): CardLink {
  return { ...dep, isBefore: dep.isBefore === true };
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
   * cardId of the dependency card (the other end of the edge). Present on both
   * shapes — `GET /cards` inlines it exactly as `/cards/:id/dependencies`
   * returns it (measured 2026-08-13, #162). Optional because it is the wire's
   * key and nothing forces Favro to keep sending it.
   */
  cardId?: string;
  /** True when the dependency card comes before the card you queried. */
  isBefore: boolean;
  cardCommonId?: string;
  /** Never observed on either endpoint. Passed through if it ever appears. */
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
   * The `--include` facets this read asked for and could not reach — `{id,
   * reason}` objects under the one key every producer uses (#86). Present only
   * when there are any, so an absent marker with `links: []` means the card
   * genuinely has no dependencies rather than unreadable (`read-shape.ts`
   * rule 3, #116/#153). A single read has no envelope, so the marker rides on
   * the entity — the same place `context`'s snapshot puts its own.
   */
  unreachable?: Unreachable[];
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
  /**
   * Replaces the card's title. Honoured, and the PUT **response echoes it
   * byte-for-byte** — probed live (#106,
   * `docs/research/card-write-field-semantics.md` §1): leading and trailing
   * whitespace survive and markdown syntax is stored literally, so nothing is
   * canonicalised on the way in. That echo is what earns `TxCards.setText` a
   * strict-equality read-back on this field and only this field.
   */
  name?: string;
  /**
   * Replaces the card's body. `mapDescription` rewrites the key to
   * `detailedDescription` on the way out, because `PUT {description}` is a
   * measured silent no-op (#15/#16/#17).
   *
   * **The round trip is LOSSY, and a read-back is therefore impossible** — probed
   * live (#106, `docs/research/card-write-field-semantics.md` §2). Plain text
   * survives byte-for-byte; markdown does not. `-` list markers come back as `*`,
   * a blank line is inserted between list items, a fence's info string is
   * dropped, and a **zero-width space (U+200B) is injected after every `[`** —
   * with `descriptionFormat` correctly on the query string, so that placement is
   * not a defence against the injection, only against the worse body-placement
   * damage `MARKDOWN_BODY` records. Writing the returned value straight back
   * mutates it AGAIN (the brackets pick up backslash escapes) and only then
   * converges. `{description: ''}` clears the body but stores `"\n"`.
   */
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
  /**
   * The card's due date, or `null` to clear it. Probed live (#106,
   * `docs/research/card-write-field-semantics.md` §3):
   *
   * - `"YYYY-MM-DD"` → **honoured, and NORMALISED on the way in.** The echo and a
   *   following GET both read `"YYYY-MM-DDT00:00:00.000Z"`. The day is preserved;
   *   no timezone shift was observed. So the write took, and strict equality
   *   against the argument would still say it did not — compare on the DAY.
   * - a full ISO timestamp → **honoured, and echoed verbatim.** This closes the
   *   open edge this comment used to record: the read shape IS a legal write
   *   shape, which is what makes a captured pre-state restorable.
   * - `null` → **honoured, clears the date.** The echo carries no `dueDate` key at
   *   all, and neither does the following GET. The only measured clear.
   * - `""` → **200 and a silent no-op.** The echo carries the value that was
   *   already there. Same family as `status`, `assignees`, whole-array `tags` and
   *   `archived`; and it is the natural spelling for "clear this" from a CSV cell
   *   or an empty flag, which is what makes it dangerous. `TxCards.setDueDate`
   *   refuses it rather than forwarding it.
   *
   * A card READS the field back as a full ISO timestamp encoding a local day
   * boundary (`2023-07-27T07:00:00.000Z`), measured across 853 dated cards with
   * zero date-only (#132, `duedate-wire-shape.test.ts`) — consistent with the
   * above, since those are UI-written values.
   */
  dueDate?: string | null;
  /** Target board ID when moving a card between boards. Supported by Favro API updateCard endpoint. */
  boardId?: string;
  /**
   * Target column ID when moving a card between columns on a board. This is the
   * **honoured** write: `status` is the silent no-op, and `updateCard`
   * translates it into this field rather than forwarding it.
   *
   * The PUT **response** does echo `columnId` back: measured 2026-08-13 (#162),
   * raw HTTP, on a column move that landed — the response's `columnId` and
   * `widgetCommonId` both agreed with a follow-up GET.
   *
   * That changes nothing here, and deliberately. The echo was measured on a
   * SUCCESS only; what this PUT answers with when the column move is refused is
   * still unmeasured, and the refusal on this endpoint is a 2xx
   * (`202 {"message":"Access denied"}`, the #162 defect), so an echo comparison
   * would be asserting against a shape nothing has seen fail.
   * `TxCards.moveColumn` still confirms by re-reading the card and comparing the
   * GET row, which is the surface measured on every row (#101,
   * `docs/research/tracker-contract-favro-carriers.md` §1.3).
   */
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
  /**
   * Custom field values, in Favro's own wire shape. There is no sub-resource
   * endpoint — the full card PUT is the only path. It is now the ONLY path in
   * this codebase too: `CustomFieldsAPI` had its own copy of this write and it
   * was deleted with #109, so `TxCards.setFieldValue` is the single caller.
   *
   * Probed live (#106, `docs/research/card-write-field-semantics.md` §4) on **one
   * field type, `Single select`**, and nothing here generalises to the types that
   * were not measured — the scratch board carries no other, and Favro exposes no
   * verb to create one.
   *
   * - `{customFieldId, value: [optionId]}` → **honoured**, and the echo carries
   *   the stored value back under the same `customFieldId`.
   * - `value: []` on a select → `202 {"message":"Invalid status value"}`, nothing
   *   written. **A select has no measured spelling for "clear".**
   * - an unknown `customFieldId` → `202 {"message":"Custom field is not valid"}`.
   * - a bare string where the select wants `[optionId]` → `202
   *   {"message":"Match failed"}`.
   *
   * All three failures answer **202, which axios reads as success**, with a body
   * carrying `message` and **no card row at all**. So the observable signal is the
   * missing row, not the status — and `updateCard` refuses on it below, at the
   * seam, so a caller reaching this door does not have to know that. That is the
   * whole reason the check is not left in `TxCards.setFieldValue`: this field is
   * the one new way to send a custom-field write, and #109's `cards update` will
   * come through here too.
   */
  customFields?: CustomFieldWrite[];
}

/**
 * One entry of a `customFields` write. `customFieldId` is required — the echo has
 * to be matched on it, and the whole-array-vs-touched-entries question is an open
 * edge (§4.2 of the research note), so a reader that takes `[0]` may confirm this
 * write with another field's value.
 *
 * A CLOSED shape, listing the four payload keys `custom-fields-api.ts` builds per
 * field type. Only `value` on a `Single select` has been measured on this path;
 * the other three are declared so a caller can spell what that module already
 * spells, not because this path has probed them. An open index signature was the
 * first spelling and was wrong for `UpdateCardRequest`'s own reason — it reopens
 * arbitrary keys on the type whose job is to keep a caller off the shapes Favro
 * answers 200 to and ignores.
 */
export interface CustomFieldWrite {
  customFieldId: string;
  value?: unknown;
  members?: string[];
  link?: { url: string };
  total?: number;
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

/**
 * A reader that asks for markdown descriptions and survives Favro answering 500.
 *
 * Favro's markdown converter crashes on some card bodies, and it 500s the whole
 * read rather than that one card. Retrying without `descriptionFormat` gets the
 * cards back with plain-text descriptions, which beats an error.
 *
 * Stateful on purpose: once a read has fallen back, the rest of it skips the
 * flag, so a paged read pays the failed call once instead of once per page. A
 * one-shot caller simply never uses that memory. Shaped as a `Getter` so
 * `getAllPages` can page through it. (#91 — this was four verbatim copies.)
 *
 * That one failed call is not cheap. `shouldRetry` in `http-client` retries any
 * 5xx, so the interceptor burns four attempts at 1+2+4+8s before the rejection
 * ever reaches this catch: "one failed call per read" is really one ~15s stall
 * per read. Stickiness is what keeps it from being ~15s per *page*. Narrowing
 * the interceptor to spare a 500 that carries `descriptionFormat` would remove
 * the stall, but that is the interceptor's business, not this reader's.
 */
function markdownReader(client: FavroHttpClient): Getter {
  let markdown = true;

  return {
    async get<T>(url: string, config?: any): Promise<T> {
      const params: Record<string, unknown> = config?.params ?? {};
      if (!markdown) return client.get<T>(url, { params });
      try {
        return await client.get<T>(url, { params: { ...params, descriptionFormat: 'markdown' } });
      } catch (err) {
        if ((err as { response?: { status?: number } })?.response?.status !== 500) throw err;
        markdown = false;
        return client.get<T>(url, { params });
      }
    },
  };
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

  /**
   * Settle a board reference — a NAME or an id — to the `widgetCommonId` the
   * wire wants. Every board-shaped argument on this class goes through here.
   *
   * This is the one guard, at the one seam, and it is not defensive: Favro
   * never refuses a board name in this slot. `GET /cards` answers **200 with an
   * empty page** for a widgetCommonId nobody has, and a write lands nowhere —
   * so a name forwarded raw is zero rows, silently, and there is no
   * classified not-found to escalate on the way `getBoard` can. Resolution has
   * to happen BEFORE the request is built (#82).
   *
   * It is `BoardsAPI.resolveBoardId`, not a second resolver: an exact id passes
   * straight through off the cached listing, and an unknown or duplicated name
   * refuses in the one wording — "missing or not visible to your key", every
   * colliding id listed. Three commands refusing three ways is the next version
   * of this bug.
   */
  private async boardIdOf(board?: string): Promise<string | undefined> {
    if (!board) return undefined;
    return new BoardsAPI(this.client).resolveBoardId(board);
  }

  /** Translate a card reference to the `cardId` a path segment wants. */
  async resolveCardId(reference: string, options?: { widgetCommonId?: string }): Promise<string> {
    const boardId = await this.boardIdOf(options?.widgetCommonId);
    return this.references.toCardId(reference, { widgetCommonId: boardId });
  }

  /** Translate a card reference to the `cardCommonId` comments/tasks/tasklists want. */
  async resolveCardCommonId(reference: string, options?: { widgetCommonId?: string }): Promise<string> {
    const boardId = await this.boardIdOf(options?.widgetCommonId);
    return this.references.toCardCommonId(reference, { widgetCommonId: boardId });
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

    // A board that was PROVIDED but EMPTY is refused, never widened. `boardIdOf`
    // maps `''` to `undefined`, so `widgetCommonId` is omitted and `getAllPages`
    // reads every card in the ORGANISATION to completion. Measured over a
    // three-page stand: `listCards('')` goes out byte-identical to
    // `listCards()` — `/cards?limit=100&archived=false&descriptionFormat=markdown`,
    // no `widgetCommonId` — and both read all three pages. Two commands take a
    // required `<board>` positional and hand it straight here, so
    // `favro release-check ""` and `favro risks ""` each swept the whole
    // organisation and reported a verdict over it.
    //
    // #107 closed this on `TxCards.listCards`, which one intent reaches. This is
    // the same rule at the seam every CLI caller routes through, so the fix lands
    // once instead of at seven call sites.
    //
    // Strictly `=== ''`, so an ABSENT board stays legal: `aggregate` reads a whole
    // collection with `{ collectionId, unique }` and no board at all, on purpose.
    // Omission is a caller saying "not by board"; an empty string is a caller
    // that meant to name one and did not.
    if (opts.boardId === '') {
      throw new RefusalError(
        `Refusing to list cards for an empty board id. An empty board omits widgetCommonId, which ` +
          `reads every card in the organisation, paginated to completion — an unbounded sweep, and ` +
          `every client-side filter downstream would then score a verdict over the whole org.\n` +
          `Name the board: 'favro boards list' shows the ids. To read across boards on purpose, pass ` +
          `a collection instead of a board.`,
      );
    }

    // Refused before any call: a column and a collection cannot both scope one
    // read, and the wire would silently answer about the column's own board.
    if (opts.status && opts.collectionId) {
      throw new ColumnResolutionError(
        'A column and a collection cannot scope the same read: pass --status with --board, or --collection on its own.',
        opts.status,
      );
    }
    // Board FIRST, column second, and the order is load-bearing: column
    // resolution run against an unresolved board refused with "No column named
    // Done on board Backlog - Web Hub" — a structured refusal naming the wrong
    // problem entirely (#82).
    const boardId = await this.boardIdOf(opts.boardId);
    const columnId = opts.status
      ? await this.columns.resolveColumnId(opts.status, boardId)
      : undefined;
    const path = '/cards';
    // Favro clamps this to 100 regardless; asking for the page maximum is the
    // only thing it affects.
    const params: Record<string, unknown> = { limit: 100 };

    // Favro uses widgetCommonId to scope cards to a board
    if (boardId) {
      params.widgetCommonId = boardId;
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

    // One reader for the whole paged read: once a page 500s on markdown, the
    // remaining pages skip the flag rather than paying the failed call again.
    const raw = await getAllPages<RawCard>(markdownReader(this.client), path, params);

    const allCards = raw.map(normalizeCard);
    await this.hydrateNames(allCards);
    return allCards;
  }

  /**
   * Get a single card with optional includes (board, collection, custom-fields, links, comments).
   */
  async getCard(cardRef: string, options?: GetCardOptions): Promise<Card> {
    const boardId = await this.boardIdOf(options?.board);
    const scope = boardId ? { widgetCommonId: boardId } : undefined;
    return this.references.escalateOnNotFound(cardRef, (cardId) => this.getCardById(cardId, options), scope);
  }

  private async getCardById(cardId: string, options?: GetCardOptions): Promise<Card> {
    const params: Record<string, unknown> = {};
    const includes = options?.include ?? [];
    if (includes.length > 0) {
      params.include = includes.join(',');
    }
    const rawCard = await markdownReader(this.client).get<RawCard>(`/cards/${cardId}`, { params });
    const card = normalizeCard(rawCard);
    await this.hydrateNames([card]);

    // Each facet read RECORDS its hole instead of answering with emptiness
    // (#153). A `catch { /* best effort */ }` here left the field absent, which
    // is exactly what "this card has no board / no links / no comments" looks
    // like — so a caller that ASKED for the facet got a card quietly missing it.
    // `holeCollector` is the same mechanism `api/context.ts` uses for its
    // five-way fan-out; the marker rides on the entity because a single read has
    // no envelope to carry it (`read-shape.ts` rule 1).
    //
    // Each facet is `const` first and assigned only when it came back, so a
    // failure leaves the KEY absent rather than present-and-`undefined`. Those
    // two look identical through `JSON.stringify` and through every `??` here,
    // but not to `Object.keys` — `query-parser.ts`'s `knownFields` reads exactly
    // that — and "absent means we could not look" is the claim this whole change
    // makes. It should be true of the object as well as of the bytes.
    const { unreachable, orElse } = holeCollector();

    // Hydrate board/collection if requested and not already present
    if (includes.includes('board') && card.boardId && !card.board) {
      const board = await orElse<Card['board']>(
        'board',
        new BoardsAPI(this.client)
          .getBoard(card.boardId)
          .then((raw) => raw as unknown as Card['board']),
        undefined,
      );
      if (board !== undefined) card.board = board;
    }
    if (includes.includes('collection') && card.collectionId && !card.collection) {
      const collection = await orElse<Card['collection']>(
        'collection',
        // `CollectionsAPI`, not `BoardsAPI`: the deleted twin took ids only, so
        // this facet was the one card-path read that could not settle a name
        // (#123). Favro sends `collectionId` here, but the escalation is what
        // makes the pair one behaviour rather than two.
        new CollectionsAPI(this.client)
          .getCollection(card.collectionId)
          .then((raw) => raw as unknown as Card['collection']),
        undefined,
      );
      if (collection !== undefined) card.collection = collection;
    }
    // Custom fields are returned inline on card responses from Favro API,
    // not via a separate endpoint.
    if (includes.includes('links') && !card.links) {
      // The fallback stays ABSENT rather than `[]`, and that asymmetry is on
      // purpose: `[]` is what a card with no dependencies answers, and
      // `query-parser.ts`'s `linksOf` reads an absent `links` as "fall through to
      // the raw `dependencies` the card GET already carried". Writing `[]` here
      // would shadow real edges with a manufactured emptiness.
      // Favro: GET /cards/:cardId/dependencies
      const links = await orElse<CardLink[] | undefined>(
        'links',
        this.client
          .get<{ dependencies: CardLink[] }>(`/cards/${cardId}/dependencies`)
          .then((lnk) => lnk.dependencies ?? []),
        undefined,
      );
      if (links !== undefined) card.links = links;
    }
    if ((includes.includes('comments') || includes.includes('relations')) && !card.comments) {
      // One facet id for both spellings — `relations` reads the same endpoint,
      // fills the same `comments` field, and so reports the same hole.
      // Favro: GET /comments?cardCommonId=<cardId>
      const comments = await orElse<CardComment[] | undefined>(
        'comments',
        this.client
          .get<{ entities: CardComment[] }>('/comments', { params: { cardCommonId: cardId } })
          .then((cmt) => cmt.entities ?? []),
        undefined,
      );
      if (comments !== undefined) card.comments = comments;
    }
    // Set only when non-empty, so an absent marker stays distinguishable from an
    // empty one (`read-shape.ts` rule 3).
    if (unreachable.length > 0) card.unreachable = unreachable;
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
   * Move a card to a different board — `PUT /cards/:cardId {widgetCommonId,
   * dragMode:'move'}`.
   *
   * **`dragMode` is what makes this a move.** MEASURED 2026-08-13 (#161), raw
   * HTTP against the live API: this PUT defaults `dragMode` to `commit`, and
   * `commit` ADDS a board instance rather than moving one. A bare
   * `PUT {widgetCommonId}` answered 200 and left the card on TWO boards — the
   * source instance untouched, a second instance of the same `cardCommonId`
   * minted on the destination with its own `cardId`, which is why the response
   * came back naming an id nobody asked about. `dragMode:'move'` answers 200 with
   * the REQUESTED `cardId` and one instance. Favro's own validator names the
   * enum when probed with a bogus value: `dragMode is expected as one of
   * "commit", "move" (optional)`. So this was `widgets add` wearing the name
   * `cards move`, and it is why `WidgetsAPI.addWidgetToBoard` — the same endpoint
   * with `dragMode:'commit'` — is a separate method rather than a flag here.
   * `docs/research/card-identifier-semantics.md:280-286` had the missing field
   * written down before it was measured — it names this method as sending
   * `widgetCommonId` "without `dragMode`" — but drew a different hazard from it
   * (an arbitrary source instance getting moved), not the fork.
   *
   * The board echo is MEASURED on this PUT's response by the same probe (and by
   * the live A/B on the #105 scratch board), so the write is read back and a
   * mismatch throws. Compared on the BOARD and never on the card: a move onto a
   * board that already holds an instance of this card merges, and answers with
   * the surviving instance's `cardId`, so `raw.cardId` legitimately differs from
   * the id we addressed. The same comparison is the catch for the denial shape
   * this endpoint answers with — a board id outside the key's reach answers
   * `202 {"message":"Access denied"}`, a 2xx that axios hands back as success and
   * whose body carries no board at all.
   *
   * The response goes through `normalizeCard` like `getCard` does — and unlike
   * `updateCard`, which returns its PUT body raw, so a caller reading a card back
   * off THAT gets no `description`, `assignees`, `boardId` or `tagIds`
   * (`TxCards`'s text read-back reads both key spellings for exactly that reason).
   * Normalising here is what puts the echo in `Card.boardId` — `normalizeCard` derives `boardId`
   * from `widgetCommonId`. Returning the PUT body raw made `boardId` `undefined`
   * whatever the server sent, so a caller reading it could not tell an echo from
   * a silence, and `cards move --json` was the one card-returning path that
   * emitted `widgetCommonId` and never `boardId`.
   */
  async moveCard(cardRef: string, req: MoveCardRequest): Promise<Card> {
    const boardId = await this.boardIdOf(req.toBoardId);
    const cardId = await this.references.toCardId(cardRef);
    const raw = await this.client.put<RawCard>(`/cards/${cardId}`, {
      widgetCommonId: boardId,
      dragMode: 'move',
    });
    // A bare `Error`: neither marker's claim is measured for both branches this
    // catches. `RefusalError` would claim the write landed nowhere, which holds
    // for the 202 denial and is unknown for a mismatched echo; `TransientError`
    // would claim the next attempt may differ, which is false for the denial. An
    // unmarked throw is the fail-closed default the table already reads (#151).
    //
    // Spelled `!==`, and not `!(… === …)`: #82's ratchet reads `widgetCommonId
    // ===` as a WIRE WRITE whose value must be `boardId`, and this line is a
    // RESPONSE read. Tidying it to the positive form fails
    // `board-resolution-wire.test.ts` on a claim that has nothing to do with it.
    if (raw.widgetCommonId !== boardId) {
      throw new Error(
        `Move of card ${cardId} to board ${boardId} was accepted (2xx) but the response does not put the ` +
          `card on that board: it reads ${JSON.stringify(raw.widgetCommonId)}.\n` +
          `A move that lands echoes the destination board back (measured #161). Favro answers ` +
          `202 {"message":"Access denied"} — a success status to every HTTP client — for a board this key ` +
          `cannot write to, and that body carries no board at all, so this is the only place it is visible.\n` +
          `Verify with: favro cards get ${cardId}`,
      );
    }
    return normalizeCard(raw);
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
    // Map boardId → widgetCommonId for callers using the old field name, and
    // settle whichever spelling arrived: a NAME in this slot creates nothing
    // and reports success-shaped nonsense, so it never reaches the POST (#82).
    const payload: Record<string, unknown> = { ...rest };
    const boardId = await this.boardIdOf(
      (payload.widgetCommonId ?? payload.boardId) as string | undefined,
    );
    delete payload.boardId;
    if (boardId) payload.widgetCommonId = boardId;
    mapDescription(payload);

    if (status !== undefined) {
      payload.columnId = await this.columns.resolveColumnId(status, boardId);
    }

    if (payload.parentCardId !== undefined) {
      payload.parentCardId = await this.references.toCardId(String(payload.parentCardId), {
        widgetCommonId: boardId,
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
    // `foldName` rather than a local `trim().toLowerCase()`: a tag typed in one
    // normalisation form used to miss the identical org tag in the other, and
    // a missed tag here is a tag CREATION on the wire (#141).
    const tags = await this.orgTags((known) => names.every((raw) => known.has(foldName(raw))));
    const byName = new Map(tags.map((t) => [foldName(t.name), t.name]));

    return names.map((raw) => {
      const known = byName.get(foldName(raw));
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
        // Folded the same way every caller's lookup key is (#141) — a set keyed
        // one way and probed the other answers "unknown" for a tag that exists.
        new Set(tags.map((t) => foldName(t.name))),
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
    // Same settling as `createCard`: a board NAME on a PUT moves the card
    // nowhere and answers 200 (#82).
    // `let`, because the column guard below fills it from the card when this
    // write named no board of its own — see there.
    let boardId = await this.boardIdOf(
      (payload.widgetCommonId ?? payload.boardId) as string | undefined,
    );
    delete payload.boardId;
    if (boardId) payload.widgetCommonId = boardId;

    // At most one read, shared by every field that has to diff against the card.
    let current: Card | undefined;
    const currentCard = async (): Promise<Card> => (current ??= await this.getCard(cardId));

    // `status` on a write IS a column move: name → columnId, against the board
    // the card will be on (the target board when this write also moves boards).
    if (payload.status !== undefined) {
      const status = String(payload.status);
      delete payload.status;
      const columnBoardId = boardId ?? (await currentCard()).boardId;
      payload.columnId = await this.columns.resolveColumnId(status, columnBoardId);
    }

    // Favro resolves `columnId` AGAINST `widgetCommonId`, so a PUT carrying a
    // column and no board has nothing to resolve it against. MEASURED 2026-08-13
    // (#162), raw HTTP against the live API: `PUT {columnId}` answers
    // `202 {"message":"Access denied"}` and the card does not move;
    // `PUT {columnId, widgetCommonId}` answers 200 and it does; and a
    // widgetCommonId naming the WRONG board answers `202 {"message":"Invalid
    // column"}` — which is what proves the board is the resolution context and
    // "Access denied" is a resolution failure wearing a rights message. 202 is a
    // success to axios, so without this every column move was silently denied.
    //
    // Sending the card's OWN board is a no-op for board membership: a field diff
    // across a fixed move changed only `columnId`, `listPosition`, time counters
    // and one board-automation custom field.
    //
    // Filled here rather than at the call sites because this is the seam every
    // column move funnels through — `cards update --status`/`--column`,
    // `resolve`, `claim`, bulk CSV `status` rows, and `TxCards.moveColumn`'s own
    // `applyInverse`, which was denied for this same reason and so could not
    // unwind a move. On the `status` path the read above already happened, so
    // this costs nothing; an explicit `columnId` pays one GET.
    //
    // Conditioned on `boardId` — the SETTLED board — rather than on
    // `payload.widgetCommonId`, which is still whatever the caller spread in when
    // it did not resolve. `boardIdOf('')` is `undefined`, so an empty spelling
    // takes this branch and is replaced by the card's real board instead of
    // riding out as a board Favro cannot resolve a column against. Keeping that
    // board in the same local leaves exactly ONE name for a settled board id in
    // this method, which is what the #82 ratchet reads. Resolution is not needed
    // on this value: it is an id off the card's own GET row, never a board name.
    if (payload.columnId !== undefined && !boardId) {
      boardId = (await currentCard()).boardId;
      if (boardId) payload.widgetCommonId = boardId;
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
    const updated = await this.client.put<Card>(`/cards/${cardId}`, payload, MARKDOWN_BODY);

    // A `customFields` write Favro rejects answers **202 with `{message}` and no
    // card row** (#106 §4.3), and 202 is a SUCCESS to axios — so without this the
    // denial is handed back typed as a `Card` on which every field is `undefined`,
    // and a caller reporting `card.name` prints nothing for a write that never
    // happened. Refused at the seam rather than in `TxCards.setFieldValue`, because
    // `UpdateCardRequest.customFields` is a door every future caller comes through
    // (#109's `cards update --field` included) and a guard per call site is the
    // pattern this facade exists to stop.
    //
    // Scoped to `customFields`, deliberately. Other write shapes have 202 families
    // of their own — `parentCardId` answers `202 Access denied` — and widening the
    // refusal to every response without a `cardId` would assert a shape nobody has
    // probed on those paths, on the endpoint every command writes through.
    if (data.customFields !== undefined && (updated as { cardId?: string }).cardId === undefined) {
      const said = (updated as { message?: unknown }).message;
      throw new RefusalError(
        `Custom field write on card ${cardId} was rejected: Favro answered ` +
          `${typeof said === 'string' ? `"${said}"` : 'no message'} and sent no card row.\n` +
          `Nothing was written. Measured causes (#106): an unknown customFieldId, a value in the ` +
          `wrong shape for the field's type, or an empty array on a select — which is how "clear it" ` +
          `is spelled everywhere else and is not a clear here.`,
      );
    }
    return updated;
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
      desired.every((entry) => ids.has(entry) || names.has(foldName(entry))),
    );

    // Same fold as `orgTags` builds its name set with — an entry that resolves
    // to an existing tag must not be re-sent as a new one (#141).
    const byName = new Map(orgTags.map((t) => [foldName(t.name), t.tagId]));
    const knownIds = new Set(orgTags.map((t) => t.tagId));

    const desiredIds = new Set<string>();
    const newNames: string[] = [];
    for (const entry of desired) {
      const asId = knownIds.has(entry) ? entry : byName.get(foldName(entry));
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
   * returns the one board instance, or null if none matched.
   * Pass `widgetCommonId` to scope the lookup to a single board.
   *
   * The fork filter and the multi-board refusal are `pickOneInstance`'s, not a
   * second copy of them (#123). The read stays here rather than moving onto
   * `CardReferenceResolver.query` because this one returns a whole normalized
   * card, so it asks for `descriptionFormat: markdown`; the resolver's query
   * wants ids and deliberately does not.
   *
   * A miss stays `null` rather than becoming `pickOneInstance`'s refusal:
   * `findCardByUrl` is the only caller and `cards find` already turns null into
   * its own message naming the URL.
   */
  async findCardBySequentialId(
    sequentialId: number,
    options?: { widgetCommonId?: string },
  ): Promise<Card | null> {
    const params: Record<string, unknown> = {
      cardSequentialId: sequentialId,
      unique: true,
    };
    const boardId = await this.boardIdOf(options?.widgetCommonId);
    if (boardId) {
      params.widgetCommonId = boardId;
    }

    const response = await markdownReader(this.client)
      .get<PaginatedResponse<RawCard>>('/cards', { params });

    const entities = (response.entities ?? []).map(normalizeCard);
    let card: Card;
    try {
      card = pickOneInstance(String(sequentialId), entities, '--board <board>');
    } catch (err) {
      if (err instanceof CardResolutionError && err.candidates.length === 0) return null;
      throw err;
    }
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
    const response = await markdownReader(this.client).get<PaginatedResponse<Card>>(
      '/cards/search',
      { params: { q: query, limit } },
    );
    return response.entities ?? [];
  }
}

export default CardsAPI;
