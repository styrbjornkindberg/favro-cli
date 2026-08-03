/**
 * `favro next` — Developer Persona: "What should I work on next?"
 * v2.0 LLM-first command: outputs JSON by default.
 *
 * Algorithm:
 *   1. Fetch my cards across collections
 *   2. Filter to queued/backlog/ready stages only
 *   3. Score: priority (4x) + due urgency (3x) + low effort (bonus)
 *      Blocking is deliberately NOT scored — see `scoreCard`.
 *   4. Return top N ranked cards with reasoning
 */
import { Command } from 'commander';
import { resolveUserId } from '../lib/config';
import { AggregateCard } from '../api/aggregate';
import { extractEffort } from '../api/context';
import { parseLimit } from '../lib/read-shape';
import { Ctx, run } from '../lib/run';

const CANDIDATE_STAGES = ['queued', 'backlog', 'active'];

interface ScoredCard {
  id: string;
  title: string;
  board: string;
  collection?: string;
  stage?: string;
  column?: string;
  due?: string;
  priority?: string;
  effort?: number;
  score: number;
  reasons: string[];
}

interface NextResult {
  userId: string;
  suggestions: ScoredCard[];
  total: number;
  generatedAt: string;
}

export function extractPriority(card: AggregateCard): { label: string; score: number } {
  if (!card.customFields) return { label: 'unset', score: 0 };
  for (const [key, val] of Object.entries(card.customFields)) {
    if (/priority|urgency|severity/i.test(key)) {
      const v = String(val).toLowerCase();
      if (/critical|blocker/i.test(v)) return { label: v, score: 4 };
      if (/high/i.test(v)) return { label: v, score: 3 };
      if (/medium|normal/i.test(v)) return { label: v, score: 2 };
      if (/low/i.test(v)) return { label: v, score: 1 };
    }
  }
  return { label: 'unset', score: 0 };
}

export function scoreCard(card: AggregateCard): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  // Priority (4x weight)
  const priority = extractPriority(card);
  score += priority.score * 4;
  if (priority.score > 0) reasons.push(`priority: ${priority.label}`);

  // Due urgency (3x weight)
  if (card.due) {
    const daysUntilDue = (new Date(card.due).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    if (daysUntilDue < 0) {
      score += 15; // overdue — max urgency
      reasons.push(`overdue by ${Math.abs(Math.ceil(daysUntilDue))} days`);
    } else if (daysUntilDue < 3) {
      score += 12;
      reasons.push(`due in ${Math.ceil(daysUntilDue)} days`);
    } else if (daysUntilDue < 7) {
      score += 6;
      reasons.push(`due this week`);
    }
  }

  // No blocking term (#47). The −5-per-blocker penalty could never fire —
  // `aggregate.ts` handed every card `blockedBy: []` — and now that the edges
  // are real, scoring them still needs the one thing this snapshot cannot say:
  // whether the blocker is FINISHED. That answer lives on the blocker (the
  // tracker board's mapped `done` column, or `archived` off it) and costs a
  // per-blocker read. Paying for it to nudge a heuristic by 5 points is not
  // worth it, and scoring an unjudged blocker is how it was wrong before.
  // Ask the frontier instead: `cards list --board <id> --filter "unblocked"`.

  // Low effort bonus (prefer quick wins)
  const effort = extractEffort(card);
  if (effort !== undefined && effort <= 2) {
    score += 3;
    reasons.push(`quick win (effort: ${effort})`);
  }

  // Active stage bonus (already started)
  if (card.stage === 'active') {
    score += 5;
    reasons.push('already in progress');
  }

  if (reasons.length === 0) reasons.push('available in queue');

  return { score, reasons };
}

function formatHuman(data: NextResult): string {
  const lines: string[] = [];
  lines.push(`What to work on next (${data.suggestions.length} suggestions)\n`);

  for (let i = 0; i < data.suggestions.length; i++) {
    const s = data.suggestions[i];
    const due = s.due ? ` [due: ${s.due}]` : '';
    lines.push(`  ${i + 1}. ${s.title} (score: ${s.score})`);
    lines.push(`     Board: ${s.board}${due}`);
    lines.push(`     Why: ${s.reasons.join(', ')}`);
  }

  return lines.join('\n');
}

interface NextOptions {
  collection?: string;
  count: string;
  limit: string;
}

export async function nextHandler(ctx: Ctx, options: NextOptions) {
  const userId = await resolveUserId();
  if (!userId) {
    throw new Error('userId not configured. Run `favro auth login` to resolve your identity.');
  }

  const count = parseInt(options.count, 10) || 5;
  const cardLimit = parseLimit(options.limit) ?? 1000;

  let snapshot;
  if (options.collection) {
    snapshot = await ctx.api.aggregate.getCollectionSnapshot(options.collection, cardLimit);
  } else if (ctx.config.scopeCollectionId) {
    snapshot = await ctx.api.aggregate.getMultiBoardSnapshot({ collectionIds: [ctx.config.scopeCollectionId] }, cardLimit);
  } else {
    snapshot = await ctx.api.aggregate.getMultiBoardSnapshot({}, cardLimit);
  }

  // Filter to my cards in candidate stages
  const myCards = snapshot.allCards.filter(c =>
    (c.assignees?.includes(userId) || c.owner === userId) &&
    CANDIDATE_STAGES.includes(c.stage ?? ''),
  );

  // Score and rank
  const scored = myCards.map(c => {
    const { score, reasons } = scoreCard(c);
    return {
      id: c.id,
      title: c.title,
      board: c.boardName ?? 'unknown',
      collection: c.collectionName,
      stage: c.stage,
      column: c.column,
      due: c.due,
      priority: extractPriority(c).label,
      effort: extractEffort(c),
      score,
      reasons,
    } as ScoredCard;
  });

  scored.sort((a, b) => b.score - a.score);

  const result: NextResult = {
    userId,
    suggestions: scored.slice(0, count),
    total: myCards.length,
    generatedAt: new Date().toISOString(),
  };

  return { item: result, human: formatHuman };
}

export function registerNextCommand(program: Command): void {
  program
    .command('next')
    .description('"What should I work on next?" — AI-ranked suggestions (LLM-first JSON)')
    .option('--collection <name>', 'Filter to a specific collection')
    .option('--count <n>', 'Number of suggestions', '5')
    .option('--limit <n>', 'Max cards per collection', '1000')
    .action(run(nextHandler));
}

export default registerNextCommand;
