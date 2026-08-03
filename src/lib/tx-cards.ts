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
 * is unconstructible from inside an intent.
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
import CardsAPI, { Card, CardLink, CreateCardRequest, unknownTagMessage } from './cards-api';
import FavroHttpClient from './http-client';
import { classifyThrownError } from './favro-error';
import { isUserId } from './users-api';
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
  /** The field as a caller names it: `columnId`, `tags`, `assignees`, `dependencies`, `card`. */
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

// ─── the seven reversible ops, plus one that is not ──────────────────────────

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
 * The only card surface an intent gets: every read, and only instrumented
 * writes. Seven reversible ops, each declared once, capture + mutate + push fused
 * — plus `deleteCard`, the one write with no inverse, which logs nothing and
 * says why.
 *
 * The `CardsAPI` is `private`, and an intent is handed neither a client nor a
 * config, so it cannot build one either. A raw un-instrumented write from an
 * intent is unrepresentable, not merely discouraged.
 */
export class TxCards {
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
   */
  listCards(boardId?: string): Promise<Card[]> {
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

  /** One `userId`, from a name, an email, a `userId` or `@me`. One home (#42). */
  resolveAssignee(value: string): Promise<string> {
    return resolveAssignee(this.client, value);
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
   * The write is deliberately NOT read back, unlike `setArchived` below. That
   * asymmetry is a measurement gap, not an oversight (#101). `setArchived`
   * compares because #75 probed that the `PUT {archive}` **response** echoes
   * `archived`; nothing equivalent has ever been probed for `columnId`. The
   * carrier table measures `columnId` on every GET row
   * (`docs/research/tracker-contract-favro-carriers.md` §1.3) — a read-side row
   * is not a write-side echo, and inferring one from the other is the step
   * ADR-0003 refuses. Getting it wrong is not cheap: if the response omits the
   * field, `after.columnId` is `undefined` on every move and the guard throws on
   * every `claim` and every `resolve` — two commands that work today.
   *
   * The stand cannot settle it. `dispatch-tx-wire.test.ts` answers a PUT with a
   * full card row because WE wrote it that way, so a read-back tested there
   * verifies our own assumption against itself. Only a live probe closes this,
   * blocked on #105's throwaway board — the same gate as #126.
   *
   * What defends the move meanwhile: `columnId` is not a member of the
   * silent-no-op family, it is the honoured verb that family is TRANSLATED INTO,
   * and callers report `moved.columnId` — the observed value, never the
   * requested one — so a no-op surfaces as the old column rather than as a
   * fabricated success.
   */
  async moveColumn(cardRef: string, status: string): Promise<Card> {
    const before = await this.api.getCard(cardRef);
    const columnId = await this.api.resolveColumnId(status, before.boardId);
    const after = await this.api.updateCard(before.cardId, { columnId });
    const cardId = before.cardId;
    this.log.push({
      card: cardId,
      field: 'columnId',
      record: { shape: 'scalar', wrote: columnId, before: before.columnId },
      label: `move card ${cardId} back to column ${before.columnId}`,
      readLive: async () => (await this.api.getCard(cardId)).columnId,
      applyInverse: async () => { await this.api.updateCard(cardId, { columnId: before.columnId }); },
    });
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
    if ((after.archived === true) !== archived) {
      throw new TransientError(
        `Archive write on card ${cardId} answered 200 but did not take: sent ` +
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
