/**
 * Unit tests — assertScope, the single shared scope-lock check.
 *
 * The interesting case is the boardless write: the lock cannot be checked, so it
 * has to refuse rather than fall through. See issue #77.
 */
import { assertScope, ScopeError } from '../../lib/safety';

function makeClient(collectionIds: string[] = [], name = 'Some board') {
  return {
    get: jest.fn().mockResolvedValue({ collectionIds, name }),
  } as any;
}

const LOCKED = { scopeCollectionId: 'col-1', scopeCollectionName: 'Locked' } as any;

describe('assertScope', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('no-ops with an empty board id when no lock is configured', async () => {
    const client = makeClient();

    await expect(assertScope('', client, {} as any)).resolves.toBeUndefined();
    expect(client.get).not.toHaveBeenCalled();
  });

  it('refuses an empty board id under a lock without issuing a request', async () => {
    const client = makeClient(['col-1']);

    await expect(assertScope('', client, LOCKED)).rejects.toThrow(ScopeError);
    expect(client.get).not.toHaveBeenCalled();
  });

  it('refuses an empty board id even with --force', async () => {
    const client = makeClient(['col-1']);

    await expect(assertScope('', client, LOCKED, true)).rejects.toThrow(ScopeError);
    expect(client.get).not.toHaveBeenCalled();
  });

  it('starts the boardless refusal with the "Scope violation:" prefix checkScope splits on', async () => {
    const client = makeClient(['col-1']);

    await expect(assertScope('', client, LOCKED)).rejects.toThrow(/^Scope violation:/);
  });

  it('names BOTH causes of a boardless write — no board instance, or an unreadable card', async () => {
    const client = makeClient(['col-1']);

    // The `?? ''` callers reach here two ways: an assignment fork with no
    // widgetCommonId, and a `getCard` that threw. A message that only mentions
    // forks misdiagnoses the second, more common one.
    await expect(assertScope('', client, LOCKED)).rejects.toThrow(/no board instance/i);
    await expect(assertScope('', client, LOCKED)).rejects.toThrow(/could not be read/i);
  });

  it('resolves for a board inside the locked collection', async () => {
    const client = makeClient(['col-1']);

    await expect(assertScope('board-1', client, LOCKED)).resolves.toBeUndefined();
    expect(client.get).toHaveBeenCalledWith('/widgets/board-1');
  });

  it('throws for a board outside the locked collection', async () => {
    const client = makeClient(['col-other']);

    await expect(assertScope('board-1', client, LOCKED)).rejects.toThrow(ScopeError);
  });

  it('lets --force through for an out-of-scope board that names a board', async () => {
    const client = makeClient(['col-other']);

    await expect(assertScope('board-1', client, LOCKED, true)).resolves.toBeUndefined();
  });
});
