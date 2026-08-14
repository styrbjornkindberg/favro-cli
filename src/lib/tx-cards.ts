/**
 * The transactional write facade and its compensation log (#50).
 *
 * A failed multi-step write is fully rolled back, so an agent can retry the same
 * call without inspecting wreckage — and the result says whether retrying is
 * safe.
 *
 * ## Why a facade and not per-intent capture/mutate pairs
 *
 * Each reversible op is declared **once**, with capture + mutate + push fused.
 * Per-intent declared pairs were rejected: they split capture from mutate, and an
 * intent cannot know what it will touch before its arguments are resolved. A
 * generic state-differ was rejected too — a full-card PUT clobbers concurrent
 * edits, and Favro's write shape is not symmetric with its read shape (a
 * whole-array `tags` / `assignees` PUT answers 200 and writes nothing; only the
 * add/remove verbs are honoured).
 *
 * Intents receive `TxCards` and nothing else — no `CardsAPI`, no
 * `FavroHttpClient` — so an un-instrumented write is not merely discouraged, it
 * is unconstructible from inside an intent. An intent that declares
 * `readOnly: true` receives the narrower `ReadTx` below, on which no write
 * exists at all.
 *
 * ## Compare-before-restore, facade-wide, always on
 *
 * There is **no version carrier on the wire**: no `updatedAt`, no `ETag`, no
 * `Last-Modified`, and the monotone-ish fields (`position`, `timeOnBoard`,
 * `timeOnColumns`) do not move when the mutated fields move. Optimistic
 * concurrency by version is therefore impossible, and comparing is the only
 * guard available. So the rule is stated once, facade-wide, and a new reversible
 * op inherits it rather than restating it:
 *
 *   > Compare in whatever shape the write took. Delta-shaped writes compare
 *   > per-element on our own delta; scalar writes compare strict equality;
 *   > `addBlockingEdge` compares existence with direction; `create` is exempt.
 *
 * Per-element follows from the wire: whole-field equality would guard a
 * whole-field write that never happens, and would refuse to undo our own
 * `tags=[A]` because a human added `B`.
 *
 * This is **not** a re-read of the restore value. The value still comes from the
 * captured pre-state; the read only DETECTS. Capture-before-mutate stands
 * unamended, so `rolled-back` keeps its strong meaning.
 *
 * There is no opt-out flag on the guard. Under the honest-failure posture that
 * would be a licence to clobber in silence.
 */
import CardsAPI, {
  Card,
  CardLink,
  CreateCardRequest,
  CustomFieldWrite,
  unknownTagMessage,
} from './cards-api';
import BoardsAPI from './boards-api';
import CustomFieldsAPI from './custom-fields-api';
import WidgetsAPI, { CommittedWidget } from './widgets-api';
import FavroHttpClient from './http-client';
import { classifyThrownError, WireRefusalError } from './favro-error';
import { isImpossibleDate } from './card-predicates';
import { isUserId } from './id-shapes';
import { resolveAssignee } from './assignee';
import { requireTrackerMapping, verifyTrackerMapping, VerifiedTracker } from './tracker-config';
// Every guard below that DECLINES to write throws this rather than a bare
// `Error`, so the dispatch table's one structural test covers it: a deterministic
// refusal must never be reported as a retryable `rolled-back`.
import { RefusalError, TransientError } from './refusal';

// ─── the three outcomes ──────────────────────────────────────────────────────

/**
 * Three outcomes, no fourth.
 *
 * - `ok` — the write applied.
 * - `rolled-back` — it failed and every compensating write landed.
 * - `rollback-incomplete` — the unwind left something behind. **Never retryable.**
 *
 * The outcome does NOT settle retryability, and `rolled-back` on its own does
 * not mean "try again": a deterministic wire refusal unwinds perfectly cleanly.
 * `isRetryable` in `dispatch.ts` is the single answer, reported as
 * `DispatchResult.retryable` — read that, never the outcome (see #66).
 *
 * A pre-write refusal (scope lock, resolver, unknown intent) is deliberately not
 * an outcome here: it throws, so there is nothing to roll back and nothing to
 * report as a fourth state.
 */
export type TxOutcome = 'ok' | 'rolled-back' | 'rollback-incomplete';

/**
 * Something the unwind left behind, so a human can finish the cleanup.
 *
 * The two causes are distinct and stay distinct — a compensating write that
 * FAILED is a different problem from compensation deliberately SKIPPED because a
 * concurrent editor now owns that field.
 */
export interface Orphan {
  cause: 'compensation-failed' | 'compensation-skipped';
  /** The `cardId` the write landed on. */
  card: string;
  /**
   * The field as a caller names it: `columnId`, `tags`, `assignees`,
   * `dependencies`, `card`, `archived`, `name`, `description`, `dueDate`, or
   * `customField:<customFieldId>`.
   */
  field: string;
  /** What we wrote — the scalar, the delta element, the edge, or the created card. */
  wrote: unknown;
  /** What is live now. Present on a skip; absent when the compensating write failed. */
  live?: unknown;
  reason: string;
}

// ─── the one compare rule ────────────────────────────────────────────────────

/**
 * The shape a write took, which is the only thing that decides how it compares.
 * An op declares one of these; it never implements a comparison.
 */
export type WriteRecord =
  /** `create`. Nothing to compare: the card either exists or it is already gone. */
  | { shape: 'exempt' }
  /** One value replaced another. Compares strict equality. */
  | { shape: 'scalar'; wrote: unknown; before: unknown }
  /** Set membership changed. Compares per-element, on our own delta only. */
  | { shape: 'delta'; added: readonly string[]; removed: readonly string[] }
  /** One directional edge. Compares existence WITH direction. */
  | { shape: 'edge'; far: string; isBefore: boolean; created: boolean };

/** What the unwind is still allowed to write, after the compare. */
export type Restorable =
  | { shape: 'exempt' }
  | { shape: 'scalar' }
  /** Elements to un-add and to un-remove — never elements outside our own delta. */
  | { shape: 'delta'; unadd: string[]; unremove: string[] }
  | { shape: 'edge' };

/** One unit the compare refused to restore, and what is live in its place. */
export interface SkippedUnit {
  wrote: unknown;
  live: unknown;
}

/** The live edge to one far card, as the compare needs to see it. */
export interface LiveEdge {
  far: string;
  isBefore: boolean;
}

/**
 * The facade-wide rule, in exactly one place.
 *
 * @param record what the write did, in the shape it did it.
 * @param live what the detecting read found. Shape follows `record.shape`:
 *   the scalar value, the whole element set, or the live edge (`null` when the
 *   edge is absent).
 */
export function compareBeforeRestore(
  record: WriteRecord,
  live: unknown,
): { restorable?: Restorable; skipped: SkippedUnit[] } {
  switch (record.shape) {
    case 'exempt':
      return { restorable: { shape: 'exempt' }, skipped: [] };

    case 'scalar':
      // Still the value we wrote → nobody touched it, restore it. Anything else
      // means a concurrent editor owns this field now, and undoing our write
      // would clobber theirs.
      if (live === record.wrote) return { restorable: { shape: 'scalar' }, skipped: [] };
      return { skipped: [{ wrote: record.wrote, live }] };

    case 'delta': {
      const present = new Set(Array.isArray(live) ? (live as string[]) : []);
      // Per element, on our own delta. An element that already moved back on its
      // own needs no inverse — the inverse is idempotent per element, so a
      // divergence here can never clobber anyone, and dropping it silently is
      // honest rather than an orphan. Elements OUTSIDE our delta are never
      // touched: that is the whole reason this is not whole-field equality.
      const unadd = record.added.filter((e) => present.has(e));
      const unremove = record.removed.filter((e) => !present.has(e));
      if (unadd.length === 0 && unremove.length === 0) return { skipped: [] };
      return { restorable: { shape: 'delta', unadd, unremove }, skipped: [] };
    }

    case 'edge': {
      const edge = (live ?? null) as LiveEdge | null;
      const mine = { far: record.far, isBefore: record.isBefore };
      if (record.created) {
        // We added it. Absent already → the inverse is a no-op the wire will 404,
        // which counts as success. Present with OUR direction → delete it.
        // Present FLIPPED → someone reversed the pair, and direction is not part
        // of edge identity, so deleting it would remove their edge.
        if (edge === null || edge.isBefore === record.isBefore) return { restorable: { shape: 'edge' }, skipped: [] };
        return { skipped: [{ wrote: mine, live: edge }] };
      }
      // We removed it. Still absent → re-add it. Present again, either
      // direction → someone re-created the pair; re-adding ours would 403
      // ("Dependency already exists") or, worse, report the wrong direction.
      if (edge === null) return { restorable: { shape: 'edge' }, skipped: [] };
      return { skipped: [{ wrote: mine, live: edge }] };
    }
  }
}

// ─── the log ─────────────────────────────────────────────────────────────────

/** One reversible op, as the log holds it. Built by `TxCards`, never by hand. */
export interface CompensationEntry {
  card: string;
  field: string;
  record: WriteRecord;
  /** Terminal-ready wording for a preview or a report. */
  label: string;
  /** The DETECTING read. Never the source of the restore value. */
  readLive(): Promise<unknown>;
  /** The inverse write, given whatever the compare left restorable. */
  applyInverse(restorable: Restorable): Promise<void>;
}

