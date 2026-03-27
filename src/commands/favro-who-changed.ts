/**
 * Who-Changed Command — FAVRO-040
 * CLA-1802: `favro who-changed "<card-title>"`
 *
 * Displays the full edit history for a card, found by title substring match.
 * Shows timestamps in both relative and absolute (ISO 8601) format.
 */
import { Command } from 'commander';
import FavroHttpClient from '../lib/http-client';
import AuditAPI, { formatTimestamp } from '../lib/audit-api';
import { logError, missingApiKeyError } from '../lib/error-handler';
import { resolveApiKey } from '../lib/config';

export function registerWhoChangedCommand(program: Command): void {
  program
    .command('who-changed <cardTitle>')
    .description(
      'Show full edit history for a card, searched by title.\n\n' +
      'Examples:\n' +
      '  favro who-changed "Fix login bug"\n' +
      '  favro who-changed "login" --board <boardId>\n' +
      '  favro who-changed "My card" --json\n\n' +
      'Tip: Use a distinctive part of the card title for a precise match.\n' +
      '     If multiple cards match, all are shown.'
    )
    .option('--board <id>', 'Restrict search to a specific board ID')
    .option('--limit <n>', 'Maximum history entries per card', '200')
    .option('--json', 'Output as JSON')
    .action(async (cardTitle: string, options) => {
      const verbose = program.parent?.opts()?.verbose ?? program.opts()?.verbose ?? false;
      try {
        const token = await resolveApiKey();
        if (!token) {
          console.error(`Error: ${missingApiKeyError()}`);
          process.exit(1);
        }

        const limitRaw = parseInt(options.limit, 10);
        const limit = isNaN(limitRaw) || limitRaw < 1 ? 200 : limitRaw;

        const client = new FavroHttpClient({ auth: { token } });
        const api = new AuditAPI(client);

        const results = await api.getCardHistory(cardTitle, options.board, limit);

        if (results.length === 0) {
          console.error(`✗ No cards found matching "${cardTitle}".`);
          if (options.board) {
            console.error(`  (searched board: ${options.board})`);
          }
          process.exit(1);
        }

        if (options.json) {
          const out = results.map(r => ({
            card: { cardId: r.card.cardId, name: r.card.name },
            history: r.entries,
          }));
          console.log(JSON.stringify(out, null, 2));
          return;
        }

        for (const { card, entries } of results) {
          console.log(`\n📝 History for: "${card.name}" (${card.cardId})`);
          console.log('─'.repeat(60));

          if (entries.length === 0) {
            console.log('  No change history available for this card.');
            continue;
          }

          for (const entry of entries) {
            const ts = formatTimestamp(entry.timestamp);
            const author = entry.author ? ` by ${entry.author}` : '';
            console.log(`  [${(entry.changeType ?? 'unknown').toUpperCase()}]${author}`);
            console.log(`    When:    ${ts}`);
            console.log(`    What:    ${entry.description}`);
            console.log();
          }

          console.log(`  Total: ${entries.length} change(s).`);
        }

        if (results.length > 1) {
          console.log(`\n${results.length} card(s) matched "${cardTitle}".`);
        }
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });
}

export default registerWhoChangedCommand;
