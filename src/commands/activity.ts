/**
 * Activity CLI Commands
 * CLA-1789 FAVRO-027: Comments & Activity API
 *
 * Commands:
 *   favro activity log <board-id> [--since 2h|1d|7d] [--limit N] [--offset N] [--format json|table]
 */
import { Command } from 'commander';
import FavroHttpClient from '../lib/http-client';
import { resolveApiKey } from '../lib/config';
import { logError, missingApiKeyError } from '../lib/error-handler';
import ActivityApiClient, { parseSince, formatTimestamp } from '../api/activity';

export function registerActivityCommand(program: Command): void {
  const activityCmd = program
    .command('activity')
    .description('Board and card activity logs');

  // ─── activity log ──────────────────────────────────────────────────────────
  activityCmd
    .command('log <boardId>')
    .description(
      'Show activity log for a board.\n\n' +
      'Examples:\n' +
      '  favro activity log <boardId>              Show all recent activity\n' +
      '  favro activity log <boardId> --since 2h   Activity in the last 2 hours\n' +
      '  favro activity log <boardId> --since 1d   Activity in the last day\n' +
      '  favro activity log <boardId> --since 7d   Activity in the last 7 days\n' +
      '  favro activity log <boardId> --format json\n' +
      '  favro activity log <boardId> --limit 50 --offset 10\n\n' +
      'Time units: h (hours), d (days), w (weeks)\n' +
      'Tip: Use `favro boards list` to find board IDs.'
    )
    .option('--since <time>', 'Only show activity after: 2h, 1d, 7d, 1w, etc.')
    .option('--limit <n>', 'Maximum number of activity entries (default: 200)', '200')
    .option('--offset <n>', 'Number of entries to skip — for pagination (default: 0)', '0')
    .option('--format <format>', 'Output format: table or json (default: table)', 'table')
    .option('--json', 'Shorthand for --format json')
    .action(async (boardId: string, options) => {
      const verbose = program.opts()?.verbose ?? false;
      try {
        const token = await resolveApiKey();
        if (!token) {
          console.error(`Error: ${missingApiKeyError()}`);
          process.exit(1);
        }

        let since: Date | undefined;
        try {
          since = parseSince(options.since);
        } catch (err: any) {
          console.error(`Error: ${err.message}`);
          process.exit(1);
        }

        const limitRaw = parseInt(options.limit, 10);
        const limit = !isNaN(limitRaw) && limitRaw >= 1 ? limitRaw : 200;

        const offsetRaw = parseInt(options.offset, 10);
        const offset = !isNaN(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

        const format = options.json ? 'json' : (options.format ?? 'table').toLowerCase();
        if (format !== 'json' && format !== 'table') {
          console.error(`Error: Invalid format "${options.format}". Use --format table or --format json`);
          process.exit(1);
        }

        const client = new FavroHttpClient({ auth: { token } });
        const api = new ActivityApiClient(client);

        const entries = await api.getBoardActivity(boardId, since, limit, offset);

        if (format === 'json') {
          console.log(JSON.stringify(entries, null, 2));
          return;
        }

        // Table format
        if (entries.length === 0) {
          const sinceMsg = since ? ` since ${since.toISOString()}` : '';
          console.log(`No activity found for board "${boardId}"${sinceMsg}.`);
          return;
        }

        const sinceLabel = options.since ? ` (last ${options.since})` : '';
        const offsetLabel = offset > 0 ? ` [offset: ${offset}]` : '';
        console.log(`\n📋 Activity log for board "${boardId}"${sinceLabel}${offsetLabel} — ${entries.length} entry/entries:\n`);

        for (const entry of entries) {
          const ts = formatTimestamp(entry.createdAt);
          const author = entry.author ? ` by ${entry.author}` : '';
          const cardRef = entry.cardId ? ` (card: ${entry.cardId})` : '';
          console.log(`  [${(entry.type ?? 'activity').toUpperCase()}]${author} — ${ts}`);
          if (entry.cardName) {
            console.log(`    Card: ${entry.cardName}${cardRef}`);
          } else if (entry.cardId) {
            console.log(`    Card: ${entry.cardId}`);
          }
          console.log(`    ${entry.description}`);
          console.log();
        }

        console.log(`Total: ${entries.length} entry/entries shown.`);
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });
}

export default registerActivityCommand;
