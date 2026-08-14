/**
 * Sprint Plan CLI Command
 * CLA-1799 / FAVRO-037: Standup & Sprint Commands
 *
 * Usage:
 *   favro sprint-plan [--board <name>] [--budget <points>]
 *
 * Lists backlog cards sorted by suggested sprint order (priority×effort heuristic).
 * Defaults: budget=40 points.
 *
 * Output includes:
 *   - Cards within budget (suggestions)
 *   - Cards that overflow budget
 *   - Running effort total
 */

import { Command } from 'commander';
import { PRIORITY_VOCABULARY } from '../api/context';
import { EFFORT_UNAVAILABLE_NOTE } from '../lib/custom-field-map';
import { parseLimit } from '../lib/read-shape';
import { RefusalError } from '../lib/refusal';
import { Ctx, run } from '../lib/run';
import type { SprintCard, SprintPlanResult } from '../api/sprint-plan';

/** Width of the priority cell. 11 so `unavailable` prints as the word (#169). */
const PRIORITY_COL = 11;

function formatSprintCard(card: SprintCard, index: number): string {
  const num = String(index + 1).padStart(2);
  const id = card.id.slice(0, 12).padEnd(12);
  const title = card.title.length > 45
    ? card.title.slice(0, 42) + '...'
    : card.title.padEnd(45);
  const effort = card.effort !== undefined ? String(card.effort).padStart(3) + 'pt' : '  —  ';
  // No `—` fallback: since the `readPriority` merge the label is always a non-empty
  // string (`unset` / `unavailable` / the value), so the old branch was dead.
  const priority = (card.priority ?? 'unset').slice(0, PRIORITY_COL).padEnd(PRIORITY_COL);
  return `  ${num}. ${id}  ${title}  ${priority}  ${effort}`;
}

/**
 * The human render. Prints for itself and returns `void`, so the runner appends
 * nothing under it.
 */
function formatHuman(result: SprintPlanResult): void {
  const backlogTotal = result.suggestions.length + result.overflow.length;
  // No total means "N fit in budget" is a claim nothing behind it supports (#169).
  const unreadable = result.totalSuggested === null;
  // THREE states, not two. `addEffort`'s `null` is sticky but POSITIONAL: a card
  // measured to overflow can be ranked before the first unreadable one, so
  // `overflow` is non-empty while the total is `null` — and "no budget cut made"
  // then printed four lines above the cut it made.
  const unmeasured = result.suggestions.filter(c => c.withinBudget === null).length;
  // Branch (c) said `budget not applied` — but a card measured to FIT can rank
  // before the first unreadable one, so `withinBudget: true` sits in the JSON of
  // the same run. Keyed on the same fact the section header uses: nothing was
  // excluded, which is all an empty `overflow` establishes.
  const verdict = !unreadable
    ? `${result.suggestions.length} fit in budget (${result.totalSuggested} pts)`
    : result.overflow.length
      ? `budget applied until effort ran out — ${unmeasured} card(s) unmeasured`
      : `no card excluded — ${unmeasured} card(s) unmeasured`;
  console.log(`\n🗓️  Sprint Plan: ${result.board.name}`);
  console.log(`   Budget: ${result.budget} pts · ${backlogTotal} backlog cards · ${verdict}`);

  // Named before the early return below: "no backlog cards found" over a board
  // whose card fetch died is advice, not an answer (#116).
  const holes = (): void => {
    if (!result.unreachable?.length) return;
    console.log(`\n  ⚠️  Incomplete — ${result.unreachable.length} part(s) of this board could not be read:`);
    for (const u of result.unreachable) console.log(`    ${u.id} — ${u.reason}`);
  };

  if (result.suggestions.length === 0 && result.overflow.length === 0) {
    console.log('\n  (no backlog cards found)');
    holes();
    console.log('');
    return;
  }

  const header = `  #.  ${'Card ID'.padEnd(12)}  ${'Title'.padEnd(45)}  ${'Priority'.padEnd(PRIORITY_COL)}  Effort`;
  console.log(!unreadable
    ? `\n  ✅ Within budget (${result.suggestions.length} cards, ${result.totalSuggested} pts):`
    : result.overflow.length
      ? `\n  📋 Ranked backlog (${result.suggestions.length} cards, ${unmeasured} not measured against budget):`
      : `\n  📋 Ranked backlog (${result.suggestions.length} cards, no budget cut made):`);
  console.log(header);
  console.log('  ' + '─'.repeat(header.length - 2));

  if (result.suggestions.length === 0) {
    console.log('  (none fit within budget)');
  } else {
    result.suggestions.forEach((card, i) => {
      console.log(formatSprintCard(card, i));
    });
  }

  if (result.overflow.length > 0) {
    console.log(`\n  ⚠️  Over budget (${result.overflow.length} cards excluded):`);
    console.log(header);
    console.log('  ' + '─'.repeat(header.length - 2));
    result.overflow.forEach((card, i) => {
      console.log(formatSprintCard(card, i));
    });
  }

  // Human mode must not print a word the JSON's `null` explains nowhere — the
  // same note `workload` and `team` print, from the one place it lives (#169).
  if (unreadable) console.log(`\n  ${EFFORT_UNAVAILABLE_NOTE}`);

  // The other half of the same payload, and the one that decides ORDER:
  // `compareSprintCards` reads `priorityScore` first, so a card with no score ranks
  // as if unset and the list stops being the priority×effort ranking `--help`
  // advertises. TWO reasons a score is `null` and they are not the same sentence —
  // a name that could not be matched, and a name that was matched onto a value
  // outside the vocabulary (`readPriority`).
  const ranked = [...result.suggestions, ...result.overflow];
  const unavailable = ranked.filter(c => c.priority === 'unavailable').length;
  const unranked = ranked.filter(c => c.priorityScore === null && c.priority !== 'unavailable');
  if (unavailable) {
    console.log(`\n  ⚠️  Priority "unavailable" on ${unavailable} card(s) — no priority field could be ` +
      'matched by name, so those rank as if unset and the order above is not the priority×effort ranking.');
  }
  if (unranked.length) {
    console.log(`\n  ⚠️  Priority outside the scored vocabulary (${PRIORITY_VOCABULARY}) on ` +
      `${unranked.length} card(s) — ${[...new Set(unranked.map(c => c.priority))].join(', ')}. ` +
      'Read, reported, and ranked as if unset.');
  }

  holes();
  console.log('');
}

