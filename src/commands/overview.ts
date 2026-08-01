/**
 * `favro overview` — PM/PO Persona: Collection-level dashboard
 * v2.0 LLM-first command: outputs JSON by default.
 */
import { Command } from 'commander';
import { createFavroClient } from '../lib/client-factory';
import { readConfig } from '../lib/config';
import AggregateAPI, { AggregateCard } from '../api/aggregate';
import { outputResult, resolveFormat } from '../lib/output';
import { boundedSweep, Unreachable } from '../lib/read-shape';
import { logError } from '../lib/error-handler';

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
   * Blockers named by a fetched card that are not themselves in the fetched
   * set, so their rank could not be judged. Present only when there are any:
   * an absent `unreachable` with an empty `topBlockers` means there genuinely
   * are none, which is the distinction `read-shape.ts` exists to keep.
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
 * The holes are built by `boundedSweep` rather than by hand (#86), the same way
 * `judgeBlockers` builds its own: blockers already in the fetch resolve free,
 * the rest go through the sweep, and the cap and the marker wording are decided
 * in `read-shape.ts` rather than re-decided here. The sweep's `perItemCall` has
 * no wire to reach for — this read is over a snapshot already fetched — so it
 * resolves from the snapshot index and throws when the id is not in it, which is
 * exactly the hole. Past `SWEEP_CAP` the sweep supplies its own reason; the
 * ids are swept most-blocking-first so the ones that carry the edge count are
 * the ones that matter most.
 */
export async function findTopBlockers(
  cards: AggregateCard[],
  count: number = 5,
): Promise<{ topBlockers: OverviewResult['topBlockers']; unreachable: Unreachable[] }> {
  const edgeCount = new Map<string, number>();
  for (const card of cards) {
    for (const blockerId of card.blockedBy ?? []) {
      edgeCount.set(blockerId, (edgeCount.get(blockerId) ?? 0) + 1);
    }
  }

  // `blockedBy` holds `cardCommonId`s — that is all an inlined edge carries —
  // while `id` is the `cardId`. Matching on `id` never hit.
  const byCommonId = new Map(cards.filter(c => c.commonId).map(c => [c.commonId!, c]));

  const ranked = [...edgeCount].sort((a, b) => b[1] - a[1]);

  const topBlockers: OverviewResult['topBlockers'] = [];
  const toSweep: string[] = [];

  for (const [blockerId, n] of ranked) {
    const blocker = byCommonId.get(blockerId);
    if (!blocker) {
      toSweep.push(blockerId);
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

  const swept = await boundedSweep(toSweep, async (blockerId) => {
    const blocker = byCommonId.get(blockerId);
    if (!blocker) {
      throw new Error(
        `blocks ${edgeCount.get(blockerId)} card(s) in this scope, but the blocking card is ` +
        `outside the fetched set (blocking edges are not board-scoped), so it could not be ` +
        `ranked or named.`,
      );
    }
    return blocker;
  });

  return { topBlockers, unreachable: swept.unreachable };
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
    // `--json` still carries every one for a machine reader.
    const all = data.unreachable;
    lines.push(`\n  Not ranked — ${all.length} blocker(s) outside this scope:`);
    for (const u of all.slice(0, UNREACHABLE_HUMAN_LIMIT)) {
      lines.push(`    • ${u.id} — ${u.reason}`);
    }
    if (all.length > UNREACHABLE_HUMAN_LIMIT) {
      lines.push(`    … +${all.length - UNREACHABLE_HUMAN_LIMIT} more (use --json for all)`);
    }
  }

  return lines.join('\n');
}

export function registerOverviewCommand(program: Command): void {
  program
    .command('overview')
    .description('Collection-level dashboard with stage distribution (LLM-first JSON)')
    .option('--collection <name>', 'Filter to a specific collection')
    .option('--limit <n>', 'Max cards', '1000')
    .option('--human', 'Human-readable formatted output')
    .option('--json', 'JSON output (default)')
    .action(async (options) => {
      const verbose = program.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();
        const api = new AggregateAPI(client);
        const config = await readConfig();
        const cardLimit = parseInt(options.limit, 10) || 1000;

        let snapshot;
        let scope: string;
        if (options.collection) {
          snapshot = await api.getCollectionSnapshot(options.collection, cardLimit);
          scope = options.collection;
        } else if (config.scopeCollectionId) {
          snapshot = await api.getMultiBoardSnapshot({ collectionIds: [config.scopeCollectionId] }, cardLimit);
          scope = config.scopeCollectionName ?? config.scopeCollectionId;
        } else {
          snapshot = await api.getMultiBoardSnapshot({}, cardLimit);
          scope = 'all collections';
        }

        // Board summaries
        const boardMap = new Map<string, AggregateCard[]>();
        for (const card of snapshot.allCards) {
          const bName = (card as any).boardName ?? 'Unknown';
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

        const blockers = await findTopBlockers(snapshot.allCards);

        const result: OverviewResult = {
          scope,
          boardCount: boards.length,
          totalCards: snapshot.allCards.length,
          boards,
          stageDistribution,
          topBlockers: blockers.topBlockers,
          ...(blockers.unreachable.length > 0 ? { unreachable: blockers.unreachable } : {}),
          dueSummary: computeDueSummary(snapshot.allCards),
          generatedAt: new Date().toISOString(),
        };

        const format = resolveFormat(options);
        outputResult(result, { format }, formatHuman);
      } catch (err: any) {
        logError(err, verbose);
        process.exit(1);
      }
    });
}

export default registerOverviewCommand;
