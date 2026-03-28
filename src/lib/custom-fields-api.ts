/**
 * Custom Fields API
 * CLA-1787 FAVRO-025: Implement Custom Fields API
 *
 * Supports all Favro field types: text, select, date, user, link
 * Type validation for select fields against allowed options
 */
import FavroHttpClient from './http-client';
import { CustomFieldCache, globalFieldCache } from './profiling';

export type CustomFieldType = 'text' | 'select' | 'date' | 'user' | 'link' | string;

export interface CustomFieldOption {
  optionId: string;
  name: string;
  color?: string;
}

export interface CustomFieldDefinition {
  fieldId: string;
  name: string;
  type: CustomFieldType;
  boardId?: string;
  options?: CustomFieldOption[];
  required?: boolean;
  description?: string;
}

export interface CustomFieldValue {
  fieldId: string;
  value: string | null;
  displayValue?: string;
}

export interface SetCustomFieldRequest {
  value: string | null;
}

interface PaginatedResponse<T> {
  entities: T[];
  requestId?: string;
  pages?: number;
  page?: number;
}

/**
 * Validate value for 'select' type fields.
 * Returns the matching option or throws with a helpful message.
 */
export function validateSelectValue(
  field: CustomFieldDefinition,
  value: string
): CustomFieldOption {
  const options = field.options ?? [];
  if (options.length === 0) {
    throw new Error(
      `Custom field "${field.name}" has no defined options. Cannot validate select value.`
    );
  }

  // Exact match first (case-insensitive)
  const match = options.find(
    o => o.name.toLowerCase() === value.toLowerCase()
  );
  if (!match) {
    const allowed = options.map(o => `"${o.name}"`).join(', ');
    throw new Error(
      `Invalid value "${value}" for select field "${field.name}".\n` +
      `Allowed values: ${allowed}`
    );
  }
  return match;
}

/**
 * Format a CustomFieldDefinition for display.
 */
export function formatFieldType(field: CustomFieldDefinition): string {
  if (field.type === 'select' && field.options && field.options.length > 0) {
    const opts = field.options.map(o => o.name).join(', ');
    return `select [${opts}]`;
  }
  return field.type;
}

export class CustomFieldsAPI {
  private cache: CustomFieldCache;

  constructor(private client: FavroHttpClient, options: { cache?: CustomFieldCache; useGlobalCache?: boolean } = {}) {
    // By default, use a fresh per-instance cache to ensure test isolation.
    // Pass { useGlobalCache: true } in long-running batch operations to share the
    // cache across multiple CustomFieldsAPI instances and avoid N+1 API calls.
    // Pass { cache: myCache } to provide a specific shared cache instance.
    if (options.cache) {
      this.cache = options.cache;
    } else if (options.useGlobalCache) {
      this.cache = globalFieldCache;
    } else {
      this.cache = new CustomFieldCache();
    }
  }

  /**
   * List all custom field definitions for a board.
   * Handles pagination automatically.
   */
  async listFields(boardId: string): Promise<CustomFieldDefinition[]> {
    const allFields: CustomFieldDefinition[] = [];
    let requestId: string | undefined;
    let page = 1;

    while (true) {
      const params: Record<string, unknown> = { limit: 100 };
      if (requestId) {
        params.requestId = requestId;
        params.page = page;
      }

      const response = await this.client.get<PaginatedResponse<CustomFieldDefinition>>(
        `/boards/${boardId}/custom-fields`,
        { params }
      );

      const fields = response.entities ?? [];
      allFields.push(...fields);

      requestId = response.requestId;
      if (!requestId || !response.pages || page >= response.pages || fields.length === 0) break;
      page += 1;
    }

    return allFields;
  }

  /**
   * Get a single custom field definition by ID.
   * Results are cached to avoid N+1 API calls in batch operations.
   * Cache key is `${fieldId}:${boardId ?? ''}`.
   *
   * @param fieldId - The ID of the custom field
   * @param boardId - Optional board ID to scope the field lookup
   */
  async getField(fieldId: string, boardId?: string): Promise<CustomFieldDefinition> {
    const cacheKey = boardId ? `${fieldId}:${boardId}` : fieldId;
    const cached = this.cache.get<CustomFieldDefinition>(cacheKey);
    if (cached) return cached;

    const field = boardId
      ? await this.client.get<CustomFieldDefinition>(`/custom-fields/${fieldId}`, { params: { boardId } })
      : await this.client.get<CustomFieldDefinition>(`/custom-fields/${fieldId}`);

    this.cache.set(cacheKey, field);
    return field;
  }

