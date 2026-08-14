/**
 * The custom-field key, over the shape the WIRE sends (#167 item 5).
 *
 * The fixture is the measured one, not the declared one. `Card.customFields` is
 * typed `{fieldId, name, value, type}`, and a live `POST /cards` echo on
 * 2026-08-14 carried `[{"customFieldId":"zxMLxD4zx4tSwJr75","value":
 * ["YLanLiuXKA8JpvEsX"]}]` — no `name`, no `fieldId`. An arm written against the
 * declared shape is green today and says nothing about that card, which is how
 * `{"customFields":{"undefined":[…]}}` reached a release.
 */
import { customFieldMap } from '../../lib/custom-field-map';

describe('customFieldMap', () => {
  it('keys the wire shape on customFieldId, never the string "undefined"', () => {
    const map = customFieldMap([
      { customFieldId: 'zxMLxD4zx4tSwJr75', value: ['YLanLiuXKA8JpvEsX'] },
    ]);

    expect(map).toEqual({ zxMLxD4zx4tSwJr75: ['YLanLiuXKA8JpvEsX'] });
    expect(Object.keys(map)).not.toContain('undefined');
  });

  it('keeps two fields apart — the old key collapsed them onto one', () => {
    // The half a single-field fixture cannot show: both entries used to key
    // themselves `"undefined"`, so the second silently overwrote the first and
    // the card emitted one field where it carries two.
    const map = customFieldMap([
      { customFieldId: 'cf-one', value: 'a' },
      { customFieldId: 'cf-two', value: 'b' },
    ]);

    expect(map).toEqual({ 'cf-one': 'a', 'cf-two': 'b' });
  });

  it('prefers a name when one is there, so the readable key still wins', () => {
    expect(customFieldMap([{ customFieldId: 'cf-1', name: 'Priority', value: 'High' }])).toEqual({
      Priority: 'High',
    });
    // `CustomFieldsAPI`'s normalised spelling, which no card path has been
    // measured to carry but which a caller may hand in.
    expect(customFieldMap([{ fieldId: 'cf-1', name: 'Priority', value: 'High' }])).toEqual({
      Priority: 'High',
    });
  });

  it('drops an entry carrying no key at all rather than inventing one', () => {
    expect(customFieldMap([{ value: 'orphan' }])).toEqual({});
  });
});
