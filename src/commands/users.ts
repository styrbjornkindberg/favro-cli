/**
 * Users & Groups Commands
 * CLA-1806 FAVRO-XXX: Identity Endpoints
 *
 * favro users list
 * favro groups list
 */
import { Command } from 'commander';
import { User, UserGroup } from '../lib/users-api';
import { RefusalError } from '../lib/refusal';
import { assertOrgScope, confirmAction, dryRunLog } from '../lib/safety';
import { Ctx, run } from '../lib/run';

/** The flag row the group writes share. */
interface GroupWriteFlags {
  name?: string;
  members?: string;
  addMembers?: string;
  removeMembers?: string;
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
}

/** A comma-separated flag value, as the three group writes read it. */
const idList = (value?: string): string[] | undefined =>
  value ? value.split(',').map((s) => s.trim()) : undefined;

export function registerUsersCommands(program: Command): void {
  const usersCommand = program.command('users').description('Manage organization users');

  usersCommand
    .command('list')
    .description('List all users in the organization')
    .option('--limit <n>', 'Cap how many rows are printed; sets "truncated"')
    .action(run(async (ctx: Ctx, options: { limit?: string }) => ({
      // The fetch runs to completion; `--limit` cuts the PRINT (#99).
      rows: await ctx.api.users.listUsers(),
      limit: options.limit,
      human: (users: User[]) => {
        console.log(`Found ${users.length} user(s):`);
        console.table(users.map(u => ({
          ID: u.userId,
          Name: u.name,
          Email: u.email,
          Role: u.organizationRole || 'member',
        })));
      },
    })));

  usersCommand
    .command('get <user>')
    .description('Get one user by name, email or userId')
    .action(run(async (ctx: Ctx, user: string) => ({
      item: await ctx.api.users.getUser(user),
      human: (found: User) => [
        `User: ${found.name}`,
        `ID: ${found.userId}`,
        `Email: ${found.email}`,
        `Role: ${found.organizationRole || 'member'}`,
      ].join('\n'),
    })));

  const groupsCommand = program.command('groups').description('Manage organization user groups');

  groupsCommand
    .command('list')
    .description('List all user groups in the organization')
    .option('--limit <n>', 'Cap how many rows are printed; sets "truncated"')
    .action(run(async (ctx: Ctx, options: { limit?: string }) => ({
      rows: await ctx.api.users.listGroups(),
      limit: options.limit,
      human: (groups: UserGroup[]) => {
        console.log(`Found ${groups.length} group(s):`);
        console.table(groups.map(g => ({
          ID: g.userGroupId,
          Name: g.name,
          Members: (g.userIds || []).length,
        })));
      },
    })));

  groupsCommand
    .command('get <groupId>')
    .description('Get a user group by ID')
    .action(run(async (ctx: Ctx, groupId: string) => ({
      item: await ctx.api.users.getGroup(groupId),
      human: (group: UserGroup) =>
        [
          `Group: ${group.name} (${group.userGroupId})`,
          `Members: ${(group.userIds || []).length}`,
          ...(group.userIds && group.userIds.length > 0
            ? [`User IDs: ${group.userIds.join(', ')}`]
            : []),
        ].join('\n'),
    })));

  // The three group writes below (#104) skip the scope lock on purpose. The lock
  // is a COLLECTION lock — `assertScope` resolves the board a write lands on and
  // checks that board against the locked collection. A user group is an org-scoped
  // entity: no board, nothing to resolve. A check here would either always pass
  // (a lie) or always refuse, breaking group management for every locked user.
  // Neither is the lock working; it is the lock pretending. An org-level guardrail
  // has to be a DIFFERENT guardrail — #125 built one (`assertOrgScope`), and it
  // covers `delete` only: deleting a group is org-wide and irreversible, while
  // `create` is additive and `update` is undone by another update. On those two
  // the guard remains `confirmAction`, which `-y` waives.
  groupsCommand
    .command('create')
    .description('Create a new user group')
    .requiredOption('--name <name>', 'Group name')
    .option('--members <userIds>', 'Comma-separated user IDs to add')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(run(async (ctx: Ctx, options: GroupWriteFlags) => {
      if (options.dryRun) {
        dryRunLog('creating', 'group', options.name!);
        return;
      }

      if (!(await confirmAction(`Create group "${options.name}"?`, { yes: options.yes }))) {
        return;
      }

      return {
        item: await ctx.api.users.createGroup(options.name!, idList(options.members)),
        human: (group: UserGroup) => `✓ Group created: ${group.userGroupId} (${group.name})`,
      };
    }));

  groupsCommand
    .command('update <groupId>')
    .description('Update a user group')
    .option('--name <name>', 'New group name')
    .option('--add-members <userIds>', 'Comma-separated user IDs to add')
    .option('--remove-members <userIds>', 'Comma-separated user IDs to remove')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(run(async (ctx: Ctx, groupId: string, options: GroupWriteFlags) => {
      const updateData: { name?: string; addMembers?: string[]; removeMembers?: string[] } = {};
      if (options.name) updateData.name = options.name;
      if (options.addMembers) updateData.addMembers = idList(options.addMembers);
      if (options.removeMembers) updateData.removeMembers = idList(options.removeMembers);

      if (Object.keys(updateData).length === 0) {
        throw new RefusalError('Provide at least one field: --name, --add-members, or --remove-members');
      }

      if (options.dryRun) {
        dryRunLog('updating', 'group', groupId, updateData);
        return;
      }

      if (!(await confirmAction(`Update group ${groupId}?`, { yes: options.yes }))) {
        return;
      }

      return {
        item: await ctx.api.users.updateGroup(groupId, updateData),
        human: (group: UserGroup) => `✓ Group updated: ${group.userGroupId} (${group.name})`,
      };
    }));

  groupsCommand
    .command('delete <groupId>')
    .description('Delete a user group — organization-wide; refused while a scope lock is set')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Allow this org-wide delete despite the scope lock')
    .action(run(async (ctx: Ctx, groupId: string, options: GroupWriteFlags) => {
      // #125: org-wide and irreversible, so the org guard applies even though
      // the collection lock cannot. Before the dry-run, so a preview is not a
      // way around it.
      await assertOrgScope(`Deleting group ${groupId}`, options.force);

      if (options.dryRun) {
        dryRunLog('deleting', 'group', groupId);
        return;
      }

      if (!(await confirmAction(`Delete group ${groupId}? This cannot be undone.`, { yes: options.yes }))) {
        return;
      }

      await ctx.api.users.deleteGroup(groupId);

      return { item: { deleted: true, groupId }, human: () => `✓ Group deleted: ${groupId}` };
    }));
}
