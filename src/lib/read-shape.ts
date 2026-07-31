/**
 * The one shape every list read hands an agent, and the one way to write a
 * composite read (#44).
 *
 * Three rules live here, so no command has to re-decide them:
 *
 * 1. **List reads emit an envelope, singles stay bare.** The envelope is always
 *    an envelope — never "an array unless something went wrong" — because a
 *    shape that varies with the data makes the agent's least-exercised branch
 *    the one that matters most.
 * 2. **Omission is rendering, never truth.** `omitBulk` is applied to what is
 *    printed, after the read returned every field Favro sent. No read may drop a
 *    field from the object it returns: that is what keeps `--filter
 *    "description:foo"` real grammar rather than a dead flag.
 * 3. **Honest failure splits on call count.** A single-call read throws, so
 *    unavailability never reaches stdout dressed as emptiness and an empty
 *    return unambiguously means true-empty. A composite read cannot: a capped
 *    sweep can hold 17 real rows *and* a hole, so it returns both — via
 *    `boundedSweep`, which is the only way to write one and parks the cap in
 *    one place.
 */
import { classifyThrownError } from './favro-error';

/** An item a composite read could not reach, and why. */
export interface Unreachable {
  /** The id that was swept for. */
  id: string;
  /** Terminal-ready wording. Never a bare "not found". */
  reason: string;
}

/**
 * What every list read returns. `rows` is always present, even when empty —
 * and an empty `rows` with no `unreachable` means true-empty, not "we could not
 * look".
 */
export interface ListEnvelope<T> {
  rows: T[];
  /** Present only when `--limit` cut rows off the end of a complete fetch. */
  truncated?: true;
  /** Present only when a composite read could not reach part of its input. */
  unreachable?: Unreachable[];
}

/**
 * How many per-item calls one composite read may make. A read that wants more
 * than this returns what it got plus an `unreachable` entry per skipped id —
 * it never quietly walks the whole set, and never quietly stops either.
 */
export const SWEEP_CAP = 20;

/**
 * The only way to write a composite read.
 *
 * Runs `perItemCall` over `ids` up to `SWEEP_CAP`, sequentially. A per-item
 * failure is recorded, not thrown: one bad card must not fail the whole sweep.
 * Ids past the cap are recorded too, so "we stopped" is never mistaken for
 * "there was nothing there".
 */
export async function boundedSweep<T>(
  ids: string[],
  perItemCall: (id: string) => Promise<T>,
): Promise<{ rows: T[]; unreachable: Unreachable[] }> {
  const rows: T[] = [];
  const unreachable: Unreachable[] = [];

  for (const id of ids.slice(0, SWEEP_CAP)) {
    try {
      rows.push(await perItemCall(id));
    } catch (error) {
      unreachable.push({ id, reason: reasonFor(error) });
    }
  }
  for (const id of ids.slice(SWEEP_CAP)) {
    unreachable.push({ id, reason: `not attempted — this read is capped at ${SWEEP_CAP} calls` });
  }

  return { rows, unreachable };
}

function reasonFor(error: unknown): string {
  const classified = classifyThrownError(error);
  if (classified?.message) return classified.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Cap what is printed — never what is fetched.
 *
 * `--limit` used to truncate the *fetch*, so every client-side filter filtered a
 * partial set and answered a plausible wrong number. The fetch now runs to
 * completion and filters run over all of it; this is the last step, and it says
 * so with `truncated`.
 */
export function capRows<T>(rows: T[], limit?: number): ListEnvelope<T> {
  if (limit === undefined || limit < 1 || rows.length <= limit) return { rows };
  return { rows: rows.slice(0, limit), truncated: true };
}

/**
 * Per-resource bulk fields, omitted from rendered list output by default.
 *
 * A **denylist**, not an allowlist: `normalizeCard` passes every Favro field
 * through, so a field Favro adds tomorrow shows up on its own rather than going
 * invisible until someone remembers to widen a list. Only fields measured to
 * dominate the byte count are named, and each has an existing flag that brings
 * it back — no `--full`.
 *
 * Resources not named here have no bulk field: `boards list` (322 rows) and
 * `tags list` (249 rows) are expensive by row COUNT, which `--limit` and compact
 * JSON answer, not by any one fat field.
 */
const DENYLIST: Record<string, readonly string[]> = {
  // `description` restored by `--body`, `customFields` by `--include custom-fields`.
  card: ['description', 'detailedDescription', 'customFields'],
  // 47% of a `collections list` payload; `boards` inlines whole board objects.
  collection: ['sharedToUsers', 'boards'],
};

/** The default-omitted field names for a resource — for help text and tests. */
export function omittedFields(resource: string): readonly string[] {
  return DENYLIST[resource] ?? [];
}

/**
 * Render-time omission. Returns new objects; the rows handed in are untouched,
 * because something else may still need the whole card.
 *
 * @param keep Field names to restore, from the flags the caller was given.
 */
export function omitBulk<T extends object>(
  resource: string,
  rows: readonly T[],
  keep: readonly string[] = [],
): T[] {
  const denied = omittedFields(resource).filter((field) => !keep.includes(field));
  if (denied.length === 0) return [...rows];
  return rows.map((row) => {
    const rendered = { ...row } as Record<string, unknown>;
    for (const field of denied) delete rendered[field];
    return rendered as T;
  });
}

/**
 * Write one list read to stdout as compact JSON. Compact, not pretty: 19% of the
 * bytes for output nothing reads with its eyes.
 */
export function writeEnvelope<T>(envelope: ListEnvelope<T>): void {
  console.log(JSON.stringify(envelope));
}
