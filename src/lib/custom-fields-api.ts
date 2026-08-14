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
   * The custom field definitions that name this board, or every one in the
   * organisation when no board is given. Handles pagination automatically.
   *
   * **The board filter is CLIENT-SIDE, because Favro ignores it on the wire.**
   * Measured 2026-08-14 against board `5dd75f0d…` on the #105 org: the request
   * below, `widgetCommonId` and all, came back with **3797 rows, of which 2 name
   * that board**. The param is still sent — it is the documented spelling and
   * costs nothing — but nothing may depend on it; the filter under it is what
   * makes the answer true. Unfiltered, `custom-fields list <board>` and the
   * `customFields` facet of `favro context <board>` both reported the whole
   * organisation as the board's, with no marker saying so.
   *
   * Re-measured later the same day, and this is the reconciliation for the two
   * row counts in this repo: the page-through returned **3799** rows, and the
   * request WITH `widgetCommonId` returned the identical 3799-row set — same ids
   * in both directions, same 270 carrying no `widgetCommonId`, the same 2 naming
   * the board. So the client-side claim above is confirmed twice over, on
   * separate reads, and the ignored param is not what moves the count. The
   * two-row gap between 3797 and 3799 is **unexplained**: the 270-unattributed
   * and 2-naming-this-board counts are identical across all three reads, which
   * rules the filter out and leaves "two fields were created in the org between
   * the reads" as the untested remainder. `id-shapes.ts` and `custom-field-map.ts`
   * carry the 3799 figure and point here; `query-parser.ts:575`, `context.ts:180`
   * and ADR-0006 record the earlier 3797 read.
   *
   * `widgetCommonId` is the only board attribution the wire offers, and only on
   * THIS endpoint: `GET /customfields/<id>` omits the key entirely (measured the
   * same day, on a field whose list row carries it), so a single-field read
   * cannot be filtered this way.
   *
   * Two open edges, both measured, neither asserted about:
   *   - 270 of those 3797 rows carry NO `widgetCommonId` at all. What board they
   *     belong to is not readable from any endpoint probed, so they are not
   *     listed for any board. A field that exists only in that form would be
   *     missing here.
   *   - a card can carry a field whose definition names a DIFFERENT board:
   *     writing field `9G8jeC2LaMas7DHFi` (definition names board `28865e9b…`)
   *     onto a card on board `5dd75f0d…` was accepted and echoed back. So this
   *     is what the board DEFINES, not everything its cards can carry.
   */
  async listFields(boardId?: string): Promise<CustomFieldDefinition[]> {
    const params: Record<string, unknown> = { limit: 100 };
    if (boardId) {
      params.widgetCommonId = boardId;
    }

    // Favro endpoint: /customfields (no hyphen, org-scoped)
    const raw = await getAllPages<RawCustomField>(this.client, '/customfields', params);
    const fields = raw.map(normalizeCustomField);
    return boardId ? fields.filter(f => f.widgetCommonId === boardId) : fields;
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
   * The wire payload one value takes on one field. **Resolution only — this
   * class no longer writes.**
   *
   * There WAS a `setFieldValue` here that resolved and PUT in one call, and a
   * private `putCardCustomField` under it. Both are deleted (#109): every card
   * write goes through `TxCards` now, and an un-instrumented write left reachable
   * is one the next command reaches without touching the table — which is the
   * seam's whole premise, not a tidiness preference. What that PUT reported as
   * "accepted (200) but UNCONFIRMED" is now `TxCards.setFieldValue` throwing,
   * because it matches the echo on `customFieldId` and refuses to call an
   * unobserved write a write.
   *
   * `buildFieldPayload` stays the single owner of "which key does this field type
   * spell", and it always returns exactly one, which is what makes the
   * destructure below total.
   */
  async fieldWrite(
    fieldId: string,
    value: string
  ): Promise<{ key: 'value' | 'members' | 'link' | 'total'; value: unknown }> {
    const payload = this.buildFieldPayload(await this.getField(fieldId), value);
    const [key, resolved] = Object.entries(payload)[0] as ['value' | 'members' | 'link' | 'total', unknown];
    return { key, value: resolved };
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
   * List all possible values (options) for a select-type field.
   * Returns empty array for non-select fields.
   */
  async listFieldValues(fieldId: string, boardId?: string): Promise<CustomFieldOption[]> {
    const field = await this.getField(fieldId, boardId);
    return field.options ?? [];
  }
}

export default CustomFieldsAPI;
