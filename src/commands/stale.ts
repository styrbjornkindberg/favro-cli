/**
 * `favro stale` — PM/PO Persona: Find stale/inactive cards
 * v2.0 LLM-first command: outputs JSON by default.
 */
import { Command } from 'commander';
import { createFavroClient } from '../lib/client-factory';
import { readConfig } from '../lib/config';
import AggregateAPI, { AggregateCard } from '../api/aggregate';
import { outputResult, resolveFormat } from '../lib/output';
import { logError } from '../lib/error-handler';

const DONE_STAGES = ['done', 'approved', 'archived'];

interface StaleCard {
  id: string;
  title: string;
  board?: string;
  collection?: string;
  stage?: string;
  column?: string;
  assignees?: string[];
  due?: string;
  daysSinceUpdate: number;
  group: 'assigned-stale' | 'unassigned-stale';
}

interface StaleResult {
  scope: string;
  staleDays: number;
  assignedStale: StaleCard[];
  unassignedStale: StaleCard[];
  total: number;
  generatedAt: string;
}

function daysSince(dateStr?: string): number {
  if (!dateStr) return Infinity;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return Infinity;
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}

function formatHuman(data: StaleResult): string {
  const lines: string[] = [];
  lines.push(`Stale Cards (inactive >${data.staleDays} days) — ${data.scope}\n`);

  if (data.assignedStale.length > 0) {
    lines.push(`  Assigned but stale (${data.assignedStale.length}):`);
    for (const c of data.assignedStale) {
      const who = c.assignees?.join(', ') ?? 'unknown';
      lines.push(`    • ${c.title} — ${c.board} (${c.daysSinceUpdate}d ago, assigned: ${who})`);
    }
  }

  if (data.unassignedStale.length > 0) {
    lines.push(`  Unassigned and stale (${data.unassignedStale.length}):`);
    for (const c of data.unassignedStale) {
      lines.push(`    • ${c.title} — ${c.board} (${c.daysSinceUpdate}d ago)`);
    }
  }

  if (data.total === 0) lines.push('  No stale cards found.');

  return lines.join('\n');
}

export function registerStaleCommand(program: Command): void {
  program
    .command('stale')
    .description('Find cards with no recent activity (LLM-first JSON)')
    .option('--board <name>', 'Filter to a specific board')
    .option('--collection <name>', 'Filter to a specific collection')
    .option('--days <n>', 'Inactivity threshold in days', '14')
    .option('--limit <n>', 'Max cards', '1000')
    .option('--human', 'Human-readable formatted output')
    .option('--json', 'JSON output (default)')
    .action(async (options) => {
      const verbose = program.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();
        const api = new AggregateAPI(client);
        const config = await readConfig();
        const staleDays = parseInt(options.days, 10) || 14;
        const cardLimit = parseInt(options.limit, 10) || 1000;

        let snapshot;
        let scope: string;
        if (options.board) {
          const ContextAPI = (await import('../api/context')).default;
          const ctx = new ContextAPI(client);
          const boardSnapshot = await ctx.getSnapshot(options.board, cardLimit);
          snapshot = {
            allCards: boardSnapshot.cards.map(c => ({
              ...c,
              boardName: boardSnapshot.board.name,
            })) as AggregateCard[],
          };
          scope = boardSnapshot.board.name;
        } else if (options.collection) {
          snapshot = await api.getCollectionSnapshot(options.collection, cardLimit);
          scope = options.collection;
        } else if (config.scopeCollectionId) {
          snapshot = await api.getMultiBoardSnapshot({ collectionIds: [config.scopeCollectionId] }, cardLimit);
          scope = config.scopeCollectionName ?? config.scopeCollectionId;
        } else {
          snapshot = await api.getMultiBoardSnapshot({}, cardLimit);
          scope = 'all collections';
        }

        const assignedStale: StaleCard[] = [];
        const unassignedStale: StaleCard[] = [];

        for (const card of snapshot.allCards) {
          // Skip done/archived cards
          if (DONE_STAGES.includes(card.stage ?? '')) continue;

          const days = Math.min(
            daysSince(card.updatedAt),
            daysSince(card.createdAt),
          );

          if (days >= staleDays) {
            const staleCard: StaleCard = {
              id: card.id,
              title: card.title,
              board: (card as any).boardName,
              collection: (card as any).collectionName,
              stage: card.stage,
              column: card.column,
              assignees: card.assignees,
              due: card.due,
              daysSinceUpdate: days === Infinity ? -1 : days,
              group: (card.assignees?.length ?? 0) > 0 ? 'assigned-stale' : 'unassigned-stale',
            };
            if (staleCard.group === 'assigned-stale') {
              assignedStale.push(staleCard);
            } else {
              unassignedStale.push(staleCard);
            }
          }
        }

        // Sort by staleness (most stale first)
        assignedStale.sort((a, b) => b.daysSinceUpdate - a.daysSinceUpdate);
        unassignedStale.sort((a, b) => b.daysSinceUpdate - a.daysSinceUpdate);

        const result: StaleResult = {
          scope,
          staleDays,
          assignedStale,
          unassignedStale,
          total: assignedStale.length + unassignedStale.length,
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

export default registerStaleCommand;