  /**
   * Pre-warm the field cache for a board.
   * Call this before processing a batch of cards that use custom fields.
   * Reduces N+1 API calls to a single bulk fetch.
   *
   * @param boardId - Board ID to pre-warm field definitions for
   */
  async preWarmCache(boardId: string): Promise<CustomFieldDefinition[]> {
    const fields = await this.listFields(boardId);
    for (const field of fields) {
      const cacheKey = `${field.fieldId}:${boardId}`;
      this.cache.set(cacheKey, field);
      // Also cache without boardId for cross-board lookups
      this.cache.set(field.fieldId, field);
    }
    return fields;
  }

  /**
   * Return cache statistics (useful for profiling/debugging N+1 issues).
   */
  cacheStats(): ReturnType<CustomFieldCache['stats']> {
    return this.cache.stats();
  }

  /**
   * Get custom field values on a specific card.
   * Handles pagination automatically.
   */
  async getCardFieldValues(cardId: string): Promise<CustomFieldValue[]> {
    const allValues: CustomFieldValue[] = [];
    let requestId: string | undefined;
    let page = 1;

    while (true) {
      const params: Record<string, unknown> = { limit: 100 };
      if (requestId) {
        params.requestId = requestId;
        params.page = page;
      }

      const response = await this.client.get<PaginatedResponse<CustomFieldValue>>(
        `/cards/${cardId}/custom-fields`,
        { params }
      );

      const values = response.entities ?? [];
      allValues.push(...values);

      requestId = response.requestId;
      if (!requestId || !response.pages || page >= response.pages || values.length === 0) break;
      page += 1;
    }

    return allValues;
  }

  /**
   * Set a custom field value on a card.
   * For select fields, validates value against allowed options before calling API.
   *
   * @param cardId  The card to update
   * @param fieldId The field to set
   * @param value   The value to set (string for text/date/user/link; option name for select)
   */
  async setFieldValue(
    cardId: string,
    fieldId: string,
    value: string
  ): Promise<CustomFieldValue> {
    // Fetch field definition to validate type
    // Errors are propagated — field lookup failure is not silently bypassed
    const field = await this.getField(fieldId);

    // Type-specific validation
    if (field.type === 'select') {
      const option = validateSelectValue(field, value);
      // Use optionId as the value to send to the API
      return this.client.patch<CustomFieldValue>(
        `/cards/${cardId}/custom-fields/${fieldId}`,
        { value: option.optionId }
      );
    }

    if (field.type === 'date') {
      // Reject empty/blank strings explicitly before format check
      if (!value || !value.trim()) {
        throw new Error(
          `Date field "${field.name}" requires a value. Use ISO 8601, e.g. "2024-12-31".`
        );
      }
      // Strict ISO 8601 regex — rejects non-ISO formats and invalid dates like "2024-02-30"
      const iso8601 = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;
      if (!iso8601.test(value)) {
        throw new Error(
          `Invalid date "${value}" for field "${field.name}".\n` +
          `Please use ISO 8601 format, e.g. "2024-12-31" or "2024-12-31T00:00:00Z".`
        );
      }
      // Reject invalid calendar dates (e.g. 2024-02-30 would normalize in Date.parse)
      const parsed = new Date(value);
      const [year, month, day] = value.split('T')[0].split('-').map(Number);
      if (
        isNaN(parsed.getTime()) ||
        parsed.getUTCFullYear() !== year ||
        parsed.getUTCMonth() + 1 !== month ||
        parsed.getUTCDate() !== day
      ) {
        throw new Error(
          `Invalid date "${value}" for field "${field.name}".\n` +
          `Please use ISO 8601 format, e.g. "2024-12-31" or "2024-12-31T00:00:00Z".`
        );
      }
    }

    return this.client.patch<CustomFieldValue>(
      `/cards/${cardId}/custom-fields/${fieldId}`,
      { value }
    );
  }

  /**
   * List all possible values (options) for a select-type field.
   * Returns empty array for non-select fields.
   */
  async listFieldValues(fieldId: string, boardId?: string): Promise<CustomFieldOption[]> {
    const field = await this.getField(fieldId, boardId);
    return field.options ?? [];
  }
}

export default CustomFieldsAPI;
