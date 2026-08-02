/**
 * Activity CLI Commands
 * CLA-1789 FAVRO-027: Comments & Activity API
 *
 * Commands:
 *   favro activity <card> [--since 2h] [--until 1d] [--limit N] [--format json|table]
 *
 * Card-scoped only — Favro has no board-level activity feed (#18).
 */
import { Command } from 'commander';
import { createFavroClient } from '../lib/client-factory';
import { logError } from '../lib/error-handler';
import { capRows, noteTruncation, parseLimit, writeEnvelope } from '../lib/read-shape';
import ActivityApiClient, { parseSince, formatTimestamp } from '../api/activity';

/** Parse a relative time window, reporting errors against the flag it came from. */
function parseWindow(value: string | undefined, flag: string): Date | undefined {
  try {
    return parseSince(value);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(message.replace('--since', flag));
  }
}

export function registerActivityCommand(program: Command): void {
  program
    .command('activity <card>')
    .description(
      'Show the activity log for a card.\n\n' +
      'Examples:\n' +
      '  favro activity <card>              All activity on the card\n' +
      '  favro activity <card> --since 2h   Activity in the last 2 hours\n' +
      '  favro activity <card> --until 1d   Activity older than 1 day\n' +
      '  favro activity <card> --format json\n\n' +
      'Time units: h (hours), d (days), w (weeks)\n\n' +
      'Favro has no board-level activity feed, so activity is per card. The feed is\n' +
      'also scoped to what the API-key user follows or has news for, so it is card\n' +
      'history for humans — never a source of truth for a card\'s state.\n' +
      'Tip: use `favro cards find` to get a cardId.'
    )
    .option('--since <time>', 'Only show activity after: 2h, 1d, 7d, 1w, etc.')
    .option('--until <time>', 'Only show activity before: 2h, 1d, 7d, 1w, etc.')
    .option('--limit <n>', 'Cap how many entries are printed (default: 200); sets "truncated"', '200')
    .option('--format <format>', 'Output format: table or json (default: table)', 'table')
    .option('--json', 'Shorthand for --format json')
    .action(async (cardId: string, options) => {
      const verbose = program.opts()?.verbose ?? false;
      try {
        // `favro activity log <boardId>` was the old form. Without this it would
        // be read as a cardId of "log" and fail with an opaque 403.
        if (cardId === 'log') {
          console.error(
            'Error: `favro activity log <boardId>` is gone — Favro has no board-level\n' +
            'activity feed (the endpoint it used answers 404). Activity is per card:\n' +
            '  favro activity <card>'
          );
          process.exit(1);
          return;
        }

        // Parse the window client-side — Favro answers 400 on an unparseable value.
        let since: Date | undefined;
        let until: Date | undefined;
        try {
          since = parseWindow(options.since, '--since');
          until = parseWindow(options.until, '--until');
        } catch (err: unknown) {
          console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(1);
        }

        // `parseLimit`, not a local `parseInt`: the prefix parse read
        // `--limit 1e9` as 1 and printed one entry marked `truncated` (#99).
        const limit = parseLimit(options.limit) ?? 200;

        const format = options.json ? 'json' : (options.format ?? 'table').toLowerCase();
        if (format !== 'json' && format !== 'table') {
          console.error(`Error: Invalid format "${options.format}". Use --format table or --format json`);
          process.exit(1);
        }

        const client = await createFavroClient();
        const api = new ActivityApiClient(client);

        const entries = await api.getCardActivity(cardId, { since, until });
        // The read already returned the whole feed; `--limit` cuts the PRINT,
        // and the cut says so (#99). It used to slice inside the client.
        const envelope = capRows(entries, limit);
        const shown = envelope.rows;

        if (format === 'json') {
          writeEnvelope(envelope, Boolean(program.opts()?.pretty));
          return;
        }

        if (shown.length === 0) {
          const window = since ? ` since ${since.toISOString()}` : '';
          console.log(
            `No activity found for card "${cardId}"${window}.\n` +
            'Note: the feed only carries activity the API-key user follows or has news for.'
          );
          return;
        }

        const cardName = shown[0].cardName;
        const label = cardName ? `${cardName} (${cardId})` : cardId;
        const sinceLabel = options.since ? ` (last ${options.since})` : '';
        console.log(`\n📋 Activity for ${label}${sinceLabel} — ${shown.length} entry/entries:\n`);

        for (const entry of shown) {
          const ts = formatTimestamp(entry.time);
          const who = entry.byUserId ? ` by ${entry.byUserId}` : '';
          console.log(`  [${(entry.type ?? 'activity').toUpperCase()}]${who} — ${ts}`);
          const where = [entry.widgetName, entry.columnName].filter(Boolean).join(' / ');
          if (where) console.log(`    ${where}`);
          console.log();
        }

        console.log(`Total: ${shown.length} entry/entries shown.`);
        noteTruncation(envelope, entries.length);
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });
}

export default registerActivityCommand;
