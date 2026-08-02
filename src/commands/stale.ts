/**
 * `favro stale` — PM/PO Persona: Find stale/inactive cards
 * v2.0 LLM-first command: outputs JSON by default.
 */
import { Command } from 'commander';
import { AggregateCard } from '../api/aggregate';
import { Ctx, run } from '../lib/run';
import { daysSince } from '../lib/time';

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

/**
 * A card the threshold could not be put to: Favro sent no usable `createdAt`,
 * so its age is unknown (#130). Deliberately carries no day count — there is no
 * honest number to put there, and the `-1` that used to stand in was both
 * uninterpretable and, in a most-stale-first list, sorted last.
 */
interface UndatedCard {
  id: string;
  title: string;
  board?: string;
}

interface StaleResult {
  scope: string;
  staleDays: number;
  assignedStale: StaleCard[];
  unassignedStale: StaleCard[];
  total: number;
  /**
   * Live cards excluded from the assessment for want of a creation date.
   * Reported rather than dropped: a silent exclusion is the same fail-open as a
   * fabricated number, one step quieter. Not counted in `total`, which is the
   * number of cards actually judged stale.
   */
  undated: UndatedCard[];
  generatedAt: string;
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

  // Printed alongside "No stale cards found.", never instead of it: nothing was
  // stale AND something was skipped are two separate facts, and suppressing the
  // second makes the first a lie by omission.
  if (data.undated.length > 0) {
    lines.push(`  No creation date — not assessed (${data.undated.length}):`);
    for (const c of data.undated) {
      lines.push(`    • ${c.title} — ${c.board ?? 'unknown board'}`);
    }
  }

  return lines.join('\n');
}

interface StaleOptions {
  board?: string;
  collection?: string;
  days: string;
  limit: string;
}

export async function staleHandler(ctx: Ctx, options: StaleOptions) {
  const staleDays = parseInt(options.days, 10) || 14;
  const cardLimit = parseInt(options.limit, 10) || 1000;

  let snapshot: { allCards: AggregateCard[] };
  let scope: string;
  if (options.board) {
    // `ctx.api.context` replaces the dynamic `await import` + `new ContextAPI`
    // this arm used to do; the namespace getter is lazy, so the board arm is
    // still the only path that constructs it.
    const boardSnapshot = await ctx.api.context.getSnapshot(options.board, cardLimit);
    snapshot = {
      allCards: boardSnapshot.cards.map(c => ({
        ...c,
        boardName: boardSnapshot.board.name,
      })) as AggregateCard[],
    };
    scope = boardSnapshot.board.name;
  } else if (options.collection) {
    snapshot = await ctx.api.aggregate.getCollectionSnapshot(options.collection, cardLimit);
    scope = options.collection;
  } else if (ctx.config.scopeCollectionId) {
    snapshot = await ctx.api.aggregate.getMultiBoardSnapshot({ collectionIds: [ctx.config.scopeCollectionId] }, cardLimit);
    scope = ctx.config.scopeCollectionName ?? ctx.config.scopeCollectionId;
  } else {
    snapshot = await ctx.api.aggregate.getMultiBoardSnapshot({}, cardLimit);
    scope = 'all collections';
  }

  const assignedStale: StaleCard[] = [];
  const unassignedStale: StaleCard[] = [];
  const undated: UndatedCard[] = [];

  for (const card of snapshot.allCards) {
    // Skip done/archived cards. Before the date check: this command has no
    // opinion about finished work, datable or not.
    if (DONE_STAGES.includes(card.stage ?? '')) continue;

    // Favro sends no last-modified field; age is measured from creation.
    const days = daysSince(card.createdAt);

    // No creation date means no age, and no age means no threshold applies —
    // not that every threshold applies, which is what `Infinity` used to say
    // (#130). The card leaves the ranked set and is named separately.
    if (days === undefined) {
      undated.push({ id: card.id, title: card.title, board: card.boardName });
      continue;
    }

    if (days >= staleDays) {
      const staleCard: StaleCard = {
        id: card.id,
        title: card.title,
        board: card.boardName,
        collection: card.collectionName,
        stage: card.stage,
        column: card.column,
        assignees: card.assignees,
        due: card.due,
        daysSinceUpdate: days,
        group: (card.assignees?.length ?? 0) > 0 ? 'assigned-stale' : 'unassigned-stale',
      };
      if (staleCard.group === 'assigned-stale') {
        assignedStale.push(staleCard);
      } else {
        unassignedStale.push(staleCard);
      }
    }
  }

  // Sort by staleness (most stale first). Every `daysSinceUpdate` here is a
  // measured age, so the order is a real ranking.
  assignedStale.sort((a, b) => b.daysSinceUpdate - a.daysSinceUpdate);
  unassignedStale.sort((a, b) => b.daysSinceUpdate - a.daysSinceUpdate);

  const result: StaleResult = {
    scope,
    staleDays,
    assignedStale,
    unassignedStale,
    total: assignedStale.length + unassignedStale.length,
    undated,
    generatedAt: new Date().toISOString(),
  };

  return { item: result, human: formatHuman };
}

export function registerStaleCommand(program: Command): void {
  program
    .command('stale')
    .description('Find cards with no recent activity (LLM-first JSON)')
    .option('--board <name>', 'Filter to a specific board')
    .option('--collection <name>', 'Filter to a specific collection')
    .option('--days <n>', 'Inactivity threshold in days', '14')
    .option('--limit <n>', 'Max cards', '1000')
    .action(run(staleHandler));
}

export default registerStaleCommand;
