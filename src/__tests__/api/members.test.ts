/**
 * Unit tests — Members API client methods
 * CLA-1788 FAVRO-026: Members & Permissions API
 */
import { FavroApiClient, isValidEmail } from '../../api/members';
import FavroHttpClient from '../../lib/http-client';

jest.mock('../../lib/http-client');

const MockHttpClient = FavroHttpClient as jest.MockedClass<typeof FavroHttpClient>;

// ─── isValidEmail ────────────────────────────────────────────────────────────

describe('isValidEmail', () => {
  it('accepts valid emails', () => {
    expect(isValidEmail('user@example.com')).toBe(true);
    expect(isValidEmail('alice.bob@company.org')).toBe(true);
    expect(isValidEmail('test+alias@domain.co.uk')).toBe(true);
    expect(isValidEmail('  user@example.com  ')).toBe(true); // trims whitespace
  });

  it('rejects invalid emails', () => {
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('   ')).toBe(false);
    expect(isValidEmail('notanemail')).toBe(false);
    expect(isValidEmail('@nodomain.com')).toBe(false);
    expect(isValidEmail('user@')).toBe(false);
    expect(isValidEmail('user@domain')).toBe(false);
    expect(isValidEmail('user @example.com')).toBe(false);
    expect(isValidEmail('user@exam ple.com')).toBe(false);
  });
});

// ─── FavroApiClient.getMembers ───────────────────────────────────────────────

describe('FavroApiClient.getMembers', () => {
  let client: jest.Mocked<FavroHttpClient>;
  let api: FavroApiClient;

  beforeEach(() => {
    client = new MockHttpClient() as jest.Mocked<FavroHttpClient>;
    api = new FavroApiClient(client);
  });

  it('returns normalized members from single page', async () => {
    client.get = jest.fn().mockResolvedValue({
      entities: [
        { memberId: 'm1', email: 'alice@example.com', name: 'Alice', role: 'admin' },
        { memberId: 'm2', email: 'bob@example.com', name: 'Bob', role: 'member' },
      ],
    });

    const members = await api.getMembers();
    expect(members).toHaveLength(2);
    expect(members[0]).toEqual({ id: 'm1', email: 'alice@example.com', name: 'Alice', role: 'admin' });
    expect(members[1]).toEqual({ id: 'm2', email: 'bob@example.com', name: 'Bob', role: 'member' });
  });

  it('passes boardId filter to GET request', async () => {
    client.get = jest.fn().mockResolvedValue({ entities: [] });

    await api.getMembers({ boardId: 'board-123' });
    expect(client.get).toHaveBeenCalledWith('/users', expect.objectContaining({
      params: expect.objectContaining({ boardId: 'board-123' }),
    }));
  });

  it('passes collectionId filter to GET request', async () => {
    client.get = jest.fn().mockResolvedValue({ entities: [] });

    await api.getMembers({ collectionId: 'coll-456' });
    expect(client.get).toHaveBeenCalledWith('/users', expect.objectContaining({
      params: expect.objectContaining({ collectionId: 'coll-456' }),
    }));
  });

  it('paginates through multiple pages', async () => {
    client.get = jest.fn()
      .mockResolvedValueOnce({
        entities: [{ memberId: 'm1', email: 'a@x.com', name: 'A', role: 'member' }],
        requestId: 'req-1',
        pages: 2,
      })
      .mockResolvedValueOnce({
        entities: [{ memberId: 'm2', email: 'b@x.com', name: 'B', role: 'member' }],
        requestId: 'req-1',
        pages: 2,
      });

    const members = await api.getMembers();
    expect(members).toHaveLength(2);
    expect(client.get).toHaveBeenCalledTimes(2);
  });

  it('returns empty array when no members', async () => {
    client.get = jest.fn().mockResolvedValue({ entities: [] });
    const members = await api.getMembers();
    expect(members).toEqual([]);
  });

  it('normalizes member with userId fallback when memberId missing', async () => {
    client.get = jest.fn().mockResolvedValue({
      entities: [{ userId: 'u99', email: 'z@x.com', name: 'Z' }],
    });
    const members = await api.getMembers();
    expect(members[0].id).toBe('u99');
  });
});

// ─── FavroApiClient.addMember ────────────────────────────────────────────────

