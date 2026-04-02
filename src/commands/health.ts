/**
 * `favro health` — CTO Persona: Per-board health scoring
 * v2.0 LLM-first command: outputs JSON by default.
 *
 * Health score (0-100):
 *   Flow ratio: cards in active/done stages (40%)
 *   Stale ratio: % cards inactive >14 days (25%)
 *   Blocked ratio: % cards with blockers (20%)
 *   Overdue ratio: % cards past due date (15%)
 */
import { Command } from 'commander';
import { createFavroClient } from '../lib/client-factory';
import { readConfig } from '../lib/config';
import AggregateAPI, { AggregateBoard, AggregateCard } from '../api/aggregate';
import { outputResult, resolveFormat } from '../lib/output';
import { logError } from '../lib/error-handler';

const FLOWING_STAGES = ['active', 'review', 'testing', 'approved', 'done'];
const DONE_STAGES = ['done', 'approved', 'archived'];

interface BoardHealth {
  name: string;
  score: number;
  signal: 'green' | 'yellow' | 'red';
  totalCards: number;
  breakdown: {
    flow: number;
    stale: number;
    blocked: number;
    overdue: number;
  };
}

interface HealthResult {
  scope: string;
  boards: BoardHealth[];
  overallScore: number;
  overallSignal: 'green' | 'yellow' | 'red';
  generatedAt: string;
}

function daysSince(dateStr?: string): number {
  if (!dateStr) return Infinity;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return Infinity;
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}

function scoreBoard(cards: AggregateCard[]): BoardHealth['breakdown'] {
  if (cards.length === 0) return { flow: 100, stale: 100, blocked: 100, overdue: 100 };

  // Flow ratio: % of non-done cards in flowing stages
  const nonDone = cards.filter(c => !DONE_STAGES.includes(c.stage ?? ''));
  const flowing = nonDone.filter(c => FLOWING_STAGES.includes(c.stage ?? ''));
  const flowScore = nonDone.length > 0
    ? Math.round((flowing.length / nonDone.length) * 100)
    : 100;

  // Stale ratio: % of non-done cards NOT inactive >14 days
  const staleCount = nonDone.filter(c => {
    const days = Math.min(daysSince(c.updatedAt), daysSince(c.createdAt));
    return days > 14;
  }).length;
  const staleScore = nonDone.length > 0
    ? Math.round(((nonDone.length - staleCount) / nonDone.length) * 100)
    : 100;

  // Blocked ratio: % of non-done cards NOT blocked
  const blockedCount = nonDone.filter(c =>
    (c.blockedBy && c.blockedBy.length > 0),
  ).length;
  const blockedScore = nonDone.length > 0
    ? Math.round(((nonDone.length - blockedCount) / nonDone.length) * 100)
    : 100;

  // Overdue ratio: % of cards with due dates that are NOT overdue
  const withDue = nonDone.filter(c => c.due);
  const overdueCount = withDue.filter(c => new Date(c.due!).getTime() < Date.now()).length;
  const overdueScore = withDue.length > 0
    ? Math.round(((withDue.length - overdueCount) / withDue.length) * 100)
    : 100;

  return { flow: flowScore, stale: staleScore, blocked: blockedScore, overdue: overdueScore };
}

function computeHealth(name: string, cards: AggregateCard[]): BoardHealth {
  const breakdown = scoreBoard(cards);
  const score = Math.round(
    breakdown.flow * 0.40 +
    breakdown.stale * 0.25 +
    breakdown.blocked * 0.20 +
    breakdown.overdue * 0.15,
  );
  const signal: BoardHealth['signal'] = score > 75 ? 'green' : score >= 50 ? 'yellow' : 'red';
  return { name, score, signal, totalCards: cards.length, breakdown };
}

function formatHuman(data: HealthResult): string {
  const lines: string[] = [];
  const icon = data.overallSignal === 'green' ? '●' : data.overallSignal === 'yellow' ? '●' : '●';
  lines.push(`Health — ${data.scope} (overall: ${data.overallScore}/100 ${icon})\n`);

  for (const b of data.boards) {
    const sig = b.signal === 'green' ? '●' : b.signal === 'yellow' ? '●' : '●';
    lines.push(`  ${sig} ${b.name}: ${b.score}/100 (${b.totalCards} cards)`);
    lines.push(`     Flow: ${b.breakdown.flow}  Stale: ${b.breakdown.stale}  Blocked: ${b.breakdown.blocked}  Overdue: ${b.breakdown.overdue}`);
  }

  return lines.join('\n');
}

export function registerHealthCommand(program: Command): void {
  program
    .command('health')
    .description('Per-board health scores with traffic-light indicators (LLM-first JSON)')
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

        // Group cards by board
        const boardCardMap = new Map<string, AggregateCard[]>();
        for (const card of snapshot.allCards) {
          const bName = (card as any).boardName ?? 'Unknown';
          if (!boardCardMap.has(bName)) boardCardMap.set(bName, []);
          boardCardMap.get(bName)!.push(card);
        }

        const boards: BoardHealth[] = Array.from(boardCardMap.entries())
          .map(([name, cards]) => computeHealth(name, cards))
          .sort((a, b) => a.score - b.score); // Worst health first

        const overallScore = boards.length > 0
          ? Math.round(boards.reduce((sum, b) => sum + b.score, 0) / boards.length)
          : 100;
        const overallSignal: HealthResult['overallSignal'] =
          overallScore > 75 ? 'green' : overallScore >= 50 ? 'yellow' : 'red';

        const result: HealthResult = {
          scope,
          boards,
          overallScore,
          overallSignal,
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

export default registerHealthCommand;