/**
 * The thing we would undo is already undone.
 *
 * `favro-error.ts` is the ONE place not-found is decided, and it decides on the
 * MESSAGE — Favro's status says nothing, and its closed set is default-refuse
 * on purpose. The raw-404 arm below is the single documented exception, and it
 * is load-bearing rather than a fast path (#68):
 *
 *   `unlinkCard` is measured to answer `404 "Dependency not found"` once the
 *   edge is gone (see `CardsAPI.unlinkCard`), and that message is not in the
 *   closed set. That 404 is the ROUTINE case, not an exceptional one — the edge
 *   compare in `compareBeforeRestore` deliberately sends the inverse delete at
 *   an absent edge and counts the 404 as success. On the message alone it would
 *   classify `unknown`, so an ordinary concurrent removal would surface as a
 *   false `compensation-failed` orphan and downgrade a correct, retryable
 *   `rolled-back` to `rollback-incomplete`.
 *
 * The arm is scoped to the inverses this log applies, all of which are settled
 * `/cards/{cardId}` writes: `DELETE /cards/{id}`, `PUT /cards/{id}`,
 * `POST|DELETE /cards/{id}/dependencies[/{far}]`. A 404 on any of those means
 * the card or the edge is gone, which is what an inverse wants to hear. It is
 * NOT a general not-found rule and must not be copied elsewhere.
 *
 * If #58 widens the closed set to cover `Dependency not found`, this arm
 * becomes redundant and should go — `tx-cards-unwind-wire.test.ts` pins the
 * behaviour either way.
 */
function alreadyGone(error: unknown): boolean {
  // A 2xx denial is the compensating write being REFUSED, never evidence its
  // target is gone (#165). `202 {"message":"Access denied"}` classifies
  // `not-found` on its message — the same words a 403 uses for an absent
  // resource — so without this line an inverse Favro turned down was counted as
  // already-undone and the run reported `rolled-back` with no orphan: the one
  // place left where a 2xx denial reads as success, and it is inside the
  // rollback report. Keyed on the type, not the status, because the type is what
  // says the response was a 2xx that we chose to refuse.
  if (error instanceof WireRefusalError) return false;
  const status = (error as { response?: { status?: number } })?.response?.status;
  if (status === 404) return true;
  return classifyThrownError(error)?.kind === 'not-found';
}

