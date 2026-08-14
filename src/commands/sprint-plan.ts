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
import { EFFORT_UNAVAILABLE_NOTE } from '../lib/custom-field-map';
import { parseLimit } from '../lib/read-shape';
import { RefusalError } from '../lib/refusal';
import { Ctx, run } from '../lib/run';
import type { SprintCard, SprintPlanResult } from '../api/sprint-plan';

function formatSprintCard(card: SprintCard, index: number): string {
  const num = String(index + 1).padStart(2);
  const id = card.id.slice(0, 12).padEnd(12);
  const title = card.title.length > 45
    ? card.title.slice(0, 42) + '...'
    : card.title.padEnd(45);
  const effort = card.effort !== undefined ? String(card.effort).padStart(3) + 'pt' : '  —  ';
  // 11, not 8: `unavailable` is now a value this cell carries (#169) and an 8-char
  // slice printed `unavaila`. The header below pads to the same width.
  const priority = card.priority ? card.priority.slice(0, PRIORITY_COL).padEnd(PRIORITY_COL) : '  —' + ' '.repeat(PRIORITY_COL - 3);
  return `  ${num}. ${id}  ${title}  ${priority}  ${effort}`;
}

const PRIORITY_COL = 11;

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
  const verdict = !unreadable
    ? `${result.suggestions.length} fit in budget (${result.totalSuggested} pts)`
    : result.overflow.length
      ? `budget applied until effort ran out — ${unmeasured} card(s) unmeasured`
      : 'budget not applied — effort unavailable';
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
  // `compareSprintCards` reads `priorityScore` first, so cards whose priority
  // could not be matched rank as if unset and the list stops being the
  // priority×effort ranking `--help` advertises. Said out loud rather than left
  // for a reader to infer from a column of `unavailable`.
  const priorityBlind = [...result.suggestions, ...result.overflow]
    .filter(c => c.priorityScore === null).length;
  if (priorityBlind) {
    console.log(`\n  ⚠️  Priority "unavailable" on ${priorityBlind} card(s) — no priority field could be ` +
      'matched by name, so those rank as if unset and the order above is not the priority×effort ranking.');
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
      '  1. Priority (critical > high > medium > low)\n' +
      '  2. Effort (lower first — feasibility-first)\n\n' +
      'Both terms are custom fields matched BY NAME, and the card payload is\n' +
      'measured to name its fields by id alone. Where no name can be matched the\n' +
      'ranking says so — priority reads "unavailable" and no budget total is\n' +
      'claimed — rather than scoring the miss as a zero.\n\n' +
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
