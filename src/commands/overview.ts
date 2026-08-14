/**
 * `favro overview` — PM/PO Persona: Collection-level dashboard
 * v2.0 LLM-first command: outputs JSON by default.
 */
import { Command } from 'commander';
import { AggregateCard } from '../api/aggregate';
import { Unreachable } from '../lib/read-shape';
import { Ctx, run } from '../lib/run';

interface BoardSummary {
  name: string;
  totalCards: number;
  stageDistribution: Record<string, number>;
}

interface DueSummary {
  overdue: number;
  dueThisWeek: number;
  dueNextWeek: number;
  noDueDate: number;
}

export interface OverviewResult {
  scope: string;
  boardCount: number;
  totalCards: number;
  boards: BoardSummary[];
  stageDistribution: Record<string, number>;
  topBlockers: Array<{ id: string; title: string; board?: string; blockingCount: number }>;
  /**
   * Everything this report could not reach, from BOTH sources, in one list:
   *
   *   - blockers named by a fetched card that are not themselves in the fetched
   *     set, so their rank could not be judged (`findTopBlockers`);
   *   - facets of the snapshot itself that failed to read (#148), which is why a
   *     board's cards can be counted under stage `unknown` below.
   *
   * The second used to be dropped on the floor here (#149). That made this key's
   * own promise false: an absent `unreachable` is documented to mean "there
   * genuinely are none", and a collection with a dark board emitted no marker
   * while `stageDistribution.unknown` quietly held thirteen cards. Bucketing them
   * as `unknown` was already the honest half — the envelope was the dishonest one.
   *
   * Present only when there are any, so absent stays distinguishable from empty
   * (`read-shape.ts` rule 3).
   *
   * The KEY is `unreachable`, not `unreachableBlockers` (#86): an agent parses
   * one marker across every command, and this shipped under a name none of them
   * looked for.
   */
  unreachable?: Unreachable[];
  dueSummary: DueSummary;
  generatedAt: string;
}

function computeDueSummary(cards: AggregateCard[]): DueSummary {
  const now = Date.now();
  const oneWeek = 7 * 24 * 60 * 60 * 1000;
  const twoWeeks = 14 * 24 * 60 * 60 * 1000;

  let overdue = 0, dueThisWeek = 0, dueNextWeek = 0, noDueDate = 0;

  for (const card of cards) {
    if (!card.due) { noDueDate++; continue; }
    const dueMs = new Date(card.due).getTime();
    if (isNaN(dueMs)) { noDueDate++; continue; }
    const diff = dueMs - now;
    if (diff < 0) overdue++;
    else if (diff <= oneWeek) dueThisWeek++;
    else if (diff <= twoWeeks) dueNextWeek++;
  }

  return { overdue, dueThisWeek, dueNextWeek, noDueDate };
}

/**
 * The cards blocking the most other cards, plus the blockers we could not judge.
 *
 * Counting comes FIRST, over every edge, and resolution second — blocking edges
 * are not board-scoped, so a blocker can easily live outside the fetched set,
 * and the most impactful blocker in a workspace is plausibly exactly the one
 * that spans boards. Resolving before counting dropped those silently (#69),
 * which conflates "no blockers" with "we could not check". They come back as
 * `unreachable` instead, in the `read-shape.ts` vocabulary.
 *
 * The counts are a LOWER BOUND for every blocker, reachable or not: an edge from
 * a card outside the fetch was never seen at all. That is inherent to a bounded
 * snapshot; naming the holes is what stops it being a lie.
 *
 * The holes carry `read-shape.ts`'s `Unreachable` type under its canonical key
 * (#86), but they are built here rather than through `boundedSweep`. That is
 * deliberate: the sweep caps *per-item wire calls*, and this read makes none —
 * it ranks over a snapshot already fetched. Every hole is known the moment the
 * id misses the index, so there is nothing to attempt, nothing to cap, and no
 * reason for `SWEEP_CAP` to overwrite a true cause with "not attempted". The
 * ids are ranked most-blocking-first.
 */
