/**
 * `cards archive` / `cards unarchive` — the CLI surface of the `archive` intent
 * (#75).
 *
 * Two spellings, ONE intent. The pair mirrors `cards link` / `cards unlink`
 * because that is how a human reads it, but the resemblance stops at the CLI:
 * link and unlink are two intents because they are two wire ops (POST and
 * DELETE), while archiving is one — `PUT {archive: boolean}` — so a second intent
 * here would be a second name for one write.
 *
 * Archiving is the reversible sibling of `cards delete`, and this file is
 * deliberately shaped like `cards-delete.ts`: routed through the shared dispatch
 * table so the scope lock applies, `confirmAction` before it writes, `-y` to skip
 * the prompt, `--dry-run` as a preview and never as the wall. What differs is
 * everything downstream — the intent is not terminal, it carries a real
 * compensating write, and it can appear as a skill `command:` step.
 */
import { Command } from 'commander';
import { dispatch } from '../lib/dispatch';
import { reportDispatch } from '../lib/report-dispatch';
import { logError } from '../lib/error-handler';
import { createFavroClient } from '../lib/client-factory';

type ArchiveResult = { cardId: string; archived: boolean };

const SHARED_NOTES =
  'The write field Favro honours is `archive`; the field a card reads BACK is\n' +
  '`archived`. They are not the same field: PUT {archived: true} answers 200 and\n' +
  'changes nothing, and neither spelling works as a query parameter. Read the\n' +
  "line back with 'favro cards get <card>', or select a side of it with\n" +
  "'favro cards list --archived true|false|all'.\n\n" +
  'Archives ONE BOARD INSTANCE. A card claimed by someone, or living on two\n' +
  'boards, has more than one instance, and this moves the one you named.\n\n' +
  'Routed through the shared dispatch table, so the scope lock applies. A card\n' +
  'that resolves to no board (an assignment fork, no widgetCommonId) is REFUSED,\n' +
  'not archived: the lock cannot check a write it cannot see, and --force does\n' +
  'not rescue it.';

const ARCHIVE_DESCRIPTION =
  'Archive a card — REVERSIBLE. Run \'favro cards unarchive <card>\' to undo it,\n' +
  'and unlike \'cards delete\' this carries a real compensating write: a later\n' +
  'step of the same transaction that fails moves the card back.\n\n' +
  SHARED_NOTES +
  '\n\nExamples:\n' +
  '  favro cards archive CLA-1804\n' +
  '  favro cards archive CLA-1804 --dry-run\n' +
  '  favro cards archive CLA-1804 -y\n';

const UNARCHIVE_DESCRIPTION =
  'Un-archive a card — the same one wire op as \'cards archive\', with the\n' +
  'direction flipped. A card already on the requested side of the line is left\n' +
  'alone and nothing is written.\n\n' +
  SHARED_NOTES +
  '\n\nExamples:\n' +
  '  favro cards unarchive CLA-1804\n' +
  '  favro cards unarchive CLA-1804 -y\n';

/**
 * One action body for both spellings — the direction is the only difference, and
 * duplicating the confirm/dispatch/report chain per spelling is how the two would
 * drift apart on the guardrail.
 */
function archiveAction(cardsCmd: Command, archived: boolean) {
  return async (card: string, options: Record<string, any>): Promise<void> => {
    const verbose = cardsCmd.parent?.opts()?.verbose ?? cardsCmd.opts()?.verbose ?? false;
    const verb = archived ? 'Archive' : 'Un-archive';
    try {
      const client = await createFavroClient();
      const { readConfig } = await import('../lib/config');
      const { confirmAction } = await import('../lib/safety');

      // Previewing is not writing, so `--dry-run` skips the prompt. Everything
      // else prompts, exactly as every other write command in this CLI does.
      if (
        !options.dryRun &&
        !(await confirmAction(
          `${verb} card ${card}? This moves ONE board instance across the archive line. ` +
            `Reversible with 'favro cards ${archived ? 'unarchive' : 'archive'} ${card}'.`,
          { yes: options.yes },
        ))
      ) {
        console.log('Aborted.');
        return;
      }

      const result = await dispatch<ArchiveResult>('archive', { card, archived }, {
        client,
        config: (await readConfig()) ?? {},
        force: options.force,
        dryRun: options.dryRun,
      });

      if (reportDispatch(result, options.json)) process.exit(1);
      if (result.outcome === 'ok' && result.value !== undefined) {
        const { cardId, archived: side } = result.value;
        console.log(`✓ Card ${cardId} is ${side ? 'archived' : 'un-archived'}`);
        if (options.json) console.log(JSON.stringify(result.value, null, 2));
      }
    } catch (error) {
      logError(error, verbose);
      process.exit(1);
    }
  };
}

export function registerCardsArchiveCommands(cardsCmd: Command): void {
  cardsCmd
    .command('archive <card>')
    .description(ARCHIVE_DESCRIPTION)
    .option('--dry-run', 'Preview the archive without writing')
    .option('--force', 'Bypass scope check')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--json', 'Output as JSON')
    .action(archiveAction(cardsCmd, true));

  cardsCmd
    .command('unarchive <card>')
    .description(UNARCHIVE_DESCRIPTION)
    .option('--dry-run', 'Preview the un-archive without writing')
    .option('--force', 'Bypass scope check')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--json', 'Output as JSON')
    .action(archiveAction(cardsCmd, false));
}

export default registerCardsArchiveCommands;
