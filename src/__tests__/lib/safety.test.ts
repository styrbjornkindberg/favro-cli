/**
 * Unit tests — assertScope, the single shared scope-lock check.
 *
 * The interesting case is the boardless write: the lock cannot be checked, so it
 * has to refuse rather than fall through. See issue #77.
 */
import { assertScope, checkScope, ScopeError } from '../../lib/safety';
import { RefusalError } from '../../lib/refusal';
import { isRetryable } from '../../lib/dispatch';

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

  /**
   * A scope refusal must never come back `retryable: true` (#120 item 1).
   *
   * This is not hypothetical. `dispatch` calls `assertScope` OUTSIDE its own
   * try, so a `ScopeError` throws clean out of the table — and the skill engine
   * catches it as `abortCause`, unwinds the steps that already wrote, then asks
   * `isRetryable(unwound.outcome, abortCause)` (`skill-engine.ts`). While
   * `ScopeError` extended bare `Error` that call answered TRUE: no
   * `RefusalError`, no `.response` for `classifyThrownError` to read, so it fell
   * through to the transient arm. Retrying a scope violation cannot change the
   * answer, so that was advice to loop forever.
   *
   * NEITHER wide-population reader depends on the TYPE any more: the runner's
   * error boundary gates on `isWireFailure` first since #134 and the skill
   * engine's end-of-run unwind since #151 (ADR-0002, "Two populations"), so a
   * `ScopeError` answers `false` at both for a second, independent reason — it
   * never touched the wire. This assertion is the derivation on its own, so it
   * keeps earning its keep.
   */
  it('is not retryable — a scope refusal is a deterministic decline', () => {
    const refusal = new ScopeError('Scope violation: nope', 'board-1', 'col-1');

    expect(isRetryable('rolled-back', refusal)).toBe(false);
  });
});

/**
 * `checkScope` — the funnel, and the one place the refusal's TYPE can be lost.
 *
 * Every board-lock refusal in the codebase passes through this `catch` on its way
 * out: 13 command call sites plus `checkResolvedScope`. `assertScope` throws a
 * `ScopeError`; `checkScope` catches it to reword a 404 and rethrows. Rewriting
 * that rethrow as `throw new Error(error.message)` — same wording, same
 * `retryable: false`, no type — passed all 162 suites / 3085 tests, and cost two
 * things measured on the built CLI:
 *
 *   - `git commit --comment` under a lock went back to exit 0 with the refusal
 *     replaced by `(Could not add comment to card)`. That catch filters on
 *     `instanceof RefusalError`, which is exactly what the rewrite drops — the
 *     regression #133's second commit had just fixed, reintroduced.
 *   - `boards delete --human` printed `✗ Error: Scope violation: …` (215 bytes)
 *     where it prints `✗ Scope violation: …` (208). `logError` heads on
 *     `.name === 'ScopeError'`. #133's other acceptance criterion.
 *
 * Nothing saw it because the arms that cover those two readers hand-build their
 * own refusal: `git-scope.test.ts` mocks `safety` wholesale and throws a
 * `RefusalError` it wrote itself, and `error-handler.test.ts` builds one from
 * `{ name }`. Both are right for what they test. Neither can observe the funnel.
 */
describe('checkScope', () => {
  it('rethrows the refusal AS a ScopeError — the type both readers key on', async () => {
    const client = makeClient(['col-other']);

    // Not `.toThrow(ScopeError)`: jest's `toThrow` with a class matches by
    // constructor NAME up the prototype chain, so a bare `Error` renamed to
    // 'ScopeError' would satisfy it. `instanceof` is what `git.ts` and the
    // dispatch table actually ask.
    const thrown = await checkScope('board-1', client, LOCKED).catch((e) => e);
    expect(thrown).toBeInstanceOf(ScopeError);
    expect(thrown).toBeInstanceOf(RefusalError);
    expect(thrown.name).toBe('ScopeError');
  });

  it('does NOT dress a 404 up as a refusal — the foreign arm of the same rethrow', async () => {
    // The reword is the only thing this wrapper adds, and it must stay a bare
    // `Error`: a missing board is the id being wrong, which the lock has no
    // opinion about. Without this arm the assertion above could be satisfied by
    // wrapping everything in a `ScopeError`.
    const client = {
      get: jest.fn().mockRejectedValue(
        Object.assign(new Error('Request failed with status code 404'), {
          response: { status: 404 },
        }),
      ),
    } as any;

    const thrown = await checkScope('board-gone', client, LOCKED).catch((e) => e);
    expect(thrown).not.toBeInstanceOf(RefusalError);
    expect(thrown.message).toBe('Scope check failed: Board board-gone not found.');
  });

  it('passes an unlocked config straight through, with no request', async () => {
    // The omit arm: the two above pass against a `checkScope` that refuses
    // unconditionally.
    const client = makeClient(['col-other']);

    await expect(checkScope('board-1', client, {} as any)).resolves.toBeUndefined();
    expect(client.get).not.toHaveBeenCalled();
  });
});

