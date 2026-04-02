/**
 * `favro my-cards` — Developer Persona: Cross-board personal card view
 * v2.0 LLM-first command: outputs JSON by default.
 */
import { Command } from 'commander';
import { createFavroClient } from '../lib/client-factory';
import { resolveUserId, readConfig } from '../lib/config';
import AggregateAPI, { AggregateCard } from '../api/aggregate';
import { outputResult, resolveFormat } from '../lib/output';
import { logError } from '../lib/error-handler';

interface MyCardsResult {
  userId: string;
  collections: Array<{
    name: string;
    boards: Array<{
      name: string;
      cards: Array<{
        id: string;
        title: string;
        stage?: string;
        column?: string;
        due?: string;
        tags?: string[];
        boardName?: string;
      }>;
    }>;
  }>;
  suggestedNext?: {
    id: string;
    title: string;
    board: string;
    reason: string;
  };
  total: number;
  generatedAt: string;
}

function filterMyCards(cards: AggregateCard[], userId: string): AggregateCard[] {
  return cards.filter(c =>
    c.assignees?.includes(userId) || c.owner === userId,
  );
}

function pickSuggestedNext(cards: AggregateCard[]): MyCardsResult['suggestedNext'] {
  // Find highest-priority card in queued or active stage
  const candidates = cards.filter(c =>
    c.stage === 'queued' || c.stage === 'active' || c.stage === 'backlog',
  );
  if (candidates.length === 0) return undefined;

  // Simple scoring: active > queued > backlog, then by due date urgency
  const scored = candidates.map(c => {
    let score = 0;
    if (c.stage === 'active') score += 30;
    else if (c.stage === 'queued') score += 20;
    else score += 10;

    if (c.due) {
      const daysUntilDue = (new Date(c.due).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      if (daysUntilDue < 0) score += 50; // overdue
      else if (daysUntilDue < 3) score += 30;
      else if (daysUntilDue < 7) score += 15;
    }
    return { card: c, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const reasons: string[] = [];
  if (best.card.stage === 'active') reasons.push('already in progress');
  if (best.card.due) {
    const days = Math.ceil((new Date(best.card.due).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    if (days < 0) reasons.push(`overdue by ${Math.abs(days)} days`);
    else if (days < 3) reasons.push(`due in ${days} days`);
  }
  if (reasons.length === 0) reasons.push('highest priority in queue');

  return {
    id: best.card.id,
    title: best.card.title,
    board: best.card.boardName ?? 'unknown',
    reason: reasons.join(', '),
  };
}

function formatHuman(data: MyCardsResult): string {
  const lines: string[] = [];
  lines.push(`My Cards (${data.total} total)\n`);

  for (const coll of data.collections) {
    for (const board of coll.boards) {
      lines.push(`  ${coll.name} → ${board.name}`);
      for (const card of board.cards) {
        const due = card.due ? ` [due: ${card.due}]` : '';
        const stage = card.stage ? ` (${card.stage})` : '';
        lines.push(`    • ${card.title}${stage}${due}`);
      }
    }
  }

  if (data.suggestedNext) {
    lines.push(`\n  → Next: ${data.suggestedNext.title} (${data.suggestedNext.reason})`);
  }

  return lines.join('\n');
}

export function registerMyCardsCommand(program: Command): void {
  program
    .command('my-cards')
    .description('Show your cards across all boards (LLM-first JSON output)')
    .option('--collection <name>', 'Filter to a specific collection')
    .option('--status <filter>', 'Filter by workflow stage (e.g., active, queued)')
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
        const cardLimit = parseInt(options.limit, 10) || 1000;

        let snapshot;
        if (options.collection) {
          snapshot = await api.getCollectionSnapshot(options.collection, cardLimit);
        } else if (config.scopeCollectionId) {
          snapshot = await api.getMultiBoardSnapshot({ collectionIds: [config.scopeCollectionId] }, cardLimit);
        } else {
          snapshot = await api.getMultiBoardSnapshot({}, cardLimit);
        }

        let myCards = filterMyCards(snapshot.allCards, userId);

        // Apply status filter
        if (options.status) {
          const stage = options.status.toLowerCase();
          myCards = myCards.filter(c => c.stage === stage);
        }

        // Group by collection → board
        const collectionMap = new Map<string, Map<string, AggregateCard[]>>();
        for (const card of myCards) {
          const collName = card.collectionName ?? 'Unknown';
          if (!collectionMap.has(collName)) collectionMap.set(collName, new Map());
          const boardMap = collectionMap.get(collName)!;
          const bName = card.boardName ?? 'Unknown';
          if (!boardMap.has(bName)) boardMap.set(bName, []);
          boardMap.get(bName)!.push(card);
        }

        const result: MyCardsResult = {
          userId,
          collections: Array.from(collectionMap.entries()).map(([collName, boardMap]) => ({
            name: collName,
            boards: Array.from(boardMap.entries()).map(([bName, cards]) => ({
              name: bName,
              cards: cards.map(c => ({
                id: c.id,
                title: c.title,
                stage: c.stage,
                column: c.column,
                due: c.due,
                tags: c.tags,
                boardName: c.boardName,
              })),
            })),
          })),
          suggestedNext: pickSuggestedNext(myCards),
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

export default registerMyCardsCommand;
