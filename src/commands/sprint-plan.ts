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
  const priority = card.priority ? card.priority.slice(0, 8).padEnd(8) : '  —     ';
  return `  ${num}. ${id}  ${title}  ${priority}  ${effort}`;
}

/**
 * The human render. Prints for itself and returns `void`, so the runner appends
 * nothing under it.
 */
function formatHuman(result: SprintPlanResult): void {
  const backlogTotal = result.suggestions.length + result.overflow.length;
  console.log(`\n🗓️  Sprint Plan: ${result.board.name}`);
  console.log(`   Budget: ${result.budget} pts · ${backlogTotal} backlog cards · ` +
    `${result.suggestions.length} fit in budget (${result.totalSuggested} pts)`);

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

  const header = `  #.  ${'Card ID'.padEnd(12)}  ${'Title'.padEnd(45)}  ${'Priority'.padEnd(8)}  Effort`;
  console.log(`\n  ✅ Within budget (${result.suggestions.length} cards, ${result.totalSuggested} pts):`);
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

  holes();
  console.log('');
}

interface SprintPlanOptions {
  board?: string;
  budget?: string;
  limit?: string;
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
  const budget = parseLimit(options.budget ?? '40');
  if (budget === undefined) {
    throw new RefusalError(`--budget must be a positive number, not "${options.budget}".`);
  }

  const cardLimit = parseInt(options.limit ?? '500', 10) || 500;
  const result = await ctx.api.sprintPlan.getSuggestions(options.board, budget, cardLimit);

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
      'Shows which cards fit in the budget and which overflow.\n\n' +
      'Examples:\n' +
      '  favro sprint-plan --board "Sprint 42"\n' +
      '  favro sprint-plan --board boards-1234 --budget 20\n' +
      '  favro sprint-plan --board "My Board" --human'
    )
    .option('--board <name>', 'Board name or ID (required)')
    .option('--budget <points>', 'Sprint point budget (default 40)', '40')
    .option('--limit <number>', 'Maximum cards to fetch (default 500)', '500')
    .action(run(sprintPlanHandler));
}
