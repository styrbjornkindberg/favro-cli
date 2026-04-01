/**
 * Unit tests — UsersAPI group CRUD methods
 */
import UsersAPI from '../../lib/users-api';

function makeMockClient() {
  return {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
  };
}

describe('UsersAPI.getGroup', () => {
  it('gets a group by ID', async () => {
    const client = makeMockClient();
    client.get.mockResolvedValue({
      userGroupId: 'grp-1',
      name: 'Developers',
      userIds: ['u-1', 'u-2'],
    });

    const api = new UsersAPI(client as any);
    const group = await api.getGroup('grp-1');

    expect(client.get).toHaveBeenCalledWith('/usergroups/grp-1');
    expect(group.userGroupId).toBe('grp-1');
    expect(group.name).toBe('Developers');
    expect(group.userIds).toEqual(['u-1', 'u-2']);
  });
});

describe('UsersAPI.createGroup', () => {
  it('creates a group with name only', async () => {
    const client = makeMockClient();
    client.post.mockResolvedValue({
      userGroupId: 'grp-new',
      name: 'New Group',
    });

    const api = new UsersAPI(client as any);
    const group = await api.createGroup('New Group');

    expect(client.post).toHaveBeenCalledWith('/usergroups', { name: 'New Group' });
    expect(group.userGroupId).toBe('grp-new');
  });

  it('creates a group with members', async () => {
    const client = makeMockClient();
    client.post.mockResolvedValue({
      userGroupId: 'grp-new',
      name: 'Team',
      userIds: ['u-1', 'u-2'],
    });

    const api = new UsersAPI(client as any);
    await api.createGroup('Team', ['u-1', 'u-2']);

    expect(client.post).toHaveBeenCalledWith('/usergroups', {
      name: 'Team',
      members: ['u-1', 'u-2'],
    });
  });
});

describe('UsersAPI.updateGroup', () => {
  it('updates group name', async () => {
    const client = makeMockClient();
    client.put.mockResolvedValue({
      userGroupId: 'grp-1',
      name: 'Renamed',
    });

    const api = new UsersAPI(client as any);
    const group = await api.updateGroup('grp-1', { name: 'Renamed' });

    expect(client.put).toHaveBeenCalledWith('/usergroups/grp-1', { name: 'Renamed' });
    expect(group.name).toBe('Renamed');
  });

  it('adds and removes members', async () => {
    const client = makeMockClient();
    client.put.mockResolvedValue({
      userGroupId: 'grp-1',
      name: 'Team',
      userIds: ['u-2', 'u-3'],
    });

    const api = new UsersAPI(client as any);
    await api.updateGroup('grp-1', {
      addMembers: ['u-3'],
      removeMembers: ['u-1'],
    });

    expect(client.put).toHaveBeenCalledWith('/usergroups/grp-1', {
      addMembers: ['u-3'],
      removeMembers: ['u-1'],
    });
  });
});

describe('UsersAPI.deleteGroup', () => {
  it('deletes a group by ID', async () => {
    const client = makeMockClient();
    client.delete.mockResolvedValue(undefined);

    const api = new UsersAPI(client as any);
    await api.deleteGroup('grp-1');

    expect(client.delete).toHaveBeenCalledWith('/usergroups/grp-1');
  });
});
