/**
 * Comments CLI Commands
 * CLA-1789 FAVRO-027: Comments & Activity API
 *
 * Commands:
 *   favro comments list <card>
 *   favro comments add <card> --text "COMMENT"
 */
import { Command } from 'commander';
import { boardOfCard, boardOfComment, checkResolvedScope, confirmAction } from '../lib/safety';
import { Comment } from '../api/comments';
import { parseLimit } from '../lib/read-shape';
import { RefusalError } from '../lib/refusal';
import { Ctx, run } from '../lib/run';
import { formatTimestamp } from '../lib/time';

/** One comment, as it reads to a person. */
function commentLines(comment: Comment, indent: string): string[] {
  const ts = formatTimestamp(comment.createdAt);
  const author = comment.author ? ` by ${comment.author}` : '';
  return [`${indent}[${comment.commentId}]${author} — ${ts}`, `${indent}  ${comment.text}`];
}

/** Refuse empty comment text — the same call declines identically. */
function requireText(text: string | undefined): string {
  if (!text || !text.trim()) throw new RefusalError('Comment text cannot be empty.');
  return text;
}

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
      '  favro comments get <commentId> --human\n\n' +
      'Tip: Use `favro comments list <card>` to find comment IDs.'
    )
    .action(run(async (ctx: Ctx, commentId: string) => ({
      item: await ctx.api.comments.getComment(commentId),
      human: (comment: Comment) => commentLines(comment, '').join('\n'),
    })));

  // ─── comments list ─────────────────────────────────────────────────────────
  commentsCmd
    .command('list <card>')
    .description(
      'List all comments on a card.\n\n' +
      'Examples:\n' +
      '  favro comments list <card>\n' +
      '  favro comments list <card> --human\n' +
      '  favro comments list <card> --limit 50\n\n' +
      'Tip: Use `favro cards list --board <board>` to find card IDs.'
    )
    .option('--limit <number>', 'Maximum number of comments to print (default: 100)', '100')
    .action(run(async (ctx: Ctx, cardId: string, options: { limit?: string }) => {
      // Parsed BEFORE the fetch, not inline in the returned object: since #142 a
      // malformed `--limit` refuses, and a refusal evaluated after `rows:` costs
      // a whole comments read that is then thrown away. Property order decided
      // that, which is too quiet a thing to leave load-bearing.
      const limit = parseLimit(options.limit) ?? 100;
      return {
      // The fetch runs to completion; `--limit` cuts the PRINT (#136). The old
      // shape capped the fetch and then printed that count as the total, so a
      // card with 150 comments answered "100". `capRows` inside the runner is
      // the one place the cut happens now, so both modes read the same envelope
      // and cannot disagree — and it owns the parse too, so `--limit 1e9` is
      // not read as 1 by a local `parseInt` (#99).
      rows: await ctx.api.comments.listComments(cardId),
      limit,
      // The cut itself is the runner's line (`noteTruncation`): a `human` is
      // handed rows, never the envelope, so it cannot see one.
      human: (comments: Comment[]) => {
        if (comments.length === 0) {
          console.log(`No comments found on card "${cardId}".`);
          return;
        }
        console.log(`\n💬 Comments on card "${cardId}" — ${comments.length} comment(s):\n`);
        for (const comment of comments) {
          for (const line of commentLines(comment, '  ')) console.log(line);
          console.log();
        }
      },
      };
    }));

  // ─── comments add ──────────────────────────────────────────────────────────
  commentsCmd
    .command('add <card>')
    .description(
      'Add a comment to a card.\n\n' +
      'Examples:\n' +
      '  favro comments add <card> --text "Looks good to me"\n' +
      '  favro comments add <card> --text "Blocked by API issue"\n\n' +
      'Tip: Use `favro cards list --board <board>` to find card IDs.'
    )
    .requiredOption('--text <comment>', 'Comment text to add')
    // Measured, and NOT "without making API calls" like its siblings say (#135):
    // the scope check below reads the card to name its board, so this preview
    // needs credentials and issues one GET whenever a lock is configured.
    .option('--dry-run', 'Preview the comment. Reads the card first to check the scope lock')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(run(async (
      ctx: Ctx,
      cardId: string,
      options: { text?: string; dryRun?: boolean; yes?: boolean; force?: boolean },
    ) => {
      const text = requireText(options.text);

      // Check BEFORE the confirm, and with the resolving GET wrapped — this
      // command was already "guarded" but had neither, which is the #78 shape
      // its own siblings were just fixed for (#104): a stale cardId threw out
      // of the command instead of refusing, and a user could answer "add this
      // comment?" only to be refused afterwards.
      await checkResolvedScope(ctx.client, () => boardOfCard(ctx.client, cardId), options.force);

      if (options.dryRun) {
        return {
          item: { dryRun: true, cardId, text },
          human: () => `[dry-run] Would add comment to ${cardId}: "${text}"`,
        };
      }

      if (!(await confirmAction(`Add comment to card ${cardId}?`, { yes: options.yes }))) {
        return { item: { added: false, aborted: true, cardId }, human: () => 'Aborted.' };
      }

      return {
        item: await ctx.api.comments.addComment(cardId, text),
        human: (comment: Comment) => `✓ Comment added: ${comment.commentId}`,
      };
    }));

  // ─── comments update ────────────────────────────────────────────────────────
  commentsCmd
    .command('update <commentId>')
    .description(
      'Update a comment\'s text.\n\n' +
      'Examples:\n' +
      '  favro comments update <commentId> --text "Updated text"\n' +
      '  favro comments update <commentId> --text "Fixed typo"\n\n' +
      'Tip: Use `favro comments list <card>` to find comment IDs.'
    )
    .requiredOption('--text <comment>', 'New comment text')
    .option('--dry-run', 'Preview the update. Reads the comment first to check the scope lock')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(run(async (
      ctx: Ctx,
      commentId: string,
      options: { text?: string; dryRun?: boolean; yes?: boolean; force?: boolean },
    ) => {
      const text = requireText(options.text);

      await checkResolvedScope(ctx.client, () => boardOfComment(ctx.client, commentId), options.force);

      if (options.dryRun) {
        return {
          item: { dryRun: true, commentId, text },
          human: () => `[dry-run] Would update comment ${commentId}: "${text}"`,
        };
      }

      if (!(await confirmAction(`Update comment ${commentId}?`, { yes: options.yes }))) {
        return { item: { updated: false, aborted: true, commentId }, human: () => 'Aborted.' };
      }

      return {
        item: await ctx.api.comments.updateComment(commentId, text),
        human: (comment: Comment) => `✓ Comment updated: ${comment.commentId}`,
      };
    }));

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
    .option('--dry-run', 'Preview the delete. Reads the comment first to check the scope lock')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(run(async (
      ctx: Ctx,
      commentId: string,
      options: { dryRun?: boolean; yes?: boolean; force?: boolean },
    ) => {
      await checkResolvedScope(ctx.client, () => boardOfComment(ctx.client, commentId), options.force);

      if (options.dryRun) {
        return {
          item: { dryRun: true, commentId },
          human: () => `[dry-run] Would delete comment ${commentId}`,
        };
      }

      if (!(await confirmAction(`Delete comment ${commentId}?`, { yes: options.yes }))) {
        return { item: { deleted: false, aborted: true, commentId }, human: () => 'Aborted.' };
      }

      await ctx.api.comments.deleteComment(commentId);
      return {
        item: { deleted: true, commentId },
        human: () => `✓ Comment deleted: ${commentId}`,
      };
    }));
}

export default registerCommentsCommand;
