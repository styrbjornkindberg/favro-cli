/**
 * `favro my-standup` — Developer Persona: Personal cross-board standup
 * v2.0 LLM-first command: outputs JSON by default.
 */
import { Command } from 'commander';
import { resolveUserId } from '../lib/config';
import { AggregateCard } from '../api/aggregate';
import { Unreachable } from '../lib/read-shape';
import { Ctx, run } from '../lib/run';
import { isBlocked } from '../api/standup';
import { isDoneStage } from '../lib/workflow-stage';

const IN_PROGRESS_STAGES = ['active', 'review', 'testing'];

interface StandupCard {
  id: string;
  title: string;
  board: string;
  collection?: string;
  stage?: string;
  column?: string;
  due?: string;
  group: 'completed' | 'in-progress' | 'blocked' | 'due-soon' | 'stage-unknown';
}

interface MyStandupResult {
  userId: string;
  completed: StandupCard[];
  inProgress: StandupCard[];
  blocked: StandupCard[];
  dueSoon: StandupCard[];
  /**
   * My cards whose workflow stage could not be determined, so no standup claim
   * can be made about them (#149). Always present, `[]` when there are none:
   * this is a bucket of the same set `total` counts, not a hole marker, and the
   * four buckets above are unconditional for the same reason.
   */
  stageUnknown: StandupCard[];
  total: number;
  /**
   * Parts of the read that failed, and therefore the reason a card is in
   * `stageUnknown` (#149). Present only when non-empty — absent has to stay
   * distinguishable from empty (`read-shape.ts` rule 3).
   */
  unreachable?: Unreachable[];
  generatedAt: string;
}

function classifyCard(card: AggregateCard, dueSoonDays: number): StandupCard['group'] {
  // Priority: blocked > completed > due-soon > in-progress
  //
  // A `blockedBy` edge is NOT consulted here (#61). Nothing clears a Favro
  // `isBefore` edge when the blocker finishes, so length-of-edges is a
  // permanent over-count — and sitting above the `completed` check it hid the
  // real stage of finished work. Judging doneness costs a per-blocker sweep
  // (`judgeBlockers`); `cards list --filter unblocked` is the ONLY caller that
  // pays it, a standup summary should not. (`next` used to be named here too
  // and no longer belongs: it dropped its blocking term in #47 and does not
  // import `judgeBlockers` — see the comment at `next.ts:86`. Corrected in
  // #98.)
  //
  // The blocked *state* comes from the same column-name predicate `favro
  // standup` uses, so the two commands cannot disagree about one card. The
  // stage cannot carry it: `WorkflowStage` has no 'blocked' member, and
  // `detectStage('Blocked')` falls through to 'queued'.
  if (isBlocked(card)) return 'blocked';

  // What a hole does to `my-standup`: the card STAYS — it is my card and it is
  // my standup — and it goes in a group that says the stage is unknown rather
  // than into one of the four that assert a state (#149).
  //
  // The line under this function's last `return` used to be reached by every
  // card with no stage, so a board whose columns read failed reported its
  // FINISHED work as in progress in somebody's standup: the same fabrication as
  // #148's red board, in the place a human reads out loud every morning.
  //
  // NOT `excludeUnreadableBoards`, which is what the four consumers #148 fixed
  // do. Dropping the card deletes my own work from my own standup and quietly
  // shrinks `total`, which is the objection #149 raises against fixing this at
  // the producer. And the guard here is the root cause rather than the reported
  // path: `stage === undefined` also covers a card whose column is absent from
  // the workflow on a board that read perfectly, which the board-level exclusion
  // never sees.
  //
  // Placed AFTER `isBlocked` on purpose. That predicate reads `status` — a field
  // Favro sends on the card itself — so it still answers on a dark board, and
  // "blocked" is a truer thing to say about that card than "stage unknown".
  if (card.stage === undefined) return 'stage-unknown';

  if (isDoneStage(card.stage)) return 'completed';

  if (card.due) {
    const daysUntilDue = (new Date(card.due).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    if (daysUntilDue <= dueSoonDays) return 'due-soon';
  }

  if (IN_PROGRESS_STAGES.includes(card.stage)) return 'in-progress';
  // Default for cards assigned to me whose stage IS known and is neither
  // finished nor active — `queued`, `backlog`. Unchanged, and deliberately: the
  // stage was read, so this is a judgement about real data rather than an
  // invention over absent data. Only the missing-stage case moved (#149).
  return 'in-progress';
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
    // Named in human mode too, so the group is not a JSON-only fact — the
    // half #117 found `risks --human` hiding.
    ['Stage unknown — not assessed', data.stageUnknown],
  ];

  for (const [label, cards] of sections) {
    if (cards.length === 0) continue;
    lines.push(`  ${label} (${cards.length}):`);
    for (const c of cards) {
      const due = c.due ? ` [due: ${c.due}]` : '';
      lines.push(`    • ${c.title} — ${c.board}${due}`);
    }
  }

  // Why a card is in `stageUnknown`. Printed after the sections rather than
  // instead of any of them: work was still done and the read still failed, and
  // suppressing either makes the other a lie by omission.
  if (data.unreachable?.length) {
    lines.push(`\n  Not read (${data.unreachable.length}):`);
    for (const hole of data.unreachable) lines.push(`    • ${hole.id} — ${hole.reason}`);
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
  const stageUnknown: StandupCard[] = [];

  for (const card of myCards) {
    const group = classifyCard(card, dueSoonDays);
    const sc = toStandupCard(card, group);
    switch (group) {
      case 'completed': completed.push(sc); break;
      case 'in-progress': inProgress.push(sc); break;
      case 'blocked': blocked.push(sc); break;
      case 'due-soon': dueSoon.push(sc); break;
      case 'stage-unknown': stageUnknown.push(sc); break;
    }
  }

  const result: MyStandupResult = {
    userId,
    completed,
    inProgress,
    blocked,
    dueSoon,
    stageUnknown,
    total: myCards.length,
    // Carried across, not dropped: `stageUnknown` says WHICH of my cards could
    // not be judged and this says why. Non-empty only (#116/#148).
    ...(snapshot.unreachable?.length ? { unreachable: snapshot.unreachable } : {}),
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