export function findTopBlockers(
  cards: AggregateCard[],
  count: number = 5,
): { topBlockers: OverviewResult['topBlockers']; unreachable: Unreachable[] } {
  // Distinct blocked CARDS per blocker, not edges. Since #167 item 3 the
  // snapshot carries one row per board instance, so a card sitting on two boards
  // states its `blockedBy` twice — and an edge tally would report a blocker as
  // blocking two cards when it blocks one card that happens to live on two
  // boards. Every other number in this report is a partition of the instance set
  // and counts instances on purpose; `blockingCount` is a statement about work
  // items, so it is the one that has to collapse them.
  //
  // `commonId` is the card across its instances (`AggregateCard.commonId`); `id`
  // is a `cardId` and stands in only for a row that arrived without one, where
  // one-row-one-card is the best available reading.
  const blockedCards = new Map<string, Set<string>>();
  for (const card of cards) {
    for (const blockerId of card.blockedBy ?? []) {
      const blocked = blockedCards.get(blockerId) ?? new Set<string>();
      blocked.add(card.commonId ?? card.id);
      blockedCards.set(blockerId, blocked);
    }
  }
  const blockedCount = new Map([...blockedCards].map(([id, blocked]) => [id, blocked.size] as const));

  // `blockedBy` holds `cardCommonId`s — `blockingEdges` reports the
  // board-independent id, and since #162 that is a CHOICE: an inlined edge
  // carries `cardId` too. `id` here is the `cardId`, so matching on it misses.
  const byCommonId = new Map(cards.filter(c => c.commonId).map(c => [c.commonId!, c]));

  const ranked = [...blockedCount].sort((a, b) => b[1] - a[1]);

  const topBlockers: OverviewResult['topBlockers'] = [];
  const outsideFetch: string[] = [];

  for (const [blockerId, n] of ranked) {
    const blocker = byCommonId.get(blockerId);
    if (!blocker) {
      outsideFetch.push(blockerId);
      continue;
    }
    if (topBlockers.length < count) {
      topBlockers.push({
        id: blocker.id,
        title: blocker.title,
        board: blocker.boardName,
        blockingCount: n,
      });
    }
  }

  // Built directly, not through `boundedSweep`: this read makes no per-item
  // calls. Every hole is already known — the id is absent from the fetched set
  // — so there is nothing to attempt and nothing to cap. Routing it through the
  // sweep would replace these true reasons with "not attempted" past
  // `SWEEP_CAP`, and this list runs to hundreds. `read-shape.ts`'s cap counts
  // wire calls; zero calls means the cap has nothing to say here.
  const unreachable: Unreachable[] = outsideFetch.map(blockerId => ({
    id: blockerId,
    reason:
      `blocks ${blockedCount.get(blockerId)} card(s) in this scope, but the blocking card is ` +
      `outside the fetched set (blocking edges are not board-scoped), so it could not be ` +
      `ranked or named.`,
  }));

  return { topBlockers, unreachable };
}

/** How many unreachable blockers the human render names before summarising. */
const UNREACHABLE_HUMAN_LIMIT = 5;

export function formatHuman(data: OverviewResult): string {
  const lines: string[] = [];
  lines.push(`Overview — ${data.scope}`);
  lines.push(`  Boards: ${data.boardCount}  Cards: ${data.totalCards}\n`);

  lines.push('  Stage Distribution:');
  for (const [stage, count] of Object.entries(data.stageDistribution)) {
    const pct = data.totalCards > 0 ? Math.round((count / data.totalCards) * 100) : 0;
    lines.push(`    ${stage}: ${count} (${pct}%)`);
  }

  lines.push('\n  Due Dates:');
  lines.push(`    Overdue: ${data.dueSummary.overdue}`);
  lines.push(`    Due this week: ${data.dueSummary.dueThisWeek}`);
  lines.push(`    Due next week: ${data.dueSummary.dueNextWeek}`);

  if (data.topBlockers.length > 0) {
    lines.push('\n  Top Blockers:');
    for (const b of data.topBlockers) {
      lines.push(`    • ${b.title} — blocking ${b.blockingCount} card(s) (${b.board})`);
    }
  }

  if (data.unreachable?.length) {
    // Never let the ranking above read as complete when it is not — but the
    // count in this header is what carries that, not the lines under it. Across
    // ~20 boards cross-board edges are routine and this list runs to hundreds of
    // ~150-char lines that differ only in an id and a number, drowning a ranking
    // of five. Shown at the ranking's own horizon; the rest is a remainder, and
    // the DEFAULT JSON output still carries every one for a machine reader —
    // this formatter runs only under `--human` (ADR-0002).
    const all = data.unreachable;
    // "item(s) this report could not reach", not "blocker(s) outside this
    // scope": since #149 this list also carries the snapshot's own failed
    // facets, and the old header would have described a dark board as a
    // blocker. Each entry states its own kind in its `reason`.
    lines.push(`\n  Not covered — ${all.length} item(s) this report could not reach:`);
    for (const u of all.slice(0, UNREACHABLE_HUMAN_LIMIT)) {
      lines.push(`    • ${u.id} — ${u.reason}`);
    }
    if (all.length > UNREACHABLE_HUMAN_LIMIT) {
      lines.push(`    … +${all.length - UNREACHABLE_HUMAN_LIMIT} more (drop --human for all)`);
    }
  }

  return lines.join('\n');
}

