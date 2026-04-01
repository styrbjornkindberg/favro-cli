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

export function registerUsersCommands(program: Command): void {
  const usersCommand = program.command('users').description('Manage organization users');

  usersCommand
    .command('list')
    .description('List all users in the organization')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const verbose = usersCommand.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();
        const api = new UsersAPI(client);
        const users = await api.listUsers();

        if (options.json) {
          console.log(JSON.stringify(users, null, 2));
        } else {
          console.log(`Found ${users.length} user(s):`);
          const rows = users.map(u => ({
            ID: u.userId,
            Name: u.name,
            Email: u.email,
            Role: u.organizationRole || 'member',
          }));
          console.table(rows);
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
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const verbose = groupsCommand.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();
        const api = new UsersAPI(client);
        const groups = await api.listGroups();

        if (options.json) {
          console.log(JSON.stringify(groups, null, 2));
        } else {
          console.log(`Found ${groups.length} group(s):`);
          const rows = groups.map(g => ({
            ID: g.userGroupId,
            Name: g.name,
            Members: (g.userIds || []).length,
          }));
          console.table(rows);
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
