/**
 * Is a blocker still blocking? (#47)
 *
 * Favro has exactly ONE dependency edge — `isBefore`, describing the far card
 * relative to the card queried — and `GET /cards` inlines it whole: the same
 * `{cardId, isBefore, cardCommonId, reverseCardId}` that
 * `/cards/:id/dependencies` returns, measured byte-identical on 2026-08-13
 * (#162). So "what blocks this card" is free: it arrives with the
 * card. What is NOT free is "is that blocker finished", because **Favro has no
 * board-independent completion signal**: no `completed`, no `status`, no `state`
 * on any card; `assignments[].completed` is per person; and `position` is
 * monotone but rightmost is not done on 2 of 4 measured boards, so
 * position-as-progress ranks a blocked card above a finished one.
 *
 * Hence the only rule that can be stated honestly:
 *
 *   - On the tracker board, a blocker is done when it sits in the **mapped
 *     `done` column** (`tracker init`'s two columnIds).
 *   - Off the tracker board, `archived` alone decides.
 *   - Anything we could not read still blocks.
 *
 * That is wrong in **one direction only** — over-blocking. A frontier that hides
 * a takeable ticket costs a turn; a frontier that offers a blocked one costs a
 * wrong write.
 *
 * The per-blocker read deliberately **omits the `archived` param**, because
 * Favro's default list INCLUDES archived cards — which is what lets an archived
 * blocker resolve free instead of reading as unreachable.
 */
import FavroHttpClient from './http-client';
import type { Card } from './cards-api';
import CardReferenceResolver, { type CardInstance } from './card-reference';
import { boundedSweep, Unreachable } from './read-shape';
import { readTrackerMapping } from './tracker-config';
import { blockersOf, blockedByThis } from './query-parser';

/**
 * Which blockers are finished, and which could not be looked at.
 *
 * `done` is a whitelist of proof, never an assumption: an id absent from it
 * blocks, whether because it is genuinely open or because the read failed.
 * `unreachable` is what tells those two apart — `0 blockers` and `couldn't check
 * blockers` demand opposite next moves.
 */
export interface BlockerJudgement {
  /** `cardCommonId`s proved done. */
  done: ReadonlySet<string>;
  unreachable: Unreachable[];
}

const NOTHING: BlockerJudgement = { done: new Set(), unreachable: [] };

/**
 * The far-end ids of a card's edges, split by direction — as `cardCommonId`s.
 *
 * Both shapes carry both ids: `GET /cards` inlines an edge byte-identically to
 * `/cards/:id/dependencies`, `{cardId, isBefore, cardCommonId, reverseCardId}`
 * (measured 2026-08-13, #162). So this is a CHOICE, not a fallback, and the
 * choice is `cardCommonId` for two reasons:
 *
 *   - it is the id every consumer already indexes on. `findTopBlockers`
 *     (`commands/overview.ts`) builds its index from `AggregateCard.commonId`
 *     and looks these ids up in it; `judgeBlockers` below keys its `done` set
 *     the same way. Reporting a `cardId` here would miss both indexes and read
 *     as "blocker outside the fetch" rather than as an error;
 *   - it is board-independent. A `cardId` names one board instance of a card
 *     that may have several, so two edges onto the same card from different
 *     boards would count as two different blockers.
 *
 * `cardId` is the fallback only, for an edge that arrived without the common id.
 */
export function blockingEdges(card: Card): { blockedBy: string[]; blocking: string[] } {
  const farId = (l: { cardId?: string; cardCommonId?: string }) => l.cardCommonId ?? l.cardId;
  const ids = (links: Array<{ cardId?: string; cardCommonId?: string }>) =>
    links.map(farId).filter((id): id is string => Boolean(id));
  return { blockedBy: ids(blockersOf(card)), blocking: ids(blockedByThis(card)) };
}

/**
 * Judge every blocker referenced by `cards` in as few calls as possible.
 *
 * Blockers that are themselves among `cards` cost nothing — the one-call
 * frontier is the whole point. The rest go through `boundedSweep`, so the 20-cap
 * and the honest-failure marker are parked in one place rather than re-decided
 * here.
 */
