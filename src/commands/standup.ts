/**
 * Standup CLI Command
 * CLA-1799 / FAVRO-037: Standup & Sprint Commands
 *
 * Usage:
 *   favro standup [--board <name>]
 *
 * Lists cards from the specified board grouped by status:
 *   ✅ Completed    — cards with done/closed/released status
 *   🚧 In Progress  — cards with in-progress/review status
 *   🚫 Blocked      — cards in a blocked/on-hold column
 *
 * Dependency edges are shown as a `deps:` count on the card line, never as a
 * blocked state (#61) — nothing clears a Favro edge when the blocker finishes.
 *   ⏰ Due Soon     — cards due within 3 days
 */

import { Command } from 'commander';
import { RefusalError } from '../lib/refusal';
import { Ctx, run } from '../lib/run';
import type { StandupCard, StandupResult } from '../api/standup';

function formatCardLine(card: StandupCard): string {
  const id = card.id.slice(0, 12).padEnd(12);
  const title = card.title.length > 50
    ? card.title.slice(0, 47) + '...'
    : card.title;
  const assignees = (card.assignees ?? []).length > 0
    ? ` — ${card.assignees!.join(', ')}`
    : '';
  // An edge count, not a blocked state (#61).
  const deps = card.dependencies > 0 ? `  [deps: ${card.dependencies}]` : '';
  return `  ${id}  ${title}${assignees}${deps}`;
}

function printGroup(label: string, emoji: string, cards: StandupCard[]): void {
  console.log(`\n${emoji} ${label} (${cards.length})`);
  if (cards.length === 0) {
    console.log('  (none)');
  } else {
    for (const card of cards) {
      console.log(formatCardLine(card));
    }
  }
}

/**
 * The human render. Prints for itself and returns `void` — the runner appends
 * nothing under a formatter that already wrote (`writeHuman`).
 */
function formatHuman(result: StandupResult): void {
  console.log(`\n📋 Standup: ${result.board.name}`);
  console.log(`   ${result.total} total cards · ${new Date(result.generatedAt).toLocaleString()}`);

  printGroup('Completed', '✅', result.completed);
  printGroup('In Progress', '🚧', result.inProgress);
  printGroup('Blocked', '🚫', result.blocked);
  printGroup('Due Soon', '⏰', result.dueSoon);

  // `0 total cards` from a failed fetch and `0 total cards` from an empty board
  // read identically without this (#116).
  if (result.unreachable?.length) {
    console.log(`\n⚠️  Incomplete — ${result.unreachable.length} part(s) of this board could not be read:`);
    for (const u of result.unreachable) console.log(`  ${u.id} — ${u.reason}`);
  }

  console.log('');
}

interface StandupOptions {
  board?: string;
}

/** Exported for a test that reads the `Result` back off a fake `Ctx`. */
export async function standupHandler(ctx: Ctx, options: StandupOptions) {
  if (!options.board) {
    // A RefusalError, not a bare one: the same invocation declines identically,
    // so `retryable: true` would be advice to loop (`refusal.ts`).
    throw new RefusalError(
      '--board <name> is required. Use `favro boards list` to find board names.',
    );
  }

  const result = await ctx.api.standup.getStandup(options.board);

  return { item: result, human: formatHuman };
}

export function registerStandupCommand(program: Command): void {
  program
    .command('standup')
    .description(
      'Daily standup view — cards grouped by status.\n\n' +
      'Groups:\n' +
      '  ✅ Completed   — done, closed, released\n' +
      '  🚧 In Progress — in progress, in review\n' +
      '  🚫 Blocked     — blocked, on hold\n' +
      '  ⏰ Due Soon    — due within 3 days\n\n' +
      'Cards carrying dependency edges show a `deps:` count. That is an edge\n' +
      'count, not a blocked state — a Favro edge is never cleared when the\n' +
      'blocker finishes. Ask the frontier for the live ones:\n' +
      '  favro cards list <board> --filter "unblocked"\n\n' +
      'Examples:\n' +
      '  favro standup --board "Sprint 42"\n' +
      '  favro standup --board boards-1234 --human'
    )
    .option('--board <name>', 'Board name or ID (uses default if omitted)')
    .action(run(standupHandler));
}
