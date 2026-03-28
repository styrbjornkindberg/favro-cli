/**
 * Integration Tests for Custom Fields API
 * CLA-1787 FAVRO-025: Implement Custom Fields API
 *
 * Runs only when FAVRO_API_TOKEN and FAVRO_TEST_BOARD_ID are set.
 * Requires a real Favro board with at least one custom field defined.
 */

import CustomFieldsAPI from '../lib/custom-fields-api';
import FavroHttpClient from '../lib/http-client';

const FAVRO_API_TOKEN = process.env.FAVRO_API_TOKEN;
const FAVRO_TEST_BOARD_ID = process.env.FAVRO_TEST_BOARD_ID;
const FAVRO_TEST_CARD_ID = process.env.FAVRO_TEST_CARD_ID;
const FAVRO_TEST_FIELD_ID = process.env.FAVRO_TEST_FIELD_ID;
const FAVRO_ORG = process.env.FAVRO_ORG ?? 'seldon';

const RUN_INTEGRATION = !!(FAVRO_API_TOKEN && FAVRO_TEST_BOARD_ID);

const describeIf = (condition: boolean) => (condition ? describe : describe.skip);

describeIf(RUN_INTEGRATION)('Custom Fields Integration Tests', () => {
  let api: CustomFieldsAPI;

  beforeAll(() => {
    if (!FAVRO_API_TOKEN) throw new Error('FAVRO_API_TOKEN not set');
    const client = new FavroHttpClient({
      auth: { token: FAVRO_API_TOKEN },
      baseUrl: `https://favro.com/api/v1`,
      headers: {
        'organizationId': FAVRO_ORG,
      },
    });
    api = new CustomFieldsAPI(client);
  });

  describe('listFields', () => {
    test('returns array of fields for board', async () => {
      const fields = await api.listFields(FAVRO_TEST_BOARD_ID!);
      expect(Array.isArray(fields)).toBe(true);
      // Board may have 0 fields; just verify structure
      for (const f of fields) {
        expect(f).toHaveProperty('fieldId');
        expect(f).toHaveProperty('name');
        expect(f).toHaveProperty('type');
      }
    }, 30000);
  });

  describeIf(!!(FAVRO_API_TOKEN && FAVRO_TEST_FIELD_ID))('getField', () => {
    test('returns field definition', async () => {
      const field = await api.getField(FAVRO_TEST_FIELD_ID!);
      expect(field.fieldId).toBe(FAVRO_TEST_FIELD_ID);
      expect(field.name).toBeDefined();
      expect(field.type).toBeDefined();
    }, 30000);
  });

  describeIf(!!(FAVRO_API_TOKEN && FAVRO_TEST_FIELD_ID))('listFieldValues', () => {
    test('returns options array (may be empty for non-select fields)', async () => {
      const opts = await api.listFieldValues(FAVRO_TEST_FIELD_ID!);
      expect(Array.isArray(opts)).toBe(true);
      for (const opt of opts) {
        expect(opt).toHaveProperty('optionId');
        expect(opt).toHaveProperty('name');
      }
    }, 30000);
  });

  describeIf(!!(FAVRO_API_TOKEN && FAVRO_TEST_CARD_ID))('getCardFieldValues', () => {
    test('returns field values for a card', async () => {
      const values = await api.getCardFieldValues(FAVRO_TEST_CARD_ID!);
      expect(Array.isArray(values)).toBe(true);
    }, 30000);
  });
});