interface SprintPlanOptions {
  board?: string;
  budget?: string;
}

/** Exported for a test that reads the `Result` back off a fake `Ctx`. */
export async function sprintPlanHandler(ctx: Ctx, options: SprintPlanOptions) {
  // Both declines are deterministic — the same invocation refuses identically —
  // so they are `RefusalError`, which is what makes `retryable` false.
  if (!options.board) {
    throw new RefusalError(
      '--board <name> is required. Use `favro boards list` to find board names.',
    );
  }

  // `parseLimit`, not `parseInt`: `parseInt` takes a numeric PREFIX and stops,
  // so `--budget 1e9` planned a ONE-POINT sprint and `--budget 40abc` silently
  // became 40 — a well-formed, plausible, wrong answer, which is the defect
  // class `read-shape.ts` names. Whole digits or a refusal, nothing between.
  //
  // The local `if (budget === undefined) throw` this used to carry is gone:
  // since #142 `parseLimit` raises the refusal itself, naming the flag it was
  // given, so a second wording here would be two spellings of one decline.
  const budget = parseLimit(options.budget, '--budget') ?? 40;

  const result = await ctx.api.sprintPlan.getSuggestions(options.board, budget);

  return { item: result, human: formatHuman };
}

export function registerSprintPlanCommand(program: Command): void {
  program
    .command('sprint-plan')
    .description(
      'Sprint planning — suggests backlog cards by priority×effort heuristic.\n\n' +
      'Filters cards with status="Backlog" and sorts by:\n' +
      `  1. Priority (${PRIORITY_VOCABULARY})\n` +
      '  2. Effort (lower first — feasibility-first)\n\n' +
      'Both terms are custom fields matched BY NAME — a field whose name contains\n' +
      'priority, urgency or severity for the first, and effort, estimate, points or\n' +
      'story points for the second. A priority OUTSIDE the vocabulary above is\n' +
      'reported as itself and ranks nowhere.\n\n' +
      'The card payload is measured to name its fields by id alone. Where no name\n' +
      'can be matched the ranking says so — priority reads "unavailable" and no\n' +
      'budget total is claimed — rather than scoring the miss as a zero.\n\n' +
      'Shows which cards fit in the budget and which overflow.\n\n' +
      'Examples:\n' +
      '  favro sprint-plan --board "Sprint 42"\n' +
      '  favro sprint-plan --board boards-1234 --budget 20\n' +
      '  favro sprint-plan --board "My Board" --human'
    )
    .option('--board <name>', 'Board name or ID (required)')
    .option('--budget <points>', 'Sprint point budget (default 40)', '40')
    .action(run(sprintPlanHandler));
}
