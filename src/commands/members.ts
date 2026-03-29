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
import { createFavroClient } from '../lib/client-factory';
import { logError } from '../lib/error-handler';
import { FavroApiClient, isValidEmail } from '../api/members';

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
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const verbose = program.opts()?.verbose ?? false;
      try {
        if (options.board && options.collection) {
          console.error('Error: cannot specify both --board and --collection');
          process.exit(1);
        }

        const client = await createFavroClient();
        const api = new FavroApiClient(client);

        const members = await api.getMembers({
          boardId: options.board,
          collectionId: options.collection,
        });

        if (options.json) {
          console.log(JSON.stringify(members, null, 2));
        } else {
          if (members.length === 0) {
            console.log('No members found.');
            return;
          }
          console.log(`Found ${members.length} member(s):`);
          const rows = members.map(m => ({
            ID: m.id,
            Name: m.name || '—',
            Email: m.email,
            Role: m.role,
          }));
          console.table(rows);
        }
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  // ─── members add ───────────────────────────────────────────────────────────
  membersCmd
    .command('add <email>')
    .description('Add a member by email to a board or collection')
    .requiredOption('--to <target-id>', 'Board or collection ID to add member to')
    .option('--board-target', 'Target is a board (default)')
    .option('--json', 'Output as JSON')
    .option('--dry-run', 'Print what would be added without making API calls')
    .option('--force', 'Bypass scope check')
    .action(async (email: string, options) => {
      const verbose = program.opts()?.verbose ?? false;
      try {
        if (!isValidEmail(email)) {
          console.error(`Error: Invalid email format: "${email}"`);
          process.exit(1);
        }

        // Default to board target unless --collection-target is specified
        const isBoardTarget = !options.collectionTarget;

        if (options.dryRun) {
          console.log(`[dry-run] Would add member ${email} to ${isBoardTarget ? 'board' : 'collection'} ${options.to}`);
          return;
        }

        const client = await createFavroClient();
        
        const { readConfig } = await import('../lib/config');
        const { checkScope, checkCollectionScope } = await import('../lib/safety');
        if (isBoardTarget) {
          await checkScope(options.to, client, await readConfig(), options.force);
        } else {
          checkCollectionScope(options.to, await readConfig(), options.force);
        }
        
        const api = new FavroApiClient(client);

        const member = await api.addMember(email, options.to, isBoardTarget);

        if (options.json) {
          console.log(JSON.stringify(member, null, 2));
        } else {
          console.log(`✓ Member added: ${member.email} (${member.id})`);
        }
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  // ─── members remove ────────────────────────────────────────────────────────
  membersCmd
    .command('remove <member-id>')
    .description('Remove a member from a board or collection')
    .requiredOption('--from <target-id>', 'Board or collection ID to remove member from')
    .option('--board-target', 'Target is a board (default)')
    .option('--collection-target', 'Target is a collection')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .action(async (memberId: string, options) => {
      const verbose = program.opts()?.verbose ?? false;
      try {

        const isBoardTarget = !options.collectionTarget;

        const client = await createFavroClient();
        
        const { readConfig } = await import('../lib/config');
        const { checkScope, checkCollectionScope, confirmAction } = await import('../lib/safety');
        if (isBoardTarget) {
          await checkScope(options.from, client, await readConfig(), options.force);
        } else {
          checkCollectionScope(options.from, await readConfig(), options.force);
        }
        
        if (!(await confirmAction(`Remove member ${memberId} from ${options.from}?`, { yes: options.yes }))) {
          console.log('Aborted.');
          process.exit(0);
        }
        
        const api = new FavroApiClient(client);

        await api.removeMember(memberId, options.from, isBoardTarget);
        console.log(`✓ Member ${memberId} removed from ${options.from}`);
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  // ─── members permissions ───────────────────────────────────────────────────
  membersCmd
    .command('permissions <member-id>')
    .description('Get permission level for a member on a board')
    .requiredOption('--board <board-id>', 'Board ID to check permissions on')
    .option('--json', 'Output as JSON')
    .action(async (memberId: string, options) => {
      const verbose = program.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();
        const api = new FavroApiClient(client);

        const level = await api.getMemberPermissions(memberId, options.board);

        if (options.json) {
          console.log(JSON.stringify({ memberId, boardId: options.board, permissionLevel: level }));
        } else {
          console.log(`Member ${memberId} on board ${options.board}: ${level}`);
        }
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });
}

export default registerMembersCommand;
