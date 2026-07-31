/**
 * Favro error classification — CLA #38.
 *
 * Favro answers 403 for not-found across several resources, answers 404 for a
 * couple of others, and can carry a denial message on a 2xx
 * (`202 {"message":"Access Denied"}`). Status therefore says nothing: every
 * decision here is made on the message alone.
 *
 * The recognised set is CLOSED and default-refuse. Only messages we have
 * actually probed (see scripts/probe-favro-errors.ts) are read as "missing";
 * any other 403 is refused as a permission denial and quotes Favro's raw
 * message verbatim rather than guessing at its meaning.
 */

export type FavroErrorKind =
  /** Clean response, no denial message. */
  | 'none'
  /** 401 — the key/email pair was rejected. Never conflated with 403. */
  | 'credentials'
  /** Recognised "missing or not visible" message, on any status. */
  | 'not-found'
  /** Unrecognised 403 — refused as permission by default. */
  | 'permission'
  /** Recognised "already exists" message. */
  | 'conflict'
  /** Recognised bad-input message. */
  | 'invalid'
  /** Failure we cannot name. */
  | 'unknown';

export interface FavroErrorClassification {
  kind: FavroErrorKind;
  /** false only for a clean response carrying no recognised denial message. */
  isFailure: boolean;
  /** Terminal-ready wording. Never says a bare "not found". */
  message: string;
  /** Favro's raw message, verbatim, when it sent one. */
  raw?: string;
  /**
   * True when a READ caller may escalate (retry wider, fall back to a listing).
   * Callers on a mutation must ignore this — a 403 on a write never escalates,
   * because we cannot tell a refused write from an absent target.
   */
  escalatableOnRead: boolean;
}

/** Terminal wording for an absent-or-withheld resource. Never "not found". */
export const MISSING_WORDING = 'missing or not visible to your key';

/**
 * Closed set. Keys are lowercased for lookup only — lowercasing collapses
 * `Access denied` / `Access Denied` into one entry without admitting any new
 * message family.
 */
const NOT_FOUND_MESSAGES = new Set([
  'access denied',
  'page not found',
  'custom field does not exist',
  'tag does not exist',
  'user does not exist',
]);

const CONFLICT_MESSAGES = new Set(['dependency already exists']);

const INVALID_MESSAGES = new Set(['invalid column']);

/**
 * Classify a Favro response by its message, not its status.
 *
 * @param status HTTP status of the response (2xx included — a 2xx can deny).
 * @param message `response.data.message` as Favro sent it, if any.
 */
export function classifyFavroError(status: number, message?: string): FavroErrorClassification {
  const raw = typeof message === 'string' && message.trim() ? message.trim() : undefined;
  const key = raw?.toLowerCase();

  if (key && NOT_FOUND_MESSAGES.has(key)) {
    return {
      kind: 'not-found',
      isFailure: true,
      message: `Favro said "${raw}" — the resource is ${MISSING_WORDING}.`,
      raw,
      escalatableOnRead: true,
    };
  }

  if (key && CONFLICT_MESSAGES.has(key)) {
    return {
      kind: 'conflict',
      isFailure: true,
      message: `Favro said "${raw}" — nothing was changed.`,
      raw,
      escalatableOnRead: false,
    };
  }

  if (key && INVALID_MESSAGES.has(key)) {
    return {
      kind: 'invalid',
      isFailure: true,
      message: `Favro said "${raw}" — the request was rejected as invalid.`,
      raw,
      escalatableOnRead: false,
    };
  }

  if (status === 401) {
    return {
      kind: 'credentials',
      isFailure: true,
      message: raw
        ? `Favro rejected your credentials (401): "${raw}". Run 'favro auth login'.`
        : `Favro rejected your credentials (401). Run 'favro auth login'.`,
      raw,
      escalatableOnRead: false,
    };
  }

  if (status === 403) {
    return {
      kind: 'permission',
      isFailure: true,
      message: raw
        ? `Favro refused this request (403): "${raw}". Treated as a permission denial.`
        : `Favro refused this request (403) with no message. Treated as a permission denial.`,
      raw,
      escalatableOnRead: false,
    };
  }

  if (status >= 200 && status < 300) {
    return { kind: 'none', isFailure: false, message: '', raw, escalatableOnRead: false };
  }

  return {
    kind: 'unknown',
    isFailure: true,
    message: raw
      ? `Favro failed with status ${status}: "${raw}".`
      : `Favro failed with status ${status}.`,
    raw,
    escalatableOnRead: false,
  };
}

/**
 * Classify a thrown axios error. Returns undefined when the error carries no
 * HTTP response (network failure, timeout) — nothing to classify there.
 */
export function classifyThrownError(error: unknown): FavroErrorClassification | undefined {
  const response = (error as any)?.response;
  if (!response || typeof response.status !== 'number') return undefined;
  return classifyFavroError(response.status, response.data?.message);
}
