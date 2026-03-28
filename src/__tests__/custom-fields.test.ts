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
  boardId: 'board-1',
  required: false,
};

const sampleSelectField: CustomFieldDefinition = {
  fieldId: 'field-select-1',
  name: 'Priority',
  type: 'select',
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
  boardId: 'board-1',
  required: false,
};

const sampleUserField: CustomFieldDefinition = {
  fieldId: 'field-user-1',
  name: 'Reviewer',
  type: 'user',
  boardId: 'board-1',
  required: false,
};

const sampleLinkField: CustomFieldDefinition = {
  fieldId: 'field-link-1',
  name: 'Related Card',
  type: 'link',
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
    delete: jest.fn(),
  } as unknown as jest.Mocked<Pick<FavroHttpClient, 'get' | 'post' | 'patch' | 'delete'>>;
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
        '/boards/board-1/custom-fields',
        expect.objectContaining({ params: expect.objectContaining({ limit: 100 }) })
      );
    });

    test('returns empty array when no fields', async () => {
      mockClient.get.mockResolvedValue({ entities: [] });
      const result = await api.listFields('board-1');
      expect(result).toEqual([]);
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
      // Second call should include requestId and page
      expect(mockClient.get).toHaveBeenNthCalledWith(
        2,
        '/boards/board-1/custom-fields',
        expect.objectContaining({ params: expect.objectContaining({ requestId: 'req-1', page: 2 }) })
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
      expect(mockClient.get).toHaveBeenCalledWith('/custom-fields/field-select-1');
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

  // --- setFieldValue ---

  describe('setFieldValue', () => {
    test('sets text field value directly', async () => {
      mockClient.get.mockResolvedValue(sampleTextField);
      mockClient.patch.mockResolvedValue({ fieldId: 'field-text-1', value: 'hello' });

      const result = await api.setFieldValue('card-1', 'field-text-1', 'hello');
      expect(result.value).toBe('hello');
      expect(mockClient.patch).toHaveBeenCalledWith(
        '/cards/card-1/custom-fields/field-text-1',
        { value: 'hello' }
      );
    });

    test('sets select field value using optionId', async () => {
      mockClient.get.mockResolvedValue(sampleSelectField);
      mockClient.patch.mockResolvedValue({ fieldId: 'field-select-1', value: 'opt-high' });

      await api.setFieldValue('card-1', 'field-select-1', 'High');
      expect(mockClient.patch).toHaveBeenCalledWith(
        '/cards/card-1/custom-fields/field-select-1',
        { value: 'opt-high' }
      );
    });

    test('throws for invalid select value', async () => {
      mockClient.get.mockResolvedValue(sampleSelectField);

      await expect(
        api.setFieldValue('card-1', 'field-select-1', 'Critical')
      ).rejects.toThrow(/Invalid value "Critical"/);
    });

    test('throws for invalid date format', async () => {
      mockClient.get.mockResolvedValue(sampleDateField);

      await expect(
        api.setFieldValue('card-1', 'field-date-1', 'not-a-date')
      ).rejects.toThrow(/Invalid date "not-a-date"/);
    });

    test('throws for empty string date value', async () => {
      mockClient.get.mockResolvedValue(sampleDateField);

      await expect(
        api.setFieldValue('card-1', 'field-date-1', '')
      ).rejects.toThrow(/requires a value/);
    });

    test('throws for blank/whitespace date value', async () => {
      mockClient.get.mockResolvedValue(sampleDateField);

      await expect(
        api.setFieldValue('card-1', 'field-date-1', '   ')
      ).rejects.toThrow(/requires a value/);
    });

    test('throws for non-ISO date format like MM/DD/YYYY', async () => {
      mockClient.get.mockResolvedValue(sampleDateField);

      await expect(
        api.setFieldValue('card-1', 'field-date-1', '12/31/2024')
      ).rejects.toThrow(/Invalid date "12\/31\/2024"/);
    });

    test('throws for invalid calendar date like 2024-02-30', async () => {
      mockClient.get.mockResolvedValue(sampleDateField);

      await expect(
        api.setFieldValue('card-1', 'field-date-1', '2024-02-30')
      ).rejects.toThrow(/Invalid date "2024-02-30"/);
    });

    test('accepts valid ISO 8601 date', async () => {
      mockClient.get.mockResolvedValue(sampleDateField);
      mockClient.patch.mockResolvedValue({ fieldId: 'field-date-1', value: '2024-12-31' });

      const result = await api.setFieldValue('card-1', 'field-date-1', '2024-12-31');
      expect(mockClient.patch).toHaveBeenCalledWith(
        '/cards/card-1/custom-fields/field-date-1',
        { value: '2024-12-31' }
      );
    });

    test('accepts valid ISO 8601 datetime with timezone', async () => {
      mockClient.get.mockResolvedValue(sampleDateField);
      mockClient.patch.mockResolvedValue({ fieldId: 'field-date-1', value: '2024-12-31T00:00:00Z' });

      await api.setFieldValue('card-1', 'field-date-1', '2024-12-31T00:00:00Z');
      expect(mockClient.patch).toHaveBeenCalledWith(
        '/cards/card-1/custom-fields/field-date-1',
        { value: '2024-12-31T00:00:00Z' }
      );
    });

    test('rejects when getField fails (no silent bypass)', async () => {
      mockClient.get.mockRejectedValue(new Error('Network error'));

      await expect(
        api.setFieldValue('card-1', 'field-text-1', 'fallback')
      ).rejects.toThrow(/Network error/);
    });

    test('sets user field value', async () => {
      mockClient.get.mockResolvedValue(sampleUserField);
      mockClient.patch.mockResolvedValue({ fieldId: 'field-user-1', value: 'user-123' });

      await api.setFieldValue('card-1', 'field-user-1', 'user-123');
      expect(mockClient.patch).toHaveBeenCalledWith(
        '/cards/card-1/custom-fields/field-user-1',
        { value: 'user-123' }
      );
    });

    test('sets link field value', async () => {
      mockClient.get.mockResolvedValue(sampleLinkField);
      mockClient.patch.mockResolvedValue({ fieldId: 'field-link-1', value: 'card-999' });

      await api.setFieldValue('card-1', 'field-link-1', 'card-999');
      expect(mockClient.patch).toHaveBeenCalledWith(
        '/cards/card-1/custom-fields/field-link-1',
        { value: 'card-999' }
      );
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
