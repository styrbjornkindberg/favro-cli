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
}