interface OverviewOptions {
  collection?: string;
}

export async function overviewHandler(ctx: Ctx, options: OverviewOptions) {
  let snapshot;
  let scope: string;
  if (options.collection) {
    snapshot = await ctx.api.aggregate.getCollectionSnapshot(options.collection);
    scope = options.collection;
  } else if (ctx.config.scopeCollectionId) {
    snapshot = await ctx.api.aggregate.getMultiBoardSnapshot({ collectionIds: [ctx.config.scopeCollectionId] });
    scope = ctx.config.scopeCollectionName ?? ctx.config.scopeCollectionId;
  } else {
    snapshot = await ctx.api.aggregate.getMultiBoardSnapshot({});
    scope = 'all collections';
  }

  // Board summaries
  const boardMap = new Map<string, AggregateCard[]>();
  for (const card of snapshot.allCards) {
    const bName = card.boardName ?? 'Unknown';
    if (!boardMap.has(bName)) boardMap.set(bName, []);
    boardMap.get(bName)!.push(card);
  }

  const boards: BoardSummary[] = Array.from(boardMap.entries()).map(([name, cards]) => {
    const dist: Record<string, number> = {};
    for (const c of cards) {
      const stage = c.stage ?? 'unknown';
      dist[stage] = (dist[stage] ?? 0) + 1;
    }
    return { name, totalCards: cards.length, stageDistribution: dist };
  });

  // Overall stage distribution
  const stageDistribution: Record<string, number> = {};
  for (const card of snapshot.allCards) {
    const stage = card.stage ?? 'unknown';
    stageDistribution[stage] = (stageDistribution[stage] ?? 0) + 1;
  }

  const blockers = findTopBlockers(snapshot.allCards);

  // What a hole does to `overview`: the cards STAY and are counted under stage
  // `unknown`, and the hole is now named in the envelope (#149).
  //
  // Keeping them is right and was never the defect: `overview` is a census, its
  // buckets are `Record<string, number>` and `unknown` is an honest bucket name,
  // so unlike `health`/`workload`/`stale` nothing here silently re-reads a
  // missing stage as "not done". Dropping them would make `totalCards` disagree
  // with the collection for no gain.
  //
  // The defect was the envelope: this key already existed, already meant "and
  // here is what we could not reach", and carried only the blocker holes — so an
  // agent that correctly read an absent marker as "nothing was missed" was told
  // that while `unknown` held every card of a board whose columns read had failed.
  //
  // Snapshot holes go FIRST. `formatHuman` prints five entries and summarises the
  // rest, and a cross-board blocker list runs to hundreds — appending would have
  // pushed the one hole that explains the `unknown` bucket past the horizon in
  // human mode, which is the same JSON-only reporting #117 measured on `risks`.
  const unreachable = [...(snapshot.unreachable ?? []), ...blockers.unreachable];

  const result: OverviewResult = {
    scope,
    boardCount: boards.length,
    totalCards: snapshot.allCards.length,
    boards,
    stageDistribution,
    topBlockers: blockers.topBlockers,
    ...(unreachable.length > 0 ? { unreachable } : {}),
    dueSummary: computeDueSummary(snapshot.allCards),
    generatedAt: new Date().toISOString(),
  };

  return { item: result, human: formatHuman };
}

export function registerOverviewCommand(program: Command): void {
  program
    .command('overview')
    .description('Collection-level dashboard with stage distribution (LLM-first JSON)')
    .option('--collection <name>', 'Filter to a specific collection')
    .action(run(overviewHandler));
}

export default registerOverviewCommand;
