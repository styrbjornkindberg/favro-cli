/**
 * `favro stale` — PM/PO Persona: Find stale/inactive cards
 * v2.0 LLM-first command: outputs JSON by default.
 */
import { Command } from 'commander';
import { AggregateCard } from '../api/aggregate';
import { excludeUnreadableBoards, Unreachable } from '../lib/read-shape';
import { Ctx, run } from '../lib/run';
import { daysSince, DEFAULT_STALE_DAYS, isStale, staleWording } from '../lib/time';

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
  /**
   * Parts of the read that failed, and therefore cards this assessment did not
   * see at all (#148) — a different exclusion from `undated`, which is a card
   * we DID read and could not date. Present only when non-empty.
   */
  unreachable?: Unreachable[];
  generatedAt: string;
}

function formatHuman(data: StaleResult): string {
  const lines: string[] = [];
  // Off the same helper as the filter below, not written out beside it: the
  // header used to promise `>${staleDays}` over a set built with `>=` (#145).
  lines.push(`Stale Cards (${staleWording(data.staleDays)}) — ${data.scope}\n`);

  if (data.assignedStale.length > 0) {
    lines.push(`  Assigned but stale (${data.assignedStale.length}):`);
    for (const c of data.assignedStale) {
      const who = c.assignees?.join(', ') ?? 'unknown';
      lines.push(`    • ${c.title} — ${c.board ?? 'unknown board'} (${c.daysSinceUpdate}d ago, assigned: ${who})`);
    }
  }

  if (data.unassignedStale.length > 0) {
    lines.push(`  Unassigned and stale (${data.unassignedStale.length}):`);
    for (const c of data.unassignedStale) {
      lines.push(`    • ${c.title} — ${c.board ?? 'unknown board'} (${c.daysSinceUpdate}d ago)`);
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

  // Same reasoning as `undated` directly above: printed alongside "No stale
  // cards found.", never instead of it.
  if (data.unreachable?.length) {
    lines.push(`  Not read — not assessed (${data.unreachable.length}):`);
    for (const hole of data.unreachable) lines.push(`    • ${hole.id} — ${hole.reason}`);
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
  // `|| 14` let `--days -2` through — a card Favro dated tomorrow then cleared
  // it and reported `daysSinceUpdate: -1`, the value #130 exists to remove —
  // and read `--days 0` as absent. Clamp-to-declared-default, as `context.ts:50`.
  const parsedDays = parseInt(options.days, 10);
  const staleDays = !isNaN(parsedDays) && parsedDays >= 0 ? parsedDays : DEFAULT_STALE_DAYS;
  const cardLimit = parseInt(options.limit, 10) || 1000;

  let snapshot: { allCards: AggregateCard[]; unreachable?: Unreachable[] };
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
      // Carried across, not dropped — #116 records these and this arm was one
      // of the five consumers #117 found throwing them away.
      unreachable: boardSnapshot.unreachable,
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

  // What a hole does to `stale`: the unreadable board's cards are dropped and
  // the hole is named beside `undated`, no exit code — this command finds
  // rather than judges.
  //
  // Dropped rather than assessed: the very first thing the loop below does is
  // `DONE_STAGES.includes(card.stage ?? '')`, and a board with no columns has
  // no stage on anything. Every finished card on it would have sailed past that
  // guard and been reported as a stale card somebody should chase (#148).
  const { cards, unreachable } = excludeUnreadableBoards(snapshot);

  const assignedStale: StaleCard[] = [];
  const unassignedStale: StaleCard[] = [];
  const undated: UndatedCard[] = [];

  for (const card of cards) {
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

    if (isStale(days, staleDays)) {
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
    ...(unreachable.length > 0 ? { unreachable } : {}),
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
    .option('--days <n>', 'Inactivity threshold in days (inclusive)', String(DEFAULT_STALE_DAYS))
    .option('--limit <n>', 'Max cards', '1000')
    .action(run(staleHandler));
}

export default registerStaleCommand;
