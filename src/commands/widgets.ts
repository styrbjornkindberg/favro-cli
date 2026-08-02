/**
 * Widgets Commands
 * CLA-1801 FAVRO-XXX: Widgets Endpoints
 *
 * favro widgets list --card <card>
 * favro widgets add <board> <card>
 */
import { Command } from 'commander';
import WidgetsAPI from '../lib/widgets-api';
import { createFavroClient } from '../lib/client-factory';
import { logError } from '../lib/error-handler';
import BoardsAPI from '../lib/boards-api';
import { checkResolvedScope, confirmAction, dryRunLog } from '../lib/safety';
import { capRows, noteTruncation, writeEnvelope } from '../lib/read-shape';

export function registerWidgetsCommands(program: Command): void {
  const widgetsCommand = program.command('widgets').description('Manage card widget instances directly');

  widgetsCommand
    .command('list')
    .description('List all board widgets/instances of a specific card')
    .requiredOption('--card <card>', 'The central cardCommonId to trace')
    .option('--limit <n>', 'Cap how many rows are printed; sets "truncated"')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const verbose = widgetsCommand.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();
        const api = new WidgetsAPI(client);
        const widgets = await api.listWidgetsForCard(options.card);
        // The fetch already ran to completion; `--limit` cuts the PRINT (#99).
        const envelope = capRows(widgets, options.limit);

        if (options.json) {
          writeEnvelope(envelope, Boolean(program.opts()?.pretty));
        } else {
          console.log(`Found ${envelope.rows.length} widget(s) for card ${options.card}:`);
          const rows = envelope.rows.map(w => ({
            BoardID: w.boardId || (w.collectionIds ? w.collectionIds.join(',') : '—'),
            WidgetID: w.widgetCommonId,
            Type: w.type,
            Name: w.name,
          }));
          console.table(rows);
          noteTruncation(envelope, widgets.length);
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  widgetsCommand
    .command('add <board> <card>')
    .description('Add an existing card to a new board, by board name or boardId (creates a new linked widget)')
    .option('--column <columnId>', 'Specific column ID to place the widget in')
    .option('--json', 'Output as JSON')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass bounds checking')
    .action(async (board: string, cardCommonId: string, options) => {
      const verbose = widgetsCommand.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();

        // The lock checks a `widgetCommonId`, so a NAME has to settle before it
        // — `GET /widgets/Backlog - Web Hub` 404s and the lock then reports
        // "Board … not found", a refusal naming the wrong problem (#82). The
        // thunk keeps an unlocked user off the network entirely.
        await checkResolvedScope(client, () => new BoardsAPI(client).resolveBoardId(board), options.force);

        if (options.dryRun) {
          dryRunLog('adding', 'widget', `card "${cardCommonId}" to board ${board}`);
          process.exit(0);
        }

        if (!(await confirmAction(`Add card ${cardCommonId} to board ${board}?`, { yes: options.yes }))) {
          process.exit(0);
        }

        const api = new WidgetsAPI(client);
        const widget = await api.addWidgetToBoard(board, cardCommonId, options.column);

        if (options.json) {
          console.log(JSON.stringify(widget, null, 2));
        } else {
          console.log(`✓ Widget added to board (${widget.widgetCommonId})`);
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });
}
