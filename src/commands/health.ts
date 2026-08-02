/**
 * `favro health` — CTO Persona: Per-board health scoring
 * v2.0 LLM-first command: outputs JSON by default.
 *
 * Health score (0-100):
 *   Flow ratio: cards in active/done stages (40%)
 *   Stale ratio: % cards inactive >14 days (25%)
 *   Dependency ratio: % cards carrying a dependency edge, judged or not (20%)
 *   Overdue ratio: % cards past due date (15%)
 */
import { Command } from 'commander';
import { AggregateCard } from '../api/aggregate';
import { Ctx, run } from '../lib/run';
import { daysSince } from '../lib/time';

// 'approved' and 'done' are unreachable here — `nonDone` strips DONE_STAGES
// before the flow numerator is computed. Kept so the list reads as the full set
// of stages that would count as flowing.
const FLOWING_STAGES = ['active', 'review', 'testing', 'approved', 'done'];
const DONE_STAGES = ['done', 'approved', 'archived'];

export interface BoardHealth {
  name: string;
  score: number;
  signal: 'green' | 'yellow' | 'red';
  totalCards: number;
  breakdown: {
    flow: number;
    stale: number;
    /**
     * % of non-done cards carrying NO dependency edge. An edge count, not a
     * blocked state — nothing clears a Favro edge when the blocker finishes,
     * and this path does not pay for `judgeBlockers` (#61).
     */
    dependencies: number;
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

export function scoreBoard(cards: AggregateCard[]): BoardHealth['breakdown'] {
  if (cards.length === 0) return { flow: 100, stale: 100, dependencies: 100, overdue: 100 };

  // Flow ratio: % of non-done cards in flowing stages
  const nonDone = cards.filter(c => !DONE_STAGES.includes(c.stage ?? ''));
  const flowing = nonDone.filter(c => FLOWING_STAGES.includes(c.stage ?? ''));
  const flowScore = nonDone.length > 0
    ? Math.round((flowing.length / nonDone.length) * 100)
    : 100;

  // Stale ratio: % of datable non-done cards NOT inactive >14 days.
  // Favro sends no last-modified field; age is measured from creation, and a
  // card with no usable one drops out of BOTH halves — the same treatment
  // `overdueScore` below gives a card with no due date (#130).
  const ages = nonDone.map(c => daysSince(c.createdAt)).filter((d): d is number => d !== undefined);
  const staleCount = ages.filter(d => d > 14).length;
  const staleScore = ages.length > 0
    ? Math.round(((ages.length - staleCount) / ages.length) * 100)
    : 100;

  // Dependency ratio: % of non-done cards carrying no dependency edge (#61)
  const withDependencies = nonDone.filter(c =>
    (c.blockedBy && c.blockedBy.length > 0),
  ).length;
  const dependencyScore = nonDone.length > 0
    ? Math.round(((nonDone.length - withDependencies) / nonDone.length) * 100)
    : 100;

  // Overdue ratio: % of cards with due dates that are NOT overdue
  const withDue = nonDone.filter(c => c.due);
  const overdueCount = withDue.filter(c => new Date(c.due!).getTime() < Date.now()).length;
  const overdueScore = withDue.length > 0
    ? Math.round(((withDue.length - overdueCount) / withDue.length) * 100)
    : 100;

  return { flow: flowScore, stale: staleScore, dependencies: dependencyScore, overdue: overdueScore };
}

/** The traffic-light rule. One copy — boards and the rollup both go through it. */
function signalFor(score: number): BoardHealth['signal'] {
  return score > 75 ? 'green' : score >= 50 ? 'yellow' : 'red';
}

export function computeHealth(name: string, cards: AggregateCard[]): BoardHealth {
  const breakdown = scoreBoard(cards);
  const score = Math.round(
    breakdown.flow * 0.40 +
    breakdown.stale * 0.25 +
    breakdown.dependencies * 0.20 +
    breakdown.overdue * 0.15,
  );
  return { name, score, signal: signalFor(score), totalCards: cards.length, breakdown };
}

/**
 * Orders boards worst-first and folds them into the unweighted overall score.
 * An empty scope scores 100 — nothing measured is not the same as nothing wrong,
 * but a red light on zero boards is worse noise.
 */
export function rollUp(boards: BoardHealth[]): {
  boards: BoardHealth[];
  overallScore: number;
  overallSignal: BoardHealth['signal'];
} {
  const sorted = [...boards].sort((a, b) => a.score - b.score);
  const overallScore = sorted.length > 0
    ? Math.round(sorted.reduce((sum, b) => sum + b.score, 0) / sorted.length)
    : 100;
  return { boards: sorted, overallScore, overallSignal: signalFor(overallScore) };
}

function formatHuman(data: HealthResult): string {
  const lines: string[] = [];
  const icon = data.overallSignal === 'green' ? '●' : data.overallSignal === 'yellow' ? '●' : '●';
  lines.push(`Health — ${data.scope} (overall: ${data.overallScore}/100 ${icon})\n`);

  for (const b of data.boards) {
    const sig = b.signal === 'green' ? '●' : b.signal === 'yellow' ? '●' : '●';
    lines.push(`  ${sig} ${b.name}: ${b.score}/100 (${b.totalCards} cards)`);
    lines.push(`     Flow: ${b.breakdown.flow}  Stale: ${b.breakdown.stale}  Deps: ${b.breakdown.dependencies}  Overdue: ${b.breakdown.overdue}`);
  }

  return lines.join('\n');
}

interface HealthOptions {
  collection?: string;
  limit: string;
}

/**
 * No `exitCode` on the `Result`.
 *
 * ADR-0002 and #115 both describe `health` as exiting 1 on an unhealthy report
 * — it never has. The only hard exit this command carried was the error
 * boundary's, and the same is true of `release-check` and `diff`. Turning a red
 * signal into a non-zero exit would be a new behaviour, not a migration, so it
 * is raised on the issue rather than smuggled in here.
 */
export async function healthHandler(ctx: Ctx, options: HealthOptions) {
  const cardLimit = parseInt(options.limit, 10) || 1000;

  let snapshot;
  let scope: string;
  if (options.collection) {
    snapshot = await ctx.api.aggregate.getCollectionSnapshot(options.collection, cardLimit);
    scope = options.collection;
  } else if (ctx.config.scopeCollectionId) {
    snapshot = await ctx.api.aggregate.getMultiBoardSnapshot({ collectionIds: [ctx.config.scopeCollectionId] }, cardLimit);
    scope = ctx.config.scopeCollectionName ?? ctx.config.scopeCollectionId;
  } else {
    snapshot = await ctx.api.aggregate.getMultiBoardSnapshot({}, cardLimit);
    scope = 'all collections';
  }

  // Group cards by board
  const boardCardMap = new Map<string, AggregateCard[]>();
  for (const card of snapshot.allCards) {
    const bName = card.boardName ?? 'Unknown';
    if (!boardCardMap.has(bName)) boardCardMap.set(bName, []);
    boardCardMap.get(bName)!.push(card);
  }

  const { boards, overallScore, overallSignal } = rollUp(
    Array.from(boardCardMap.entries()).map(([name, cards]) => computeHealth(name, cards)),
  );

  const result: HealthResult = {
    scope,
    boards,
    overallScore,
    overallSignal,
    generatedAt: new Date().toISOString(),
  };

  return { item: result, human: formatHuman };
}

export function registerHealthCommand(program: Command): void {
  program
    .command('health')
    .description('Per-board health scores with traffic-light indicators (LLM-first JSON)')
    .option('--collection <name>', 'Filter to a specific collection')
    .option('--limit <n>', 'Max cards', '1000')
    .action(run(healthHandler));
}

export default registerHealthCommand;
