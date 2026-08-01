/**
 * `cards delete` — the CLI surface of the `delete` intent (#73).
 *
 * Cards were the only entity with no delete command: collections, boards,
 * comments, tasks, tasklists, tags, webhooks and dependencies all have one, and
 * `collections delete` / `boards delete` are strictly more destructive. A card
 * the CLI created could only be removed in the Favro web UI.
 *
 * Routed through the shared dispatch table like `cards claim` / `resolve` /
 * `retag`, and for the same reason with more force behind it: the scope lock
 * lives in the table, and a delete that reached `CardsAPI` directly would be the
 * one write in this CLI that could destroy data outside the locked collection.
 * `--dry-run` is a preview, never the wall.
 */
import { Command } from 'commander';
import { dispatch, DeleteResult } from '../lib/dispatch';
import { reportDispatch } from '../lib/report-dispatch';
import { logError } from '../lib/error-handler';
import { createFavroClient } from '../lib/client-factory';

const DESCRIPTION =
  'Delete a card — DESTRUCTIVE and IRREVERSIBLE. There is no undo and no\n' +
  'compensating write: the deleted card is not rolled back if a later step\n' +
  'of the same transaction fails.\n\n' +
  'Deletes ONE BOARD INSTANCE, not the card everywhere. Favro keys\n' +
  'DELETE /cards/{cardId} on the instance id, and only ?everywhere=true\n' +
  'removes every instance — this command does not send it. A card claimed by\n' +
  'someone, or living on two boards, has more than one instance: deleting the\n' +
  'one you named leaves the others, along with the shared cardCommonId. Run\n' +
  "'favro cards get <card>' first to see which instance you are naming.\n\n" +
  'Comments, tasks, tasklists and attachments hang off cardCommonId, so they\n' +
  'survive as long as any instance does — and go with the last one.\n\n' +
  'Routed through the shared dispatch table, so the scope lock applies. A card\n' +
  'that resolves to no board (an assignment fork, no widgetCommonId) is\n' +
  'REFUSED, not deleted: the lock cannot check a write it cannot see, and\n' +
  '--force does not rescue it.\n\n' +
  'Examples:\n' +
  '  favro cards delete CLA-1804\n' +
  '  favro cards delete CLA-1804 --dry-run\n' +
  '  favro cards delete CLA-1804 -y\n';

export function registerCardsDeleteCommand(cardsCmd: Command): void {
  cardsCmd
    .command('delete <card>')
    .description(DESCRIPTION)
    .option('--dry-run', 'Preview the delete without writing')
    .option('--force', 'Bypass scope check')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--json', 'Output as JSON')
    .action(async (card: string, options) => {
      const verbose = cardsCmd.parent?.opts()?.verbose ?? cardsCmd.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();
        const { readConfig } = await import('../lib/config');
        const { confirmAction } = await import('../lib/safety');

        // Previewing is not writing, so `--dry-run` skips the prompt. Everything
        // else prompts, exactly as every other write command in this CLI does.
        if (
          !options.dryRun &&
          !(await confirmAction(
            `Delete card ${card}? This removes ONE board instance and CANNOT be undone.`,
            { yes: options.yes },
          ))
        ) {
          console.log('Aborted.');
          return;
        }

        const result = await dispatch<DeleteResult>(
          'delete',
          { card },
          {
            client,
            config: (await readConfig()) ?? {},
            force: options.force,
            dryRun: options.dryRun,
          },
        );

        if (reportDispatch(result, options.json)) process.exit(1);
        if (result.outcome === 'ok' && result.value !== undefined) {
          const { cardId, boardId } = result.value;
          console.log(`✓ Card instance deleted: ${cardId}${boardId ? ` (board ${boardId})` : ''}`);
          if (options.json) console.log(JSON.stringify(result.value, null, 2));
        }
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });
}

export default registerCardsDeleteCommand;
