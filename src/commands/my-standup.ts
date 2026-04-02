/**
 * `favro my-standup` — Developer Persona: Personal cross-board standup
 * v2.0 LLM-first command: outputs JSON by default.
 */
import { Command } from 'commander';
import { createFavroClient } from '../lib/client-factory';
import { resolveUserId, readConfig } from '../lib/config';
import AggregateAPI, { AggregateCard } from '../api/aggregate';
import { outputResult, resolveFormat } from '../lib/output';
import { logError } from '../lib/error-handler';

const COMPLETED_STAGES = ['done', 'approved', 'archived'];
const IN_PROGRESS_STAGES = ['active', 'review', 'testing'];
const BLOCKED_STAGES = ['blocked'];

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
  if (card.blockedBy && card.blockedBy.length > 0) return 'blocked';
  if (BLOCKED_STAGES.includes(card.stage ?? '')) return 'blocked';
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

export function registerMyStandupCommand(program: Command): void {
  program
    .command('my-standup')
    .description('Personal standup across all boards (LLM-first JSON output)')
    .option('--collection <name>', 'Filter to a specific collection')
    .option('--days <n>', 'Days ahead for due-soon threshold', '3')
    .option('--limit <n>', 'Max cards per collection', '1000')
    .option('--human', 'Human-readable formatted output')
    .option('--json', 'JSON output (default)')
    .action(async (options) => {
      const verbose = program.opts()?.verbose ?? false;
      try {
        const userId = await resolveUserId();
        if (!userId) {
          console.error('Error: userId not configured. Run `favro auth login` to resolve your identity.');
          process.exit(1);
        }

        const client = await createFavroClient();
        const api = new AggregateAPI(client);
        const config = await readConfig();
        const dueSoonDays = parseInt(options.days, 10) || 3;
        const cardLimit = parseInt(options.limit, 10) || 1000;

        let snapshot;
        if (options.collection) {
          snapshot = await api.getCollectionSnapshot(options.collection, cardLimit);
        } else if (config.scopeCollectionId) {
          snapshot = await api.getMultiBoardSnapshot({ collectionIds: [config.scopeCollectionId] }, cardLimit);
        } else {
          snapshot = await api.getMultiBoardSnapshot({}, cardLimit);
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

        const format = resolveFormat(options);
        outputResult(result, { format }, formatHuman);
      } catch (err: any) {
        logError(err, verbose);
        process.exit(1);
      }
    });
}

export default registerMyStandupCommand;
