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
import FavroHttpClient from '../lib/http-client';
import { resolveApiKey } from '../lib/config';
import { logError, missingApiKeyError } from '../lib/error-handler';
import SprintPlanAPI, { type SprintCard } from '../api/sprint-plan';

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
      '  favro sprint-plan --board "My Board" --json'
    )
    .option('--board <name>', 'Board name or ID (required)')
    .option('--budget <points>', 'Sprint point budget (default 40)', '40')
    .option('--json', 'Output as JSON')
    .option('--limit <number>', 'Maximum cards to fetch (default 500)', '500')
    .action(async (options) => {
      const token = await resolveApiKey();
      if (!token) {
        console.error(`Error: ${missingApiKeyError()}`);
        process.exit(1);
      }

      const board = options.board;
      if (!board) {
        console.error('Error: --board <name> is required. Use `favro boards list` to find board names.');
        process.exit(1);
      }

      const budget = parseInt(options.budget, 10);
      if (isNaN(budget) || budget < 1) {
        console.error('Error: --budget must be a positive number.');
        process.exit(1);
      }

      try {
        const cardLimit = parseInt(options.limit, 10) || 500;
        const client = new FavroHttpClient({ auth: { token } });
        const api = new SprintPlanAPI(client);

        const result = await api.getSuggestions(board, budget, cardLimit);

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        // Human-readable sprint plan output
        const backlogTotal = result.suggestions.length + result.overflow.length;
        console.log(`\n🗓️  Sprint Plan: ${result.board.name}`);
        console.log(`   Budget: ${budget} pts · ${backlogTotal} backlog cards · ` +
          `${result.suggestions.length} fit in budget (${result.totalSuggested} pts)`);

        if (result.suggestions.length === 0 && result.overflow.length === 0) {
          console.log('\n  (no backlog cards found)');
          console.log('');
          return;
        }

        // Print column header
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

        console.log('');
      } catch (err) {
        logError(err);
        process.exit(1);
      }
    });
}