/**
 * `checkResolvedScope` — the lazy check (#102/#104).
 *
 * `checkScope` is already free when nothing is locked, but `checkScope(await
 * resolve(), …)` is NOT: the argument evaluates first, so every guarded command
 * billed an unlocked user a GET for an answer nobody was going to read. Both
 * issues make that a criterion — "no behaviour change when no lock is
 * configured, and no extra requests on that path" — so the saving is asserted
 * on the thing that spends the request: whether the resolver runs at all.
 */
describe('checkResolvedScope', () => {
  const UNLOCKED = {} as any;

  beforeEach(() => {
    jest.resetModules();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  const load = async (config: any) => {
    jest.doMock('../../lib/config', () => ({ readConfig: jest.fn().mockResolvedValue(config) }));
    return import('../../lib/safety');
  };

  it('never invokes the resolver when no lock is configured', async () => {
    const { checkResolvedScope } = await load(UNLOCKED);
    const resolve = jest.fn().mockResolvedValue('board-1');

    await expect(checkResolvedScope(makeClient(), resolve)).resolves.toBeUndefined();

    // The whole point: no lock, no resolution, no request.
    expect(resolve).not.toHaveBeenCalled();
  });

  it('invokes the resolver and checks the board it returns when a lock IS configured', async () => {
    const { checkResolvedScope } = await load(LOCKED);
    const client = makeClient(['col-1']);
    const resolve = jest.fn().mockResolvedValue('board-1');

    await expect(checkResolvedScope(client, resolve)).resolves.toBeUndefined();

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(client.get).toHaveBeenCalledWith('/widgets/board-1');
  });
});

/**
 * `boardOfCard` — the one resolver the guarded commands share.
 *
 * Three properties, all policy, and the reason six copies became one: it wraps
 * the GET, it fails CLOSED to `''`, and it REPORTS the cause. `assertScope`'s
 * own refusal promises the underlying error "is reported separately", and six
 * silent `catch { return '' }` blocks made that a promise nothing kept.
 */
describe('boardOfCard', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  const loadWith = async (getCard: jest.Mock) => {
    jest.doMock('../../lib/cards-api', () => ({
      __esModule: true,
      default: class { getCard = getCard; },
    }));
    return import('../../lib/safety');
  };

  it('returns the board of a readable card', async () => {
    const { boardOfCard } = await loadWith(jest.fn().mockResolvedValue({ boardId: 'board-1' }));

    await expect(boardOfCard(makeClient(), 'card-1')).resolves.toBe('board-1');
  });

  it('resolves an unreadable card to the empty string rather than throwing', async () => {
    // Fail-CLOSED, and alive: an unwrapped GET here turns a stale reference into
    // a dead command instead of a clean refusal (#78).
    const { boardOfCard } = await loadWith(jest.fn().mockRejectedValue(new Error('404 Not Found')));

    await expect(boardOfCard(makeClient(), 'gone')).resolves.toBe('');
  });

  it('reports WHY the card could not be read', async () => {
    const { boardOfCard } = await loadWith(jest.fn().mockRejectedValue(new Error('404 Not Found')));

    await boardOfCard(makeClient(), 'gone');

    // Without this the user gets "this write names no board" and no hint that
    // the real cause was a typo'd id.
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('404 Not Found'));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('gone'));
  });

  it('resolves a card with no board instance to the empty string, making no claim', async () => {
    const { boardOfCard } = await loadWith(jest.fn().mockResolvedValue({ boardId: undefined }));

    await expect(boardOfCard(makeClient(), 'fork')).resolves.toBe('');
  });

  it('spends no request at all on an empty reference', async () => {
    const getCard = jest.fn();
    const { boardOfCard } = await loadWith(getCard);

    await expect(boardOfCard(makeClient(), '')).resolves.toBe('');
    expect(getCard).not.toHaveBeenCalled();
  });
});
