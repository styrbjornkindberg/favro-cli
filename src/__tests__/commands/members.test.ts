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
jest.mock('../../lib/safety', () => ({
  checkScope: jest.fn().mockResolvedValue(true),
  checkCollectionScope: jest.fn().mockResolvedValue(true),
  confirmAction: jest.fn().mockResolvedValue(true)
}));

const MockFavroApiClient = apiMembers.FavroApiClient as jest.MockedClass<typeof apiMembers.FavroApiClient>;

const SAMPLE_MEMBERS = [
  { id: 'm1', name: 'Alice', email: 'alice@example.com', role: 'admin' },
  { id: 'm2', name: 'Bob', email: 'bob@example.com', role: 'member' },
];

function buildProgram(): Command {
  const program = new Command();
  // The runner's three flags live on the root (ADR-0002).
  program.option('--verbose', 'Show stack traces').option('--human').option('--pretty');
  registerMembersCommand(program);
  return program;
}

async function runCli(args: string[]): Promise<void> {
  const program = buildProgram();
  program.exitOverride();
  await program.parseAsync(['node', 'favro', ...args]);
}

/** The runner's error envelope, off whatever went to stdout. */
const errorEnvelope = (spy: jest.SpyInstance) =>
  JSON.parse(spy.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('{"error"'))!);

