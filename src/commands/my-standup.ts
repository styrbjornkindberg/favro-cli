/**
 * `favro my-standup` — Developer Persona: Personal cross-board standup
 * v2.0 LLM-first command: outputs JSON by default.
 */
import { Command } from 'commander';
import { resolveUserId } from '../lib/config';
import { AggregateCard } from '../api/aggregate';
import { Ctx, run } from '../lib/run';
import { isBlocked } from '../api/standup';

const COMPLETED_STAGES = ['done', 'approved', 'archived'];
const IN_PROGRESS_STAGES = ['active', 'review', 'testing'];

interface StandupCard {
  id: string;
  title: string;
  board: string;
  collection?: string;
  stage?: string;
  column?: string;
  due?: string;
  group: 'completed' | 'in-progress' | 'blocked' | 'due-soon';
}

interface MyStandupResult {
  userId: string;
  completed: StandupCard[];
  inProgress: StandupCard[];
  blocked: StandupCard[];
  dueSoon: StandupCard[];
  total: number;
  generatedAt: string;
}

function classifyCard(card: AggregateCard, dueSoonDays: number): StandupCard['group'] {
  // Priority: blocked > completed > due-soon > in-progress
  //
  // A `blockedBy` edge is NOT consulted here (#61). Nothing clears a Favro
  // `isBefore` edge when the blocker finishes, so length-of-edges is a
  // permanent over-count — and sitting above the `completed` check it hid the
  // real stage of finished work. Judging doneness costs a per-blocker sweep
  // (`judgeBlockers`); `unblocked` and `next` pay it, a standup summary should
  // not.
  //
  // The blocked *state* comes from the same column-name predicate `favro
  // standup` uses, so the two commands cannot disagree about one card. The
  // stage cannot carry it: `WorkflowStage` has no 'blocked' member, and
  // `detectStage('Blocked')` falls through to 'queued'.
  if (isBlocked(card)) return 'blocked';
  if (COMPLETED_STAGES.includes(card.stage ?? '')) return 'completed';

  if (card.due) {
    const daysUntilDue = (new Date(card.due).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    if (daysUntilDue <= dueSoonDays) return 'due-soon';
  }

  if (IN_PROGRESS_STAGES.includes(card.stage ?? '')) return 'in-progress';
  return 'in-progress'; // Default for cards assigned to me
}

function toStandupCard(card: AggregateCard, group: StandupCard['group']): StandupCard {
  return {
    id: card.id,
    title: card.title,
    board: card.boardName ?? 'unknown',
    collection: card.collectionName,
    stage: card.stage,
    column: card.column,
    due: card.due,
    group,
  };
}

function formatHuman(data: MyStandupResult): string {
  const lines: string[] = [];
  lines.push(`My Standup (${data.total} cards)\n`);

  const sections: Array<[string, StandupCard[]]> = [
    ['Completed', data.completed],
    ['In Progress', data.inProgress],
    ['Blocked', data.blocked],
    ['Due Soon', data.dueSoon],
  ];

  for (const [label, cards] of sections) {
    if (cards.length === 0) continue;
    lines.push(`  ${label} (${cards.length}):`);
    for (const c of cards) {
      const due = c.due ? ` [due: ${c.due}]` : '';
      lines.push(`    • ${c.title} — ${c.board}${due}`);
    }
  }

  return lines.join('\n');
}

interface MyStandupOptions {
  collection?: string;
  days: string;
}

export async function myStandupHandler(ctx: Ctx, options: MyStandupOptions) {
  const userId = await resolveUserId();
  if (!userId) {
    throw new Error('userId not configured. Run `favro auth login` to resolve your identity.');
  }

  const dueSoonDays = parseInt(options.days, 10) || 3;

  let snapshot;
  if (options.collection) {
    snapshot = await ctx.api.aggregate.getCollectionSnapshot(options.collection);
  } else if (ctx.config.scopeCollectionId) {
    snapshot = await ctx.api.aggregate.getMultiBoardSnapshot({ collectionIds: [ctx.config.scopeCollectionId] });
  } else {
    snapshot = await ctx.api.aggregate.getMultiBoardSnapshot({});
  }

  // Filter to my cards
  const myCards = snapshot.allCards.filter(c =>
    c.assignees?.includes(userId) || c.owner === userId,
  );

  // Classify
  const completed: StandupCard[] = [];
  const inProgress: StandupCard[] = [];
  const blocked: StandupCard[] = [];
  const dueSoon: StandupCard[] = [];

  for (const card of myCards) {
    const group = classifyCard(card, dueSoonDays);
    const sc = toStandupCard(card, group);
    switch (group) {
      case 'completed': completed.push(sc); break;
      case 'in-progress': inProgress.push(sc); break;
      case 'blocked': blocked.push(sc); break;
      case 'due-soon': dueSoon.push(sc); break;
    }
  }

  const result: MyStandupResult = {
    userId,
    completed,
    inProgress,
    blocked,
    dueSoon,
    total: myCards.length,
    generatedAt: new Date().toISOString(),
  };

  return { item: result, human: formatHuman };
}

export function registerMyStandupCommand(program: Command): void {
  program
    .command('my-standup')
    .description('Personal standup across all boards (LLM-first JSON output)')
    .option('--collection <name>', 'Filter to a specific collection')
    .option('--days <n>', 'Days ahead for due-soon threshold', '3')
    .action(run(myStandupHandler));
}

export default registerMyStandupCommand;