function reasonFor(error: unknown): string {
  const classified = classifyThrownError(error);
  if (classified?.raw) return classified.raw;
  if (classified?.message) return classified.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * The compensation log. Owned by the dispatch table, never by an intent and
 * never by the skill engine — the engine opens one per run and threads it
 * through steps, which is what makes a failed multi-step skill unwind as a
 * whole, but it holds no rollback logic of its own.
 */
export class CompensationLog {
  private entries: CompensationEntry[] = [];

  push(entry: CompensationEntry): void {
    this.entries.push(entry);
  }

  /** How many reversible writes this transaction has made so far. */
  get depth(): number {
    return this.entries.length;
  }

  /** What this transaction would have to undo, newest first. For a preview. */
  describe(): string[] {
    return [...this.entries].reverse().map((e) => e.label);
  }

  /**
   * Unwind LIFO, best effort — one failed compensating write must not stop the
   * rest, because every remaining entry is another orphan if we give up.
   *
   * Every entry compares before restoring, per the facade-wide rule. The log is
   * emptied either way: what could not be undone is reported, not retried.
   */
  async unwind(): Promise<{ outcome: 'rolled-back' | 'rollback-incomplete'; orphans: Orphan[] }> {
    const orphans: Orphan[] = [];

    for (const entry of [...this.entries].reverse()) {
      try {
        const live = entry.record.shape === 'exempt' ? undefined : await entry.readLive();
        const { restorable, skipped } = compareBeforeRestore(entry.record, live);
        for (const unit of skipped) {
          orphans.push({
            cause: 'compensation-skipped',
            card: entry.card,
            field: entry.field,
            wrote: unit.wrote,
            live: unit.live,
            reason:
              `${entry.field} on card ${entry.card} changed after our write, so restoring it would ` +
              `clobber a concurrent edit. We wrote ${JSON.stringify(unit.wrote)}; it is now ` +
              `${JSON.stringify(unit.live)}. Left as-is deliberately.`,
          });
        }
        if (restorable) await entry.applyInverse(restorable);
      } catch (error) {
        // Already gone is already undone.
        if (alreadyGone(error)) continue;
        orphans.push({
          cause: 'compensation-failed',
          card: entry.card,
          field: entry.field,
          wrote: 'wrote' in entry.record ? entry.record.wrote : entry.record,
          reason: `restoring ${entry.field} on card ${entry.card} failed: ${reasonFor(error)}`,
        });
      }
    }

    this.entries = [];
    return {
      outcome: orphans.length > 0 ? 'rollback-incomplete' : 'rolled-back',
      orphans,
    };
  }
}

// ─── the ten reversible ops, plus one that is not ────────────────────────────

/** What `removeBlockingEdge` observed. `removed: false` means nothing was written. */
export interface EdgeRemoval {
  removed: boolean;
  /** The direction the removed edge had, so a caller can report it. */
  isBefore?: boolean;
}

/** What `addBlockingEdge` wrote. */
export interface EdgeAddition {
  links: CardLink[];
  isBefore: boolean;
}

const setDiff = (current: readonly string[], desired: readonly string[]) => ({
  added: desired.filter((id) => !current.includes(id)),
  removed: current.filter((id) => !desired.includes(id)),
});

/**
 * Every read an intent may make, and **not one write**.
 *
 * This is the surface a `readOnly: true` intent receives — see `Intent.run` in
 * `dispatch.ts`, which is a union of two arms precisely so that it can hand this
 * one out. It is what turns `readOnly` from a promise into a compile error: the
 * writes are not reachable through a `ReadTx`-typed `tx`, so an intent declaring
 * it writes nothing and then writing does not build (#107).
 *
 * That matters beyond tidiness. `readOnly` is what skips the boardless-write
 * refusal in `dispatch`, so an intent that declared it falsely would take the
 * exemption from the scope lock AND make the write it promised not to — the
 * promise being unenforceable was a hole in the lock itself.
 *
 * An INTERFACE rather than a base class. The ticket's shape was `TxCards extends
 * ReadTx`; `implements` buys the identical subtyping — a `TxCards` is a `ReadTx`
 * either way — without moving nine method bodies into a base or downgrading two
 * `private` fields to `protected` to keep them reachable.
 *
 * What `implements` buys, stated no wider than what it does. It catches drift in
 * ONE direction: a read here whose signature no longer matches the class stops
 * compiling, and it does so AT the class rather than remotely at `dispatch`'s two
 * `tx` arguments — measured, both with the clause and without it, and the drift is
 * caught either way because TypeScript is structural. It does NOT keep the two in
 * step the other way: a read added to `TxCards` and not listed here compiles clean
 * and is simply invisible to a `readOnly` intent (measured: zero errors). Six of
 * the nine reads below can also be deleted from this list with `tsc` clean, since
 * no intent reads them yet — narrowing, so fail-closed, but not guarded. Add a
 * read to the class and it belongs here too; nothing will remind you.
 */
export interface ReadTx {
  getCard(cardRef: string, options?: { include?: string[]; board?: string }): Promise<Card>;
  getCardLinks(cardRef: string): Promise<CardLink[]>;
  listCards(boardId: string): Promise<Card[]>;
  resolveCardId(cardRef: string, options?: { widgetCommonId?: string }): Promise<string>;
  resolveCardCommonId(cardRef: string, options?: { widgetCommonId?: string }): Promise<string>;
  resolveColumnId(value: string, boardId?: string): Promise<string>;
  resolveBoardId(board: string): Promise<string>;
  resolveAssignee(value: string): Promise<string>;
  customFieldWrite(fieldId: string, value: string): Promise<CustomFieldWriteValue>;
  tracker(): Promise<VerifiedTracker>;
  liveEdge(cardId: string, farId: string): Promise<LiveEdge | null>;
}

/**
 * The scalar text fields of a card: the two whose value is replaced wholesale and
 * whose write `CardsAPI.updateCard` already spells the way Favro honours.
 *
 * A CLOSED union, and that is a guard rather than tidiness — see `setText`.
 */
export type TextField = 'name' | 'description';

/**
 * The day part of a due date — the one space the WRITE shape and the READ shape
 * share. `PUT {dueDate: "2026-09-01"}` stores and echoes
 * `"2026-09-01T00:00:00.000Z"`, so string equality against the argument would call
 * a write that landed a write that did not (#106, §3.1 of the research note).
 * Absent and `null` both fold to `''`, which is what makes one comparison cover
 * setting and clearing alike.
 */
const dueDay = (value: string | null | undefined): string =>
  typeof value === 'string' ? value.slice(0, 10) : '';

/**
 * One custom field's stored value on a card, in the wire's own shape.
 *
 * Matched on `customFieldId` and never by position: whether the PUT echo carries
 * the card's WHOLE field set or only the entries the write touched is an open edge
 * (§4.2 of the research note), so a reader taking `[0]` could confirm this write
 * with a different field's value.
 *
 * `Card.customFields` is DECLARED as `CustomField[]` (`{fieldId, name, value,
 * type}`) and the wire sends `{customFieldId, value}` — `normalizeCard` passes the
 * raw array through under that name without mapping it. Both id spellings are read
 * rather than trusting the declared one.
 *
 * **All four value keys are read, not just `value`** — the same
 * `value ?? members ?? link ?? total` fallback `CustomFieldsAPI` used to read its
 * own PUT echo with, kept when that method was deleted (#109) rather than
 * re-derived. Only `value` on a `Single select`
 * is measured; the other three are what `custom-fields-api.ts` builds for
 * `Members`, `Link` and `Number` fields. Reading `value` alone was worse than
 * unmeasured, it was BLIND in one direction: a write to one of those types that
 * Favro honoured and echoed under its own key would read back `undefined`, and the
 * caller would be told the write did not take — a real mutation reported as no
 * mutation, and left off the compensation log. Reading a key is not asserting a
 * shape; refusing to read it is asserting its absence.
 */
function cardFieldValue(card: Card, fieldId: string): unknown {
  const entries = (card.customFields ?? []) as unknown as Array<Record<string, unknown>>;
  const found = entries.find((f) => (f.customFieldId ?? f.fieldId) === fieldId);
  return found?.value ?? found?.members ?? found?.link ?? found?.total;
}

/**
 * Which of the four payload keys a custom-field write spells. The field's TYPE
 * decides it, never the caller — `custom-fields-api.ts` owns that mapping and
 * `customFieldWrite` below is the only way to get one.
 *
 * Only `value`, on a `Single select`, is measured (#106). The other three are the
 * keys that module already builds for `Members`, `Link` and `Number` fields; they
 * are spelled here so routing those types through this facade keeps sending the
 * shape they were sent before, not because this path has probed them.
 */
export type CustomFieldKey = 'value' | 'members' | 'link' | 'total';

/** One custom-field value in the wire's own shape: which key, and what under it. */
export interface CustomFieldWriteValue {
  key: CustomFieldKey;
  value: unknown;
}

/**
 * The only card surface an intent gets: every read, and only instrumented
 * writes. Ten reversible ops, each declared once, capture + mutate + push fused
 * — plus THREE writes with no inverse, which log nothing and each say why:
 * `deleteCard`, `moveToBoard` and `commitToBoard`. Every one of the three is
 * called from an intent marked `terminal`, and must be the last write its `run`
 * makes.
 *
 * The `CardsAPI` is `private`, and an intent is handed neither a client nor a
 * config, so it cannot build one either. A raw un-instrumented write from an
 * intent is unrepresentable, not merely discouraged.
 */
export class TxCards implements ReadTx {
  /**
   * The `client` is held for the READS an intent cannot express through
   * `CardsAPI` — the tracker mapping and assignee resolution. It stays
   * `private`, and no method hands it out, so the guarantee that an intent
   * cannot build its own un-instrumented writer is unchanged.
   */
  constructor(
    private readonly api: CardsAPI,
    private readonly log: CompensationLog,
    private readonly client: FavroHttpClient,
  ) {}

  // ── reads (uninstrumented on purpose — a read has nothing to compensate) ──

  getCard(cardRef: string, options?: { include?: string[]; board?: string }): Promise<Card> {
    return this.api.getCard(cardRef, options);
  }

  getCardLinks(cardRef: string): Promise<CardLink[]> {
    return this.api.getCardLinks(cardRef);
  }

  /**
   * One board's cards, paginated to completion. `read`'s children listing is a
   * client-side pass over this: `parentCardId` is not a proven `GET /cards`
   * filter, and hierarchy is same-board only, so one board read answers it.
   *
   * **A board is REQUIRED, and empty REFUSES** (#107). `CardsAPI.listCards`
   * takes an absent board and then omits `widgetCommonId`, which paginates every
   * card in the ORGANISATION to completion — the unbounded whole-org sweep this
   * build refuses. Measured, not inferred: `boardIdOf` maps a falsy board to
   * `undefined` and the `if (boardId)` guard around `params.widgetCommonId` then
   * does not fire, so the request goes out as
   * `/cards?limit=100&archived=false&descriptionFormat=markdown` — no
   * `widgetCommonId` — and `getAllPages` reads it to the end.
   *
   * The type and the guard close different halves and NEITHER closes it alone.
   * Dropping `?` deletes `undefined` from the signature; `''` is still a
   * `string`, and `boardIdOf('')` is `undefined` too — so a future intent
   * spelling `tx.listCards(card.boardId ?? '')` would compile and sweep. The
   * refusal is what makes the sweep unreachable from this facade rather than
   * merely un-spellable one way.
   *
   * Unreachable from any caller today, on purpose: `read` refuses a boardless
   * card before it gets here, for a reason of its own (a fork has no children by
   * construction). This is the guard for the intents not yet written, which is
   * where the ticket said the value was.
   */
  // `async`, so the refusal below arrives as a REJECTION and not as a synchronous
  // throw out of a `Promise`-returning call. The rest of the facade's guards
  // (`setTags`, `setAssignees`) sit inside `async` methods and reject; a caller
  // writing `tx.listCards(x).catch(…)` would never see a sync throw.
  async listCards(boardId: string): Promise<Card[]> {
    if (!boardId) {
      throw new RefusalError(
        `Refusing to list cards with no board. An empty board id omits widgetCommonId, which reads ` +
          `every card in the organisation, paginated to completion — the unbounded sweep this build ` +
          `refuses.\n` +
          `Pass the board-resident instance's widgetCommonId. A card that has none is an assignment ` +
          `fork, and a fork is on no board to list.`,
      );
    }
    return this.api.listCards(boardId);
  }

  resolveCardId(cardRef: string, options?: { widgetCommonId?: string }): Promise<string> {
    return this.api.resolveCardId(cardRef, options);
  }

  resolveCardCommonId(cardRef: string, options?: { widgetCommonId?: string }): Promise<string> {
    return this.api.resolveCardCommonId(cardRef, options);
  }

  resolveColumnId(value: string, boardId?: string): Promise<string> {
    return this.api.resolveColumnId(value, boardId);
  }

  /**
   * A board NAME or id, settled to the `widgetCommonId` the lock and the wire
   * both want.
   *
   * Here because two intents take a board as an ARGUMENT rather than reading it
   * off a card (`move-board`, `add-board-instance`), and `board()` runs before
   * `assertScope` — which GETs `/widgets/{id}` and, handed a name, 404s into
   * "Board … not found", a refusal naming the wrong problem (#82).
   */
  resolveBoardId(board: string): Promise<string> {
    return new BoardsAPI(this.client).resolveBoardId(board);
  }

  /** One `userId`, from a name, an email, a `userId` or `@me`. One home (#42). */
  resolveAssignee(value: string): Promise<string> {
    return resolveAssignee(this.client, value);
  }

  /**
   * What a custom-field value looks like on the wire, resolved against the
   * field's OWN definition: an option name becomes `[optionId]`, a number
   * becomes a number, a date is validated, a link becomes `{url}`.
   *
   * A read — one `GET` for the definition, nothing written — so it is
   * uninstrumented like every other read here. It lives on the facade because an
   * intent is handed no client and cannot build a `CustomFieldsAPI` of its own,
   * and the resolution has to happen on the same side of the seam as the write:
   * `custom-fields set` used to resolve and PUT in one uninstrumented call.
   *
   * The KEY travels with the value because the field families spell it
   * differently, and `setFieldValue` has to send the same key back to undo the
   * write. Only `value` on a `Single select` is measured (#106) — see
   * `CustomFieldKey`.
   */
  async customFieldWrite(fieldId: string, value: string): Promise<CustomFieldWriteValue> {
    return new CustomFieldsAPI(this.client).fieldWrite(fieldId, value);
  }

  /**
   * The tracker mapping, verified against the board.
   *
   * Verified once per transaction: within one dispatch invocation a second
   * check buys nothing, and a mapped column that is gone REFUSES rather than
   * self-healing, so the answer cannot change mid-flight either way.
   */
  tracker(): Promise<VerifiedTracker> {
    this.verifiedTracker ??= (async () =>
      verifyTrackerMapping(this.client, await requireTrackerMapping()))();
    return this.verifiedTracker;
  }

  private verifiedTracker?: Promise<VerifiedTracker>;

  // ── 1. create ─────────────────────────────────────────────────────────────

  /**
   * `POST /cards` is one atomic validated call: a bad tag, assignee, column or
   * dependency target 403s the whole create with **no card created**. So the
   * composites need no compensation of their own and the compare is exempt —
   * but the card itself still gets an undo handle, which is what makes a
   * multi-create rollback possible.
   */
  async create(req: CreateCardRequest): Promise<Card> {
    const card = await this.api.createCard(req);
    this.log.push({
      card: card.cardId,
      field: 'card',
      record: { shape: 'exempt' },
      label: `delete card ${card.cardId} ("${card.name}")`,
      readLive: async () => undefined,
      applyInverse: async () => { await this.api.deleteCard(card.cardId); },
    });
    return card;
  }

  // ── 1b. deleteCard — the one IRREVERSIBLE op ──────────────────────────────

  /**
   * `DELETE /cards/{cardId}` — **pushes nothing onto the compensation log**, on
   * purpose. This is the only write on this facade with no inverse.
   *
   * A re-create is NOT an inverse. It would mint a new `cardId`, a new
   * `cardCommonId` and a new `sequentialId`, and it would not bring back the
   * comments, tasks, tasklists, attachments or dependency edges that hung off
   * the old card — none of which the log ever captured. An entry claiming to
   * undo this would make `rolled-back` a lie about the run.
   *
   * `{ shape: 'exempt' }` is NOT the shape to reuse here, tempting as it looks.
   * `exempt` means "skip the detecting read, the inverse is unconditionally
   * safe" — `create`'s inverse is a DELETE that 404s harmlessly when the card is
   * already gone (see `alreadyGone`). Delete has no such safe inverse; it has
   * none at all.
   *
   * Two consequences the callers must honour, both enforced in `dispatch.ts`:
   *
   *  1. `log.depth` is UNCHANGED by this call, so an intent that refuses after
   *     calling it would be misread as refusing *before* any write
   *     (`depthAtEntry` compare). The delete must therefore be the LAST thing an
   *     intent's `run` does — nothing after it may raise a `RefusalError`.
   *  2. ANY other step of a caller-threaded transaction that fails would unwind
   *     and report `rolled-back` while this card stays gone forever — whether
   *     that step ran before this one or after it. There is no fourth outcome to
   *     express that, so a delete intent is marked `terminal: true` and refuses
   *     the moment a caller-supplied log is present at all. Gating on
   *     `log.depth > 0` was the original condition and was WRONG in exactly the
   *     direction this call creates: the delete logs nothing, so depth stays 0
   *     and every write after it went unguarded.
   *
   * Instance-scoped: no `everywhere` query parameter, so this removes ONE board
   * instance and leaves every other instance of the same `cardCommonId` alone
   * (`docs/research/card-identifier-semantics.md` §2.1).
   *
   * @returns the `cardId` actually deleted, so a caller can report which
   *   instance went rather than echoing the reference it was handed.
   */
  async deleteCard(cardRef: string): Promise<string> {
    const cardId = await this.api.resolveCardId(cardRef);
    await this.api.deleteCard(cardId);
    return cardId;
  }

  // ── 2. moveColumn ─────────────────────────────────────────────────────────

  /**
   * Favro's UI "status" IS the column, and `PUT {status}` 200s and changes
   * nothing — so a move is a `columnId` write. Scalar shape: one value replaced
   * another, and strict equality is the honest guard.
   *
   * The write is READ BACK, like `setArchived` below — but the read is a fresh
   * `GET /cards/{cardId}`, never the PUT response, and that distinction is the
   * whole design rather than an extra cost (#101):
   *
   * - `columnId` on a card's GET row is MEASURED
   *   (`docs/research/tracker-contract-favro-carriers.md` §1.3), so a comparison
   *   against it asserts only a shape the wire has been observed to carry.
   * - `columnId` on a PUT **response** is measured on a SUCCESS and only there
   *   (2026-08-13, #162: the response agreed with a follow-up GET). What the
   *   response carries when the move is REFUSED is still unprobed, and on this
   *   endpoint a refusal is a 2xx — `202 {"message":"Access denied"}`, #162's own
   *   defect — so an echo comparison would be guarding against a failure shape
   *   nothing has observed. That is the half `setArchived` has and this does not:
   *   #75 probed `archived` on the write response, which is what lets it compare
   *   one. Swapping the re-read for the echo here would also throw on every
   *   `claim` and every `resolve` the day a response omits the field.
   *
   * The re-read also settles what an echo comparison could never be tested for:
   * a stand answering a PUT with a card row WE wrote verifies our own assumption
   * against itself. A silent PUT echo plus a GET row that moved is a case only
   * the re-read can pass, and that is the case the wire tests drive.
   *
   * Callers report the re-read too, because this returns it: `claim` and
   * `resolve` print an observation of the card rather than whatever the PUT
   * happened to echo. Reporting the echo was not merely unverified: on a response
   * that says nothing about the column, `cards-tracker.ts` prints `(column —)`
   * for a move that has in fact landed.
   */
  async moveColumn(cardRef: string, status: string): Promise<Card> {
    const before = await this.api.getCard(cardRef);
    const columnId = await this.api.resolveColumnId(status, before.boardId);
    const cardId = before.cardId;
    await this.api.updateCard(cardId, { columnId });
    const entry: CompensationEntry = {
      card: cardId,
      field: 'columnId',
      record: { shape: 'scalar', wrote: columnId, before: before.columnId },
      label: `move card ${cardId} back to column ${before.columnId}`,
      readLive: async () => (await this.api.getCard(cardId)).columnId,
      applyInverse: async () => { await this.api.updateCard(cardId, { columnId: before.columnId }); },
    };
    // Where the card reads NOW. `readLive` above asks the same question of the
    // same endpoint, so this read and the rollback's detecting read cannot
    // disagree about where the card is.
    //
    // Unlike `setArchived`'s read-back, this observation is a SEPARATE request,
    // so it has a failure mode that reading a PUT's own echo does not: the read
    // can fail while the write stands. "We could not look" is not "nothing was
    // written" — the PUT already answered a success status — so the entry goes in
    // and the unwind's own compare decides. It re-reads: our column still there means
    // restore it, anything else means report the concurrent edit. Dropping the
    // entry here instead reported `rolled-back` — which this facade defines as
    // the world being genuinely back where it was — for a card still sitting in
    // the new column, and for `claim` that also undid the assignment while
    // leaving the move, a state nobody asked for.
    let after: Card;
    try {
      after = await this.api.getCard(cardId);
    } catch (error) {
      this.log.push(entry);
      throw error;
    }
    // Checked BEFORE the log push, exactly as `setArchived` checks its own
    // read-back, and for the same reason: nothing here needs compensating.
    // Either the PUT wrote nothing, so there is nothing to undo — or a
    // concurrent editor moved the card after our write, and then the facade-wide
    // compare would decline to write over their edit anyway, so an entry would
    // only report an orphan for wreckage nobody has to clean up.
    //
    // Both of those are OBSERVATIONS that the card is not where we asked. What
    // this cannot tell apart from them is a read that answered from a stale
    // replica: nothing has measured read-after-write on this endpoint, so the
    // message names that possibility rather than declaring the other two
    // exhaustive (ADR-0003). In that third case the write did land and the entry
    // is skipped, which is the one direction here that is not fail-closed — it
    // needs a version carrier or a measured read-after-write to close, neither of
    // which exists.
    //
    // A fourth cause reaches here and is NOT transient: the clean-200 family
    // (#170) — fourteen rejected writes that answer 200 with a full entity and
    // no `message`, so #165's wire refusal cannot see them and only this
    // read-back catches them at all. That is why these five read-backs cannot
    // be removed as redundant now that the wire refuses denials: doing so
    // reopens #170 silently. Telling it apart from the two observations above
    // needs the same thing they do, so it is named rather than classified.
    //
    // `TransientError`, and NOT a `RefusalError`: a refusal claims
    // "deterministic, wrote nothing, repair the call", and the call is not what
    // is wrong — the column resolved and the write was accepted. What failed is
    // the card agreeing, so the next attempt is allowed to behave differently.
    //
    // That reading used to cover a fourth cause it had no right to: a DENIED
    // write. `PUT {columnId:<not on this board>}` answers `202 {"message":"Invalid
    // column"}`, which is deterministic and will refuse identically forever, and
    // this throw told an agent it was worth retrying. It no longer arrives —
    // `http-client` refuses a 2xx carrying a message before the PUT returns
    // (#165), `retryable: false` — so the three causes above are what is left,
    // and two of the three genuinely are transient. The check STAYS: nothing at
    // the wire can see a rejected write that answers a clean 200 with a full
    // entity and no effect (14 measured across the card-write surface), and on
    // the column path this re-read is what would catch one.
    if (after.columnId !== columnId) {
      throw new TransientError(
        `Column move on card ${cardId} was accepted with no denial message but the card did not land ` +
          `there: sent {columnId: ${columnId}}, and a re-read of the card reads ` +
          `columnId=${JSON.stringify(after.columnId)}.\n` +
          `Either the write did nothing, or another editor moved the card between the write and this ` +
          `read, or the read answered from behind the write — there is no version carrier on this wire ` +
          `to tell those apart. Nothing was logged for compensation: the first case has nothing to ` +
          `undo, and in the second the compare would decline to write over their edit.\n` +
          `The comparison is against the card's own GET row, which is where \`columnId\` is measured; ` +
          `the PUT response's echo is unprobed and is never read here (#101).`,
      );
    }
    // A state change nobody asked for, and it is FAVRO's, not ours (#168).
    // MEASURED live 2026-08-14 on the #105 board, `probe: #168 archive-move`:
    // archive a card (`PUT {archive:true}` → 200, `archived:true`, confirmed by a
    // GET), then `PUT {columnId, widgetCommonId}` → **200, no message, and the
    // WRITE'S OWN ECHO already reads `archived:false`**. So the un-archive is the
    // column write, not this read-back — the ticket's open question — and it is
    // invisible to #165's rule and to the `columnId` compare above, which passes
    // because the move genuinely landed.
    //
    // Reported, not fought: refusing the move would break `claim` and `resolve` on
    // an archived card, which no ticket asked for. Not a throw either — the
    // requested change DID happen.
    //
    // ponytail: stderr, because `DispatchResult` has no warnings channel and one
    // would have to be plumbed through `reportDispatch`, the human render and the
    // MCP shape. The upgrade, if an agent needs this in the JSON, is that channel —
    // or a compensation entry, so a later failure re-archives; `PUT {archive:true}`
    // after a move was measured to stick (200, `archived:true`) in the same run, so
    // the inverse is known to work. Until then this is on stderr and in
    // `favro help issue-tracker`, NOT in the machine envelope.
    if (before.archived === true && after.archived !== true) {
      console.warn(
        `⚠ Card ${cardId} was ARCHIVED and is now on the board again. Favro un-archives a card as a ` +
          `side effect of a column write — measured, and it is not something this move asked for ` +
          `(#168). The move itself landed. Re-archive with \`favro cards archive ${cardId}\` if the ` +
          `card was meant to stay off the board.`,
      );
    }
    this.log.push(entry);
    return after;
  }

  // ── 3. setTags ────────────────────────────────────────────────────────────

  /**
   * A whole-array `tags` PUT answers 200 and writes nothing; only
   * `addTagIds` / `removeTagIds` are honoured. `CardsAPI.tagReplacement` already
   * owns that diff (and the name/id keyspace), so it is reused rather than
   * re-derived — a second tag resolver here would be a defect.
   *
   * An entry the org does not know would go out as `addTags`, which is a tag
   * *creation* — refused here, exactly as `cards create` refuses it, so a typo
   * never invents a tag on a permissive key. The wording comes from
   * `unknownTagMessage` rather than a copy, so this refusal and the create /
   * update ones cannot drift (#62).
   */
  async setTags(cardRef: string, desired: string[]): Promise<Card> {
    const before = await this.api.getCard(cardRef);
    const delta = await this.api.tagReplacement(before, desired);
    const invented = delta.addTags ?? [];
    if (invented.length > 0) throw new RefusalError(unknownTagMessage(invented));
    const added = delta.addTagIds ?? [];
    const removed = delta.removeTagIds ?? [];
    const cardId = before.cardId;
    if (added.length === 0 && removed.length === 0) return before;

    const after = await this.api.updateCard(cardId, {
      ...(added.length > 0 ? { addTagIds: added } : {}),
      ...(removed.length > 0 ? { removeTagIds: removed } : {}),
    });
    this.log.push({
      card: cardId,
      field: 'tags',
      record: { shape: 'delta', added, removed },
      label: `restore tags on card ${cardId} (${before.tagIds?.join(', ') || 'none'})`,
      readLive: async () => (await this.api.getCard(cardId)).tagIds ?? [],
      applyInverse: async (restorable) => {
        if (restorable.shape !== 'delta') return;
        await this.api.updateCard(cardId, {
          ...(restorable.unadd.length > 0 ? { removeTagIds: restorable.unadd } : {}),
          ...(restorable.unremove.length > 0 ? { addTagIds: restorable.unremove } : {}),
        });
      },
    });
    return after;
  }

  // ── 4. setAssignees ───────────────────────────────────────────────────────

  /**
   * `assignees` is a silent no-op on both verbs and `assignmentIds` is one on
   * PUT; only `add`/`removeAssignmentIds` are honoured, which is also the only
   * way an assignment can be REMOVED. Takes `userId`s: a name here would diff as
   * "unassign everyone, add a string Favro has never seen".
   */
  async setAssignees(cardRef: string, desired: string[]): Promise<Card> {
    const notIds = desired.filter((v) => !isUserId(v));
    if (notIds.length > 0) {
      throw new RefusalError(
        `setAssignees takes userIds, got ${notIds.map((v) => `"${v}"`).join(', ')}. ` +
          `A whole-array assignee write is diffed against the card's current userIds, so a name would ` +
          `unassign everyone. Resolve names first with resolveAssignees().`,
      );
    }
    const before = await this.api.getCard(cardRef);
    const cardId = before.cardId;
    const current = before.assignees ?? [];
    const { added, removed } = setDiff(current, desired);
    if (added.length === 0 && removed.length === 0) return before;

    const after = await this.api.updateCard(cardId, {
      ...(added.length > 0 ? { addAssignmentIds: added } : {}),
      ...(removed.length > 0 ? { removeAssignmentIds: removed } : {}),
    });
    this.log.push({
      card: cardId,
      field: 'assignees',
      record: { shape: 'delta', added, removed },
      label: `restore assignees on card ${cardId} (${current.join(', ') || 'none'})`,
      readLive: async () => (await this.api.getCard(cardId)).assignees ?? [],
      applyInverse: async (restorable) => {
        if (restorable.shape !== 'delta') return;
        await this.api.updateCard(cardId, {
          ...(restorable.unadd.length > 0 ? { removeAssignmentIds: restorable.unadd } : {}),
          ...(restorable.unremove.length > 0 ? { addAssignmentIds: restorable.unremove } : {}),
        });
      },
    });
    return after;
  }

  // ── 5. addBlockingEdge ────────────────────────────────────────────────────

  /**
   * Favro has one directional edge, `isBefore`, describing the far card relative
   * to the card queried — so "blocked by X" is X before us.
   *
   * The pre-state is "absent by construction": an existing pair answers
   * `403 Dependency already exists` and nothing is written, so no entry is
   * pushed. The edge shape compares existence WITH direction, because direction
   * is not part of edge identity: a duplicate, a flipped write and both from the
   * mirror end all answer the byte-identical 403.
   */
  async addBlockingEdge(cardRef: string, blockedByRef: string): Promise<EdgeAddition> {
    const cardId = await this.api.resolveCardId(cardRef);
    const farId = await this.api.resolveCardId(blockedByRef);
    const links = await this.api.linkCard(cardId, { toCardId: farId, isBefore: true });
    this.log.push({
      card: cardId,
      field: 'dependencies',
      record: { shape: 'edge', far: farId, isBefore: true, created: true },
      label: `remove the blocking edge ${farId} → ${cardId}`,
      readLive: () => this.liveEdge(cardId, farId),
      applyInverse: async () => { await this.api.unlinkCard(cardId, farId); },
    });
    return { links, isBefore: true };
  }

  // ── 6. removeBlockingEdge ─────────────────────────────────────────────────

  /**
   * `unlinkCard` is verified: 204, then 404 once the edge is gone, from either
   * end. The direction is CAPTURED before the delete — it is the only thing that
   * makes the edge restorable, and reading it back afterwards is impossible.
   */
  async removeBlockingEdge(cardRef: string, blockedByRef: string): Promise<EdgeRemoval> {
    const cardId = await this.api.resolveCardId(cardRef);
    const farId = await this.api.resolveCardId(blockedByRef);
    const existing = await this.liveEdge(cardId, farId);
    // Nothing there: nothing written, nothing to undo. Not an error — a caller
    // retrying after a failed run must be able to reach `ok`.
    if (existing === null) return { removed: false };

    await this.api.unlinkCard(cardId, farId);
    const isBefore = existing.isBefore;
    this.log.push({
      card: cardId,
      field: 'dependencies',
      record: { shape: 'edge', far: farId, isBefore, created: false },
      label: `re-add the edge between ${cardId} and ${farId} (isBefore=${isBefore})`,
      readLive: () => this.liveEdge(cardId, farId),
      applyInverse: async () => { await this.api.linkCard(cardId, { toCardId: farId, isBefore }); },
    });
    return { removed: true, isBefore };
  }

  // ── 7. setArchived ────────────────────────────────────────────────────────

  /**
   * Move a card across the archive line, either way.
   *
   * The write field is **`archive`**; the field a card reads **back** is
   * `archived`, and `PUT {archived: …}` answers 200 and writes nothing (#75, and
   * see `UpdateCardRequest.archive` for the full probe). So the capture reads
   * `archived` and the mutate sends `archive`. They are not interchangeable, and
   * forwarding the read-side spelling would be a green write that changed
   * nothing.
   *
   * Scalar shape: one boolean replaced another, so strict equality is the honest
   * guard. There is still no version carrier on this wire, so a human who moves
   * the card across the line between our write and the detecting read makes the
   * compensating write SKIPPED rather than applied — the facade-wide rule,
   * inherited rather than restated.
   *
   * The prior value is CAPTURED, never assumed to be `false`: un-archiving a card
   * that was archived must unwind back to **archived**.
   *
   * Already on the requested side → nothing is written and nothing is logged,
   * exactly as `setTags` / `setAssignees` treat an empty delta. That keeps a
   * retry after a failed run able to reach `ok` without a pointless PUT.
   *
   * The write is READ BACK, which the rest of the silent-no-op family does not
   * have to do: `status`, `assignees` and whole-array `tags` are defended by
   * TRANSLATING the write into the verb Favro honours, and there is no
   * translation available here — `archive` already IS the honoured spelling, so
   * the only remaining defence is observing the result. It costs nothing: the PUT
   * response echoes `archived` (see `UpdateCardRequest.archive`), so the
   * observation is already in hand.
   */
  async setArchived(cardRef: string, archived: boolean): Promise<Card> {
    const before = await this.api.getCard(cardRef);
    const cardId = before.cardId;
    const was = before.archived === true;
    if (was === archived) return before;

    const after = await this.api.updateCard(cardId, { archive: archived });
    // Checked BEFORE the log push, and it throws rather than refusing.
    //
    // Before the push because a mismatch means the PUT wrote NOTHING — there is
    // nothing to compensate, and an entry here would send an inverse that writes
    // nothing either and then orphan on the compare, reporting wreckage that
    // does not exist.
    //
    // `TransientError`, and NOT a `RefusalError`: a refusal claims
    // "deterministic, wrote nothing, repair the call", and the call is not what
    // is wrong. This is a probed field no longer being honoured — the world is
    // genuinely unchanged, so the next attempt is allowed to behave differently.
    //
    // The marker is load-bearing, not decoration. `retryAdvice` gates on the WIRE
    // now, at all three of its callers, so an unmarked in-process `Error` reads
    // `retryable: false`; this is the one in-process failure in the intent
    // closure that has an observation behind calling it transient, so it is the
    // one exemption. A bare `Error` here would tell an agent not to retry a write
    // that the very next attempt might land.
    //
    // Absent normalises to false, exactly as the capture above does. The two
    // must agree about the same card, and `Card.archived` is optional.
    //
    // "a SUCCESS status", not "200", here and at the two sibling read-backs
    // (`setText`, `setDueDate`) — #162 item 10 bullet 1. Favro is measured to
    // answer a write `202`: `favro custom-fields set` came back `202` with the
    // reason in the body, live on the #105 board (#165). That one was a REFUSAL,
    // and a message-carrying 2xx is classified as one before it reaches this
    // check — so what arrives here is a clean 2xx whose code nothing observed,
    // and 200 was a number this message invented. The status is not threaded out
    // of the write seam; interpolating the observed one is the upgrade if a caller
    // ever needs to tell 200 from 202 here.
    if ((after.archived === true) !== archived) {
      throw new TransientError(
        `Archive write on card ${cardId} answered a SUCCESS status but did not take: sent ` +
          `{archive: ${archived}}, the response reads archived=${JSON.stringify(after.archived)}.\n` +
          `Nothing was written, so nothing needs undoing. The write field \`archive\` is probed ` +
          `honoured in both directions (#75); the read-side \`archived\` spelling is the one that ` +
          `200s and does nothing, so if a caller-side change started sending that, this is where it ` +
          `surfaces.`,
      );
    }
    this.log.push({
      card: cardId,
      field: 'archived',
      record: { shape: 'scalar', wrote: archived, before: was },
      label: `${was ? 're-archive' : 'un-archive'} card ${cardId}`,
      readLive: async () => (await this.api.getCard(cardId)).archived === true,
      applyInverse: async () => { await this.api.updateCard(cardId, { archive: was }); },
    });
    return after;
  }

  // ── 8. setText ────────────────────────────────────────────────────────────

  /**
   * Replace one of a card's scalar text fields — its `name` or its
   * `description`.
   *
   * **THE TWO FIELDS DO NOT CARRY THE SAME GUARANTEE, and that is the first thing
   * to know about this method.** `setText(card, 'name', …)` throws when the write
   * did not take. `setText(card, 'description', …)` cannot, and never will on this
   * wire — see the read-back section below. A caller that treats a returned card as
   * proof the body changed is wrong in a way the `name` path is not.
   *
   * ONE method for the two of them rather than a `setName` / `setDescription`
   * pair, and #106 measured them apart rather than together, so this is a choice
   * and not an equivalence. Three things now differ by field: which key the payload
   * spells, which key the echo is read from, and the read-back guard, which fires
   * for `name` only. Everything else — the capture, the empty-write short-circuit,
   * the compensation entry, the inverse — is one body. Splitting would move the one
   * `if` into a private shared body and hang two public names off it; the divergence
   * would still be there, one level down, and the union that keeps a caller off
   * `status` / `tags` / `assignees` (below) would have to be re-argued at two call
   * sites instead of one. The fusion is worth exactly one comparison, and this
   * paragraph is where it is paid for.
   *
   * **The field is a CLOSED union, and that is the guard.** A general
   * `setScalar(cardRef, field, value)` would also accept `status`, `tags` and
   * `assignees` — the three fields whose whole-value PUT answers 200 and writes
   * nothing — and would hand back a green write that changed nothing, which is the
   * silent-wrong-answer class this facade exists to close. Those three have
   * primitives of their own above, each of which TRANSLATES the write into the verb
   * Favro honours rather than forwarding the spelling a caller reached for.
   *
   * `description` needs no translation here because `CardsAPI.updateCard` already
   * applies it: the honoured write field is `detailedDescription`, `PUT
   * {description}` is a measured silent no-op, and `mapDescription` rewrites the key
   * on the way out. A card reads the value back under `description`, normalised from
   * `detailedDescription` by `normaliseCard`, so the capture and the inverse both
   * spell it the read-side way and the API layer owns the asymmetry exactly once.
   *
   * **`name` IS read back; `description` cannot be.** Both were probed live in
   * #106 (`docs/research/card-write-field-semantics.md` §1–§2), and the two
   * answers came out different:
   *
   * - `name` — the PUT echo carries it **byte-for-byte**. Padding survives,
   *   markdown syntax is stored literally, nothing is trimmed. So strict equality
   *   against the echo asserts a measured shape, and this throws on a 200 that did
   *   not take, exactly as `setArchived` does on `archived`.
   * - `description` — the round trip is **lossy**. `-` list markers come back as
   *   `*`, a blank line appears between list items, a fence's info string is
   *   dropped, and a zero-width space is injected after every `[`. A strict
   *   read-back would throw on every markdown write that in fact landed, so there
   *   is none. The write is confirmed only by the caller reporting what came back.
   *
   * **A weaker description detector exists and is DECLINED, on a live false
   * positive rather than on the impossibility above.** The short-circuit means the
   * value always differs from what the card held, so `stored === was` at the throw
   * site would mean the PUT moved nothing at all — the `PUT {description}` silent
   * no-op that only `mapDescription` currently prevents. It is a real detector for
   * a real regression. It is not installed because Favro's canonicalisation makes
   * it fire on landed writes too: a caller writing `- one` at a card already
   * holding `* one` sends a value that differs from the stored one, gets a write
   * that lands, and reads back `stored === was`. Throwing there would break exactly
   * the markdown a `-`-bullet author writes. The regression it would catch is
   * covered where it belongs, by `mapDescription`'s own tests; a guard that refuses
   * correct writes to catch a defect one layer down is not a trade this facade
   * makes.
   *
   * **The compensation record holds what the wire STORED, not what we asked for.**
   * That distinction is invisible for `name` (they are the same string) and
   * load-bearing for `description`: `compareBeforeRestore` tests `live ===
   * record.wrote`, so recording the argument would compare our markdown against
   * Favro's canonicalised copy, decline the restore, and report a
   * `compensation-skipped` orphan on a card nobody else had touched — turning a
   * correct `rolled-back` into `rollback-incomplete`. The echo is measured to equal
   * what a following GET returns, so recording it makes the compare hold.
   *
   * **What the inverse cannot promise.** Writing a captured description back
   * produces a THIRD string (the ZWSP-bearing brackets pick up backslash escapes),
   * converging only on the pass after that. Favro has no write that restores a
   * description byte-exactly. The undo puts the body back semantically and this is
   * as close as the wire allows — recorded rather than papered over.
   *
   * Already holding the requested value → nothing written and nothing logged,
   * exactly as `setTags` / `setAssignees` / `setArchived` treat an empty delta.
   *
   * An absent prior value restores as `''`, never as `undefined`: the inverse has to
   * WRITE something, and `mapDescription` drops an `undefined` description from the
   * payload entirely, so an entry claiming to clear a description would quietly do
   * nothing and then orphan on the compare. `name` is always present on a card, so
   * only `description` reaches that arm — where empty IS the honest restore of "no
   * description". Measured: Favro stores `''` as `"\n"`, and since the record holds
   * the echo rather than the argument, that normalisation is inside the compare
   * rather than a permanent mismatch against it.
   */
  async setText(cardRef: string, field: TextField, value: string): Promise<Card> {
    const before = await this.api.getCard(cardRef);
    const cardId = before.cardId;
    const was = before[field];
    if (was === value) return before;
    // Spelled out per field rather than as a computed key: `UpdateCardRequest` is
    // the type that keeps a caller off the silent-no-op fields, and a computed key
    // would widen the payload back to `Record<string, unknown>`.
    const payload = (v: string) => (field === 'name' ? { name: v } : { description: v });

    const after = await this.api.updateCard(cardId, payload(value));
    // What the PUT echoed, in the space `getCard` reads it back in.
    // `CardsAPI.updateCard` returns the PUT body RAW — it does not run
    // `normalizeCard`, the way `getCard` and `moveCard` do — so a description
    // arrives under the wire's own `detailedDescription` and never under the
    // read-side `description` alias. Both spellings are read rather than betting on
    // which layer normalises, so this cannot go silently blind either way it moves.
    const stored =
      (field === 'name'
        ? after.name
        : ((after.detailedDescription ?? after.description) as string | undefined)) ?? '';
    // Checked BEFORE the log push, for `setArchived`'s reason: nothing here needs
    // compensating that we could compensate. `TransientError` for its reason too —
    // the call is not what is wrong, so the next attempt may behave differently, and
    // an unmarked in-process `Error` would report `retryable: false`.
    if (field === 'name' && stored !== value) {
      // `setArchived` can say "nothing was written" outright because `archived` is
      // two-valued: an echo that is not what we sent can only be what was there.
      // `name` has an unbounded domain, so a third value means something DID get
      // written and this throw is leaving it unlogged. Rare, and not worth guessing
      // about in the message.
      throw new TransientError(
        `Name write on card ${cardId} answered a SUCCESS status but did not take: sent ${JSON.stringify(value)}, ` +
          `the response reads name=${JSON.stringify(stored)}.\n` +
          (stored === (was ?? '')
            ? `The card still reads what it read before, so nothing was written and nothing needs undoing.`
            : `The card reads a THIRD value — neither what we sent nor what it held ` +
              `(${JSON.stringify(was ?? '')}). Something was written, and nothing was logged for it, so ` +
              `this transaction cannot unwind that change. Read the card before retrying.`) +
          `\nThe echo is probed byte-exact for this field (#106) — no trimming and no markdown ` +
          `parsing — so a mismatch is a real difference and not a normalisation.`,
      );
    }
    this.log.push({
      card: cardId,
      field,
      record: { shape: 'scalar', wrote: stored, before: was ?? '' },
      label: `restore ${field} on card ${cardId}`,
      readLive: async () => (await this.api.getCard(cardId))[field] ?? '',
      applyInverse: async () => { await this.api.updateCard(cardId, payload(was ?? '')); },
    });
    return after;
  }

  // ── 9. setDueDate ─────────────────────────────────────────────────────────

  /**
   * Set the card's due date, or clear it with `null`.
   *
   * Probed live in #106 (`docs/research/card-write-field-semantics.md` §3); the
   * measurements this method is built on, and what each one buys:
   *
   * - **`""` is a silent no-op** — 200, and the card keeps the date it had. It is
   *   the natural spelling for "clear this" out of a CSV cell or an empty flag, so
   *   it is REFUSED here rather than forwarded, the way `setAssignees` refuses a
   *   name. A refusal, not a throw after the fact: nothing has been written yet and
   *   the call is what needs repairing.
   * - **`null` clears**, and the echo then carries no `dueDate` key at all. That is
   *   the only measured clear, which is why the parameter is `string | null` rather
   *   than `string | undefined` — `undefined` would drop out of the JSON payload
   *   and write nothing.
   * - **a date-only write is NORMALISED on the way in**: `"2026-09-01"` stores and
   *   echoes `"2026-09-01T00:00:00.000Z"`. So the read-back compares on the DAY.
   *   Strict equality against the argument would report every date-only write as a
   *   write that did not take.
   * - **a full ISO timestamp is honoured too, and echoed verbatim.** That is what
   *   makes the inverse sound: the captured pre-state is an ISO string, and an ISO
   *   string is a legal write. Before this measurement the field was left out of
   *   the `update` intent for exactly that reason (see the seam note in
   *   `dispatch.ts`) — an undo handle that may not undo.
   *
   * Scalar shape, and the record holds the STORED value rather than the argument,
   * for `setText`'s reason: the compare is `live === record.wrote`, and after a
   * date-only write those two are only the same string if the normalisation is
   * recorded.
   *
   * The no-write short-circuit is strict equality and deliberately NOT the day
   * compare. Two instants on the same day are a real difference, and skipping that
   * write would be a silent no-op of our own — the class this facade exists to
   * close. Re-writing a value the card already holds costs one idempotent PUT.
   */
  async setDueDate(cardRef: string, dueDate: string | null): Promise<Card> {
    if (dueDate === '') {
      throw new RefusalError(
        `setDueDate takes a date or null, and got an empty string. \`PUT {dueDate: ""}\` is a ` +
          `measured silent no-op — 200, and the card keeps the date it had (#106) — so forwarding ` +
          `it would report a clear that never happened.\n` +
          `Pass null to clear the date, or "YYYY-MM-DD" / a full ISO timestamp to set one.`,
      );
    }
    // Refused BEFORE the request, not interpreted after it (#168). Measured live
    // 2026-08-14 on the #105 board: `PUT {dueDate: "2026-02-30"}` answers 200 with
    // no message and stores `2026-03-02T00:00:00.000Z` — so the caller gets a card
    // dated two days past anything they typed, and no 2xx rule can see it. The
    // read-back below DOES catch it (`dueDay` compares the digits), but it catches
    // it as a `TransientError`, and `favro help issue-tracker` tells an agent to
    // obey `retryable` — which would retry an impossible date forever. A refusal
    // is the honest classification: the same call fails the same way every time.
    //
    // Only the DAY needs guarding. `2026-13-01` and `not-a-date` answer
    // `202 {"message":"Invalid date"}` and write nothing, which #165's rule already
    // turns into a refusal (`card-predicates.ts` carries both measurements).
    if (dueDate !== null && isImpossibleDate(dueDate)) {
      throw new RefusalError(
        `${JSON.stringify(dueDate)} is not a date that exists. Favro does not refuse it: ` +
          `\`PUT {dueDate: "2026-02-30"}\` answers 200 and stores 2026-03-02 — measured — so ` +
          `forwarding this would set a due date two days past the one you asked for.\n` +
          `Pass a real calendar date, or null to clear it.`,
      );
    }
    const before = await this.api.getCard(cardRef);
    const cardId = before.cardId;
    const was = (before.dueDate as string | undefined) ?? null;
    if (was === dueDate) return before;

    const after = await this.api.updateCard(cardId, { dueDate });
    const stored = (after.dueDate as string | undefined) ?? null;
    if (dueDay(stored) !== dueDay(dueDate)) {
      // Same reasoning as `setText`'s guard: a date has an unbounded domain, so an
      // echo that is neither what we sent nor what was there means something WAS
      // written and this throw is leaving it unlogged. Only the equal case can
      // honestly claim nothing happened.
      throw new TransientError(
        `Due-date write on card ${cardId} answered a SUCCESS status but did not take: sent ` +
          `{dueDate: ${JSON.stringify(dueDate)}}, the response reads ` +
          `dueDate=${JSON.stringify(stored)}.\n` +
          (stored === was
            ? `The card still reads the date it read before, so nothing was written and nothing needs undoing.`
            : `The card reads a THIRD value — neither what we sent nor what it held ` +
              `(${JSON.stringify(was)}). Something was written, and nothing was logged for it, so this ` +
              `transaction cannot unwind that change. Read the card before retrying.`) +
          `\nThe comparison is on the DAY, because a date-only write is measured to come back as a ` +
          `full ISO timestamp (#106); a mismatch here is a different day, not that normalisation.`,
      );
    }
    this.log.push({
      card: cardId,
      field: 'dueDate',
      record: { shape: 'scalar', wrote: stored, before: was },
      label: `restore the due date on card ${cardId} (${was ?? 'none'})`,
      readLive: async () => ((await this.api.getCard(cardId)).dueDate as string | undefined) ?? null,
      applyInverse: async () => { await this.api.updateCard(cardId, { dueDate: was }); },
    });
    return after;
  }

  // ── 10. setFieldValue ─────────────────────────────────────────────────────

  /**
   * Set one custom field's value on a card.
   *
   * **Measured on ONE field type — `Single select` — and nothing here generalises
   * to the others** (#106, `docs/research/card-write-field-semantics.md` §4). The
   * #105 scratch board carries exactly one enabled custom field and Favro exposes
   * no verb to create another, so `Text`, `Number`, `Date`, `Members`, `Link`,
   * `Checkbox`, `Multiple select`, `Tags` and `Timeline` are unprobed on this path.
   * `value` is `unknown` rather than `string` because of that: the wire shape is
   * per type (`custom-fields-api.ts` builds four different payload keys), and
   * narrowing it here would be asserting the three shapes nobody measured.
   *
   * What was measured:
   *
   * - `{customFieldId, value: [optionId]}` is **honoured**, and the PUT echo
   *   carries the stored value back under the same `customFieldId`. So this throws
   *   on a 200 that did not take.
   * - Three ways to get it wrong — an empty array on a select, an unknown
   *   `customFieldId`, a bare string where the select wants an array — each answer
   *   **`202` with a `message` and NO card row**, and nothing is written. `202` is
   *   a success to axios, so the status cannot be the signal; the missing row is.
   *   That family is refused one layer down, by `CardsAPI.updateCard`, because
   *   `UpdateCardRequest.customFields` is a door other callers will come through
   *   too — so it never reaches the compare below.
   * - **A select has no measured spelling for "clear"** — `value: []` is one of the
   *   three 202s. So a write to a field that had NO prior value has no inverse, and
   *   the entry's `applyInverse` says that out loud instead of sending a write
   *   measured to do nothing. The unwind then reports a `compensation-failed`
   *   orphan, which is the honest answer: something was left behind.
   *
   * **What the remaining throw can and cannot claim.** Past the seam refusal, a
   * mismatch means the response WAS a card row and the field still does not read
   * what we sent. Nine of the ten field types are unmeasured here, so the honest
   * report is that what the wire did is **unobserved** — not that nothing was
   * written. Nothing is logged either way, and the message says so, because a
   * compensation entry built on an unread value would send an inverse nobody can
   * predict. The likeliest cause is a type whose stored shape is not the one we
   * sent; `cardFieldValue` already reads all four payload keys so that a `Members`,
   * `Link` or `Number` echo is not mistaken for silence.
   *
   * Scalar shape, compared as JSON. The stored value is an ARRAY for a select, and
   * the facade's scalar compare is `live === record.wrote` — two structurally equal
   * arrays are never `===`, so an un-serialised record would decline every restore
   * and orphan every rollback. Serialising is the one-line fix that keeps the
   * compare rule itself untouched; `applyInverse` closes over the real prior value,
   * so nothing is restored from the serialisation.
   *
   * `key` says which of the four payload keys the field's type spells, and
   * defaults to the one measured spelling. It exists because `custom-fields set`
   * routes through here (#109) and already sent `members` / `link` / `total` for
   * three of the types; forcing those onto `value` would have been a silent change
   * of wire shape on three paths nobody has probed. The read-back reads all four
   * keys either way (`cardFieldValue`), and the inverse sends the value back under
   * the same key it was written with.
   */
  async setFieldValue(
    cardRef: string,
    fieldId: string,
    value: unknown,
    key: CustomFieldKey = 'value',
  ): Promise<Card> {
    // A computed key, cast once: `CustomFieldWrite` is a CLOSED shape whose four
    // value keys have four different types, and `CustomFieldKey` is exactly its
    // key set, so the cast widens nothing a caller could not already spell.
    const write = (v: unknown) => ({ customFieldId: fieldId, [key]: v } as CustomFieldWrite);
    const before = await this.api.getCard(cardRef);
    const cardId = before.cardId;
    const was = cardFieldValue(before, fieldId);
    // Already holding it → nothing written and nothing logged, exactly as every
    // sibling op treats an empty delta. Compared as JSON for the reason the record
    // is: the stored value is an array for a select. This also catches `value`
    // arriving as `undefined` on a field that has none — which would otherwise log
    // an entry whose `applyInverse` is guaranteed to throw.
    if (JSON.stringify(was) === JSON.stringify(value)) return before;

    const after = await this.api.updateCard(cardId, { customFields: [write(value)] });
    const stored = cardFieldValue(after, fieldId);
    // Checked BEFORE the log push: an entry built on a value we could not read
    // would send an inverse nobody can predict.
    //
    // The measured failure family — 202, a message, no card row — never reaches
    // here; `http-client`'s success interceptor refuses it at the wire (#165 —
    // it was `CardsAPI.updateCard`'s own `customFields` guard until then, and the
    // move is why that guard is gone). So this arm is the
    // UNMEASURED one, and it must not borrow the other's certainty: the response
    // was a card row, the field does not read what we sent, and nine of the ten
    // field types are unprobed on this path. `TransientError`, because a
    // deterministic rejection is what the seam already caught, and what is left has
    // no observation behind calling it permanent.
    if (JSON.stringify(stored) !== JSON.stringify(value)) {
      throw new TransientError(
        `Custom field write on card ${cardId} answered with a card row that does not carry what we ` +
          `sent: {customFieldId: ${fieldId}, value: ${JSON.stringify(value)}}, and the field reads ` +
          `${JSON.stringify(stored)}.\n` +
          `**Whether anything was written is UNOBSERVED** — this is not the measured ` +
          `202-and-nothing-happened case, which is refused before it gets here. Nothing was logged ` +
          `for compensation, so if the write did land this transaction cannot unwind it: read the ` +
          `card before retrying.\n` +
          `Only \`Single select\` is measured on this path (#106). The likeliest cause is a field ` +
          `type that stores a shape other than the one it was sent.`,
      );
    }
    this.log.push({
      card: cardId,
      field: `customField:${fieldId}`,
      record: { shape: 'scalar', wrote: JSON.stringify(stored), before: JSON.stringify(was) },
      label: `restore custom field ${fieldId} on card ${cardId} (${JSON.stringify(was) ?? 'unset'})`,
      readLive: async () => JSON.stringify(cardFieldValue(await this.api.getCard(cardId), fieldId)),
      applyInverse: async () => {
        if (was === undefined) {
          throw new Error(
            `custom field ${fieldId} on card ${cardId} had no value before this write, and Favro has ` +
              `no measured way to clear one — \`value: []\` answers 202 "Invalid status value" and ` +
              `writes nothing (#106). The value we set is still there.`,
          );
        }
        await this.api.updateCard(cardId, { customFields: [write(was)] });
      },
    });
    return after;
  }

  // ── 11/12. the two board-instance writes, neither with an inverse ─────────

  /**
   * Move ONE card to another board — `PUT /cards/{cardId} {widgetCommonId}`, the
   * write behind `cards move`.
   *
   * **Pushes nothing onto the compensation log**, and the intent that calls it is
   * `terminal` for that reason. Which reason, exactly, because there are two on
   * offer and only one of them holds:
   *
   *  - NOT "the pre-state is unavailable". It is available and it is free:
   *    `move-board`'s `board()` already reads the card, so `boardId` AND
   *    `columnId` are both in hand before the write. Capturing them would cost
   *    nothing, and an earlier draft of this comment implied otherwise.
   *  - The reason is that **restoring a column after a cross-board move is
   *    UNMEASURED**. `moveColumn` is a measured inverse *within* a board; where a
   *    card lands when it arrives back on its origin board, and whether the old
   *    `columnId` is still writable on it, is not something anything here has
   *    observed. So an inverse would restore the board and guess at the column,
   *    while `rolled-back` claims the world is back where it was. There is no
   *    fourth outcome to tell that truth with, so the composition is refused
   *    instead.
   *
   * Nothing here is a claim that a move cannot be undone by hand — `favro cards
   * move` the other way is right there. It is a claim that this facade cannot
   * undo it and say `rolled-back` honestly. Probe the return move on the #105
   * scratch board and this becomes a real compensation entry.
   *
   * So the caller must honour `deleteCard`'s two consequences: this must be the
   * LAST thing an intent's `run` does (a `RefusalError` after it would be misread
   * as pre-write, since `log.depth` is unchanged), and the intent is `terminal`.
   *
   * The echo is MEASURED (#161): a landed move answers with the destination
   * board, so `moveCard` reads its own write back and throws on a mismatch. This
   * adds no read of its own and logs nothing either way — a throw from there is
   * either a denial that wrote nothing or a write whose landing is unknown, and
   * neither has an inverse this facade could run.
   */
  async moveToBoard(cardRef: string, toBoard: string): Promise<Card> {
    return this.api.moveCard(cardRef, { toBoardId: toBoard });
  }

  /**
   * Give a card a board instance it did not have — `PUT /cards/{cardId}
   * {widgetCommonId, dragMode:'commit'}`, the write behind `widgets add`.
   *
   * The same endpoint as `moveToBoard`, and NOT the same write: `dragMode:
   * 'commit'` ADDS the instance and leaves every existing one alone, where a move
   * takes the card off the board it was on. Two names because mis-selecting one
   * for the other silently removes a card from a board.
   *
   * This is the fork factory. A card's `boardId` is its `widgetCommonId`, and the
   * boardless card `dispatch` refuses writes to is a card with no instance at all;
   * this is the write that manufactures one, which is why it belongs inside the
   * table rather than beside it.
   *
   * **Pushes nothing onto the compensation log**, and again the reason is worth
   * naming precisely rather than gesturing at the echo. The inverse would be
   * deleting the instance this commit created, which needs that instance's own
   * `cardId`:
   *
   *  - The PUT's echo is unprobed (`CommittedWidget.widgetCommonId` is optional
   *    for that reason), so the id cannot be read off the response. That alone is
   *    only an argument about the ECHO — a follow-up `GET /widgets?cardCommonId=`
   *    would name the new instance, and it is one request.
   *  - The reason terminal HOLDS is the write itself: `DELETE /cards/{cardId}` is
   *    the only removal available, and `deleteCard` next door records why that is
   *    not an inverse of a create — it takes the comments, tasks and tasklists
   *    hanging off the `cardCommonId` with it if it is the last instance, and none
   *    of that was ever captured. An "undo" that can destroy more than it made is
   *    not one.
   *
   * The intent is `terminal`, and this must be the last write its `run` makes.
   */
  async commitToBoard(board: string, cardCommonId: string, columnId?: string): Promise<CommittedWidget> {
    return new WidgetsAPI(this.client).addWidgetToBoard(board, cardCommonId, columnId);
  }

  /**
   * The one edge between two cards, from `cardId`'s point of view, or `null`.
   *
   * There is at most one edge per pair — undirected identity, directed
   * semantics. An inlined edge carries only `cardCommonId`, one read from
   * `/dependencies` carries `cardId`; take whichever is there rather than faking
   * the ambiguous reverse lookup.
   *
   * Public because `add-blocking-edge`'s pre-read asks exactly this question,
   * and its answer has to be the same one the rollback's detecting read gets —
   * a second edge reader would be a second definition of "the edge is there".
   */
  async liveEdge(cardId: string, farId: string): Promise<LiveEdge | null> {
    const links = await this.api.getCardLinks(cardId);
    const found = links.find((l) => l.cardId === farId || l.cardCommonId === farId);
    return found ? { far: farId, isBefore: found.isBefore } : null;
  }
}

export default TxCards;
