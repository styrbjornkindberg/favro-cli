/**
 * Users & Groups Commands
 * CLA-1806 FAVRO-XXX: Identity Endpoints
 *
 * favro users list
 * favro groups list
 */
import { Command } from 'commander';
import UsersAPI from '../lib/users-api';
import { createFavroClient } from '../lib/client-factory';
import { logError } from '../lib/error-handler';
import { confirmAction, dryRunLog } from '../lib/safety';
import { capRows, noteTruncation, writeEnvelope } from '../lib/read-shape';

export function registerUsersCommands(program: Command): void {
  const usersCommand = program.command('users').description('Manage organization users');

  usersCommand
    .command('list')
    .description('List all users in the organization')
    .option('--limit <n>', 'Cap how many rows are printed; sets "truncated"')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const verbose = usersCommand.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();
        const api = new UsersAPI(client);
        const users = await api.listUsers();
        // The fetch already ran to completion; `--limit` cuts the PRINT (#99).
        const envelope = capRows(users, options.limit);

        if (options.json) {
          writeEnvelope(envelope, Boolean(program.opts()?.pretty));
        } else {
          console.log(`Found ${envelope.rows.length} user(s):`);
          const rows = envelope.rows.map(u => ({
            ID: u.userId,
            Name: u.name,
            Email: u.email,
            Role: u.organizationRole || 'member',
          }));
          console.table(rows);
          noteTruncation(envelope, users.length);
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  usersCommand
    .command('get <user>')
    .description('Get one user by name, email or userId')
    .option('--json', 'Output as JSON')
    .action(async (user: string, options) => {
      const verbose = usersCommand.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();
        const api = new UsersAPI(client);
        const found = await api.getUser(user);

        if (options.json) {
          console.log(JSON.stringify(found, null, 2));
        } else {
          console.log(`User: ${found.name}`);
          console.log(`ID: ${found.userId}`);
          console.log(`Email: ${found.email}`);
          console.log(`Role: ${found.organizationRole || 'member'}`);
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  const groupsCommand = program.command('groups').description('Manage organization user groups');

  groupsCommand
    .command('list')
    .description('List all user groups in the organization')
    .option('--limit <n>', 'Cap how many rows are printed; sets "truncated"')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const verbose = groupsCommand.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();
        const api = new UsersAPI(client);
        const groups = await api.listGroups();
        // The fetch already ran to completion; `--limit` cuts the PRINT (#99).
        const envelope = capRows(groups, options.limit);

        if (options.json) {
          writeEnvelope(envelope, Boolean(program.opts()?.pretty));
        } else {
          console.log(`Found ${envelope.rows.length} group(s):`);
          const rows = envelope.rows.map(g => ({
            ID: g.userGroupId,
            Name: g.name,
            Members: (g.userIds || []).length,
          }));
          console.table(rows);
          noteTruncation(envelope, groups.length);
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  groupsCommand
    .command('get <groupId>')
    .description('Get a user group by ID')
    .option('--json', 'Output as JSON')
    .action(async (groupId: string, options) => {
      const verbose = groupsCommand.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();
        const api = new UsersAPI(client);
        const group = await api.getGroup(groupId);

        if (options.json) {
          console.log(JSON.stringify(group, null, 2));
        } else {
          console.log(`Group: ${group.name} (${group.userGroupId})`);
          console.log(`Members: ${(group.userIds || []).length}`);
          if (group.userIds && group.userIds.length > 0) {
            console.log(`User IDs: ${group.userIds.join(', ')}`);
          }
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  // The three group writes below (#104) skip the scope lock on purpose. The lock
  // is a COLLECTION lock — `assertScope` resolves the board a write lands on and
  // checks that board against the locked collection. A user group is an org-scoped
  // entity: no board, nothing to resolve. A check here would either always pass
  // (a lie) or always refuse, breaking group management for every locked user.
  // Neither is the lock working; it is the lock pretending. An org-level guardrail
  // would be a DIFFERENT guardrail, and one that does not exist yet. What actually
  // guards these paths is `confirmAction`.
  groupsCommand
    .command('create')
    .description('Create a new user group')
    .requiredOption('--name <name>', 'Group name')
    .option('--members <userIds>', 'Comma-separated user IDs to add')
    .option('--json', 'Output as JSON')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (options) => {
      const verbose = groupsCommand.opts()?.verbose ?? false;
      try {
        if (options.dryRun) {
          dryRunLog('creating', 'group', options.name);
          return;
        }

        if (!(await confirmAction(`Create group "${options.name}"?`, { yes: options.yes }))) {
          return;
        }

        const client = await createFavroClient();
        const api = new UsersAPI(client);
        const memberIds = options.members ? options.members.split(',').map((s: string) => s.trim()) : undefined;
        const group = await api.createGroup(options.name, memberIds);

        if (options.json) {
          console.log(JSON.stringify(group, null, 2));
        } else {
          console.log(`✓ Group created: ${group.userGroupId} (${group.name})`);
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  groupsCommand
    .command('update <groupId>')
    .description('Update a user group')
    .option('--name <name>', 'New group name')
    .option('--add-members <userIds>', 'Comma-separated user IDs to add')
    .option('--remove-members <userIds>', 'Comma-separated user IDs to remove')
    .option('--json', 'Output as JSON')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (groupId: string, options) => {
      const verbose = groupsCommand.opts()?.verbose ?? false;
      try {
        const updateData: { name?: string; addMembers?: string[]; removeMembers?: string[] } = {};
        if (options.name) updateData.name = options.name;
        if (options.addMembers) updateData.addMembers = options.addMembers.split(',').map((s: string) => s.trim());
        if (options.removeMembers) updateData.removeMembers = options.removeMembers.split(',').map((s: string) => s.trim());

        if (Object.keys(updateData).length === 0) {
          console.error('Error: Provide at least one field: --name, --add-members, or --remove-members');
          process.exit(1);
        }

        if (options.dryRun) {
          dryRunLog('updating', 'group', groupId, updateData);
          return;
        }

        if (!(await confirmAction(`Update group ${groupId}?`, { yes: options.yes }))) {
          return;
        }

        const client = await createFavroClient();
        const api = new UsersAPI(client);
        const group = await api.updateGroup(groupId, updateData);

        if (options.json) {
          console.log(JSON.stringify(group, null, 2));
        } else {
          console.log(`✓ Group updated: ${group.userGroupId} (${group.name})`);
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  groupsCommand
    .command('delete <groupId>')
    .description('Delete a user group')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (groupId: string, options) => {
      const verbose = groupsCommand.opts()?.verbose ?? false;
      try {
        if (options.dryRun) {
          dryRunLog('deleting', 'group', groupId);
          return;
        }

        if (!(await confirmAction(`Delete group ${groupId}? This cannot be undone.`, { yes: options.yes }))) {
          return;
        }

        const client = await createFavroClient();
        const api = new UsersAPI(client);
        await api.deleteGroup(groupId);

        console.log(`✓ Group deleted: ${groupId}`);
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });
}
