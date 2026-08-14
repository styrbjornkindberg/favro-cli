/**
 * Unit tests for Custom Fields API and commands
 * CLA-1787 FAVRO-025: Implement Custom Fields API
 */
import CustomFieldsAPI, {
  CustomFieldDefinition,
  CustomFieldValue,
  CustomFieldOption,
  validateSelectValue,
  formatFieldType,
} from '../lib/custom-fields-api';
import FavroHttpClient from '../lib/http-client';
import {
  formatFieldsTable,
  formatFieldDetail,
  formatFieldValuesTable,
  formatOptionsTable,
} from '../commands/custom-fields';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const sampleTextField: CustomFieldDefinition = {
  fieldId: 'field-text-1',
  name: 'Notes',
  type: 'text',
  widgetCommonId: 'board-1',
  boardId: 'board-1',
  required: false,
};

const sampleSelectField: CustomFieldDefinition = {
  fieldId: 'field-select-1',
  name: 'Priority',
  type: 'select',
  widgetCommonId: 'board-1',
  boardId: 'board-1',
  required: true,
  options: [
    { optionId: 'opt-low', name: 'Low', color: 'green' },
    { optionId: 'opt-med', name: 'Medium', color: 'yellow' },
    { optionId: 'opt-high', name: 'High', color: 'red' },
  ],
};

const sampleDateField: CustomFieldDefinition = {
  fieldId: 'field-date-1',
  name: 'Due Date',
  type: 'date',
  widgetCommonId: 'board-1',
  boardId: 'board-1',
  required: false,
};

const sampleUserField: CustomFieldDefinition = {
  fieldId: 'field-user-1',
  name: 'Reviewer',
  type: 'user',
  widgetCommonId: 'board-1',
  boardId: 'board-1',
  required: false,
};

const sampleLinkField: CustomFieldDefinition = {
  fieldId: 'field-link-1',
  name: 'Related Card',
  type: 'link',
  widgetCommonId: 'board-1',
  boardId: 'board-1',
  required: false,
};

