/**
 * Custom Fields API
 * CLA-1787 FAVRO-025: Implement Custom Fields API
 *
 * Supports all Favro field types: text, select, date, user, link
 * Type validation for select fields against allowed options
 */
import FavroHttpClient from './http-client';
import { getAllPages } from './paginate';
import { foldName } from './fold-name';
import { CustomFieldCache, globalFieldCache } from './profiling';

export type CustomFieldType = 'text' | 'select' | 'date' | 'user' | 'link' | string;

export interface CustomFieldOption {
  optionId: string;
  name: string;
  color?: string;
}

export interface CustomFieldDefinition {
  /** Our internal field ID — mapped from Favro's customFieldId */
  fieldId: string;
  /** Original Favro customFieldId */
  customFieldId?: string;
  name: string;
  type: CustomFieldType;
  boardId?: string;
  /** widgetCommonId from Favro API */
  widgetCommonId?: string;
  options?: CustomFieldOption[];
  customFieldItems?: CustomFieldOption[];
  required?: boolean;
  enabled?: boolean;
  description?: string;
}

interface RawCustomField {
  customFieldId?: string;
  fieldId?: string;
  id?: string;
  name: string;
  type: string;
  widgetCommonId?: string;
  boardId?: string;
  customFieldItems?: Array<{ customFieldItemId?: string; optionId?: string; name: string; color?: string }>;
  options?: CustomFieldOption[];
  required?: boolean;
  enabled?: boolean;
}

function normalizeCustomField(raw: RawCustomField): CustomFieldDefinition {
  const id = raw.customFieldId ?? raw.fieldId ?? raw.id ?? '';
  const items = raw.customFieldItems?.map(item => ({
    optionId: item.customFieldItemId ?? item.optionId ?? '',
    name: item.name,
    color: item.color,
  })) ?? raw.options;
  return {
    fieldId: id,
    customFieldId: raw.customFieldId,
    name: raw.name,
    type: raw.type,
    widgetCommonId: raw.widgetCommonId,
    boardId: raw.boardId ?? raw.widgetCommonId,
    options: items,
    required: raw.required,
    enabled: raw.enabled,
  };
}

export interface CustomFieldValue {
  fieldId: string;
  value: string | null;
  displayValue?: string;
  /**
   * Write path only: did the PUT response actually carry this field back?
   *
   * `false` means the write was accepted (200) and **nothing observed the stored
   * value** — so `value`/`displayValue` are absent rather than filled in from the
   * argument. Callers must not print an accepted write as a confirmed one.
   *
   * Left `undefined` on the read paths, where the value IS the observation.
   */
  confirmed?: boolean;
}

export interface SetCustomFieldRequest {
  value: string | null;
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

  // Exact match first — case AND normalisation insensitive, since the option
  // name is Favro's and the value was typed by a human (#141).
  const match = options.find(o => foldName(o.name) === foldName(value));
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
  async listFields(boardId?: string): Promise<CustomFieldDefinition[]> {
    const params: Record<string, unknown> = { limit: 100 };
    // Favro /customfields is org-scoped; widgetCommonId filters to a specific board
    if (boardId) {
      params.widgetCommonId = boardId;
    }

    // Favro endpoint: /customfields (no hyphen, org-scoped)
    const raw = await getAllPages<RawCustomField>(this.client, '/customfields', params);
    return raw.map(normalizeCustomField);
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

    const raw = boardId
      ? await this.client.get<RawCustomField>(`/customfields/${fieldId}`, { params: { widgetCommonId: boardId } })
      : await this.client.get<RawCustomField>(`/customfields/${fieldId}`);

    const field = normalizeCustomField(raw);
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
    // Note: custom field values are returned inline on card responses;
    // this endpoint may not exist in Favro API
    return getAllPages<CustomFieldValue>(
      this.client,
      `/cards/${cardId}/custom-fields`,
      { limit: 100 },
    );
  }

