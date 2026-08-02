/**
 * The declared id-shape table (#122, ADR-0003).
 *
 * One row per resource: the shapes its ids take, whether shape **decides** the
 * answer or only **hints** at it, and the measurement that earned the row.
 * Before this table those measurements were comments in four files, `BASE62_17`
 * was declared byte-identically twice, and which regime applied to which
 * resource was inferable only by reading prose.
 *
 * The `mode` column is the point. It is the fact most likely to be got wrong
 * next, and in a table a reviewer sees `boardId: hints` beside `userId:
 * decides` and cannot mis-copy one for the other.
 *
 * Scope, held deliberately: a `const` object and derived predicates — no
 * runtime registry, no per-resource classes, no plugin shape. The table
 * declares WHICH SHAPES A RESOURCE'S IDS TAKE. It never declares WHICH RESOURCE
 * AN UNKNOWN ID BELONGS TO — that question has no measurement behind it and
 * gets no home here.
 */

/** 24-char hex. `tagId`, and the shared `cardId`/`cardCommonId` keyspace. */
export const HEX_24 = /^[0-9a-f]{24}$/i;
/** 17-char base62. `userId`, and the majority of `tagId`s. */
export const BASE62_17 = /^[0-9A-Za-z]{17}$/;

export type IdShape = 'hex-24' | 'base62-17';

const SHAPE_PATTERN: Record<IdShape, RegExp> = {
  'hex-24': HEX_24,
  'base62-17': BASE62_17,
};

/**
 * `decides` — shape alone settles the question, with no escalation.
 * `hints` — shape narrows a guess that a classified not-found may overturn.
 *
 * There is no `maybe` between the two, and there must not be one: an unmeasured
 * shape is a hint, and a hint that cannot be escalated on a classified
 * not-found is not a resolution strategy.
 */
export type ShapeMode = 'decides' | 'hints';

export interface ShapeRow {
  readonly shapes: readonly IdShape[];
  readonly mode: ShapeMode;
  /** The observation that earned the row. Asserted by `id-shapes.test.ts`. */
  readonly measurement: string;
}

export const ID_SHAPES = {
  userId: {
    shapes: ['base62-17'],
    mode: 'decides',
    measurement:
      'NEVER hex-24 — 135/135 measured user ids are base62-17. And every one of ' +
      '135 measured user names contains a space, so a base62-17 token is never a name.',
  },
  tagId: {
    shapes: ['hex-24', 'base62-17'],
    mode: 'decides',
    measurement:
      'TWO measured shapes inside one organization — 27 hex-24 and 222 base62-17. ' +
      'A hex-24-only classifier misses 11% of the tags. The longest pure-alnum ' +
      'single-token tag name measured is 14 chars, so nothing id-shaped is a name.',
  },
  cardId: {
    shapes: ['hex-24'],
    mode: 'hints',
    measurement:
      'Shares one 24-char-hex keyspace syntax with cardCommonId, so shape cannot ' +
      'tell the two apart — assumed to be what the endpoint wants, escalated only ' +
      'on a classified not-found (card-reference.ts).',
  },
  cardCommonId: {
    shapes: ['hex-24'],
    mode: 'hints',
    measurement: 'The other half of the shared cardId keyspace — see cardId.',
  },
  boardId: {
    shapes: [],
    mode: 'hints',
    measurement:
      'No shape declared, deliberately: a one-word board name ("Backlog") is not ' +
      'distinguishable from an id by shape, so shape alone never decides ' +
      '(name-resolve.ts). The only hint that exists is `looksLikeName` — a value ' +
      'carrying a character no id does — and it skips a round trip, never answers.',
  },
  collectionId: {
    shapes: [],
    mode: 'hints',
    measurement: 'Same as boardId — a one-word collection name is id-shaped.',
  },
} as const satisfies Record<string, ShapeRow>;

export type ShapedResource = keyof typeof ID_SHAPES;

/** True when `value` has one of the shapes declared for `resource`. */
export function hasIdShape(resource: ShapedResource, value: string): boolean {
  const v = value.trim();
  // Widened to ShapeRow: `as const` gives each row its own literal tuple type,
  // and a union of tuples has no callable `.some`.
  const row: ShapeRow = ID_SHAPES[resource];
  return row.shapes.some((s) => SHAPE_PATTERN[s].test(v));
}

/** True when the string has the shape of a `userId`. Shape DECIDES. */
export function isUserId(value: string): boolean {
  return hasIdShape('userId', value);
}

/** True when the string has the shape of a `tagId` rather than a tag name. Shape DECIDES. */
export function isTagId(value: string): boolean {
  return hasIdShape('tagId', value);
}
