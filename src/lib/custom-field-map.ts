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

export function customFieldMap(fields: readonly CustomField[]): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const cf of fields) {
    const key = cf.name ?? cf.customFieldId ?? cf.fieldId;
    if (key) map[key] = cf.value;
  }
  return map;
}
