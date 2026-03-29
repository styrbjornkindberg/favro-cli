/**
 * Widgets Commands
 * CLA-1801 FAVRO-XXX: Widgets Endpoints
 *
 * favro widgets list --card <cardCommonId>
 * favro widgets add <boardId> <cardCommonId>
 */
import { Command } from 'commander';
import WidgetsAPI from '../lib/widgets-api';
import { createFavroClient } from '../lib/client-factory';
import { logError } from '../lib/error-handler';
import { checkScope, confirmAction, dryRunLog } from '../lib/safety';
import { readConfig } from '../lib/config';

export function registerWidgetsCommands(program: Command): void {
  const widgetsCommand = program.command('widgets').description('Manage card widget instances directly');

  widgetsCommand
    .command('list')
    .description('List all board widgets/instances of a specific card')
    .requiredOption('--card <cardCommonId>', 'The central cardCommonId to trace')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const verbose = widgetsCommand.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();
        const api = new WidgetsAPI(client);
        const widgets = await api.listWidgetsForCard(options.card);

        if (options.json) {
          console.log(JSON.stringify(widgets, null, 2));
        } else {
          console.log(`Found ${widgets.length} widget(s) for card ${options.card}:`);
          const rows = widgets.map(w => ({
            BoardID: w.boardId || (w.collectionIds ? w.collectionIds.join(',') : '—'),
            WidgetID: w.widgetCommonId,
            Type: w.type,
            Name: w.name,
          }));
          console.table(rows);
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  widgetsCommand
    .command('add <boardId> <cardCommonId>')
    .description('Add an existing card to a new board (creates a new linked widget)')
    .option('--column <columnId>', 'Specific column ID to place the widget in')
    .option('--json', 'Output as JSON')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass bounds checking')
    .action(async (boardId: string, cardCommonId: string, options) => {
      const verbose = widgetsCommand.opts()?.verbose ?? false;
      try {
        const config = await readConfig();
        const client = await createFavroClient();
        
        await checkScope(boardId, client, config, options.force);

        if (options.dryRun) {
          dryRunLog('adding', 'widget', `card "${cardCommonId}" to board ${boardId}`);
          process.exit(0);
        }

        if (!(await confirmAction(`Add card ${cardCommonId} to board ${boardId}?`, { yes: options.yes }))) {
          process.exit(0);
        }

        const api = new WidgetsAPI(client);
        const widget = await api.addWidgetToBoard(boardId, cardCommonId, options.column);

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
