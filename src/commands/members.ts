/**
 * Members CLI Commands
 * CLA-1788 FAVRO-026: Members & Permissions API
 *
 * Commands:
 *   favro members list [--board <id>] [--collection <id>]
 *   favro members add <email> --to <board-id|coll-id> [--board-target|--collection-target]
 *   favro members remove <member-id> --from <board-id|coll-id> [--board-target|--collection-target]
 *   favro members permissions <member-id> --board <board-id>
 */
import { Command } from 'commander';
import { isValidEmail, Member } from '../api/members';
import { RefusalError } from '../lib/refusal';
import { checkScope, checkCollectionScope, confirmAction } from '../lib/safety';
import { Ctx, run } from '../lib/run';

/**
 * The scope check for a members write, on whichever target it names.
 *
 * A free function taking `ctx.client` / `ctx.config`, not a `Ctx` method — #92
 * collapsed the spellings from three to two and a method would make it three
 * again (#119 states the same rule).
 */
async function checkTargetScope(
  ctx: Ctx,
  targetId: string,
  isBoardTarget: boolean,
  force?: boolean,
): Promise<void> {
  if (isBoardTarget) await checkScope(targetId, ctx.client, ctx.config, force);
  else checkCollectionScope(targetId, ctx.config, force);
}

export function registerMembersCommand(program: Command): void {
  const membersCmd = program
    .command('members')
    .description('Member management and permissions');

  // ─── members list ──────────────────────────────────────────────────────────
  membersCmd
    .command('list')
    .description('List all members, optionally filtered by board or collection')
    .option('--board <board-id>', 'Filter members by board ID')
    .option('--collection <coll-id>', 'Filter members by collection ID')
    .option('--limit <n>', 'Cap how many rows are printed; sets "truncated"')
    .action(run(async (ctx: Ctx, options: { board?: string; collection?: string; limit?: string }) => {
      if (options.board && options.collection) {
        // Deterministic: the same pair of flags refuses identically, so this is
        // a RefusalError and `retryable` comes back false (`refusal.ts`).
        throw new RefusalError('cannot specify both --board and --collection.');
      }

      return {
        rows: await ctx.api.members.getMembers({
          boardId: options.board,
          collectionId: options.collection,
        }),
        // Handed over unparsed: `capRows` owns the parse now (#99), so a
        // `--limit 1e9` cannot be read as 1 by a local `parseInt`.
        limit: options.limit,
        // The truncation note is the RUNNER's, not this formatter's — a `human`
        // is handed rows, never the envelope, so it cannot see the cut (#99).
        human: (rows: Member[]) => {
          if (rows.length === 0) {
            console.log('No members found.');
            return;
          }
          console.log(`Found ${rows.length} member(s):`);
          console.table(rows.map(m => ({
            ID: m.id,
            Name: m.name || '—',
            Email: m.email,
            Role: m.role,
          })));
        },
      };
    }));

  // ─── members add ───────────────────────────────────────────────────────────
  membersCmd
    .command('add <email>')
    .description('Add a member by email to a board or collection')
    .requiredOption('--to <target-id>', 'Board or collection ID to add member to')
    .option('--board-target', 'Target is a board (default)')
    .option('--collection-target', 'Target is a collection')
    .option('--dry-run', 'Print what would be added without making API calls')
    .option('--force', 'Bypass scope check')
    .action(run(async (
      ctx: Ctx,
      email: string,
      options: { to: string; collectionTarget?: boolean; dryRun?: boolean; force?: boolean },
    ) => {
      if (!isValidEmail(email)) {
        throw new RefusalError(`Invalid email format: "${email}"`);
      }

      // Default to board target unless --collection-target is specified
      const isBoardTarget = !options.collectionTarget;

      // Before the PREVIEW, not just before the write — the order #103 settled
      // for `cards update --from-csv` and `batch.ts` states for its siblings: a
      // preview is not a way around the lock, and a dry-run that cheerfully
      // reports "would add alice@example.com to board-outside-the-lock" when the
      // real run will refuse is misinformation about the write it exists to
      // describe. It costs nothing extra in credentials — the runner has already
      // built the client by the time this handler runs (#135) — only one
      // resolving GET on a locked preview, which is the price #103 accepted.
      await checkTargetScope(ctx, options.to, isBoardTarget, options.force);

      if (options.dryRun) {
        return {
          item: {
            dryRun: true,
            email,
            targetId: options.to,
            targetType: isBoardTarget ? 'board' : 'collection',
          },
          human: () =>
            `[dry-run] Would add member ${email} to ${isBoardTarget ? 'board' : 'collection'} ${options.to}`,
        };
      }

      return {
        item: await ctx.api.members.addMember(email, options.to, isBoardTarget),
        human: (member: Member) => `✓ Member added: ${member.email} (${member.id})`,
      };
    }));

  // ─── members remove ────────────────────────────────────────────────────────
  membersCmd
    .command('remove <member-id>')
    .description('Remove a member from a board or collection')
    .requiredOption('--from <target-id>', 'Board or collection ID to remove member from')
    .option('--board-target', 'Target is a board (default)')
    .option('--collection-target', 'Target is a collection')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(run(async (
      ctx: Ctx,
      memberId: string,
      options: { from: string; collectionTarget?: boolean; yes?: boolean; force?: boolean },
    ) => {
      const isBoardTarget = !options.collectionTarget;

      // Checked before the confirm, so a user cannot answer "remove?" and then
      // be refused (#78/#104).
      await checkTargetScope(ctx, options.from, isBoardTarget, options.force);

      if (!(await confirmAction(`Remove member ${memberId} from ${options.from}?`, { yes: options.yes }))) {
        // Declining is an outcome, not a failure: exit 0, in a readable shape.
        return {
          item: { removed: false, aborted: true, memberId, targetId: options.from },
          human: () => 'Aborted.',
        };
      }

      await ctx.api.members.removeMember(memberId, options.from, isBoardTarget);
      return {
        item: { removed: true, memberId, targetId: options.from },
        human: () => `✓ Member ${memberId} removed from ${options.from}`,
      };
    }));

  // ─── members permissions ───────────────────────────────────────────────────
  membersCmd
    .command('permissions <member-id>')
    .description('Get permission level for a member on a board')
    .requiredOption('--board <board-id>', 'Board ID to check permissions on')
    .action(run(async (ctx: Ctx, memberId: string, options: { board: string }) => {
      const permissionLevel = await ctx.api.members.getMemberPermissions(memberId, options.board);
      return {
        item: { memberId, boardId: options.board, permissionLevel },
        human: () => `Member ${memberId} on board ${options.board}: ${permissionLevel}`,
      };
    }));
}

export default registerMembersCommand;
