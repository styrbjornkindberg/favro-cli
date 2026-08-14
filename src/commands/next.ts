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
import { AggregateCard, workItemKey } from '../api/aggregate';
import { extractEffort } from '../api/context';
import { fieldNamesUnavailable } from '../lib/custom-field-map';
import { Unreachable } from '../lib/read-shape';
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
  /**
   * Parts of the read that failed, and therefore cards this ranking never
   * considered (#149). Present only when non-empty, so an absent marker means
   * `suggestions` was ranked over the whole candidate pool.
   */
  unreachable?: Unreachable[];
  generatedAt: string;
}

/**
 * `label` is `'unset'` only where the fields were READ and held no priority.
 * Where the payload names a field by id alone, nothing could be matched against
 * `/priority|urgency|severity/` and the answer is `'unavailable'` (#169) — the
 * same split `addEffort` makes between a measured 0 and no measurement.
 */
export function extractPriority(card: AggregateCard): { label: string; score: number } {
  for (const [key, val] of Object.entries(card.customFields ?? {})) {
    if (/priority|urgency|severity/i.test(key)) {
      const v = String(val).toLowerCase();
      if (/critical|blocker/i.test(v)) return { label: v, score: 4 };
      if (/high/i.test(v)) return { label: v, score: 3 };
      if (/medium|normal/i.test(v)) return { label: v, score: 2 };
      if (/low/i.test(v)) return { label: v, score: 1 };
    }
  }
  return { label: fieldNamesUnavailable(card.customFields) ? 'unavailable' : 'unset', score: 0 };
}

export function scoreCard(card: AggregateCard): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  // Priority (4x weight)
  const priority = extractPriority(card);
  score += priority.score * 4;
  if (priority.score > 0) reasons.push(`priority: ${priority.label}`);
  // Two of the three weighted terms read the same custom fields, so when the
  // payload names them by id alone BOTH are silently absent from the score.
  // Said out loud rather than left to look like a card nothing weighed (#169).
  else if (priority.label === 'unavailable') {
    reasons.push('priority and effort unreadable — ranked on due date and stage only');
  }

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

  // Off `unreachable` itself, so human mode cannot present a ranking as complete
  // that the JSON marks partial (#117's half).
  if (data.unreachable?.length) {
    lines.push(`\n  Not considered — ${data.unreachable.length} part(s) of this scope could not be read:`);
    for (const hole of data.unreachable) lines.push(`     ${hole.id} — ${hole.reason}`);
  }

  return lines.join('\n');
}

interface NextOptions {
  collection?: string;
  count: string;
}

export async function nextHandler(ctx: Ctx, options: NextOptions) {
  const userId = await resolveUserId();
  if (!userId) {
    throw new Error('userId not configured. Run `favro auth login` to resolve your identity.');
  }

  const count = parseInt(options.count, 10) || 5;

  let snapshot;
  if (options.collection) {
    snapshot = await ctx.api.aggregate.getCollectionSnapshot(options.collection);
  } else if (ctx.config.scopeCollectionId) {
    snapshot = await ctx.api.aggregate.getMultiBoardSnapshot({ collectionIds: [ctx.config.scopeCollectionId] });
  } else {
    snapshot = await ctx.api.aggregate.getMultiBoardSnapshot({});
  }

  // What a hole does to `next`: the card is NOT ranked, and the hole is named
  // beside the ranking (#149).
  //
  // Not ranking it is already what the filter below does — a card whose board's
  // columns read failed has no `stage`, so `CANDIDATE_STAGES.includes('')` is
  // false — and it is the right answer: a recommendation needs to know the card
  // is not already finished, and this pool cannot say. There is deliberately no
  // `excludeUnreadableBoards` call, because it would drop exactly the cards this
  // filter has already dropped and would read as a second, different rule.
  //
  // What was missing is the saying-so. The pool shrank silently and `next` then
  // recommended off the remainder with the same confidence as off a whole one,
  // so an agent could not tell "nothing else is worth picking up" from "the board
  // holding your real next task went dark". The marker below is that difference.
  //
  // No exit code, for the reason `workload` and `stale` have none: `next` states
  // a suggestion, not a verdict, so its exit code has never carried an answer and
  // making it one would be a new claim rather than a fix.

  // Filter to my cards in candidate stages
  const myCards = snapshot.allCards.filter(c =>
    (c.assignees?.includes(userId) || c.owner === userId) &&
    CANDIDATE_STAGES.includes(c.stage ?? ''),
  );

  // Score and rank
  const scored = myCards.map(c => {
    const { score, reasons } = scoreCard(c);
    return {
      key: workItemKey(c),
      card: {
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
      } as ScoredCard,
    };
  });

  scored.sort((a, b) => b.card.score - a.card.score);

  // One work item is one recommendation (#167 item 3). The snapshot carries a
  // row per board instance, and both rows of a two-board card share a title,
  // due date, priority and effort — so they score identically, sort adjacently,
  // and would spend two of `--count`'s five slots on one thing an agent reads as
  // its five most important. Sorted first, so the surviving instance is the
  // best-scoring one; its `board` is on the row, so the pick still says where to
  // go. `total` counts what was ranked, not the rows it was ranked from.
  //
  // The `key` never reaches the output: `ScoredCard` is the wire shape.
  const ranked: ScoredCard[] = [];
  const seen = new Set<string>();
  for (const { key, card } of scored) {
    if (seen.has(key)) continue;
    seen.add(key);
    ranked.push(card);
  }

  const result: NextResult = {
    userId,
    suggestions: ranked.slice(0, count),
    total: ranked.length,
    ...(snapshot.unreachable?.length ? { unreachable: snapshot.unreachable } : {}),
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
    .action(run(nextHandler));
}

export default registerNextCommand;
