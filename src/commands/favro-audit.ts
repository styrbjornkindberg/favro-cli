/**
 * Audit Command — FAVRO-040
 * CLA-1802: `favro audit <board> [--since 1h|1d|1w]`
 *
 * Displays all changes to a board: cards added/updated, assignments, fields.
 * Supports relative time filter and pagination for large audit logs.
 */
import { Command } from 'commander';
import FavroHttpClient from '../lib/http-client';
import AuditAPI, { parseSince, formatTimestamp } from '../lib/audit-api';
import { logError, missingApiKeyError } from '../lib/error-handler';
import { resolveApiKey } from '../lib/config';

const PAGE_SIZE = 100;

export function registerAuditCommand(program: Command): void {
  program
    .command('audit <board>')
    .description(
      'Show all changes to a board: cards, assignments, and field updates.\n\n' +
      'Examples:\n' +
      '  favro audit <boardId>              Show all recent changes\n' +
      '  favro audit <boardId> --since 1h   Changes in the last hour\n' +
      '  favro audit <boardId> --since 1d   Changes in the last day\n' +
      '  favro audit <boardId> --since 1w   Changes in the last week\n' +
      '  favro audit <boardId> --json       Output as JSON\n' +
      '  favro audit <boardId> --limit 200  Fetch up to 200 entries\n\n' +
      'Tip: Use `favro boards list` to find board IDs.'
    )
    .option('--since <time>', 'Only show changes after: 1h, 1d, 1w')
    .option('--limit <n>', 'Maximum number of audit entries to show', '500')
    .option('--json', 'Output as JSON')
    .option('--page-size <n>', 'Entries per page when displaying (default: 100)', String(PAGE_SIZE))
    .action(async (board: string, options) => {
      const verbose = program.parent?.opts()?.verbose ?? program.opts()?.verbose ?? false;
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
        const limit = isNaN(limitRaw) || limitRaw < 1 ? 500 : limitRaw;
        const pageSizeRaw = parseInt(options.pageSize, 10);
        const pageSize = isNaN(pageSizeRaw) || pageSizeRaw < 1 ? PAGE_SIZE : pageSizeRaw;

        const client = new FavroHttpClient({ auth: { token } });
        const api = new AuditAPI(client);

        const entries = await api.getBoardAuditLog(board, since, limit);

        if (entries.length === 0) {
          const sinceMsg = since ? ` since ${since.toISOString()}` : '';
          console.log(`No audit entries found for board "${board}"${sinceMsg}.`);
          return;
        }

        if (options.json) {
          console.log(JSON.stringify(entries, null, 2));
          return;
        }

        const sinceLabel = options.since ? ` (last ${options.since})` : '';
        console.log(`\n📋 Audit log for board "${board}"${sinceLabel} — ${entries.length} change(s):\n`);

        // Paginate output
        for (let i = 0; i < entries.length; i += pageSize) {
          const page = entries.slice(i, i + pageSize);
          const pageNum = Math.floor(i / pageSize) + 1;
          const totalPages = Math.ceil(entries.length / pageSize);

          if (totalPages > 1) {
            console.log(`── Page ${pageNum} / ${totalPages} ──────────────────────────────────`);
          }

          for (const entry of page) {
            const ts = formatTimestamp(entry.timestamp);
            const author = entry.author ? ` by ${entry.author}` : '';
            console.log(`  [${(entry.changeType ?? 'unknown').toUpperCase()}]${author} — ${ts}`);
            console.log(`    Card: ${entry.cardName} (${entry.cardId})`);
            console.log(`    ${entry.description}`);
            console.log();
          }

          if (totalPages > 1 && pageNum < totalPages) {
            console.log(`  … ${entries.length - i - pageSize} more entries (page ${pageNum + 1}/${totalPages})`);
          }
        }

        console.log(`Total: ${entries.length} change(s) shown.`);
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });
}

export default registerAuditCommand;
