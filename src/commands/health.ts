/**
 * `favro health` — CTO Persona: Per-board health scoring
 * v2.0 LLM-first command: outputs JSON by default.
 *
 * Health score (0-100):
 *   Flow ratio: cards in active/done stages (40%)
 *   Stale ratio: % cards inactive DEFAULT_STALE_DAYS days or more (25%)
 *   Dependency ratio: % cards carrying a dependency edge, judged or not (20%)
 *   Overdue ratio: % cards past due date (15%)
 */
import { Command } from 'commander';
import { AggregateCard } from '../api/aggregate';
import { excludeUnreadableBoards, Unreachable } from '../lib/read-shape';
import { RefusalError } from '../lib/refusal';
import { Ctx, run } from '../lib/run';
import { daysSince, DEFAULT_STALE_DAYS, isStale } from '../lib/time';

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
  /**
   * Parts of the read that failed, and therefore boards this report does NOT
   * cover. Present only when non-empty, so absent means every board in scope
   * was scored (#148). While it is present, `overallScore` is an average over
   * the boards that were readable and nothing else.
   */
  unreachable?: Unreachable[];
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

  // Stale ratio: % of datable non-done cards NOT stale.
  // Favro sends no last-modified field; age is measured from creation, and a
  // card with no usable one drops out of BOTH halves — the same treatment
  // `overdueScore` below gives a card with no due date (#130).
  //
  // `isStale` and `DEFAULT_STALE_DAYS`, not a literal `d > 14`: this is the
  // same threshold `favro stale` defaults to, deliberately, and while it was
  // written out here the two drifted to different boundaries around the same
  // number — a card inactive for exactly 14 days was stale to one command and
  // healthy to the other (#145). `health` has no `--days` flag, so the default
  // is the only value it can score against.
  const ages = nonDone.map(c => daysSince(c.createdAt)).filter((d): d is number => d !== undefined);
  const staleCount = ages.filter(d => isStale(d, DEFAULT_STALE_DAYS)).length;
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

  // Read off `unreachable` rather than restated, so the human line and the JSON
  // key cannot drift — the hole `risks --human` used to hide (#117).
  if (data.unreachable?.length) {
    lines.push(`\n  ⚠️  Not scored — ${data.unreachable.length} part(s) of this scope could not be read:`);
    for (const hole of data.unreachable) lines.push(`     ${hole.id} — ${hole.reason}`);
  }

  return lines.join('\n');
}

interface HealthOptions {
  collection?: string;
  limit: string;
}

/**
 * The `exitCode` here answers "does this report cover the scope you asked
 * about", and NOT "is the scope healthy".
 *
 * ADR-0002 and #115 both describe `health` as exiting 1 on an unhealthy report
 * — it never has. The only hard exit this command carried was the error
 * boundary's, and the same was true of `release-check`, `diff` and `risks`
 * until #117, whose acceptance criterion asked for the code explicitly and so
 * settled it for those three: they exit 1 when their own verdict field is not
 * the clean one.
 *
 * #117 did NOT settle it here, because `health` scores rather than finds: the
 * cut is `red` versus `yellow`, and picking it is a product decision, not the
 * migration this file already went through in #115. That decision is #115's
 * last open acceptance box, and #148 did not take it either — what #148 added
 * is the orthogonal half, an incomplete read forbidding a clean code. When
 * #115 lands the change is one clause —
 * `unreachable.length > 0 || result.overallSignal === 'red' ? 1 : 0` — plus a
 * test.
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

  // What a hole does to `health`: the board is OMITTED from scoring and named.
  //
  // A board whose columns read failed has no `stage` on any of its cards, and
  // `scoreBoard` reads a missing stage as "not flowing" — so the board scored
  // `flow: 0` and came back RED off a read that never happened (#148). The
  // other three options were weighed:
  //
  //  - Score it anyway: that is the bug. A score over cards whose stage is
  //    unknown is not a score, it is a number shaped like one.
  //  - Refuse the whole command: throws away the boards that WERE readable,
  //    which are the majority in the failure this actually models (one board's
  //    columns 500ing out of twelve).
  //  - Report it with the hole named but still scored: an agent reading
  //    `boards[]` would have to know to cross-reference `unreachable` before
  //    trusting a row. Absence cannot be misread.
  //
  // Refusal survives for the one case where omission would answer nothing at
  // all — every board in scope dark — because an empty `boards` list rolls up
  // to 100/green, and "we read nothing" must never print as "all clear".
  const { cards, unreachable } = excludeUnreadableBoards(snapshot);

  // Group cards by board
  const boardCardMap = new Map<string, AggregateCard[]>();
  for (const card of cards) {
    const bName = card.boardName ?? 'Unknown';
    if (!boardCardMap.has(bName)) boardCardMap.set(bName, []);
    boardCardMap.get(bName)!.push(card);
  }

  // Keyed on boards actually DROPPED, not on `unreachable` being non-empty: a
  // failed members read is also a hole but costs no board, so gating on the
  // list itself made an empty scope with an unreadable member list refuse with
  // "no board in scope could be read" — a false statement about a scope that
  // read fine and simply holds nothing.
  if (cards.length < snapshot.allCards.length && boardCardMap.size === 0) {
    throw new RefusalError(
      `Cannot score health for ${scope}: no board in scope could be read.\n` +
      unreachable.map(h => `  ${h.id} — ${h.reason}`).join('\n'),
    );
  }

  const { boards, overallScore, overallSignal } = rollUp(
    Array.from(boardCardMap.entries()).map(([name, cards]) => computeHealth(name, cards)),
  );

  const result: HealthResult = {
    scope,
    boards,
    overallScore,
    overallSignal,
    // Non-empty only — absent stays distinguishable from empty (#116).
    ...(unreachable.length > 0 ? { unreachable } : {}),
    generatedAt: new Date().toISOString(),
  };

  return {
    item: result,
    human: formatHuman,
    // Exit 0 is a POSITIVE claim — "this is the health of the scope you asked
    // about" — so a report that skipped part of the scope cannot earn one.
    //
    // Spread in rather than `? 1 : 0`, so a complete report leaves
    // `process.exitCode` untouched instead of pinning it to an explicit 0.
    // Same observable status either way, but `health` is not an answer-code
    // command (see above) and must not start behaving like one on the clean
    // path — `persona-human-flag.test.ts` pins exactly that for all eight
    // personas.
    //
    // This does NOT settle the red-vs-yellow cut #115 left open: the code still
    // says nothing about the verdict, only about whether the report covers what
    // was asked for. When #115 lands, the two conditions OR together.
    ...(unreachable.length > 0 ? { exitCode: 1 } : {}),
  };
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
