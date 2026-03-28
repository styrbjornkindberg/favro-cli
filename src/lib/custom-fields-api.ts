/**
 * Custom Fields API
 * CLA-1787 FAVRO-025: Implement Custom Fields API
 *
 * Supports all Favro field types: text, select, date, user, link
 * Type validation for select fields against allowed options
 */
import FavroHttpClient from './http-client';

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
  constructor(private client: FavroHttpClient) {}

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
   */
  async getField(fieldId: string): Promise<CustomFieldDefinition> {
    return this.client.get<CustomFieldDefinition>(`/custom-fields/${fieldId}`);
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
    let field: CustomFieldDefinition | undefined;
    try {
      field = await this.getField(fieldId);
    } catch {
      // If field lookup fails, proceed without type validation
    }

    // Type-specific validation
    if (field?.type === 'select') {
      const option = validateSelectValue(field, value);
      // Use optionId as the value to send to the API
      return this.client.patch<CustomFieldValue>(
        `/cards/${cardId}/custom-fields/${fieldId}`,
        { value: option.optionId }
      );
    }

    if (field?.type === 'date') {
      // Validate date format — must be ISO 8601
      if (value && isNaN(Date.parse(value))) {
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
  async listFieldValues(fieldId: string): Promise<CustomFieldOption[]> {
    const field = await this.getField(fieldId);
    return field.options ?? [];
  }
}

export default CustomFieldsAPI;
