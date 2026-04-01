/**
 * Unit tests — groups get/create/update/delete CLI commands
 */
import { Command } from 'commander';
import { registerUsersCommands } from '../../commands/users';
import * as config from '../../lib/config';
import * as safety from '../../lib/safety';
import UsersAPI from '../../lib/users-api';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../lib/safety');
jest.mock('../../lib/users-api');

const MockUsersAPI = UsersAPI as jest.MockedClass<typeof UsersAPI>;

function buildProgram(): Command {
  const program = new Command();
  program.option('--verbose', 'Show stack traces');
  registerUsersCommands(program);
  return program;
}

async function runCli(args: string[]): Promise<void> {
  const program = buildProgram();
  program.exitOverride();
  await program.parseAsync(['node', 'favro', ...args]);
}

beforeEach(() => {
  jest.clearAllMocks();
  (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
  (config.readConfig as jest.Mock).mockResolvedValue({});
  (safety.confirmAction as jest.Mock).mockResolvedValue(true);
});

describe('favro groups get', () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => { jest.restoreAllMocks(); });

  it('gets a group by ID', async () => {
    MockUsersAPI.prototype.getGroup = jest.fn().mockResolvedValue({
      userGroupId: 'grp-1',
      name: 'Developers',
      userIds: ['u-1', 'u-2'],
    });

    await runCli(['groups', 'get', 'grp-1']);

    expect(MockUsersAPI.prototype.getGroup).toHaveBeenCalledWith('grp-1');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Developers'));
  });

  it('outputs JSON', async () => {
    MockUsersAPI.prototype.getGroup = jest.fn().mockResolvedValue({
      userGroupId: 'grp-1',
      name: 'Developers',
      userIds: [],
    });

    await runCli(['groups', 'get', 'grp-1', '--json']);

    const jsonCall = consoleSpy.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('userGroupId')
    );
    expect(jsonCall).toBeDefined();
  });
});

describe('favro groups create', () => {
  let consoleSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(() => { jest.restoreAllMocks(); });

  it('creates a group', async () => {
    MockUsersAPI.prototype.createGroup = jest.fn().mockResolvedValue({
      userGroupId: 'grp-new',
      name: 'New Team',
    });

    await runCli(['groups', 'create', '--name', 'New Team', '--yes']);

    expect(MockUsersAPI.prototype.createGroup).toHaveBeenCalledWith('New Team', undefined);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Group created'));
  });

  it('creates a group with members', async () => {
    MockUsersAPI.prototype.createGroup = jest.fn().mockResolvedValue({
      userGroupId: 'grp-new',
      name: 'Team',
      userIds: ['u-1', 'u-2'],
    });

    await runCli(['groups', 'create', '--name', 'Team', '--members', 'u-1,u-2', '--yes']);

    expect(MockUsersAPI.prototype.createGroup).toHaveBeenCalledWith('Team', ['u-1', 'u-2']);
  });

  it('dry-run previews', async () => {
    await runCli(['groups', 'create', '--name', 'Test', '--dry-run']);

    expect(safety.dryRunLog).toHaveBeenCalled();
    expect(MockUsersAPI.prototype.createGroup).not.toHaveBeenCalled();
  });
});

describe('favro groups update', () => {
  let consoleSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(() => { jest.restoreAllMocks(); });

  it('updates a group name', async () => {
    MockUsersAPI.prototype.updateGroup = jest.fn().mockResolvedValue({
      userGroupId: 'grp-1',
      name: 'Renamed',
    });

    await runCli(['groups', 'update', 'grp-1', '--name', 'Renamed', '--yes']);

    expect(MockUsersAPI.prototype.updateGroup).toHaveBeenCalledWith('grp-1', { name: 'Renamed' });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Group updated'));
  });

  it('errors when no fields provided', async () => {
    await runCli(['groups', 'update', 'grp-1']);

    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});

describe('favro groups delete', () => {
  let consoleSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
  });

  afterEach(() => { jest.restoreAllMocks(); });

  it('deletes a group', async () => {
    MockUsersAPI.prototype.deleteGroup = jest.fn().mockResolvedValue(undefined);

    await runCli(['groups', 'delete', 'grp-1', '--yes']);

    expect(MockUsersAPI.prototype.deleteGroup).toHaveBeenCalledWith('grp-1');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Group deleted'));
  });

  it('aborts when user declines', async () => {
    (safety.confirmAction as jest.Mock).mockResolvedValue(false);

    await runCli(['groups', 'delete', 'grp-1']);

    expect(MockUsersAPI.prototype.deleteGroup).not.toHaveBeenCalled();
  });
});
