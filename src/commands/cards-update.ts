/**
 * Cards Update Command
 * FAVRO-007: Cards Update Command
 */
import { Command } from 'commander';
import { createFavroClient } from '../lib/client-factory';
import * as readline from 'readline';
import CardsAPI, { UpdateCardRequest } from '../lib/cards-api';
import { ColumnsAPI } from '../lib/columns-api';
import { logError, missingApiKeyError } from '../lib/error-handler';
import { resolveAssignees } from '../lib/assignee';
import { parseQuery } from '../lib/query-parser';

/**
 * Max cards that can be updated in a single batch.
 * Spec: "Max 100 cards per command (warn if > 100 match)"
 */
export const BATCH_LIMIT = 100;

/**
 * Prompt the user for confirmation (y/n).
 * Returns true if the user answered 'y' or 'yes'.
 * Exported for testing purposes.
 */
export async function confirmPrompt(question: string): Promise<boolean> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
  });
}

export function registerCardsUpdateCommand(program: Command): void {
  program
    .command('cards update <card>')
    .description('Update a card')
    .option('--name <name>', 'New card name')
    .option('--description <desc>', 'Card description')
    .option('--status <status>', 'Move the card to this column (name or columnId)')
    .option('--assignees <list>', 'Assignees, comma-separated — the whole set; drop one to unassign')
    .option('--tags <list>', 'Tags (comma-separated)')
    .option('--column <column>', 'Move card to this column (by name, requires --board)')
    .option('--board <boardId>', 'Board ID (required when using --column)')
    .option('--filter <filter>', 'Filter expression for card selection')
    .option('--json', 'Output as JSON')
    .option('--dry-run', 'Show what would be updated without making changes')
    .option('--yes', 'Skip confirmation prompt')
    .action(async (_updateArg: string, cardId: string, options: {
      name?: string;
      description?: string;
      status?: string;
      assignees?: string;
      tags?: string;
      column?: string;
      board?: string;
      filter?: string;
      json?: boolean;
      dryRun?: boolean;
      yes?: boolean;
    }) => {
      const verbose = program.parent?.opts()?.verbose ?? program.opts()?.verbose ?? false;
      try {
        // Parse filter if provided
        if (options.filter) {
          try {
            parseQuery(options.filter);
          } catch (err: any) {
            console.error(`✗ Invalid filter expression: ${err.message}`);
            process.exit(1);
          }
        }

        const token = process.env.FAVRO_API_TOKEN;

        const client = await createFavroClient();
        const api = new CardsAPI(client);

        const updateData: UpdateCardRequest = {};
        if (options.name) updateData.name = options.name;
        if (options.description) updateData.description = options.description;
        if (options.status) updateData.status = options.status;
        // Names must become userIds before the whole-array write is diffed —
        // an unresolved name would read as "remove everyone, add a stranger".
        if (options.assignees) {
          updateData.assignees = await resolveAssignees(
            client,
            options.assignees.split(',').map(a => a.trim()).filter(Boolean),
          );
        }
        // `--tags ""` clears every tag, so test for presence, not truthiness.
        if (options.tags !== undefined) {
          updateData.tags = options.tags.split(',').map(t => t.trim()).filter(Boolean);
        }

        // Column move: resolve column name → columnId
        if (options.column) {
          if (!options.board) {
            console.error('✗ --board is required when using --column');
            process.exit(1);
          }
          const columnsApi = new ColumnsAPI(client);
          const columns = await columnsApi.listColumns(options.board);
          const target = columns.find(
            c => c.name.toLowerCase() === options.column!.toLowerCase()
          );
          if (!target) {
            const available = columns.map(c => c.name).join(', ');
            console.error(`✗ Column "${options.column}" not found. Available: ${available}`);
            process.exit(1);
          }
          updateData.columnId = target.columnId;
          updateData.boardId = options.board;
        }

        // Dry-run mode: show what would be updated without making changes
        if (options.dryRun) {
          console.log(`[dry-run] Would update card: ${cardId}`);
          console.log('[dry-run] Changes:', JSON.stringify(updateData, null, 2));
          return;
        }

        // Confirmation prompt (unless --yes flag is used)
        if (!options.yes) {
          const confirmed = await confirmPrompt(`Update card ${cardId}? (y/n) `);
          if (!confirmed) {
            console.log('Update cancelled.');
            return;
          }
        }

        const card = await api.updateCard(cardId, updateData);
        console.log(`✓ Card updated: ${card.cardId}`);
        if (options.json) console.log(JSON.stringify(card));
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });
}

export default registerCardsUpdateCommand;