const sampleFieldValue: CustomFieldValue = {
  fieldId: 'field-text-1',
  value: 'Some note',
  displayValue: 'Some note',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMockClient() {
  return {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
  } as unknown as jest.Mocked<Pick<FavroHttpClient, 'get' | 'post' | 'patch' | 'put' | 'delete'>>;
}

// ─── validateSelectValue ─────────────────────────────────────────────────────

describe('validateSelectValue', () => {
  test('returns matching option (exact case)', () => {
    const opt = validateSelectValue(sampleSelectField, 'High');
    expect(opt.optionId).toBe('opt-high');
    expect(opt.name).toBe('High');
  });

  test('returns matching option (case-insensitive)', () => {
    const opt = validateSelectValue(sampleSelectField, 'low');
    expect(opt.optionId).toBe('opt-low');
  });

  test('throws on invalid value with allowed list', () => {
    expect(() => validateSelectValue(sampleSelectField, 'Critical')).toThrow(
      /Invalid value "Critical" for select field "Priority"/
    );
    expect(() => validateSelectValue(sampleSelectField, 'Critical')).toThrow(
      /Allowed values/
    );
  });

  test('throws when field has no options', () => {
    const emptyField: CustomFieldDefinition = {
      ...sampleSelectField,
      options: [],
    };
    expect(() => validateSelectValue(emptyField, 'Low')).toThrow(
      /no defined options/
    );
  });

  test('throws when options are undefined', () => {
    const noOptsField: CustomFieldDefinition = {
      ...sampleSelectField,
      options: undefined,
    };
    expect(() => validateSelectValue(noOptsField, 'Low')).toThrow(
      /no defined options/
    );
  });
});

// ─── formatFieldType ─────────────────────────────────────────────────────────

describe('formatFieldType', () => {
  test('returns plain type for text', () => {
    expect(formatFieldType(sampleTextField)).toBe('text');
  });

  test('returns select with options list', () => {
    const result = formatFieldType(sampleSelectField);
    expect(result).toContain('select');
    expect(result).toContain('Low');
    expect(result).toContain('Medium');
    expect(result).toContain('High');
  });

  test('returns plain type for select with no options', () => {
    const f = { ...sampleSelectField, options: [] };
    expect(formatFieldType(f)).toBe('select');
  });

  test('returns plain type for date', () => {
    expect(formatFieldType(sampleDateField)).toBe('date');
  });
});

// ─── CustomFieldsAPI ─────────────────────────────────────────────────────────

describe('CustomFieldsAPI', () => {
  let api: CustomFieldsAPI;
  let mockClient: ReturnType<typeof makeMockClient>;

  beforeEach(() => {
    mockClient = makeMockClient();
    api = new CustomFieldsAPI(mockClient as any);
  });

  // --- listFields ---

  describe('listFields', () => {
    test('returns fields for a board', async () => {
      mockClient.get.mockResolvedValue({ entities: [sampleTextField, sampleSelectField] });
      const result = await api.listFields('board-1');
      expect(result).toHaveLength(2);
      expect(result[0].fieldId).toBe('field-text-1');
      expect(mockClient.get).toHaveBeenCalledWith(
        '/customfields',
        expect.objectContaining({ params: expect.objectContaining({ limit: 100, widgetCommonId: 'board-1' }) })
      );
    });

    test('returns empty array when no fields', async () => {
      mockClient.get.mockResolvedValue({ entities: [] });
      const result = await api.listFields('board-1');
      expect(result).toEqual([]);
    });

    /**
     * The board filter is client-side because Favro ignores `widgetCommonId`
     * here — measured 2026-08-14: 3797 rows came back for a board that defines
     * 2. So the wire below answers the SAME page whatever board is asked for,
     * which is the shape the defect had. A later read the same day counted 3799
     * and returned the identical set filtered and unfiltered, confirming the
     * client-side reading twice; the two-row gap is reconciled and left
     * unexplained in `custom-fields-api.ts`.
     *
     * Paired polarity, over the wire's own key: `widgetCommonId` is what a
     * `/customfields` row carries and `boardId` is not (measured — the raw row
     * is `{customFieldId, name, organizationId, enabled, type, widgetCommonId}`).
     * A single "board-1 returns one row" arm would pass just as well if the
     * filter matched everything, so the unrelated board is asserted too.
     */
    describe('the board filter Favro ignores', () => {
      const ORG_WIDE = [
        { customFieldId: 'f-1', name: 'Status', type: 'Single select', widgetCommonId: 'board-1' },
        { customFieldId: 'f-2', name: 'Sprint', type: 'Text', widgetCommonId: 'board-2' },
        // 270 of the 3797 live rows carry no board at all. They belong to no
        // board this endpoint can name, so they are listed for none.
        { customFieldId: 'f-3', name: 'Delsystem', type: 'Text' },
      ];

      beforeEach(() => {
        mockClient.get.mockResolvedValue({ entities: ORG_WIDE });
      });

      test('keeps only the rows whose definition names the board asked for', async () => {
        expect((await api.listFields('board-1')).map(f => f.fieldId)).toEqual(['f-1']);
      });

      test('another board gets its own row from the same org-wide page', async () => {
        expect((await api.listFields('board-2')).map(f => f.fieldId)).toEqual(['f-2']);
      });

      test('a board that defines nothing gets nothing, not the organisation', async () => {
        expect(await api.listFields('board-3')).toEqual([]);
      });

      test('no board asked for is the whole organisation, unfiltered', async () => {
        expect((await api.listFields()).map(f => f.fieldId)).toEqual(['f-1', 'f-2', 'f-3']);
      });
    });

    test('handles pagination correctly', async () => {
      mockClient.get
        .mockResolvedValueOnce({
          entities: [sampleTextField],
          requestId: 'req-1',
          pages: 2,
        })
        .mockResolvedValueOnce({
          entities: [sampleSelectField],
          requestId: 'req-1',
          pages: 2,
        });

      const result = await api.listFields('board-1');
      expect(result).toHaveLength(2);
      expect(mockClient.get).toHaveBeenCalledTimes(2);
      // Second call should include requestId and the NEXT page. Favro's cursor is
      // 0-based and the opening call carries none, so the second call asks for
      // page 1 — this used to assert `page: 2`, which skipped a page (#91).
      expect(mockClient.get).toHaveBeenNthCalledWith(
        2,
        '/customfields',
        expect.objectContaining({ params: expect.objectContaining({ requestId: 'req-1', page: 1, widgetCommonId: 'board-1' }) })
      );
    });

    test('pagination increments page locally (not from API response)', async () => {
      // API returns page: 0 — should NOT be trusted
      mockClient.get
        .mockResolvedValueOnce({
          entities: [sampleTextField],
          requestId: 'req-x',
          pages: 2,
          page: 0, // deliberately misleading
        })
        .mockResolvedValueOnce({
          entities: [sampleDateField],
          requestId: 'req-x',
          pages: 2,
          page: 0, // still 0
        });

      const result = await api.listFields('board-1');
      expect(result).toHaveLength(2);
    });
  });

  // --- getField ---

  describe('getField', () => {
    test('returns field definition', async () => {
      mockClient.get.mockResolvedValue(sampleSelectField);
      const result = await api.getField('field-select-1');
      expect(result.fieldId).toBe('field-select-1');
      expect(result.type).toBe('select');
      expect(mockClient.get).toHaveBeenCalledWith('/customfields/field-select-1');
    });
  });

  // --- getCardFieldValues ---

  describe('getCardFieldValues', () => {
    test('returns field values for a card', async () => {
      mockClient.get.mockResolvedValue({ entities: [sampleFieldValue] });
      const result = await api.getCardFieldValues('card-1');
      expect(result).toHaveLength(1);
      expect(result[0].fieldId).toBe('field-text-1');
      expect(result[0].value).toBe('Some note');
    });

    test('returns empty array when no values', async () => {
      mockClient.get.mockResolvedValue({ entities: [] });
      const result = await api.getCardFieldValues('card-1');
      expect(result).toEqual([]);
    });
  });

  // --- fieldWrite ---

  /**
   * `setFieldValue` is GONE (#109): it resolved a value and PUT it in one
   * un-instrumented call, which is the shape the transactional facade exists to
   * make unconstructible. What survives is the RESOLUTION — which payload key a
   * field type spells, and which values it refuses — and that is what these arms
   * always tested. They now assert the resolved `{key, value}` rather than a PUT
   * body, because there is no PUT here any more; `TxCards.setFieldValue` makes it,
   * and `tx-cards-field-writes-wire.test.ts` pins that on a socket.
   */
  describe('fieldWrite', () => {
    test('a text field spells its value under `value`', async () => {
      mockClient.get.mockResolvedValue(sampleTextField);

      expect(await api.fieldWrite('field-text-1', 'hello')).toEqual({ key: 'value', value: 'hello' });
      expect(mockClient.put).not.toHaveBeenCalled();
    });

    test('a select field resolves the option NAME to an optionId array', async () => {
      mockClient.get.mockResolvedValue(sampleSelectField);

      expect(await api.fieldWrite('field-select-1', 'High')).toEqual({
        key: 'value',
        value: ['opt-high'],
      });
    });

    test('resolves select value for Favro "Status" type field (not "select")', async () => {
      const statusField: CustomFieldDefinition = {
        ...sampleSelectField,
        fieldId: 'field-status-1',
        type: 'Status', // Favro returns this instead of 'select'
      };
      mockClient.get.mockResolvedValue(statusField);

      expect(await api.fieldWrite('field-status-1', 'High')).toEqual({
        key: 'value',
        value: ['opt-high'],
      });
    });

    test('throws for invalid select value', async () => {
      mockClient.get.mockResolvedValue(sampleSelectField);

      await expect(api.fieldWrite('field-select-1', 'Critical')).rejects.toThrow(/Invalid value "Critical"/);
    });

    test('throws for invalid date format', async () => {
      mockClient.get.mockResolvedValue(sampleDateField);

      await expect(api.fieldWrite('field-date-1', 'not-a-date')).rejects.toThrow(/Invalid date "not-a-date"/);
    });

    test('throws for empty string date value', async () => {
      mockClient.get.mockResolvedValue(sampleDateField);

      await expect(api.fieldWrite('field-date-1', '')).rejects.toThrow(/requires a value/);
    });

    test('throws for blank/whitespace date value', async () => {
      mockClient.get.mockResolvedValue(sampleDateField);

      await expect(api.fieldWrite('field-date-1', '   ')).rejects.toThrow(/requires a value/);
    });

    test('throws for non-ISO date format like MM/DD/YYYY', async () => {
      mockClient.get.mockResolvedValue(sampleDateField);

      await expect(api.fieldWrite('field-date-1', '12/31/2024')).rejects.toThrow(/Invalid date "12\/31\/2024"/);
    });

    test('throws for invalid calendar date like 2024-02-30', async () => {
      mockClient.get.mockResolvedValue(sampleDateField);

      await expect(api.fieldWrite('field-date-1', '2024-02-30')).rejects.toThrow(/Invalid date "2024-02-30"/);
    });

    test('accepts valid ISO 8601 date', async () => {
      mockClient.get.mockResolvedValue(sampleDateField);

      expect(await api.fieldWrite('field-date-1', '2024-12-31')).toEqual({
        key: 'value',
        value: '2024-12-31',
      });
    });

    test('accepts valid ISO 8601 datetime with timezone', async () => {
      mockClient.get.mockResolvedValue(sampleDateField);

      expect(await api.fieldWrite('field-date-1', '2024-12-31T00:00:00Z')).toEqual({
        key: 'value',
        value: '2024-12-31T00:00:00Z',
      });
    });

    test('rejects when getField fails (no silent bypass)', async () => {
      mockClient.get.mockRejectedValue(new Error('Network error'));

      await expect(api.fieldWrite('field-text-1', 'fallback')).rejects.toThrow(/Network error/);
    });

    test('a user/members field spells its value under `members`', async () => {
      mockClient.get.mockResolvedValue(sampleUserField);

      expect(await api.fieldWrite('field-user-1', 'user-123')).toEqual({
        key: 'members',
        value: ['user-123'],
      });
    });

    test('a link field spells its value under `link`', async () => {
      mockClient.get.mockResolvedValue(sampleLinkField);

      expect(await api.fieldWrite('field-link-1', 'https://example.com')).toEqual({
        key: 'link',
        value: { url: 'https://example.com' },
      });
    });
  });

  // --- listFieldValues ---

  describe('listFieldValues', () => {
    test('returns options for select field', async () => {
      mockClient.get.mockResolvedValue(sampleSelectField);
      const opts = await api.listFieldValues('field-select-1');
      expect(opts).toHaveLength(3);
      expect(opts[0].name).toBe('Low');
    });

    test('returns empty array for field without options', async () => {
      mockClient.get.mockResolvedValue(sampleTextField);
      const opts = await api.listFieldValues('field-text-1');
      expect(opts).toEqual([]);
    });

    test('passes boardId as query param when provided', async () => {
      mockClient.get.mockResolvedValue(sampleSelectField);
      await api.listFieldValues('field-select-1', 'board-xyz');
      expect(mockClient.get).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ params: { widgetCommonId: 'board-xyz' } })
      );
    });
  });
});

