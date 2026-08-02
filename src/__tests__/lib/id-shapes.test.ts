/**
 * The declared shape table (#122, ADR-0003).
 *
 * The point of the table is that the measurements stop being comments. Every
 * declared shape is asserted here against the sample ids that earned the row,
 * so a third `tagId` shape in some future org fails loudly instead of silently
 * misclassifying 11% of the tags again.
 *
 * The samples are the ones already carried by the wire suites — the same ids
 * `tags-users-assignee-wire.test.ts` and `api/activity-wire.test.ts` use.
 */
import {
  BASE62_17,
  HEX_24,
  ID_SHAPES,
  IdShape,
  ShapedResource,
  hasIdShape,
  isTagId,
  isUserId,
} from '../../lib/id-shapes';

const PATTERN: Record<IdShape, RegExp> = { 'hex-24': HEX_24, 'base62-17': BASE62_17 };

/** Measured ids, per resource. A row with no declared shape gets no samples. */
const SAMPLES: Record<ShapedResource, string[]> = {
  userId: ['pk3qK36WHjnJt5jwr', 'aB3dE5gH7jK9mN1pQ', 'zY8xW6vU4tS2rQ0oP', 'mM4nN6bB8vV0cC2xZ'],
  tagId: ['0b49b86eba332b1b342f844c', '1a2b3c4d5e6f7a8b9c0d1e2f', '4HGKcSnW2xuXvnQqN', 'Zq8LmNp3RtVw5Xy7K'],
  cardId: ['c0a732ee70173a2443981111'],
  cardCommonId: ['c1b732ee70173a2443982222'],
  boardId: [],
  collectionId: [],
};

const resources = Object.keys(ID_SHAPES) as ShapedResource[];

describe('the declared shape table', () => {
  test.each(resources)('every measured %s sample matches a declared shape', (resource) => {
    for (const sample of SAMPLES[resource]) {
      expect({ resource, sample, matches: hasIdShape(resource, sample) }).toEqual({
        resource,
        sample,
        matches: true,
      });
    }
  });

  test.each(resources)('every shape declared for %s is earned by a sample', (resource) => {
    for (const shape of ID_SHAPES[resource].shapes) {
      const earned = SAMPLES[resource].some((s) => PATTERN[shape].test(s.trim()));
      expect({ resource, shape, earned }).toEqual({ resource, shape, earned: true });
    }
  });

  test.each(resources)('%s declares a measurement and a mode', (resource) => {
    const row = ID_SHAPES[resource];
    expect(row.mode === 'decides' || row.mode === 'hints').toBe(true);
    expect(row.measurement.length).toBeGreaterThan(0);
  });

  test('a resource with no declared shape never matches anything', () => {
    // `boardId`/`collectionId` are hints with no shape: a one-word board name
    // ("Backlog") is not distinguishable from an id by shape, so nothing here
    // may answer "that is an id".
    for (const resource of resources) {
      if (ID_SHAPES[resource].shapes.length > 0) continue;
      expect(hasIdShape(resource, 'c0a732ee70173a2443981111')).toBe(false);
      expect(hasIdShape(resource, 'pk3qK36WHjnJt5jwr')).toBe(false);
      expect(hasIdShape(resource, 'Backlog')).toBe(false);
    }
  });

  test('userId is NEVER hex-24 — the 135/135 measurement, executable', () => {
    expect(ID_SHAPES.userId.shapes).toEqual(['base62-17']);
    for (const hex of SAMPLES.tagId.filter((t) => t.length === 24)) {
      expect(isUserId(hex)).toBe(false);
    }
  });

  test('tagId takes BOTH shapes — a hex-24-only classifier misses 11%', () => {
    expect([...ID_SHAPES.tagId.shapes].sort()).toEqual(['base62-17', 'hex-24']);
    expect(SAMPLES.tagId.every(isTagId)).toBe(true);
  });

  test('names are never ids', () => {
    for (const name of ['Bug', 'documentation', 'wayfinder:map', 'Jan Book', 'Backlog', '']) {
      expect(isTagId(name)).toBe(false);
      expect(isUserId(name)).toBe(false);
    }
  });

  test('surrounding whitespace does not stop an id being recognised', () => {
    expect(isUserId('  pk3qK36WHjnJt5jwr  ')).toBe(true);
    expect(isTagId(' 0b49b86eba332b1b342f844c\n')).toBe(true);
  });
});
