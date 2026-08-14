/**
 * A card's custom fields as the `{key: value}` map `context`, `aggregate` and
 * `query` emit (#167 item 5).
 *
 * ONE expression, because there were two copies of the loop and both were wrong
 * the same way. Each keyed on `cf.name ?? cf.fieldId`, and the card array Favro
 * inlines carries NEITHER: it sends `{customFieldId, value}` — measured on a
 * live create echo, 2026-08-14,
 * `[{"customFieldId":"zxMLxD4zx4tSwJr75","value":["YLanLiuXKA8JpvEsX"]}]`. So
 * every entry keyed itself the literal string `"undefined"`, which is malformed
 * on a machine-readable path and COLLIDING besides: a card holding two custom
 * fields emitted one key carrying the last value. `cardFieldValue` in
 * `tx-cards.ts` already read both id spellings; this is the read half catching up.
 *
 * `name` stays FIRST. Nothing on the card path has been measured to carry it,
 * but `CustomFieldsAPI` normalises to `{fieldId, name}` and a caller handing
 * those in should get the readable key rather than an id.
 *
 * An entry carrying none of the three keys is DROPPED rather than keyed
 * `undefined`. Not observed on the wire; with no name and no id there is nothing
 * honest to call it, and inventing a key is the same defect under another
 * spelling.
 *
 * A leaf, and deliberately not a method on `cards-api`: twenty-odd suites
 * `jest.mock` that module wholesale, which would auto-mock this away and take
 * the mapping with it.
 */
import type { CustomField } from './cards-api';
import { BASE62_17, HEX_24 } from './id-shapes';

export function customFieldMap(fields: readonly CustomField[]): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const cf of fields) {
    const key = cf.name ?? cf.customFieldId ?? cf.fieldId;
    if (key) map[key] = cf.value;
  }
  return map;
}

/**
 * True when at least one key of this map is an ID rather than a name — so a
 * name-matching read of these fields COULD NOT HAVE FIRED, and an empty answer
 * from one says nothing about the card (#169).
 *
 * `some`, not `every`: an effort field can be the id-keyed one in a map that
 * also holds a named field, so one id is enough to make "no effort here"
 * unsupportable. Fail closed.
 *
 * Shape decides, off the two ids the table declares (`id-shapes.ts`). Measured
 * custom field ids are base62-17 (`zxMLxD4zx4tSwJr75`, `5XdsToqDtXLn2rtL9`) and
 * option ids come in both shapes (`YLanLiuXKA8JpvEsX`, `07ef4afba3a3d76994f5dd74`)
 * — live, board `5dd75f0d5116020817ebe70a`, 2026-08-14. A field NAME that
 * happened to be id-shaped would read as unavailable too, which is the safe
 * direction: this predicate only ever withholds a claim.
 */
export function fieldNamesUnavailable(fields: Record<string, unknown> | undefined): boolean {
  return Object.keys(fields ?? {}).some((k) => BASE62_17.test(k) || HEX_24.test(k));
}

/**
 * Why an effort total reads `unavailable`. One string, because `workload` and
 * `team` both print it and a second copy is how the two would drift.
 */
export const EFFORT_UNAVAILABLE_NOTE =
  'Effort "unavailable": at least one card carries a custom field the payload identifies only by id, ' +
  'so no effort field could be matched by name and no total is claimed — it is not a zero.';
