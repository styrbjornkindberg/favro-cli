/**
 * Attachments Commands
 * CLA-1805 FAVRO-XXX: Attachments Endpoints
 *
 * favro attachments upload <card> --file ./error.log
 */
import { Command } from 'commander';
import { Attachment } from '../lib/attachments-api';
import { boardOfCard, boardOfComment, checkResolvedScope, confirmAction, dryRunLog } from '../lib/safety';
import { Ctx, run } from '../lib/run';

/** The flag row both uploads declare. */
interface UploadFlags {
  file: string;
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
}

export function registerAttachmentsCommands(program: Command): void {
  const attachmentsCmd = program.command('attachments').description('Manage card attachments');

  attachmentsCmd
    .command('upload <card>')
    .description('Upload an attachment to a card')
    .requiredOption('--file <path>', 'Path to file to upload')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(run(async (ctx: Ctx, cardCommonId: string, options: UploadFlags) => {
      // Safety bound: check scope for target card. Lazy, so no lock means no GET.
      await checkResolvedScope(ctx.client, () => boardOfCard(ctx.client, cardCommonId), options.force);

      if (options.dryRun) {
        // The bare name, like `columns create` and `tasks add` since #162 item 10:
        // the card id is the positional argument the caller typed, and `run.ts`
        // already calls a dry-run preview an echo of argv.
        dryRunLog('upload', 'attachment', options.file);
        return;
      }

      if (!(await confirmAction(`Upload file "${options.file}" to card ${cardCommonId}?`, { yes: options.yes }))) {
        return { item: { uploaded: false, aborted: true }, human: () => 'Aborted.' };
      }

      return {
        item: await ctx.api.attachments.uploadAttachment(cardCommonId, options.file),
        human: (a: Attachment) => `✓ Attachment uploaded: ${a.attachmentId} (${a.name})`,
      };
    }));

  attachmentsCmd
    .command('upload-to-comment <commentId>')
    .description('Upload an attachment to a comment')
    .requiredOption('--file <path>', 'Path to file to upload')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(run(async (ctx: Ctx, commentId: string, options: UploadFlags) => {
      // Safety bound: a commentId carries no board, so resolve it through the
      // comment's card. A stale/deleted comment resolves to '' — UNCHECKABLE,
      // not exempt — and the shared check refuses it under a lock (#102).
      // Resolved lazily, so an unlocked user pays neither GET.
      await checkResolvedScope(ctx.client, () => boardOfComment(ctx.client, commentId), options.force);

      if (options.dryRun) {
        // Bare name — see the card arm above.
        dryRunLog('upload', 'attachment', options.file);
        return;
      }

      if (!(await confirmAction(`Upload file "${options.file}" to comment ${commentId}?`, { yes: options.yes }))) {
        return { item: { uploaded: false, aborted: true }, human: () => 'Aborted.' };
      }

      return {
        item: await ctx.api.attachments.uploadAttachmentToComment(commentId, options.file),
        human: (a: Attachment) => `✓ Attachment uploaded to comment: ${a.attachmentId} (${a.name})`,
      };
    }));
}
