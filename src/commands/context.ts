/**
 * Board Context Snapshot CLI Command
 * CLA-1796 / FAVRO-034: Board Context Snapshot Command
 *
 * Usage:
 *   favro context <board-name|board-id>
 *   favro context <board-name|board-id> --limit 500
 *   favro context <board-name|board-id> --pretty
 *
 * Returns a single JSON object with complete board state for AI workflows:
 *   - Board metadata (id, name, description, type, collection, members list)
 *   - Columns (all columns on the board)
 *   - Custom fields (all custom field definitions with options)
 *   - Members (all board members with roles)
 *   - Cards (full card list with all relationships)
 *   - Stats (card counts by status and owner)
 */
import { Command } from 'commander';
import FavroHttpClient from '../lib/http-client';
import { resolveApiKey } from '../lib/config';
import { logError, missingApiKeyError } from '../lib/error-handler';
import ContextAPI from '../api/context';

export function registerContextCommand(program: Command): void {
  program
    .command('context <board>')
    .description(
      'Get complete board context snapshot for AI workflows.\n\n' +
      'Returns a single JSON object with:\n' +
      '  - Board metadata (id, name, description, members)\n' +
      '  - Columns (all board columns)\n' +
      '  - Custom fields (definitions with allowed values)\n' +
      '  - Members (all board members with roles)\n' +
      '  - Cards (full card list with relationships)\n' +
      '  - Stats (counts by status and owner)\n\n' +
      'Examples:\n' +
      '  favro context boards-1234\n' +
      '  favro context "Sprint 42"\n' +
      '  favro context "My Board" --limit 200\n' +
      '  favro context boards-1234 | jq \'.stats\'\n\n' +
      'Performance: < 1s for 500-card boards (parallel data fetching).\n' +
      'Use: favro boards list to find board IDs.'
    )
    .option('--limit <number>', 'Maximum number of cards to fetch (default: 1000)', '1000')
    .option('--pretty', 'Pretty-print JSON output (default: compact)')
    .action(async (board: string, options) => {
      const verbose = program.opts()?.verbose ?? false;

      const token = await resolveApiKey();
      if (!token) {
        console.error(`Error: ${missingApiKeyError()}`);
        process.exit(1);
      }

      const parsedLimit = parseInt(options.limit ?? '1000', 10);
      const cardLimit = (!isNaN(parsedLimit) && parsedLimit >= 1) ? parsedLimit : 1000;

      try {
        const client = new FavroHttpClient({ auth: { token } });
        const api = new ContextAPI(client);

        const snapshot = await api.getSnapshot(board, cardLimit);

        if (options.pretty) {
          console.log(JSON.stringify(snapshot, null, 2));
        } else {
          console.log(JSON.stringify(snapshot));
        }
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });
}