describe('FavroApiClient.addMember', () => {
  let client: jest.Mocked<FavroHttpClient>;
  let api: FavroApiClient;

  beforeEach(() => {
    client = new MockHttpClient() as jest.Mocked<FavroHttpClient>;
    api = new FavroApiClient(client);
  });

  it('adds a member to a board', async () => {
    client.post = jest.fn().mockResolvedValue({
      memberId: 'm-new',
      email: 'new@example.com',
      name: 'New User',
      role: 'member',
    });

    const member = await api.addMember('new@example.com', 'board-1', true);
    expect(member).toEqual({ id: 'm-new', email: 'new@example.com', name: 'New User', role: 'member' });
    expect(client.post).toHaveBeenCalledWith('/members', {
      email: 'new@example.com',
      targetId: 'board-1',
      targetType: 'board',
    });
  });

  it('adds a member to a collection', async () => {
    client.post = jest.fn().mockResolvedValue({
      memberId: 'm-new',
      email: 'new@example.com',
      name: 'New User',
      role: 'member',
    });

    await api.addMember('new@example.com', 'coll-1', false);
    expect(client.post).toHaveBeenCalledWith('/members', expect.objectContaining({
      targetType: 'collection',
    }));
  });

  it('throws on invalid email', async () => {
    await expect(api.addMember('invalid-email', 'board-1', true))
      .rejects.toThrow('Invalid email format');
  });

  it('throws on empty email', async () => {
    await expect(api.addMember('', 'board-1', true))
      .rejects.toThrow('Invalid email format');
  });

  it('throws on blank email', async () => {
    await expect(api.addMember('   ', 'board-1', true))
      .rejects.toThrow('Invalid email format');
  });

  it('trims whitespace from email before sending', async () => {
    client.post = jest.fn().mockResolvedValue({
      memberId: 'm1',
      email: 'user@example.com',
      name: 'User',
      role: 'member',
    });

    await api.addMember('  user@example.com  ', 'board-1', true);
    expect(client.post).toHaveBeenCalledWith('/members', expect.objectContaining({
      email: 'user@example.com',
    }));
  });

  it('propagates API errors', async () => {
    client.post = jest.fn().mockRejectedValue(new Error('API error: 404 Not Found'));
    await expect(api.addMember('user@example.com', 'nonexistent', true))
      .rejects.toThrow('API error: 404 Not Found');
  });
});

// ─── FavroApiClient.removeMember ─────────────────────────────────────────────

describe('FavroApiClient.removeMember', () => {
  let client: jest.Mocked<FavroHttpClient>;
  let api: FavroApiClient;

  beforeEach(() => {
    client = new MockHttpClient() as jest.Mocked<FavroHttpClient>;
    api = new FavroApiClient(client);
  });

  it('removes a member from a board', async () => {
    client.delete = jest.fn().mockResolvedValue(undefined);

    await api.removeMember('m-1', 'board-1', true);
    expect(client.delete).toHaveBeenCalledWith('/members/m-1', {
      params: { targetId: 'board-1', targetType: 'board' },
    });
  });

  it('removes a member from a collection', async () => {
    client.delete = jest.fn().mockResolvedValue(undefined);

    await api.removeMember('m-1', 'coll-1', false);
    expect(client.delete).toHaveBeenCalledWith('/members/m-1', {
      params: { targetId: 'coll-1', targetType: 'collection' },
    });
  });

  it('propagates API errors for non-existent member', async () => {
    client.delete = jest.fn().mockRejectedValue(new Error('404 Not Found'));
    await expect(api.removeMember('nonexistent', 'board-1', true))
      .rejects.toThrow('404 Not Found');
  });
});

// ─── FavroApiClient.getMemberPermissions ─────────────────────────────────────

describe('FavroApiClient.getMemberPermissions', () => {
  let client: jest.Mocked<FavroHttpClient>;
  let api: FavroApiClient;

  beforeEach(() => {
    client = new MockHttpClient() as jest.Mocked<FavroHttpClient>;
    api = new FavroApiClient(client);
  });

  it('returns viewer permission level', async () => {
    client.get = jest.fn().mockResolvedValue({ role: 'viewer' });
    const level = await api.getMemberPermissions('m-1', 'board-1');
    expect(level).toBe('viewer');
  });

  it('returns editor permission level', async () => {
    client.get = jest.fn().mockResolvedValue({ role: 'editor' });
    const level = await api.getMemberPermissions('m-1', 'board-1');
    expect(level).toBe('editor');
  });

  it('returns admin permission level', async () => {
    client.get = jest.fn().mockResolvedValue({ role: 'admin' });
    const level = await api.getMemberPermissions('m-1', 'board-1');
    expect(level).toBe('admin');
  });

  it('falls back to permissionLevel field', async () => {
    client.get = jest.fn().mockResolvedValue({ permissionLevel: 'editor' });
    const level = await api.getMemberPermissions('m-1', 'board-1');
    expect(level).toBe('editor');
  });

  it('throws for invalid permission level', async () => {
    client.get = jest.fn().mockResolvedValue({ role: 'superadmin' });
    await expect(api.getMemberPermissions('m-1', 'board-1'))
      .rejects.toThrow('Invalid or missing permission level');
  });

  it('throws when permission level is missing', async () => {
    client.get = jest.fn().mockResolvedValue({});
    await expect(api.getMemberPermissions('m-1', 'board-1'))
      .rejects.toThrow('Invalid or missing permission level');
  });

  it('passes boardId as query param', async () => {
    client.get = jest.fn().mockResolvedValue({ role: 'viewer' });
    await api.getMemberPermissions('m-1', 'board-99');
    expect(client.get).toHaveBeenCalledWith('/members/m-1', {
      params: { boardId: 'board-99' },
    });
  });

  it('propagates API errors for non-existent member', async () => {
    client.get = jest.fn().mockRejectedValue(new Error('404 Not Found'));
    await expect(api.getMemberPermissions('nonexistent', 'board-1'))
      .rejects.toThrow('404 Not Found');
  });
});
