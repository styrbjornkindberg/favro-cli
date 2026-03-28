/**
 * Comments CLI Commands
 * CLA-1789 FAVRO-027: Comments & Activity API
 *
 * Commands:
 *   favro comments list <card-id>
 *   favro comments add <card-id> --text "COMMENT"
 */
import { Command } from 'commander';
import { createFavroClient } from '../lib/client-factory';
import { logError } from '../lib/error-handler';
import CommentsApiClient from '../api/comments';
import { formatTimestamp } from '../lib/audit-api';

export function registerCommentsCommand(program: Command): void {
  const commentsCmd = program
    .command('comments')
    .description('Card comment operations — list and add comments to cards');

  // ─── comments list ─────────────────────────────────────────────────────────
  commentsCmd
    .command('list <cardId>')
    .description(
      'List all comments on a card.\n\n' +
      'Examples:\n' +
      '  favro comments list <cardId>\n' +
      '  favro comments list <cardId> --json\n' +
      '  favro comments list <cardId> --limit 50\n\n' +
      'Tip: Use `favro cards list --board <id>` to find card IDs.'
    )
    .option('--limit <number>', 'Maximum number of comments to fetch (default: 100)', '100')
    .option('--json', 'Output as JSON')
    .action(async (cardId: string, options) => {
      const verbose = program.opts()?.verbose ?? false;
      try {

        const limitRaw = parseInt(options.limit, 10);
        const limit = !isNaN(limitRaw) && limitRaw >= 1 ? limitRaw : 100;

        const client = await createFavroClient();
        const api = new CommentsApiClient(client);

        const comments = await api.listComments(cardId, limit);

        if (options.json) {
          console.log(JSON.stringify(comments, null, 2));
          return;
        }

        if (comments.length === 0) {
          console.log(`No comments found on card "${cardId}".`);
          return;
        }

        console.log(`\n💬 Comments on card "${cardId}" — ${comments.length} comment(s):\n`);
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
    .command('add <cardId>')
    .description(
      'Add a comment to a card.\n\n' +
      'Examples:\n' +
      '  favro comments add <cardId> --text "Looks good to me"\n' +
      '  favro comments add <cardId> --text "Blocked by API issue" --json\n\n' +
      'Tip: Use `favro cards list --board <id>` to find card IDs.'
    )
    .requiredOption('--text <comment>', 'Comment text to add')
    .option('--json', 'Output as JSON')
    .option('--dry-run', 'Print what would be added without making API calls')
    .option('--force', 'Bypass scope check')
    .action(async (cardId: string, options) => {
      const verbose = program.opts()?.verbose ?? false;
      try {
        if (!options.text || !options.text.trim()) {
          console.error('Error: Comment text cannot be empty.');
          process.exit(1);
        }

        if (options.dryRun) {
          console.log(`[dry-run] Would add comment to ${cardId}: "${options.text}"`);
          return;
        }

        const client = await createFavroClient();
        
        const { default: CardsAPI } = await import('../lib/cards-api');
        const cardsApi = new CardsAPI(client);
        const card = await cardsApi.getCard(cardId);
        
        const { readConfig } = await import('../lib/config');
        const { checkScope } = await import('../lib/safety');
        await checkScope(card.boardId ?? '', client, await readConfig(), options.force);

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
}

export default registerCommentsCommand;
