/**
 * The two markers the dispatch table's retry advice reads: `RefusalError` for
 * "deterministic, do not retry", `TransientError` for "measured transient, retry
 * is worth it". Both live here, in one leaf module importing nothing, so any
 * module can raise either without an import cycle back through `dispatch`.
 *
 * ─── the one refusal base class ─────────────────────────────────────────────
 *
 * A refusal is a DETERMINISTIC decline: we did not write, and the same call will
 * decline again for the same reason. That is the whole distinction the dispatch
 * table needs — `rolled-back` means "the world is back where it started, so
 * retrying the same black-box call is safe", which for an unknown assignee, a
 * card that is not on the tracker board, a tag outside the vocabulary or an
 * unresolvable card reference would be a lie: the retry refuses identically.
 *
 * This lives in its own leaf module, importing nothing, so every refusal in the
 * codebase can extend it without an import cycle back through `dispatch`. The
 * table tests `error instanceof RefusalError` and nothing else — so a NEW
 * refusal declared as a subclass of any existing one (`AssigneeError`,
 * `CardResolutionError`, `TrackerConfigError`, `ReverseEdgeError`, `ScopeError`,
 * …) inherits the behaviour with nothing to remember. Anything raising a bare
 * `Error` is treated as a failure, which is the safe default: it unwinds.
 *
 * Note the last of those: a refusal is not only a failed LOOKUP. `ScopeError`
 * is a policy decline with nothing to resolve, and it extended bare `Error`
 * long after every resolver had been converted, so a scope violation reported
 * `retryable: true` (#120). The test is the `instanceof`, not the word
 * "resolution" — `refusal-drift.test.ts` holds the whole set.
 */
export class RefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefusalError';
  }
}

/**
 * A failure the raising site MEASURED transient: the world is unchanged and the
 * next attempt is genuinely allowed to behave differently.
 *
 * The mirror of `RefusalError`, and the reason the dispatch table can afford to
 * default the other way. Errors raised inside a write the table instrumented
 * used to be read as transient WHOLESALE, because "we could not classify it"
 * was assumed to mean "a wire hiccup" — which is true of a socket reset and
 * false of a `TypeError` of ours, and #151 left that reading in place because
 * inverting it would have taken out the one in-process failure that really is
 * transient. So the table now asks the same question its two siblings ask —
 * `isWireFailure`, the gate — and this type is the ONE exemption behind it
 * (`retryAdvice` in `dispatch.ts`, ADR-0002 "Two populations").
 *
 * **The whole population is five throw sites, and all five are read-backs in
 * `TxCards`** — `moveColumn`, `setArchived`, `setText`, `setDueDate` and
 * `setFieldValue`, each raising when its own re-read disagrees with what it
 * sent. `setArchived`'s "answered a SUCCESS status but did not take" and
 * `moveColumn`'s "did not land there" (#101) are the two the shape was named for.
 * They are the only in-process failures in
 * `dispatch.ts`'s import closure that are transient rather than deterministic —
 * every other non-`RefusalError` throw in there is either deterministic or
 * unreachable from inside the table's try, enumerated one by one in ADR-0002
 * ("Why `dispatch.ts` stopped being the exception"), and a bug of ours is by
 * definition not transient. `refusal-drift.test.ts` guards the resolver family
 * only, NOT that enumeration — it is a measurement, not a ratchet. That is what
 * makes the marker cheap: a short list to remember rather than a discipline
 * every future author has to keep.
 *
 * Reach for it only with an OBSERVATION behind it, never as a default. An
 * unmarked bare `Error` is now `retryable: false`, which is the fail-closed
 * side: a wrong `false` costs one honest failure, a wrong `true` costs a loop.
 */
export class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientError';
  }
}

export default RefusalError;
