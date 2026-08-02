/**
 * Activity CLI Commands
 * CLA-1789 FAVRO-027: Comments & Activity API
 *
 * Commands:
 *   favro activity <card> [--since 2h] [--until 1d] [--limit N] [--human]
 *
 * Card-scoped only — Favro has no board-level activity feed (#18).
 */
import { Command } from 'commander';
import { ActivityEntry, parseSince, formatTimestamp } from '../api/activity';
import { parseLimit } from '../lib/read-shape';
import { RefusalError } from '../lib/refusal';
import { Ctx, run } from '../lib/run';

/** Parse a relative time window, reporting errors against the flag it came from. */
function parseWindow(value: string | undefined, flag: string): Date | undefined {
  try {
    return parseSince(value);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // A malformed window refuses identically on every retry (`refusal.ts`).
    throw new RefusalError(message.replace('--since', flag));
  }
}

interface ActivityOptions {
  since?: string;
  until?: string;
  limit?: string;
}

/** Exported for a test that reads the `Result` back off a fake `Ctx`. */
export async function activityHandler(ctx: Ctx, cardId: string, options: ActivityOptions) {
  // `favro activity log <boardId>` was the old form. Without this it would be
  // read as a cardId of "log" and fail with an opaque 403.
  if (cardId === 'log') {
    throw new RefusalError(
      '`favro activity log <boardId>` is gone — Favro has no board-level\n' +
      'activity feed (the endpoint it used answers 404). Activity is per card:\n' +
      '  favro activity <card>',
    );
  }

  // Parse the window client-side — Favro answers 400 on an unparseable value.
  const since = parseWindow(options.since, '--since');
  const until = parseWindow(options.until, '--until');

  // `parseLimit`, not a local `parseInt`: the prefix parse read `--limit 1e9`
  // as 1 and printed one entry marked `truncated` (#99). The `?? 200` keeps the
  // declared default when the value is unparseable.
  const limit = parseLimit(options.limit) ?? 200;

  // No `limit` on the fetch. It is one call that returns everything Favro has
  // for the card — Favro ignores `limit` on this endpoint — so capping there
  // would hide the cut. `--limit` caps the PRINT and the envelope says
  // `truncated` when it bit (`read-shape.ts`).
  const all = await ctx.api.activity.getCardActivity(cardId, { since, until });

  return {
    rows: all,
    limit,
    human: (entries: ActivityEntry[]) => {
      if (entries.length === 0) {
        const window = since ? ` since ${since.toISOString()}` : '';
        console.log(
          `No activity found for card "${cardId}"${window}.\n` +
          'Note: the feed only carries activity the API-key user follows or has news for.'
        );
        return;
      }

      const cardName = entries[0].cardName;
      const label = cardName ? `${cardName} (${cardId})` : cardId;
      const sinceLabel = options.since ? ` (last ${options.since})` : '';
      console.log(`\n📋 Activity for ${label}${sinceLabel} — ${entries.length} entry/entries:\n`);

      for (const entry of entries) {
        const ts = formatTimestamp(entry.time);
        const who = entry.byUserId ? ` by ${entry.byUserId}` : '';
        console.log(`  [${(entry.type ?? 'activity').toUpperCase()}]${who} — ${ts}`);
        const where = [entry.widgetName, entry.columnName].filter(Boolean).join(' / ');
        if (where) console.log(`    ${where}`);
        console.log();
      }

      // Just the count. The CUT is the runner's line to write — a `human` is
      // handed rows, never the envelope, so `noteTruncation` says it once for
      // every migrated list read rather than each of them re-deriving it (#99).
      console.log(`Total: ${entries.length} entry/entries shown.`);
    },
  };
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
      '  favro activity <card> --human\n\n' +
      'Time units: h (hours), d (days), w (weeks)\n\n' +
      'Favro has no board-level activity feed, so activity is per card. The feed is\n' +
      'also scoped to what the API-key user follows or has news for, so it is card\n' +
      'history for humans — never a source of truth for a card\'s state.\n' +
      'Tip: use `favro cards find` to get a cardId.'
    )
    .option('--since <time>', 'Only show activity after: 2h, 1d, 7d, 1w, etc.')
    .option('--until <time>', 'Only show activity before: 2h, 1d, 7d, 1w, etc.')
    .option('--limit <n>', 'Cap how many entries are printed (default: 200); sets "truncated"', '200')
    // `--format table|json` is gone (ADR-0002, #116): it was a third spelling
    // of `--human`/`--json`, and the runner owns the axis.
    .action(run(activityHandler));
}

export default registerActivityCommand;
