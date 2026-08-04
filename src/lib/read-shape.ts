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
import { RefusalError } from './refusal';

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
      unreachable.push({ id, reason: unreachableReason(error) });
    }
  }
  for (const id of ids.slice(SWEEP_CAP)) {
    unreachable.push({ id, reason: `not attempted — this read is capped at ${SWEEP_CAP} calls` });
  }

  return { rows, unreachable };
}

/**
 * The wording of an `Unreachable.reason`, in one place.
 *
 * Exported because not every hole comes from a sweep: `getSnapshot` fans out
 * over five DIFFERENT calls in parallel, so there is no `ids` list to hand
 * `boundedSweep` and no shared row type for it to return (#116). It still has
 * to phrase its holes the way every other producer does, and that is this
 * function — the same reason `overview` builds its holes directly rather than
 * through a sweep with no wire.
 */
export function unreachableReason(error: unknown): string {
  const classified = classifyThrownError(error);
  if (classified?.message) return classified.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Hole collection for a parallel fan-out — the one implementation.
 *
 * `boundedSweep` cannot serve one: a fan-out is N DIFFERENT calls with N
 * different return types and no shared `ids` list, and routing it through a
 * sweep would serialise it. `ContextAPI.getSnapshot` (#116) built this inline
 * and `AggregateAPI.getMultiBoardSnapshot` (#148) needs the identical thing, so
 * it lives here once rather than twice.
 *
 * `unreachable` is the live array — read it AFTER every call has settled, and
 * spread the key in only when it is non-empty, so absent stays distinguishable
 * from empty (rule 3 above).
 */
export function holeCollector(): {
  unreachable: Unreachable[];
  orElse: <T>(id: string, call: Promise<T>, fallback: T) => Promise<T>;
} {
  const unreachable: Unreachable[] = [];
  return {
    unreachable,
    orElse: async <T>(id: string, call: Promise<T>, fallback: T): Promise<T> => {
      try {
        return await call;
      } catch (error) {
        unreachable.push({ id, reason: unreachableReason(error) });
        return fallback;
      }
    },
  };
}

/**
 * The `unreachable.id` a failed columns read records when the snapshot covers
 * ONE board — `ContextAPI.getSnapshot`'s bare facet name. There is no board to
 * name because there is only one, so the bare form is correct there.
 *
 * Imported by `context.ts` rather than spelled `'columns'` at the `orElse` call,
 * because the producer and the matcher below have to agree and a string literal
 * in two files is exactly how #148's `--board` arm came to miss (the aggregate
 * side wrote `columns:<id>`, the matcher tested for that prefix, and the
 * single-board side's bare `columns` matched neither).
 */
export const COLUMNS_FACET = 'columns';

/**
 * Prefix of the `unreachable.id` a failed per-board columns read records.
 *
 * `AggregateAPI` fans out over boards, so unlike `getSnapshot`'s five bare
 * facet names its hole ids have to say WHICH board — `columns:<boardId>`.
 */
export const COLUMNS_HOLE = `${COLUMNS_FACET}:`;

/**
 * Drop the cards whose `stage` is unknown because their board's columns read
 * failed, and hand back the holes so the caller can name them.
 *
 * This is the difference between a hole and an empty list, made usable. A
 * failed columns read leaves every card on that board with no `stage`, which
 * every stage predicate in this codebase reads as "not done", "not active",
 * "not flowing" — so `health` scored the board `flow: 0` and reported it RED
 * off a read that never happened (#148), `stale` listed its finished cards as
 * stale, and `workload`/`team` reported everyone on it at zero WIP. Zero is a
 * measurement; these were not.
 *
 * TWO ARMS, because the two producers name their holes differently and both are
 * right to. `AggregateAPI` reads columns once per board, so its ids must say
 * WHICH board (`columns:<boardId>`) and the board id is what selects the cards.
 * `ContextAPI.getSnapshot` covers ONE board, so its id is the bare facet name
 * `columns` and there is no board id on its cards to match — `ContextCard` has
 * no `boardId` field at all. #148 only built the first arm, so `stale --board X`
 * and `workload --board X` matched nothing, excluded nothing, and went on
 * reporting the board's finished cards as stale off a columns read that failed
 * (#149). The bare-id arm is the second one below.
 *
 * The single-board arm drops the cards the failed read left STAGELESS, not every
 * card in the snapshot. `getSnapshot` falls back to `extendedBoard.boardColumns`
 * when `listColumns` returns nothing, so a columns hole does not always cost the
 * cards their stage — and dropping a card that was staged from the fallback would
 * be its own fabricated zero, one the hole is not evidence for. Measured, not
 * assumed: `boardColumns` is a real field on `/widgets/{id}` in this codebase
 * (`boards-api.ts:86`) and `api/context.test.ts` drives that fallback.
 *
 * Lives HERE and not next to `AggregateSnapshot`, for two reasons that agree:
 * it is a rule about reading an `Unreachable`, which is this module's whole
 * remit — and five test files `jest.mock('../../api/aggregate')`, which
 * auto-mocks every export of that module, so a pure helper exported from it
 * comes back as a `jest.fn()` returning `undefined` and every destructuring
 * call site throws. Nothing mocks `read-shape`.
 */
export function excludeUnreadableBoards<T extends { boardId?: string; stage?: string }>(
  snapshot: { allCards: T[]; unreachable?: Unreachable[] },
): { cards: T[]; unreachable: Unreachable[] } {
  const unreachable = snapshot.unreachable ?? [];

  // The single-board arm. A bare `columns` id — the facet name with no
  // `:<boardId>` after it — can only have come from a snapshot covering one
  // board, so every stageless card in it is stageless BECAUSE of this hole.
  if (unreachable.some(h => h.id === COLUMNS_FACET)) {
    return { cards: snapshot.allCards.filter(c => c.stage !== undefined), unreachable };
  }

  const dark = new Set(
    unreachable
      .filter(h => h.id.startsWith(COLUMNS_HOLE))
      .map(h => h.id.slice(COLUMNS_HOLE.length)),
  );
  return {
    cards: dark.size === 0
      ? snapshot.allCards
      : snapshot.allCards.filter(c => !dark.has(c.boardId ?? '')),
    unreachable,
  };
}

/**
 * A supplied `--limit` as a usable cap, `undefined` when the flag is ABSENT,
 * and a refusal when it is present and does not parse (#142).
 *
 * Whole digits only, and deliberately NOT `parseInt`: `parseInt` accepts a
 * numeric PREFIX and stops at the first non-digit, so `--limit 1e9` read as 1,
 * `--limit 5,000` as 5 and `--limit 2.7` as 2. A caller asking for effectively
 * no cap got ONE row back marked `truncated` — well-formed, plausible, and
 * wrong, which is the defect class #44/#91/#136 are all instances of. #99 fixed
 * that half by rejecting outright, but a rejection was still `undefined`, and
 * `undefined` is what every caller reads as "the flag said nothing" — so
 * `--limit banana` silently became NO cap on the print path and the command's
 * own default on the fetch path. Both are a plausible answer invented from
 * garbage, which is the one thing this codebase does not do (fail-closed).
 *
 * So the two meanings are now two returns, and only one of them is a value:
 *
 *   - ABSENT  → `undefined`. Each caller keeps deciding what that means —
 *     `capRows` no cap, `activity`/`comments`/the fetch caps their own default.
 *   - GARBAGE → `RefusalError`, naming the value and what is accepted. It is
 *     deterministic, so retrying is pointless, so it is a refusal and not a
 *     failure — `run`'s boundary reports it `retryable: false` and exits 1.
 *
 * `0` IS GARBAGE, decided (#142). It parses as a number, so it is the one value
 * where "malformed" is a judgement rather than a fact. `capRows` has always read
 * it as no cap (`!(cap >= 1)`) and `parseLimit` has always rejected it, so the
 * two disagreed in spirit; a caller typing `--limit 0` gets *everything* under
 * the old reading, which is the exact plausible-wrong shape above. "Count only,
 * no rows" is a real want, but it is not this flag — nothing in the CLI offers
 * it, and inventing it here would make `0` mean something no other command's
 * `--limit` means. Refuse, and let a ticket add `--count` if anyone asks.
 *
 * A NEGATIVE value is garbage by the same rule and never reached the digit test.
 *
 * `flag` names the flag in the refusal, because this is not only `--limit`'s
 * parser: `sprint-plan --budget` has the same grammar and had the same prefix
 * bug (`--budget 1e9` planned a ONE-POINT sprint). One parser, one wording, the
 * flag substituted — not two spellings of the same decline.
 */
export function parseLimit(limit?: string, flag = '--limit'): number | undefined {
  if (limit === undefined) return undefined;
  const trimmed = limit.trim();
  if (/^\d+$/.test(trimmed) && Number(trimmed) >= 1) return Number(trimmed);
  throw new RefusalError(
    `${flag} takes a whole number of 1 or more — got "${limit}"`,
  );
}

/**
 * Cap what is printed — never what is fetched.
 *
 * `--limit` used to truncate the *fetch*, so every client-side filter filtered a
 * partial set and answered a plausible wrong number. The fetch now runs to
 * completion and filters run over all of it; this is the last step, and it says
 * so with `truncated`.
 *
 * `limit` is `number | string` because commander hands a flag over as a string
 * and every call site would otherwise re-type the same `parseInt` — the count is
 * deliberately not written down here, because it read "eighteen" for two tickets
 * after it stopped being eighteen. Parsing here rather than once per caller is
 * what makes the unparseable case answer once — and since #142 that answer is a
 * REFUSAL, not a silent no-cap: a string goes through `parseLimit`, which throws
 * on anything that is not a whole number of 1 or more. This function therefore
 * throws for a malformed string, which `run`'s boundary turns into exit 1.
 *
 * A NUMBER handed in by a non-commander caller is not re-validated, so `NaN`
 * still has to be caught here — that is what `!(cap >= 1)` is for.
 */
export function capRows<T>(rows: T[], limit?: number | string): ListEnvelope<T> {
  const cap = typeof limit === 'string' ? parseLimit(limit) : limit;
  // Written as `!(cap >= 1)` and not `cap < 1`, so a NaN handed in by a numeric
  // caller takes this branch too; a rejected string arrives as `undefined`.
  if (cap === undefined || !(cap >= 1) || rows.length <= cap) return { rows };
  return { rows: rows.slice(0, cap), truncated: true };
}

/**
 * Say in human mode what `truncated` says in JSON mode — the one wording, so a
 * cut reads the same whichever list read made it.
 *
 * Prints nothing when nothing was cut, which is what keeps every existing
 * table byte-identical for a caller who passed no `--limit`.
 */
export function noteTruncation<T>(envelope: ListEnvelope<T>, total: number): void {
  if (!envelope.truncated) return;
  console.log(
    `(truncated to ${envelope.rows.length} of ${total} — raise --limit to see the rest)`,
  );
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
 * Write one list read to stdout as compact JSON. Compact by default, not pretty:
 * 19% of the bytes for output nothing reads with its eyes. `--pretty` — a root
 * flag owned by the command runner (#113) — is the one way to widen it, and it
 * stays a parameter here so there is still only one writer of the envelope.
 */
export function writeEnvelope<T>(envelope: ListEnvelope<T>, pretty = false): void {
  console.log(JSON.stringify(envelope, null, pretty ? 2 : undefined));
}