  /**
   * Set a custom field value on a card.
   * For select fields, validates value against allowed options before calling API.
   *
   * @param cardId  The card to update
   * @param fieldId The field to set
   * @param value   The value to set (string; for select pass option name; for members pass userId; for link pass URL)
   */
  async setFieldValue(
    cardId: string,
    fieldId: string,
    value: string
  ): Promise<CustomFieldValue> {
    const field = await this.getField(fieldId);
    const payload = this.buildFieldPayload(field, value);
    return this.putCardCustomField(cardId, fieldId, payload);
  }

  /**
   * Build the correct API payload object for a custom field value.
   *
   * Favro returns many different type strings for option-based fields
   * ('Status', 'Dropdown', 'select', etc.) — all require the same
   * `value: [optionId]` shape. We detect them by the presence of options
   * rather than relying on the type string.
   */
  private buildFieldPayload(field: CustomFieldDefinition, value: string): Record<string, unknown> {
    const hasOptions = (field.options ?? []).length > 0;

    // Any field with defined options is a select-type regardless of type string
    if (hasOptions) {
      const option = validateSelectValue(field, value);
      return { value: [option.optionId] };
    }

    const type = field.type.toLowerCase();

    if (type === 'members' || type === 'user') {
      return { members: [value] };
    }

    if (type === 'link') {
      return { link: { url: value } };
    }

    if (type === 'number') {
      const num = Number(value);
      if (isNaN(num)) {
        throw new Error(`Number field "${field.name}" requires a numeric value, got "${value}".`);
      }
      return { total: num };
    }

    if (type === 'date') {
      if (!value || !value.trim()) {
        throw new Error(`Date field "${field.name}" requires a value. Use ISO 8601, e.g. "2024-12-31".`);
      }
      const iso8601 = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;
      if (!iso8601.test(value)) {
        throw new Error(
          `Invalid date "${value}" for field "${field.name}".\n` +
          `Please use ISO 8601 format, e.g. "2024-12-31" or "2024-12-31T00:00:00Z".`
        );
      }
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
      return { value };
    }

    // text and any unknown types
    return { value };
  }

  /**
   * Update a single custom field on a card via PUT /cards/:cardId.
   * Favro has no sub-resource endpoint — the only supported path is the full card update.
   *
   * When the response omits the field, this reports `confirmed: false` and NO
   * value. It used to degrade to the caller's own argument, which made an
   * observed write and an unobserved one produce byte-identical output — the
   * argument echoed back as though the server had said it.
   *
   * It does **not** throw. Whether this PUT's response echoes `customFields` is
   * **unmeasured**: the field is measured on every GET row
   * (`docs/research/tracker-contract-favro-carriers.md` §3, as
   * `{customFieldId, value}` pairs), and a read-side row is not a write-side
   * echo. The one measured write echo on this endpoint is `archived`, from #75's
   * live probe — which is what earns `TxCards.setArchived` its throw. Throwing
   * here on an unmeasured echo would take out `custom-fields set` on every call
   * if Favro simply does not return the array, which is #101's regression
   * exactly. Unconfirmed is reported, not fabricated and not fatal.
   */
  private async putCardCustomField(
    cardId: string,
    fieldId: string,
    fieldPayload: Record<string, unknown>
  ): Promise<CustomFieldValue> {
    type RawField = { customFieldId?: string; fieldId?: string; value?: unknown; members?: unknown[]; link?: unknown; total?: unknown };
    const updated = await this.client.put<{ customFields?: RawField[] }>(
      `/cards/${cardId}`,
      { customFields: [{ customFieldId: fieldId, ...fieldPayload }] }
    );
    const match = updated.customFields?.find(
      f => (f.customFieldId ?? f.fieldId) === fieldId
    );
    const raw = match?.value ?? match?.members ?? match?.link ?? match?.total;
    if (raw == null) return { fieldId, value: null, confirmed: false };
    const displayValue = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
    return { fieldId, value: displayValue, displayValue, confirmed: true };
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
