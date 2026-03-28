/**
 * Unit tests — members CLI commands
 * CLA-1788 FAVRO-026: Members & Permissions API
 */
import { Command } from 'commander';
import { registerMembersCommand } from '../../commands/members';
import * as config from '../../lib/config';
import * as apiMembers from '../../api/members';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../api/members');

const MockFavroApiClient = apiMembers.FavroApiClient as jest.MockedClass<typeof apiMembers.FavroApiClient>;

const SAMPLE_MEMBERS = [
  { id: 'm1', name: 'Alice', email: 'alice@example.com', role: 'admin' },
  { id: 'm2', name: 'Bob', email: 'bob@example.com', role: 'member' },
];

function buildProgram(): Command {
  const program = new Command();
  program.option('--verbose', 'Show stack traces');
  registerMembersCommand(program);
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
  (apiMembers.isValidEmail as jest.Mock).mockImplementation((email: string) => {
    if (!email || !email.trim()) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  });
});

// ─── members list ─────────────────────────────────────────────────────────────

describe('favro members list', () => {
  let consoleSpy: jest.SpyInstance;
  let consoleTableSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleTableSpy = jest.spyOn(console, 'table').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleTableSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('lists all members without filters', async () => {
    MockFavroApiClient.prototype.getMembers = jest.fn().mockResolvedValue(SAMPLE_MEMBERS);

    await runCli(['members', 'list']);

    expect(MockFavroApiClient.prototype.getMembers).toHaveBeenCalledWith({
      boardId: undefined,
      collectionId: undefined,
    });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('2 member'));
    expect(consoleTableSpy).toHaveBeenCalled();
  });

  it('passes --board filter', async () => {
    MockFavroApiClient.prototype.getMembers = jest.fn().mockResolvedValue(SAMPLE_MEMBERS);

    await runCli(['members', 'list', '--board', 'board-123']);

    expect(MockFavroApiClient.prototype.getMembers).toHaveBeenCalledWith({
      boardId: 'board-123',
      collectionId: undefined,
    });
  });

  it('passes --collection filter', async () => {
    MockFavroApiClient.prototype.getMembers = jest.fn().mockResolvedValue(SAMPLE_MEMBERS);

    await runCli(['members', 'list', '--collection', 'coll-456']);

    expect(MockFavroApiClient.prototype.getMembers).toHaveBeenCalledWith({
      boardId: undefined,
      collectionId: 'coll-456',
    });
  });

  it('outputs JSON when --json flag is set', async () => {
    MockFavroApiClient.prototype.getMembers = jest.fn().mockResolvedValue(SAMPLE_MEMBERS);

    await runCli(['members', 'list', '--json']);

    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(SAMPLE_MEMBERS, null, 2));
    expect(consoleTableSpy).not.toHaveBeenCalled();
  });

  it('shows "No members found" when empty', async () => {
    MockFavroApiClient.prototype.getMembers = jest.fn().mockResolvedValue([]);

    await runCli(['members', 'list']);

    expect(consoleSpy).toHaveBeenCalledWith('No members found.');
  });

  it('exits 1 when no API key', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(null);
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    await runCli(['members', 'list']);

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('exits 1 on API error', async () => {
    MockFavroApiClient.prototype.getMembers = jest.fn().mockRejectedValue(new Error('Network error'));
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    await runCli(['members', 'list']);

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

// ─── members add ─────────────────────────────────────────────────────────────

describe('favro members add', () => {
  let consoleSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('adds a member to a board (default board-target)', async () => {
    MockFavroApiClient.prototype.addMember = jest.fn().mockResolvedValue(SAMPLE_MEMBERS[0]);

    await runCli(['members', 'add', 'alice@example.com', '--to', 'board-1']);

    expect(MockFavroApiClient.prototype.addMember).toHaveBeenCalledWith(
      'alice@example.com', 'board-1', true
    );
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Member added'));
  });

  it('adds a member to a collection with --collection-target', async () => {
    MockFavroApiClient.prototype.addMember = jest.fn().mockResolvedValue(SAMPLE_MEMBERS[0]);

    await runCli(['members', 'add', 'alice@example.com', '--to', 'coll-1', '--collection-target']);

    expect(MockFavroApiClient.prototype.addMember).toHaveBeenCalledWith(
      'alice@example.com', 'coll-1', false
    );
  });

  it('outputs JSON when --json flag is set', async () => {
    MockFavroApiClient.prototype.addMember = jest.fn().mockResolvedValue(SAMPLE_MEMBERS[0]);

    await runCli(['members', 'add', 'alice@example.com', '--to', 'board-1', '--json']);

    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(SAMPLE_MEMBERS[0], null, 2));
  });

  it('exits 1 on invalid email', async () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    await runCli(['members', 'add', 'not-an-email', '--to', 'board-1']);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid email'));
    exitSpy.mockRestore();
  });

  it('exits 1 on empty email', async () => {
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    // Empty email would be rejected by email validation
    await runCli(['members', 'add', '', '--to', 'board-1']);

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('exits 1 on API error (non-existent target)', async () => {
    MockFavroApiClient.prototype.addMember = jest.fn().mockRejectedValue(new Error('404 Not Found'));
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    await runCli(['members', 'add', 'alice@example.com', '--to', 'nonexistent']);

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

// ─── members remove ───────────────────────────────────────────────────────────

describe('favro members remove', () => {
  let consoleSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('removes a member from a board', async () => {
    MockFavroApiClient.prototype.removeMember = jest.fn().mockResolvedValue(undefined);

    await runCli(['members', 'remove', 'm-1', '--from', 'board-1']);

    expect(MockFavroApiClient.prototype.removeMember).toHaveBeenCalledWith('m-1', 'board-1', true);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('m-1'));
  });

  it('removes a member from a collection', async () => {
    MockFavroApiClient.prototype.removeMember = jest.fn().mockResolvedValue(undefined);

    await runCli(['members', 'remove', 'm-1', '--from', 'coll-1', '--collection-target']);

    expect(MockFavroApiClient.prototype.removeMember).toHaveBeenCalledWith('m-1', 'coll-1', false);
  });

  it('exits 1 on API error (non-existent member)', async () => {
    MockFavroApiClient.prototype.removeMember = jest.fn().mockRejectedValue(new Error('404 Not Found'));
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    await runCli(['members', 'remove', 'nonexistent', '--from', 'board-1']);

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

// ─── members permissions ──────────────────────────────────────────────────────

describe('favro members permissions', () => {
  let consoleSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('shows viewer permission level', async () => {
    MockFavroApiClient.prototype.getMemberPermissions = jest.fn().mockResolvedValue('viewer');

    await runCli(['members', 'permissions', 'm-1', '--board', 'board-1']);

    expect(MockFavroApiClient.prototype.getMemberPermissions).toHaveBeenCalledWith('m-1', 'board-1');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('viewer'));
  });

  it('shows editor permission level', async () => {
    MockFavroApiClient.prototype.getMemberPermissions = jest.fn().mockResolvedValue('editor');

    await runCli(['members', 'permissions', 'm-1', '--board', 'board-1']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('editor'));
  });

  it('shows admin permission level', async () => {
    MockFavroApiClient.prototype.getMemberPermissions = jest.fn().mockResolvedValue('admin');

    await runCli(['members', 'permissions', 'm-1', '--board', 'board-1']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('admin'));
  });

  it('outputs JSON when --json flag is set', async () => {
    MockFavroApiClient.prototype.getMemberPermissions = jest.fn().mockResolvedValue('editor');

    await runCli(['members', 'permissions', 'm-1', '--board', 'board-1', '--json']);

    expect(consoleSpy).toHaveBeenCalledWith(
      JSON.stringify({ memberId: 'm-1', boardId: 'board-1', permissionLevel: 'editor' })
    );
  });

  it('exits 1 on non-existent member', async () => {
    MockFavroApiClient.prototype.getMemberPermissions = jest.fn().mockRejectedValue(new Error('404 Not Found'));
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    await runCli(['members', 'permissions', 'nonexistent', '--board', 'board-1']);

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('exits 1 on non-existent board', async () => {
    MockFavroApiClient.prototype.getMemberPermissions = jest.fn().mockRejectedValue(new Error('404 Not Found'));
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    await runCli(['members', 'permissions', 'm-1', '--board', 'nonexistent']);

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
