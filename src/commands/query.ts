/**
 * Semantic Query CLI Command
 * CLA-1798 / FAVRO-036: Semantic Query Command
 *
 * Usage:
 *   favro query <board> <natural language query>
 *   favro query "Sprint 42" "status:done"
 *   favro query boards-1234 "blocked cards"
 *   favro query "My Board" "assigned to @alice and status:In Progress"
 *
 * Returns matching cards with a human-readable summary.
 * If no cards match, explains why.
 */
import { Command } from 'commander';
import { createFavroClient } from '../lib/client-factory';
import { logError } from '../lib/error-handler';
import QueryAPI from '../api/query';

export function registerQueryCommand(program: Command): void {
  program
    .command('query <board> <query...>')
    .description(
      'Semantic query — search cards on a board with natural language.\n\n' +
      'Supported query patterns:\n' +
      '  status:done                  Cards with a specific status\n' +
      '  assigned:@alice              Cards assigned to a user\n' +
      '  blocked                      Cards that are blocked\n' +
      '  blocking                     Cards that are blocking others\n' +
      '  priority:high                Cards with a priority custom field\n' +
      '  label:bug / tag:bug          Cards with a specific tag/label\n' +
      '  due:overdue                  Cards past their due date\n' +
      '  relates:card-id              Cards related to a specific card\n' +
      '  Free text                    Title/tag search\n\n' +
      'Examples:\n' +
      '  favro query boards-1234 "status:done"\n' +
      '  favro query "Sprint 42" "assigned:@alice"\n' +
      '  favro query "My Board" "blocked cards"\n' +
      '  favro query boards-1234 "high priority status:In Progress"\n' +
      '  favro query "My Board" "relates to feature-x"\n\n' +
      'If no results are found, an explanation is provided.\n' +
      'Use --json to get full card data as JSON.'
    )
    .option('--limit <number>', 'Maximum number of cards to search (default 1000)', '1000')
    .option('--json', 'Output matched cards as JSON')
    .action(async (board: string, queryParts: string[], options) => {

      try {
        const query = queryParts.join(' ');
        const cardLimit = parseInt(options.limit, 10) || 1000;

        const client = await createFavroClient();
        const api = new QueryAPI(client);

        const result = await api.execute(board, query, cardLimit);

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        // Human-readable output
        console.log(result.summary);

        if (result.matches.length > 0) {
          console.log('');
          for (const match of result.matches) {
            const { card, matchReason } = match;
            const status = card.status ? ` [${card.status}]` : '';
            const assignees = card.assignees && card.assignees.length > 0
              ? ` — ${card.assignees.join(', ')}`
              : '';
            const tags = card.tags && card.tags.length > 0
              ? ` #${card.tags.join(' #')}`
              : '';
            console.log(`  • ${card.title}${status}${assignees}${tags}`);
            console.log(`    (${matchReason})`);
          }
        }
      } catch (err) {
        logError(err);
        process.exit(1);
      }
    });
}
