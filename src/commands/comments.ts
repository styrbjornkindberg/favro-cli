/**
 * Comments CLI Commands
 * CLA-1789 FAVRO-027: Comments & Activity API
 *
 * Commands:
 *   favro comments list <card>
 *   favro comments add <card> --text "COMMENT"
 */
import { Command } from 'commander';
import { createFavroClient } from '../lib/client-factory';
import { logError } from '../lib/error-handler';
import { boardOfCard, boardOfComment, checkResolvedScope, confirmAction } from '../lib/safety';
import CommentsApiClient from '../api/comments';
import { capRows, writeEnvelope } from '../lib/read-shape';
import { formatTimestamp } from '../lib/time';

export function registerCommentsCommand(program: Command): void {
  const commentsCmd = program
    .command('comments')
    .description('Card comment operations — list and add comments to cards');

  // ─── comments get ───────────────────────────────────────────────────────────
  commentsCmd
    .command('get <commentId>')
    .description(
      'Get a single comment by ID.\n\n' +
      'Examples:\n' +
      '  favro comments get <commentId>\n' +
      '  favro comments get <commentId> --json\n\n' +
      'Tip: Use `favro comments list <card>` to find comment IDs.'
    )
    .option('--json', 'Output as JSON')
    .action(async (commentId: string, options) => {
      const verbose = program.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();
        const api = new CommentsApiClient(client);
        const comment = await api.getComment(commentId);

        if (options.json) {
          console.log(JSON.stringify(comment, null, 2));
          return;
        }

        const ts = formatTimestamp(comment.createdAt);
        const author = comment.author ? ` by ${comment.author}` : '';
        console.log(`[${comment.commentId}]${author} — ${ts}`);
        console.log(`  ${comment.text}`);
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  // ─── comments list ─────────────────────────────────────────────────────────
  commentsCmd
    .command('list <card>')
    .description(
      'List all comments on a card.\n\n' +
      'Examples:\n' +
      '  favro comments list <card>\n' +
      '  favro comments list <card> --json\n' +
      '  favro comments list <card> --limit 50\n\n' +
      'Tip: Use `favro cards list --board <board>` to find card IDs.'
    )
    .option('--limit <number>', 'Maximum number of comments to print (default: 100)', '100')
    .option('--json', 'Output as JSON')
    .action(async (cardId: string, options) => {
      const verbose = program.opts()?.verbose ?? false;
      try {

        const limitRaw = parseInt(options.limit, 10);
        const limit = !isNaN(limitRaw) && limitRaw >= 1 ? limitRaw : 100;

        const client = await createFavroClient();
        const api = new CommentsApiClient(client);

        // The fetch runs to completion; `--limit` cuts the PRINT, and the cut
        // says so (#136). The old shape capped the fetch and then printed that
        // count as the total, so a card with 150 comments answered "100".
        // Both modes read the same `envelope.truncated`, so they cannot disagree.
        const all = await api.listComments(cardId);
        const envelope = capRows(all, limit);
        const comments = envelope.rows;

        if (options.json) {
          writeEnvelope(envelope, Boolean(program.opts()?.pretty));
          return;
        }

        if (comments.length === 0) {
          console.log(`No comments found on card "${cardId}".`);
          return;
        }

        const count = envelope.truncated
          ? `showing ${comments.length} of ${all.length} comment(s)`
          : `${comments.length} comment(s)`;
        console.log(`\n💬 Comments on card "${cardId}" — ${count}:\n`);
        for (const comment of comments) {
          const ts = formatTimestamp(comment.createdAt);
          const author = comment.author ? ` by ${comment.author}` : '';
          console.log(`  [${comment.commentId}]${author} — ${ts}`);
          console.log(`    ${comment.text}`);
          console.log();
        }
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  // ─── comments add ──────────────────────────────────────────────────────────
  commentsCmd
    .command('add <card>')
    .description(
      'Add a comment to a card.\n\n' +
      'Examples:\n' +
      '  favro comments add <card> --text "Looks good to me"\n' +
      '  favro comments add <card> --text "Blocked by API issue" --json\n\n' +
      'Tip: Use `favro cards list --board <board>` to find card IDs.'
    )
    .requiredOption('--text <comment>', 'Comment text to add')
    .option('--json', 'Output as JSON')
    .option('--dry-run', 'Print what would be added without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(async (cardId: string, options) => {
      const verbose = program.opts()?.verbose ?? false;
      try {
        if (!options.text || !options.text.trim()) {
          console.error('Error: Comment text cannot be empty.');
          process.exit(1);
        }

        const client = await createFavroClient();

        // Check BEFORE the confirm, and with the resolving GET wrapped — this
        // command was already "guarded" but had neither, which is the #78 shape
        // its own siblings were just fixed for (#104): a stale cardId threw out
        // of the command instead of refusing, and a user could answer "add this
        // comment?" only to be refused afterwards.
        await checkResolvedScope(client, () => boardOfCard(client, cardId), options.force);

        if (options.dryRun) {
          console.log(`[dry-run] Would add comment to ${cardId}: "${options.text}"`);
          return;
        }

        if (!(await confirmAction(`Add comment to card ${cardId}?`, { yes: options.yes }))) {
          console.log('Aborted.');
          return;
        }

        const api = new CommentsApiClient(client);

        const comment = await api.addComment(cardId, options.text);

        if (options.json) {
          console.log(JSON.stringify(comment, null, 2));
          return;
        }

        console.log(`✓ Comment added: ${comment.commentId}`);
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  // ─── comments update ────────────────────────────────────────────────────────
  commentsCmd
    .command('update <commentId>')
    .description(
      'Update a comment\'s text.\n\n' +
      'Examples:\n' +
      '  favro comments update <commentId> --text "Updated text"\n' +
      '  favro comments update <commentId> --text "Fixed typo" --json\n\n' +
      'Tip: Use `favro comments list <card>` to find comment IDs.'
    )
    .requiredOption('--text <comment>', 'New comment text')
    .option('--json', 'Output as JSON')
    .option('--dry-run', 'Print what would be updated without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(async (commentId: string, options) => {
      const verbose = program.opts()?.verbose ?? false;
      try {
        if (!options.text || !options.text.trim()) {
          console.error('Error: Comment text cannot be empty.');
          process.exit(1);
        }

        const client = await createFavroClient();
        const api = new CommentsApiClient(client);
        await checkResolvedScope(client, () => boardOfComment(client, commentId), options.force);

        if (options.dryRun) {
          console.log(`[dry-run] Would update comment ${commentId}: "${options.text}"`);
          return;
        }

        const { confirmAction } = await import('../lib/safety');
        if (!(await confirmAction(`Update comment ${commentId}?`, { yes: options.yes }))) {
          process.exit(0);
        }

        const comment = await api.updateComment(commentId, options.text);

        if (options.json) {
          console.log(JSON.stringify(comment, null, 2));
          return;
        }

        console.log(`✓ Comment updated: ${comment.commentId}`);
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  // ─── comments delete ───────────────────────────────────────────────────────
  commentsCmd
    .command('delete <commentId>')
    .description(
      'Delete a comment by its ID.\n\n' +
      'Examples:\n' +
      '  favro comments delete <commentId>\n' +
      '  favro comments delete <commentId> --yes\n\n' +
      'Tip: Use `favro comments list <card>` to find comment IDs.'
    )
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(async (commentId: string, options) => {
      const verbose = program.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();
        const api = new CommentsApiClient(client);
        await checkResolvedScope(client, () => boardOfComment(client, commentId), options.force);

        if (options.dryRun) {
          console.log(`[dry-run] Would delete comment ${commentId}`);
          return;
        }

        const { confirmAction } = await import('../lib/safety');
        if (!(await confirmAction(`Delete comment ${commentId}?`, { yes: options.yes }))) {
          process.exit(0);
        }

        await api.deleteComment(commentId);

        console.log(`✓ Comment deleted: ${commentId}`);
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });
}

export default registerCommentsCommand;
