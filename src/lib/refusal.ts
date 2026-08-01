/**
 * The one refusal base class.
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
 * `CardResolutionError`, `TrackerConfigError`, `ReverseEdgeError`, …) inherits
 * the behaviour with nothing to remember. Anything raising a bare `Error` is
 * treated as a failure, which is the safe default: it unwinds.
 */
export class RefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefusalError';
  }
}

export default RefusalError;
