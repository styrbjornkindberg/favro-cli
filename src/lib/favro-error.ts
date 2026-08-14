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
 *
 * A 2xx is default-refuse too, on the MESSAGE rather than the closed sets
 * (#165). See the 2xx branch below for the measurement, and `WireRefusalError`
 * for the throw that finally routes those responses in here at all.
 */
import { RefusalError } from './refusal';

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
  // #58 — by-id GETs on /tasks, /tasklists, /comments. Identical grammar to the
  // three above, from the same wire.
  'task does not exist',
  'tasklist does not exist',
  'comment does not exist',
  // #58 via #68 — DELETE /cards/{id}/dependencies/{far} once the edge is gone
  // (measured; recorded at CardsAPI.unlinkCard). Different grammatical form
  // from its neighbours on purpose: Favro says "not found" here, not "does not
  // exist". Do not "tidy" it.
  'dependency not found',
]);

const CONFLICT_MESSAGES = new Set(['dependency already exists']);

const INVALID_MESSAGES = new Set(['invalid column']);

/**
 * What a 202 denial means that a 4xx one does not: the write may be PART done.
 *
 * Measured 2026-08-14 — `PUT /cards/{id} {name, columnId:<bogus>,
 * widgetCommonId:<the card's board>}` answered `202 {"message":"Invalid
 * column"}` and the name changed anyway. The board is part of the recipe, not
 * decoration: #162 measured that a `columnId` write with NO `widgetCommonId`
 * answers `202 "Access denied"`, so only a resolvable board with an unresolvable
 * column reproduces this (`cards-api-update-wire.test.ts` pins both branches).
 *
 * So the closed sets' own wordings are all wrong on a 202 by omission: "nothing
 * was changed" and "the request was rejected as invalid" both let a reader
 * believe the card is untouched. Appended to whichever branch named the message
 * rather than written into the 2xx branch, because the three closed sets name
 * three of the ten measured denial messages and would otherwise each drop it.
 *
 * The compensation half lives HERE and not on `WireRefusalError`, because
 * `dispatch` reports `failureMessage(error)` — which prefers this wording and
 * drops the error's own. A sentence written only on the error never reaches the
 * report that needs it.
 */
const TWO_XX_PARTIAL =
  `A 202 refuses at least ONE field of the request, not necessarily all of them: measured ` +
  `2026-08-14, \`PUT /cards/{id} {name, columnId:<bogus>, widgetCommonId:<the card's board>}\` ` +
  `answered 202 {"message":"Invalid column"} and the name changed anyway. Whatever it DID apply ` +
  `is not logged for compensation, so an unwinding transaction cannot undo that half. Read the ` +
  `card back before deciding what to do.`;

/**
 * Classify a Favro response by its message, not its status.
 *
 * A **202** that classifies as a failure carries `TWO_XX_PARTIAL` on its
 * wording, whichever branch below named it.
 *
 * @param status HTTP status of the response (2xx included — a 2xx can deny).
 * @param message `response.data.message` as Favro sent it, if any.
 */
export function classifyFavroError(status: number, message?: string): FavroErrorClassification {
  const classified = classifyByMessage(status, message);
  // 202 exactly, not the 2xx range. All 28 measured denials were 202s, and the
  // caveat is a 202 measurement: on a 200 it would name a status the response
  // falsifies, and "read the card back" is not advice a refused GET or DELETE
  // can act on. The REFUSAL still fires for any 2xx — that is `http-client`'s
  // rule and it is deliberately wider than this wording.
  if (!classified.isFailure || status !== 202) return classified;
  return { ...classified, message: `${classified.message}\n${TWO_XX_PARTIAL}` };
}

