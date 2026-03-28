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
 *   🚫 Blocked      — cards with blockers or blocked status
 *   ⏰ Due Soon     — cards due within 3 days
 */

import { Command } from 'commander';
import { createFavroClient } from '../lib/client-factory';
import { logError } from '../lib/error-handler';
import StandupAPI, { type StandupCard } from '../api/standup';

function formatCardLine(card: StandupCard): string {
  const id = card.id.slice(0, 12).padEnd(12);
  const title = card.title.length > 50
    ? card.title.slice(0, 47) + '...'
    : card.title;
  const assignees = (card.assignees ?? []).length > 0
    ? ` — ${card.assignees!.join(', ')}`
    : '';
  return `  ${id}  ${title}${assignees}`;
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

export function registerStandupCommand(program: Command): void {
  program
    .command('standup')
    .description(
      'Daily standup view — cards grouped by status.\n\n' +
      'Groups:\n' +
      '  ✅ Completed   — done, closed, released\n' +
      '  🚧 In Progress — in progress, in review\n' +
      '  🚫 Blocked     — cards with blockers\n' +
      '  ⏰ Due Soon    — due within 3 days\n\n' +
      'Examples:\n' +
      '  favro standup\n' +
      '  favro standup --board "Sprint 42"\n' +
      '  favro standup --board boards-1234 --json'
    )
    .option('--board <name>', 'Board name or ID (uses default if omitted)')
    .option('--json', 'Output as JSON')
    .option('--limit <number>', 'Maximum cards to fetch (default 500)', '500')
    .action(async (options) => {

      const board = options.board;
      if (!board) {
        console.error('Error: --board <name> is required. Use `favro boards list` to find board names.');
        process.exit(1);
      }

      try {
        const cardLimit = parseInt(options.limit, 10) || 500;
        const client = await createFavroClient();
        const api = new StandupAPI(client);

        const result = await api.getStandup(board, cardLimit);

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        // Human-readable standup output
        console.log(`\n📋 Standup: ${result.board.name}`);
        console.log(`   ${result.total} total cards · ${new Date(result.generatedAt).toLocaleString()}`);

        printGroup('Completed', '✅', result.completed);
        printGroup('In Progress', '🚧', result.inProgress);
        printGroup('Blocked', '🚫', result.blocked);
        printGroup('Due Soon', '⏰', result.dueSoon);

        console.log('');
      } catch (err) {
        logError(err);
        process.exit(1);
      }
    });
}