// ─── Formatter Tests ─────────────────────────────────────────────────────────

describe('Custom Fields Formatters', () => {
  let consoleSpy: jest.SpyInstance;
  let tablespy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    tablespy = jest.spyOn(console, 'table').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('formatFieldsTable prints "No custom fields" when empty', () => {
    formatFieldsTable([]);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No custom fields'));
  });

  test('formatFieldsTable renders table with fields', () => {
    formatFieldsTable([sampleTextField, sampleSelectField]);
    expect(tablespy).toHaveBeenCalled();
  });

  test('formatFieldDetail prints all field properties', () => {
    formatFieldDetail(sampleSelectField);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('field-select-1'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Priority'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('select'));
  });

  test('formatFieldDetail lists options for select fields', () => {
    formatFieldDetail(sampleSelectField);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Low'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('High'));
  });

  test('formatFieldValuesTable prints "No custom field values" when empty', () => {
    formatFieldValuesTable([]);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No custom field values'));
  });

  test('formatFieldValuesTable renders table with values', () => {
    formatFieldValuesTable([sampleFieldValue]);
    expect(tablespy).toHaveBeenCalled();
  });

  test('formatOptionsTable prints "No options defined" when empty', () => {
    formatOptionsTable([]);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No options defined'));
  });

  test('formatOptionsTable renders table with options', () => {
    formatOptionsTable(sampleSelectField.options!);
    expect(tablespy).toHaveBeenCalled();
  });
});
