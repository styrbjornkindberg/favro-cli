/**
 * Attachments Commands
 * CLA-1805 FAVRO-XXX: Attachments Endpoints
 *
 * favro attachments upload <card> --file ./error.log
 */
import { Command } from 'commander';
import AttachmentsAPI from '../lib/attachments-api';
import CardsAPI from '../lib/cards-api';
import { CommentsApiClient } from '../api/comments';
import { createFavroClient } from '../lib/client-factory';
import { logError } from '../lib/error-handler';
import { boardOfCard, boardOfComment, checkResolvedScope, confirmAction, dryRunLog } from '../lib/safety';
import { readConfig } from '../lib/config';

export function registerAttachmentsCommands(program: Command): void {
  const attachmentsCmd = program.command('attachments').description('Manage card attachments');

  attachmentsCmd
    .command('upload <card>')
    .description('Upload an attachment to a card')
    .requiredOption('--file <path>', 'Path to file to upload')
    .option('--json', 'Output as JSON')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(async (cardCommonId: string, options) => {
      const verbose = attachmentsCmd.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();

        // Safety bound: check scope for target card. Lazy, so no lock means no GET.
        await checkResolvedScope(client, () => boardOfCard(client, cardCommonId), options.force);

        if (options.dryRun) {
          dryRunLog('uploading', 'attachment', `${options.file} to card ${cardCommonId}`);
          process.exit(0);
        }

        if (!(await confirmAction(`Upload file "${options.file}" to card ${cardCommonId}?`, { yes: options.yes }))) {
          process.exit(0);
        }

        const attachApi = new AttachmentsAPI(client);
        const attachRes = await attachApi.uploadAttachment(cardCommonId, options.file);

        if (options.json) {
          console.log(JSON.stringify(attachRes, null, 2));
        } else {
          console.log(`✓ Attachment uploaded: ${attachRes.attachmentId} (${attachRes.name})`);
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  attachmentsCmd
    .command('upload-to-comment <commentId>')
    .description('Upload an attachment to a comment')
    .requiredOption('--file <path>', 'Path to file to upload')
    .option('--json', 'Output as JSON')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(async (commentId: string, options) => {
      const verbose = attachmentsCmd.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();

        // Safety bound: a commentId carries no board, so resolve it through the
        // comment's card. A stale/deleted comment resolves to '' — UNCHECKABLE,
        // not exempt — and the shared check refuses it under a lock (#102).
        // Resolved lazily, so an unlocked user pays neither GET.
        await checkResolvedScope(client, () => boardOfComment(client, commentId), options.force);

        if (options.dryRun) {
          dryRunLog('uploading', 'attachment', `${options.file} to comment ${commentId}`);
          process.exit(0);
        }

        if (!(await confirmAction(`Upload file "${options.file}" to comment ${commentId}?`, { yes: options.yes }))) {
          process.exit(0);
        }

        const attachApi = new AttachmentsAPI(client);
        const attachRes = await attachApi.uploadAttachmentToComment(commentId, options.file);

        if (options.json) {
          console.log(JSON.stringify(attachRes, null, 2));
        } else {
          console.log(`✓ Attachment uploaded to comment: ${attachRes.attachmentId} (${attachRes.name})`);
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });
}