function classifyByMessage(status: number, message?: string): FavroErrorClassification {
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

  // A 2xx carrying a top-level message is a REFUSAL, whether or not the sets
  // above name it (#165). Measured 2026-08-14, 110 logged probes against the
  // live API: 28 of 28 responses that carried a `message` were 202s, every one
  // of them a denial; and across 47 successful 2xx — card writes, dependencies,
  // tasklists, comments, deletes, and every single-entity and paginated GET in
  // remit — not one carried a `message` at all. So the fail-closed rule costs
  // nothing measured.
  //
  // Keyed on the MESSAGE and not on 202: 202 legitimately means "async
  // accepted" in HTTP, and a message rule survives Favro moving a denial onto a
  // 200. Ten distinct denial messages were seen, seven of which none of the
  // closed sets above name, and every new KIND of probe produced a message no
  // earlier probe had seen — the vocabulary is not enumerable, which is why
  // this is a default rather than more entries in those sets. An ELEVENTH,
  // `Unsupported custom field type`, turned up on the first live drive of this
  // rule (`custom-fields set` at a `Relations` field, 2026-08-14) and was caught
  // with nothing taught to catch it. That is the argument in its shortest form.
  if (status >= 200 && status < 300) {
    if (!raw) return { kind: 'none', isFailure: false, message: '', raw, escalatableOnRead: false };
    return {
      kind: 'unknown',
      isFailure: true,
      message: `Favro answered ${status} — a SUCCESS status — and said "${raw}". The request was refused.`,
      raw,
      escalatableOnRead: false,
    };
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
 * The 2xx-denial boundary throw (#165) — a refusal Favro dressed as a success.
 *
 * `classifyThrownError` is reachable only from a `catch`, and axios does not
 * throw on a 2xx. So the whole 202-denial family — ten measured messages, seven
 * of them unnamed by any closed set — bypassed every error path this codebase
 * has and was handed back to callers as a `Card` on which every field is
 * `undefined`. Both of this release's CRITICALs are that shape. This type is
 * what converts the family into an error, thrown from `http-client`'s SUCCESS
 * interceptor — which is where it has to be, because the verb wrappers return
 * `.data` and the status is gone before any caller sees it.
 *
 * A `RefusalError`, so the dispatch table's `isRetryable` lands `retryable:
 * false` without being taught anything new: the denial is deterministic, and
 * repeating the same request repeats it.
 *
 * `.response` and `isAxiosError` are the two structural properties the rest of
 * the codebase reads a wire failure by — `classifyThrownError`, `isWireFailure`,
 * `alreadyGone`, `logError` — so the 11 `classifyThrownError` call sites across
 * eight modules (counted 2026-08-14: `boards-api`, `error-handler`,
 * `read-shape`, `tx-cards`, `dispatch`, `card-reference`, `collections-api`,
 * `tracker-init`) classify this the same way they classify a 403, and the
 * message they render comes from the same classifier rather than from a second
 * wording here — which is also why the compensation warning lives on
 * `TWO_XX_PARTIAL` and not below: `failureMessage` prefers the classifier's
 * wording and drops this error's own.
 *
 * **It satisfies only HALF of `RefusalError`'s contract, deliberately.** That
 * contract is "deterministic AND we did not write"; a 202 is measured to refuse
 * at least one field while applying others, so only the first half holds. The
 * one place that reads the second half — `dispatch`'s pre-write fast path —
 * excludes wire failures for exactly that reason.
 */
export class WireRefusalError extends RefusalError {
  /** Structural, matching what axios stamps: this describes a wire answer. */
  readonly isAxiosError = true;
  readonly response: { status: number; data: unknown };

  constructor(method: string, url: string, status: number, data: unknown) {
    const said = (data as { message?: unknown } | null | undefined)?.message;
    super(
      `${classifyFavroError(status, typeof said === 'string' ? said : undefined).message}\n` +
        `The request was ${method} ${url}.`,
    );
    this.name = 'WireRefusalError';
    this.response = { status, data };
  }
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

/**
 * What a caller should be TOLD a failure was — the classifier's wording when it
 * recognises the response, and the error's own message otherwise.
 *
 * One expression, two readers, and they disagreed until #162: the CLI's error
 * boundary (`run.ts`) has always asked the classifier, while the dispatch table
 * reported `error.message` raw. So the same 403 read `Favro said "Access denied"
 * — the resource is missing or not visible to your key.` on a read command and
 * `Request failed with status code 403` from `widgets add`, which is axios'
 * sentence about a socket rather than Favro's about the request. The wording an
 * agent is told to reason about must not depend on which of the two paths a
 * command happens to take.
 *
 * Lives here rather than in `run.ts` because `run.ts` imports `dispatch.ts`; a
 * shared expression in either of those is a cycle, and this module is the leaf
 * both already depend on.
 */
export function failureMessage(error: unknown): string {
  const classified = classifyThrownError(error);
  if (classified?.isFailure) return classified.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Did this failure come off the wire AT ALL? (#134)
 *
 * `classifyThrownError` answers "which kind of HTTP failure", and returns
 * `undefined` for two things that are not remotely alike: a transport failure
 * that never got a response, and an `ENOENT`, a `TypeError`, a bad flag. This is
 * what tells those apart, and it is asked FIRST by every reader of retry advice —
 * the CLI's error boundary (#134), the skill engine's end-of-run unwind (#151),
 * and the dispatch table itself, which was the last holdout: its population is
 * narrow but `intent.run` is still our code, so unclassifiable there meant "a
 * wire hiccup" for a `TypeError` too. All three now ask through one expression,
 * `retryAdvice` in `dispatch.ts` (ADR-0002, "Two populations of error").
 *
 * Structural, not string-matched: axios stamps `isAxiosError` on everything it
 * raises, transport failures included, so the discriminator is a property of
 * where the error CAME FROM rather than of how its message is worded. The
 * second clause admits an error carrying an HTTP response without that stamp —
 * a hand-built response object still describes a wire answer.
 */
export const isWireFailure = (error: unknown): boolean =>
  (error as { isAxiosError?: unknown } | null | undefined)?.isAxiosError === true ||
  classifyThrownError(error) !== undefined;

/**
 * Is this HTTP status worth sending the same request against again? (#162)
 *
 * `undefined` is a transport failure that never got a response. 408 and 429
 * describe a MOMENT — the request itself was fine — and 5xx is the server's own
 * state. Everything else in 4xx names the REQUEST as the problem, so repeating
 * it unchanged repeats the rejection.
 *
 * ONE expression, two readers, and they disagreed until #162: `HttpClient`
 * retried exactly this set in-process, while `isRetryable` reported every status
 * it could not name from its message as retryable. So `PUT /cards/{id}
 * {name: <1025 chars>}` — Favro answers `400 "Card can't have more than 1024
 * characters."`, measured live, never retried by the client — printed
 * `"retryable": true` and *"safe to retry"* on both of two identical runs, at a
 * command the tracker help topic tells agents to obey that field on.
 */
export const isTransientStatus = (status: number | undefined): boolean =>
  !status || status === 408 || status === 429 || status >= 500;