export async function judgeBlockers(
  cards: readonly Card[],
  client: FavroHttpClient,
): Promise<BlockerJudgement> {
  const wanted = new Set<string>();
  for (const card of cards) {
    for (const link of blockersOf(card)) {
      const id = link.cardCommonId ?? link.cardId;
      if (id) wanted.add(String(id));
    }
  }
  if (wanted.size === 0) return NOTHING;

  // A malformed tracker block refuses here rather than being read as "no
  // tracker" — a mapping nobody can parse must not silently downgrade the rule.
  const tracker = await readTrackerMapping();
  const trackerBoard = tracker?.mapping.boardId;
  const doneColumn = tracker?.mapping.columns.done;

  // What the board fetch happens to contain is a PARTIAL view of each blocker:
  // one board's instances, filtered by whatever `--archived` said. It is not the
  // card.
  const inFetch = new Map<string, CardInstance[]>();
  for (const card of cards) {
    const id = card.cardCommonId;
    if (!id || !wanted.has(id)) continue;
    inFetch.set(id, [...(inFetch.get(id) ?? []), card as unknown as CardInstance]);
  }

  const done = new Set<string>();
  const toSweep: string[] = [];
  for (const id of wanted) {
    const found = inFetch.get(id);
    if (found === undefined) {
      toSweep.push(id);
      continue;
    }
    // A partial view may prove done only via the **tracker column**: that
    // instance declares the verdict, so no unseen instance can overturn it.
    if (provenByTrackerColumn(found, trackerBoard, doneColumn)) {
      done.add(id);
      continue;
    }
    // The `archived` branch cannot be trusted on a partial view: `--archived all`
    // on one board shows an archived instance of a blocker that is still live
    // elsewhere, and clearing on that evidence UNDER-blocks — the one direction
    // this predicate may never be wrong in. So confirm it against the complete
    // set. A partial *not-done* verdict needs no confirmation and costs nothing,
    // which is why the common case (every blocker in the fetch, none archived)
    // still makes zero extra calls.
    if (isFinished(found, trackerBoard, doneColumn)) toSweep.push(id);
  }

  const references = new CardReferenceResolver(client);
  const swept = await boundedSweep(toSweep, async (id) => {
    // The resolver's own query, not a second copy of it — `unique: true` and the
    // `?? []` live in one place now (#123). `resolve` is the wrong door: it picks
    // ONE instance and refuses ambiguity, and every instance is evidence here.
    //
    // No `archived` param: Favro's default INCLUDES archived cards, and an
    // archived blocker is exactly the one that must resolve free.
    const entities = await references.query({ cardCommonId: id });
    if (entities.length === 0) {
      // A 200 carrying nothing is not evidence: a deleted blocker, a blocker
      // invisible to this key, and a `cardId` queried as a `cardCommonId` all
      // answer exactly this. The card stays blocked either way — but it has to
      // land in `unreachable`, which is the only thing that tells "no blockers"
      // apart from "couldn't check blockers".
      throw new Error(
        `blocker ${id} is missing, or not visible to your key — Favro returned no card for it`,
      );
    }
    return { id, entities };
  });
  for (const row of swept.rows) {
    if (isFinished(row.entities, trackerBoard, doneColumn)) done.add(row.id);
  }
  return { done, unreachable: swept.unreachable };
}

/** The only done-proof a partial instance set is allowed to supply. */
function provenByTrackerColumn(
  found: CardInstance[],
  trackerBoard: string | undefined,
  doneColumn: string | undefined,
): boolean {
  if (!trackerBoard) return false;
  const tracked = found.filter((i) => i.widgetCommonId === trackerBoard);
  return tracked.length > 0 && tracked.every((i) => i.columnId === doneColumn);
}

/**
 * A blocker's verdict across every instance of it we can see.
 *
 * A forked card — an assignment entity with no `widgetCommonId` — has no column
 * and cannot answer the question, so it is dropped. If the tracker board holds
 * an instance, that instance rules: the tracker is where open/closed is
 * declared. Otherwise `archived` is all there is.
 */
function isFinished(
  found: CardInstance[],
  trackerBoard: string | undefined,
  doneColumn: string | undefined,
): boolean {
  const onBoard = found.filter((i) => Boolean(i.widgetCommonId));
  if (onBoard.length === 0) return false;

  const tracked = trackerBoard ? onBoard.filter((i) => i.widgetCommonId === trackerBoard) : [];
  if (tracked.length > 0) return tracked.every((i) => i.columnId === doneColumn);

  return onBoard.every((i) => i.archived === true);
}
