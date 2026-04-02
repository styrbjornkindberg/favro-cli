/**
 * `favro overview` — PM/PO Persona: Collection-level dashboard
 * v2.0 LLM-first command: outputs JSON by default.
 */
import { Command } from 'commander';
import { createFavroClient } from '../lib/client-factory';
import { readConfig } from '../lib/config';
import AggregateAPI, { AggregateCard } from '../api/aggregate';
import { outputResult, resolveFormat } from '../lib/output';
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

interface OverviewResult {
  scope: string;
  boardCount: number;
  totalCards: number;
  boards: BoardSummary[];
  stageDistribution: Record<string, number>;
  topBlockers: Array<{ id: string; title: string; board?: string; blockingCount: number }>;
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

function findTopBlockers(cards: AggregateCard[], count: number = 5) {
  // Find cards that are blocking the most other cards
  const blockingCount = new Map<string, { card: AggregateCard; count: number }>();

  for (const card of cards) {
    if (card.blockedBy) {
      for (const blockerId of card.blockedBy) {
        const existing = blockingCount.get(blockerId);
        if (existing) {
          existing.count++;
        } else {
          const blocker = cards.find(c => c.id === blockerId);
          if (blocker) {
            blockingCount.set(blockerId, { card: blocker, count: 1 });
          }
        }
      }
    }
  }

  return Array.from(blockingCount.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, count)
    .map(b => ({
      id: b.card.id,
      title: b.card.title,
      board: (b.card as any).boardName,
      blockingCount: b.count,
    }));
}

function formatHuman(data: OverviewResult): string {
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

        const result: OverviewResult = {
          scope,
          boardCount: boards.length,
          totalCards: snapshot.allCards.length,
          boards,
          stageDistribution,
          topBlockers: findTopBlockers(snapshot.allCards),
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
