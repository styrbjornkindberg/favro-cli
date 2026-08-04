/**
 * `favro my-cards` — Developer Persona: Cross-board personal card view
 * v2.0 LLM-first command: outputs JSON by default.
 */
import { Command } from 'commander';
import { resolveUserId } from '../lib/config';
import { AggregateCard } from '../api/aggregate';
import { Unreachable } from '../lib/read-shape';
import { Ctx, run } from '../lib/run';

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
  /**
   * Parts of the read that failed (#149). The cards are all still listed above —
   * a card whose stage is unknown is still a real card assigned to me — so this
   * marker is about `suggestedNext`, which could not rank them.
   *
   * Present only when non-empty, and that is what makes an absent `suggestedNext`
   * readable: absent with no marker means there is genuinely nothing queued to
   * pick up, absent WITH one means the ranking had nothing it could rank
   * (`read-shape.ts` rule 3, applied to a single field instead of a list).
   */
  unreachable?: Unreachable[];
  generatedAt: string;
}

function filterMyCards(cards: AggregateCard[], userId: string): AggregateCard[] {
  return cards.filter(c =>
    c.assignees?.includes(userId) || c.owner === userId,
  );
}

function pickSuggestedNext(cards: AggregateCard[]): MyCardsResult['suggestedNext'] {
  // What a hole does to `my-cards`: the cards STAY LISTED and only this
  // suggestion degrades (#149). `filterMyCards` is not stage-gated, so nothing
  // above had to change — dropping a card because its board's columns read
  // failed would delete my own work from my own list, which is exactly why #148
  // refused to apply the exclusion at the producer.
  //
  // Here the stage IS load-bearing: the three-stage gate below is what keeps a
  // finished card from being recommended as the thing to do next, and a card
  // with no stage cannot pass it honestly. So it stays out of the ranking, and
  // the handler reports `unreachable` so an absent or lower-ranked suggestion is
  // not read as a complete one.
  //
  // Deliberately NOT withheld outright when a hole exists: the usual shape of
  // this failure is one dark board out of a dozen, and refusing to suggest
  // anything would trade a stated partial answer for no answer at all. The
  // suggestion is the best of what was readable; the marker says how much that
  // was.

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

  // Printed whether or not a suggestion was made, and off `unreachable` itself:
  // human mode must not read as a complete pick when the JSON says partial
  // (#117's half).
  if (data.unreachable?.length) {
    lines.push(`\n  Not ranked — ${data.unreachable.length} part(s) of this scope could not be read:`);
    for (const hole of data.unreachable) lines.push(`     ${hole.id} — ${hole.reason}`);
  }

  return lines.join('\n');
}

interface MyCardsOptions {
  collection?: string;
  status?: string;
}

export async function myCardsHandler(ctx: Ctx, options: MyCardsOptions) {
  const userId = await resolveUserId();
  if (!userId) {
    throw new Error('userId not configured. Run `favro auth login` to resolve your identity.');
  }

  let snapshot;
  if (options.collection) {
    snapshot = await ctx.api.aggregate.getCollectionSnapshot(options.collection);
  } else if (ctx.config.scopeCollectionId) {
    snapshot = await ctx.api.aggregate.getMultiBoardSnapshot({ collectionIds: [ctx.config.scopeCollectionId] });
  } else {
    snapshot = await ctx.api.aggregate.getMultiBoardSnapshot({});
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
    ...(snapshot.unreachable?.length ? { unreachable: snapshot.unreachable } : {}),
    generatedAt: new Date().toISOString(),
  };

  return { item: result, human: formatHuman };
}

export function registerMyCardsCommand(program: Command): void {
  program
    .command('my-cards')
    .description('Show your cards across all boards (LLM-first JSON output)')
    .option('--collection <name>', 'Filter to a specific collection')
    .option('--status <filter>', 'Filter by workflow stage (e.g., active, queued)')
    .action(run(myCardsHandler));
}

export default registerMyCardsCommand;