beforeEach(() => {
  jest.clearAllMocks();
  process.exitCode = undefined;
  (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
  (config.readConfig as jest.Mock).mockResolvedValue({});
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

    await runCli(['members', 'list', '--human']);

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

  it('answers the rows envelope by default \u2014 --json is gone from the leaf', async () => {
    MockFavroApiClient.prototype.getMembers = jest.fn().mockResolvedValue(SAMPLE_MEMBERS);

    await runCli(['members', 'list']);

    // An envelope, not a bare array — the shape every list read emits (#99).
    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify({ rows: SAMPLE_MEMBERS }));
    expect(consoleTableSpy).not.toHaveBeenCalled();
  });

  it('shows "No members found" under --human when empty', async () => {
    MockFavroApiClient.prototype.getMembers = jest.fn().mockResolvedValue([]);

    await runCli(['members', 'list', '--human']);

    expect(consoleSpy).toHaveBeenCalledWith('No members found.');
  });

  it('an empty list still prints an envelope rather than nothing', async () => {
    // ADR-0002: a successful command never prints nothing.
    MockFavroApiClient.prototype.getMembers = jest.fn().mockResolvedValue([]);

    await runCli(['members', 'list']);

    expect(consoleSpy).toHaveBeenCalledWith('{"rows":[]}');
  });

  it('refuses --board and --collection together, before any request', async () => {
    MockFavroApiClient.prototype.getMembers = jest.fn();

    await runCli(['members', 'list', '--board', 'b-1', '--collection', 'c-1']);

    expect(errorEnvelope(consoleSpy).error.message).toContain('cannot specify both');
    expect(errorEnvelope(consoleSpy).error.retryable).toBe(false);
    expect(MockFavroApiClient.prototype.getMembers).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('exits 1 when no API key', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(null);

    await runCli(['members', 'list']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringMatching(/^\{"error":/));
    expect(process.exitCode).toBe(1);
  });

  it('exits 1 on API error', async () => {
    MockFavroApiClient.prototype.getMembers = jest.fn().mockRejectedValue(new Error('Network error'));

    await runCli(['members', 'list']);

    expect(errorEnvelope(consoleSpy).error.message).toBe('Network error');
    expect(process.exitCode).toBe(1);
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

    await runCli(['members', 'add', 'alice@example.com', '--to', 'board-1', '--human']);

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

  it('a successful add prints the member in JSON mode too', async () => {
    MockFavroApiClient.prototype.addMember = jest.fn().mockResolvedValue(SAMPLE_MEMBERS[0]);

    await runCli(['members', 'add', 'alice@example.com', '--to', 'board-1']);

    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(SAMPLE_MEMBERS[0]));
  });

  it('--dry-run answers a parseable preview and writes nothing', async () => {
    MockFavroApiClient.prototype.addMember = jest.fn();

    await runCli(['members', 'add', 'alice@example.com', '--to', 'board-1', '--dry-run']);

    expect(MockFavroApiClient.prototype.addMember).not.toHaveBeenCalled();
    expect(JSON.parse(String(consoleSpy.mock.calls[0][0]))).toEqual({
      dryRun: true, email: 'alice@example.com', targetId: 'board-1', targetType: 'board',
    });
  });

  it('takes the scope lock BEFORE the preview, so a dry-run cannot route around it', async () => {
    // #103's order, stated in `batch.ts` for its siblings: a preview that says
    // "would add alice to board-outside-the-lock" describes a write that will
    // refuse. The preview has to be refused too, or it is misinformation.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const safety = require('../../lib/safety');
    (safety.checkScope as jest.Mock).mockRejectedValueOnce(
      new Error('Board board-9 is outside the locked collection.'),
    );
    MockFavroApiClient.prototype.addMember = jest.fn();

    await runCli(['members', 'add', 'alice@example.com', '--to', 'board-9', '--dry-run']);

    expect(MockFavroApiClient.prototype.addMember).not.toHaveBeenCalled();
    const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('outside the locked collection');
    expect(output).not.toContain('dryRun');
    expect(process.exitCode).toBe(1);
  });

  it.each([['not-an-email'], ['']])('refuses the invalid email %p before any write', async (email) => {
    MockFavroApiClient.prototype.addMember = jest.fn();

    await runCli(['members', 'add', email, '--to', 'board-1']);

    expect(errorEnvelope(consoleSpy).error.message).toContain('Invalid email');
    expect(errorEnvelope(consoleSpy).error.retryable).toBe(false);
    expect(MockFavroApiClient.prototype.addMember).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('exits 1 on API error (non-existent target)', async () => {
    MockFavroApiClient.prototype.addMember = jest.fn().mockRejectedValue(new Error('404 Not Found'));

    await runCli(['members', 'add', 'alice@example.com', '--to', 'nonexistent']);

    expect(errorEnvelope(consoleSpy).error.message).toBe('404 Not Found');
    expect(process.exitCode).toBe(1);
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

    await runCli(['members', 'remove', 'm-1', '--from', 'board-1', '--human']);

    expect(MockFavroApiClient.prototype.removeMember).toHaveBeenCalledWith('m-1', 'board-1', true);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('m-1'));
  });

  it('removes a member from a collection', async () => {
    MockFavroApiClient.prototype.removeMember = jest.fn().mockResolvedValue(undefined);

    await runCli(['members', 'remove', 'm-1', '--from', 'coll-1', '--collection-target']);

    expect(MockFavroApiClient.prototype.removeMember).toHaveBeenCalledWith('m-1', 'coll-1', false);
  });

  it('a successful remove prints a parseable result in JSON mode', async () => {
    MockFavroApiClient.prototype.removeMember = jest.fn().mockResolvedValue(undefined);

    await runCli(['members', 'remove', 'm-1', '--from', 'board-1']);

    expect(consoleSpy).toHaveBeenCalledWith(
      JSON.stringify({ removed: true, memberId: 'm-1', targetId: 'board-1' }),
    );
  });

  it('a declined confirmation is exit 0 and a readable result, not a failure', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    (require('../../lib/safety').confirmAction as jest.Mock).mockResolvedValueOnce(false);
    MockFavroApiClient.prototype.removeMember = jest.fn();

    await runCli(['members', 'remove', 'm-1', '--from', 'board-1']);

    expect(MockFavroApiClient.prototype.removeMember).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      JSON.stringify({ removed: false, aborted: true, memberId: 'm-1', targetId: 'board-1' }),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('checks the scope lock before it asks for confirmation', async () => {
    // The #78 shape: a user must not answer "remove?" and then be refused.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const safety = require('../../lib/safety');
    const order: string[] = [];
    (safety.checkScope as jest.Mock).mockImplementation(async () => { order.push('scope'); });
    (safety.confirmAction as jest.Mock).mockImplementation(async () => { order.push('confirm'); return true; });
    MockFavroApiClient.prototype.removeMember = jest.fn().mockResolvedValue(undefined);

    await runCli(['members', 'remove', 'm-1', '--from', 'board-1']);

    expect(order).toEqual(['scope', 'confirm']);
  });

  it('exits 1 on API error (non-existent member)', async () => {
    MockFavroApiClient.prototype.removeMember = jest.fn().mockRejectedValue(new Error('404 Not Found'));

    await runCli(['members', 'remove', 'nonexistent', '--from', 'board-1']);

    expect(errorEnvelope(consoleSpy).error.message).toBe('404 Not Found');
    expect(process.exitCode).toBe(1);
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

    await runCli(['members', 'permissions', 'm-1', '--board', 'board-1', '--human']);

    expect(MockFavroApiClient.prototype.getMemberPermissions).toHaveBeenCalledWith('m-1', 'board-1');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('viewer'));
  });

  it('shows editor permission level', async () => {
    MockFavroApiClient.prototype.getMemberPermissions = jest.fn().mockResolvedValue('editor');

    await runCli(['members', 'permissions', 'm-1', '--board', 'board-1', '--human']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('editor'));
  });

  it('shows admin permission level', async () => {
    MockFavroApiClient.prototype.getMemberPermissions = jest.fn().mockResolvedValue('admin');

    await runCli(['members', 'permissions', 'm-1', '--board', 'board-1', '--human']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('admin'));
  });

  it('answers the same object as JSON by default', async () => {
    MockFavroApiClient.prototype.getMemberPermissions = jest.fn().mockResolvedValue('editor');

    await runCli(['members', 'permissions', 'm-1', '--board', 'board-1']);

    expect(consoleSpy).toHaveBeenCalledWith(
      JSON.stringify({ memberId: 'm-1', boardId: 'board-1', permissionLevel: 'editor' })
    );
  });

  it.each([
    ['non-existent member', ['members', 'permissions', 'nonexistent', '--board', 'board-1']],
    ['non-existent board', ['members', 'permissions', 'm-1', '--board', 'nonexistent']],
  ])('answers an error envelope for a %s', async (_name, args) => {
    MockFavroApiClient.prototype.getMemberPermissions = jest.fn().mockRejectedValue(new Error('404 Not Found'));

    await runCli(args);

    expect(errorEnvelope(consoleSpy).error.message).toBe('404 Not Found');
    expect(process.exitCode).toBe(1);
  });
});
