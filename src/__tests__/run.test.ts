/**
 * The command runner (#113).
 *
 * Exercised through a REAL commander program, because half of what `run` owns
 * is the reading of commander state — which node holds `--verbose`, what the
 * action callback is handed — and a hand-rolled fake `Command` would let that
 * reading be wrong in exactly the way #85 was wrong.
 *
 * Nothing here mocks `http-client`, `config` or `safety` (ADR-0002): the
 * anonymous arm needs no credentials, the eager arm builds a client from env
 * vars and never issues a request, and `readConfig` is pointed at an empty temp
 * directory rather than stubbed.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';
import { run, apiNamespace, AnyResult, Ctx } from '../lib/run';
import FavroHttpClient from '../lib/http-client';
import { RefusalError } from '../lib/refusal';
import { DispatchResult } from '../lib/dispatch';
import { latchVerbose } from '../lib/error-handler';
import { checkScope, checkCollectionScope } from '../lib/safety';
import { FavroConfig } from '../lib/config';
import { stripAnsi } from '../lib/theme';

/** Every class `ctx.api` can build, as `[module, export]`. The laziness proof reads this. */
const API_MODULES: ReadonlyArray<readonly [string, string]> = [
  ['../lib/cards-api', 'CardsAPI'],
  ['../lib/boards-api', 'BoardsAPI'],
  ['../lib/collections-api', 'CollectionsAPI'],
  ['../lib/columns-api', 'ColumnsAPI'],
  // Comments live under `api/`: #89 deleted the `lib/` twin that skipped the
  // `cardCommonId` resolution.
  ['../api/comments', 'CommentsApiClient'],
  ['../lib/tags-api', 'TagsAPI'],
  ['../lib/tasks-api', 'TasksAPI'],
  ['../lib/tasklists-api', 'TaskListsAPI'],
  ['../lib/users-api', 'UsersAPI'],
  ['../lib/widgets-api', 'WidgetsAPI'],
  ['../lib/attachments-api', 'AttachmentsAPI'],
  ['../lib/custom-fields-api', 'CustomFieldsAPI'],
  ['../api/activity', 'ActivityApiClient'],
  ['../api/aggregate', 'AggregateAPI'],
  ['../api/context', 'ContextAPI'],
  // `members` is `FavroApiClient`, the pre-convention name (#116).
  ['../api/members', 'FavroApiClient'],
  ['../api/query', 'QueryAPI'],
  ['../api/sprint-plan', 'SprintPlanAPI'],
  ['../api/standup', 'StandupAPI'],
  ['../api/webhooks', 'FavroWebhooksAPI'],
];

let out: jest.SpyInstance;
let err: jest.SpyInstance;
let tmpConfigDir: string;

const stdout = (): string[] => out.mock.calls.map((call) => String(call[0]));
const stderr = (): string[] => err.mock.calls.map((call) => String(call[0]));

beforeAll(() => {
  tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'favro-run-test-'));
});

afterAll(() => {
  fs.rmSync(tmpConfigDir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.FAVRO_CONFIG_DIR = tmpConfigDir;
  // The eager arm resolves real credentials. Env vars, not a mocked `config`:
  // `createFavroClient` issues no request, so a key that goes nowhere is enough.
  process.env.FAVRO_API_KEY = 'test-key';
  process.env.FAVRO_EMAIL = 'runner@example.com';
  process.exitCode = undefined;
  out = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
  process.exitCode = undefined;
  delete process.env.FAVRO_CONFIG_DIR;
  delete process.env.FAVRO_API_KEY;
  delete process.env.FAVRO_EMAIL;
});

/**
 * A root program shaped like `cli.ts`'s: `--verbose` and `--pretty` at the root,
 * `--human` on the leaf. Returns the leaf so a test can register its action.
 */
function program(): { root: Command; leaf: Command } {
  const root = new Command();
  root.exitOverride();
  root.option('--verbose').option('--pretty');
  // The real seam: `ctx.verbose` reads #85's latch, which this hook sets.
  latchVerbose(root);
  const leaf = root.command('thing').option('--human').exitOverride();
  return { root, leaf };
}

const parse = (root: Command, argv: string[]): Promise<unknown> =>
  root.parseAsync(argv, { from: 'user' });

// ─── output ──────────────────────────────────────────────────────────────────

describe('the runner owns the output', () => {
  it('writes rows as one envelope, compact, in the default JSON mode', async () => {
    const { root, leaf } = program();
    leaf.action(run(async () => ({ rows: [{ id: 'a' }, { id: 'b' }] })));

    await parse(root, ['thing']);

    expect(stdout()).toEqual(['{"rows":[{"id":"a"},{"id":"b"}]}']);
  });

  it('caps rows at --limit and says it truncated', async () => {
    const { root, leaf } = program();
    leaf.action(run(async () => ({ rows: [1, 2, 3], limit: 2 })));

    await parse(root, ['thing']);

    expect(JSON.parse(stdout()[0])).toEqual({ rows: [1, 2], truncated: true });
  });

  it('carries `unreachable` into the envelope, and only when it is non-empty', async () => {
    // The envelope's THIRD key (`read-shape.ts`), and the one `capRows` cannot
    // produce: only a handler knows which per-item calls came back empty. #119
    // added it because `cards list --filter unblocked` was the first list read
    // with holes to migrate, and without this the runner would have dropped
    // them — an agent reading `rows` alone cannot tell "we could not look" from
    // "there was nothing there", which is rule 3.
    const hole = [{ id: 'card-9', reason: '404 Not Found' }];
    const { root, leaf } = program();
    leaf.action(run(async () => ({ rows: [{ id: 'a' }], unreachable: hole })));

    await parse(root, ['thing']);

    expect(JSON.parse(stdout()[0])).toEqual({ rows: [{ id: 'a' }], unreachable: hole });
  });

  it('omits `unreachable` entirely when there are no holes — absent, not empty', async () => {
    // The other polarity, and rule 3's actual requirement: an ABSENT marker is
    // what makes an empty `rows` mean true-empty. `unreachable: []` would say
    // the read was complete in a shape an agent has to test the length of.
    const { root, leaf } = program();
    leaf.action(run(async () => ({ rows: [{ id: 'a' }], unreachable: [] })));

    await parse(root, ['thing']);

    expect(JSON.parse(stdout()[0])).not.toHaveProperty('unreachable');
  });

  it('tells a --human reader about the holes too, off `unreachable` itself', async () => {
    // A formatter is handed ROWS, so it can no more see a hole than it can see
    // a cut — the runner says both, or human mode presents an incomplete read
    // as a complete one.
    const { root, leaf } = program();
    leaf.action(
      run(async () => ({
        rows: [{ id: 'a' }],
        unreachable: [{ id: 'card-9', reason: '404 Not Found' }],
        human: () => 'the rows',
      })),
    );

    await parse(root, ['thing', '--human']);

    expect(stdout()).toEqual([
      'the rows',
      '(1 part(s) of this read could not be reached:)',
      '  card-9 — 404 Not Found',
    ]);
  });

  it('indents the envelope under the root --pretty', async () => {
    const { root, leaf } = program();
    leaf.action(run(async () => ({ rows: [{ id: 'a' }] })));

    await parse(root, ['--pretty', 'thing']);

    expect(stdout()[0]).toContain('\n');
    expect(JSON.parse(stdout()[0])).toEqual({ rows: [{ id: 'a' }] });
  });

  it('hands --human the capped rows and prints what the formatter returns', async () => {
    const { root, leaf } = program();
    const seen: unknown[] = [];
    leaf.action(
      run(async () => ({
        rows: ['a', 'b', 'c'],
        limit: 2,
        human: (rows: string[]) => {
          seen.push(rows);
          return rows.join('/');
        },
      })),
    );

    await parse(root, ['thing', '--human']);

    // The formatter is handed rows, so it cannot see the cut; the runner says
    // it, once, for every migrated list read (#99). Without this line `--limit`
    // silently drops rows in human mode on every command the runner owns.
    expect(seen).toEqual([['a', 'b']]);
    expect(stdout()).toEqual(['a/b', '(truncated to 2 of 3 — raise --limit to see the rest)']);
  });

  it('says nothing about truncation when nothing was cut', async () => {
    // What keeps every existing table byte-identical for a caller who passed
    // no `--limit`.
    const { root, leaf } = program();
    leaf.action(run(async () => ({ rows: ['a', 'b'], human: (rows: string[]) => rows.join('/') })));

    await parse(root, ['thing', '--human']);

    expect(stdout()).toEqual(['a/b']);
  });

  it('writes nothing of its own when a human formatter returns void', async () => {
    // The `console.table` arm. The formatter printed; the runner must not
    // append a stray "undefined" under it.
    const { root, leaf } = program();
    leaf.action(
      run(async () => ({
        rows: [{ id: 'a' }],
        human: () => {
          console.log('«table»');
        },
      })),
    );

    await parse(root, ['thing', '--human']);

    expect(stdout()).toEqual(['«table»']);
  });

  it('falls back to indented JSON when --human is asked for and no formatter exists', async () => {
    // Silence would be the alternative. The rows, not the envelope — the same
    // value a formatter would have been handed.
    const { root, leaf } = program();
    leaf.action(run(async () => ({ rows: [{ id: 'a' }] })));

    await parse(root, ['thing', '--human']);

    expect(JSON.parse(stdout()[0])).toEqual([{ id: 'a' }]);
  });

  it('leaves a single read bare — no envelope (rule 1 of read-shape)', async () => {
    const { root, leaf } = program();
    leaf.action(run(async () => ({ item: { id: 'a' } })));

    await parse(root, ['thing']);

    expect(stdout()).toEqual(['{"id":"a"}']);
  });

  it('writes nothing at all for a void result — the handler owns its stdout', async () => {
    const { root, leaf } = program();
    leaf.action(
      run(async () => {
        console.log('streamed');
      }),
    );

    await parse(root, ['thing']);

    expect(stdout()).toEqual(['streamed']);
    expect(process.exitCode).toBeUndefined();
  });

  it('reports a dispatch result and takes its exit code from the report', async () => {
    const failed: DispatchResult = {
      intent: 'create',
      outcome: 'rolled-back',
      retryable: true,
      error: 'boom',
    };
    const { root, leaf } = program();
    leaf.action(run(async () => ({ dispatch: failed })));

    await parse(root, ['thing']);

    expect(stderr()[0]).toContain('create failed');
    expect(process.exitCode).toBe(1);
  });

  it('writes what a successful dispatch produced — silence would be the bug', async () => {
    // `reportDispatch` prints NOTHING on `ok`; every call site today follows it
    // with its own `✓ Created …`. If the arm only reported failure, a
    // successful write would emit nothing at all.
    const ok: DispatchResult<{ cardId: string }> = {
      intent: 'create',
      outcome: 'ok',
      retryable: false,
      value: { cardId: 'CLA-1' },
    };
    const { root, leaf } = program();
    leaf.action(run(async () => ({ dispatch: ok })));

    await parse(root, ['thing']);

    expect(stdout()).toEqual(['{"cardId":"CLA-1"}']);
    expect(process.exitCode).toBeUndefined();
  });

  it('lets a dispatch human formatter write the ✓ line', async () => {
    const ok: DispatchResult<{ cardId: string }> = {
      intent: 'create',
      outcome: 'ok',
      retryable: false,
      value: { cardId: 'CLA-1' },
    };
    const { root, leaf } = program();
    leaf.action(
      run(async () => ({
        dispatch: ok,
        human: (value: { cardId: string }) => `✓ Created ${value.cardId}`,
      })),
    );

    await parse(root, ['thing', '--human']);

    expect(stdout()).toEqual(['✓ Created CLA-1']);
  });

  it('adds nothing under a dry-run preview', async () => {
    // `reportDispatch` printed the whole chain and there is no value.
    const preview: DispatchResult = {
      intent: 'create',
      outcome: 'ok',
      retryable: false,
      preview: ['would create 1 card'],
    };
    const { root, leaf } = program();
    leaf.action(run(async () => ({ dispatch: preview })));

    await parse(root, ['thing']);

    expect(stdout()).toEqual(['[dry-run] would create 1 card']);
    expect(process.exitCode).toBeUndefined();
  });

  it('refuses a result that mixes two arms', () => {
    const ok: DispatchResult = { intent: 'create', outcome: 'ok', retryable: false };
    // Never invoked; the assertion is that it does not compile. Without the
    // mutual `?: never` members these mix freely — a union's excess-property
    // check admits any key present in any member — and `emit` would silently
    // drop one side of each pair.
    // @ts-expect-error — `dispatch` and `item` are different arms.
    run(async () => ({ dispatch: ok, item: { id: 'a' } }));
    // @ts-expect-error — so are `rows` and `item`.
    run(async () => ({ rows: [1], item: { id: 'a' } }));
    expect(true).toBe(true);
  });

  it('takes a handler that returns a different arm per branch', () => {
    // Twelve of #114's files branch on a flag. One shared `T` across the whole
    // handler cannot type this, which is why the constraint is per-arm.
    const registered = run(async (_ctx, opts: { count?: boolean }) =>
      opts.count ? { item: { total: 1 } } : { rows: [{ id: 'a' }] },
    );
    expect(typeof registered).toBe('function');
  });

  it('carries an answer-code result through to process.exitCode', async () => {
    // `health`, `release-check`, `diff`: unhealthy is the finding, not a failure.
    const { root, leaf } = program();
    leaf.action(run(async () => ({ item: { ok: false }, exitCode: 1 })));

    await parse(root, ['thing']);

    expect(stdout()).toEqual(['{"ok":false}']);
    expect(process.exitCode).toBe(1);
  });
});

// ─── the error boundary ──────────────────────────────────────────────────────

describe('the error boundary', () => {
  it('puts the error envelope on stdout in JSON mode, and nothing on stderr', async () => {
    // MCP hands an agent stdout first; a bare stderr blob is unparseable.
    const { root, leaf } = program();
    leaf.action(
      run(async () => {
        throw new Error('something went wrong');
      }),
    );

    await parse(root, ['thing']);

    // `retryable: false`, and this line used to assert the opposite (#134). A
    // bare `Error` thrown inside a handler never touched the wire, so nothing
    // here can say the next attempt would go differently.
    expect(JSON.parse(stdout()[0])).toEqual({
      error: { message: 'something went wrong', retryable: false },
    });
    expect(stderr()).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it('will not tell an agent to retry a failure it cannot place as a wire failure', async () => {
    // #134. The boundary sees a population the dispatch table never does —
    // argument validation, missing config, file I/O, our own bugs — and
    // `isRetryable`'s "unclassifiable means transient" reading is wrong for all
    // of it. Unknown is deterministic-until-proven-otherwise here: the cost of
    // a wrong `false` is one honest failure, the cost of a wrong `true` is an
    // agent looping on a typo forever.
    const deterministic: ReadonlyArray<readonly [string, () => never]> = [
      [
        'a bad flag',
        () => {
          throw new Error('Invalid --include values: bogus. Valid options: stats, velocity');
        },
      ],
      [
        'ENOENT',
        () => {
          fs.readFileSync(path.join(tmpConfigDir, 'definitely-absent.csv'), 'utf8');
          throw new Error('unreachable');
        },
      ],
      [
        'a TypeError of our own',
        () => {
          (undefined as unknown as { boom: string }).boom;
          throw new Error('unreachable');
        },
      ],
    ];

    for (const [label, thrower] of deterministic) {
      out.mockClear();
      const { root, leaf } = program();
      leaf.action(run(async () => thrower()));

      await parse(root, ['thing']);

      expect([label, JSON.parse(stdout()[0]).error.retryable]).toEqual([label, false]);
    }
  });

  it('keeps the wire table\'s answer for a failure that DID come off the wire', async () => {
    // The other half of #134: narrowing the boundary must not swallow the
    // transient family. `boundary-retryable-wire.test.ts` proves this over a
    // real socket; this pins both arms of the discriminator, which a socket
    // cannot reach — axios stamps every error it raises, so nothing served over
    // HTTP produces the second shape.
    const wire: ReadonlyArray<readonly [string, object]> = [
      // A transport failure: axios raised it, and there is no response to
      // classify. That is the transient family, not a bug of ours.
      ['a transport failure', { isAxiosError: true, code: 'ECONNRESET' }],
      // An HTTP response is wire evidence whoever assembled the object — the
      // shape `classifyThrownError` already keys on, and the shape this repo's
      // own fixtures build.
      ['an unstamped response', { response: { status: 503, data: {} } }],
    ];

    for (const [label, shape] of wire) {
      out.mockClear();
      const { root, leaf } = program();
      leaf.action(
        run(async () => {
          throw Object.assign(new Error('socket hang up'), shape);
        }),
      );

      await parse(root, ['thing']);

      expect([label, JSON.parse(stdout()[0]).error.retryable]).toEqual([label, true]);
    }
  });

  it('calls a refusal what it is — never retryable', async () => {
    const { root, leaf } = program();
    leaf.action(
      run(async () => {
        throw new RefusalError('outside the locked collection');
      }),
    );

    await parse(root, ['thing']);

    expect(JSON.parse(stdout()[0]).error).toEqual({
      message: 'outside the locked collection',
      retryable: false,
    });
  });

  it('keeps logError on stderr in human mode', async () => {
    const { root, leaf } = program();
    leaf.action(
      run(async () => {
        throw new Error('wire down');
      }),
    );

    await parse(root, ['thing', '--human']);

    expect(stdout()).toEqual([]);
    expect(stderr().join('\n')).toContain('wire down');
    expect(process.exitCode).toBe(1);
  });

  it('never calls process.exit', () => {
    // The acceptance criterion, read off the source: `process.exit()` terminates
    // before a pending async write to a pipe flushes, and stdout is a pipe under
    // MCP.
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'run.ts'), 'utf-8');
    expect(source).not.toMatch(/process\.exit\(/);
  });
});

// ─── the scope refusal ───────────────────────────────────────────────────────

/**
 * A scope violation is the one failure a write guardrail exists to produce, and
 * until #133 it was the one failure with no machine answer: `checkScope` and
 * `checkCollectionScope` printed to stderr and called `process.exit(1)`, so the
 * boundary above never ran and stdout came back EMPTY under the JSON default.
 *
 * The real `safety.ts`, unmocked, for the reason the file header gives: a stubbed
 * refusal proves the runner can serialise a `ScopeError` somebody hand-built,
 * not that the lock produces one. `LOCKED` is passed as an argument rather than
 * written to the temp config, so neither helper reads `readConfig` and neither
 * reaches the wire — `checkCollectionScope` compares two strings, and
 * `assertScope`'s boardless arm refuses before its `/widgets/` GET.
 */
const LOCKED = { scopeCollectionId: 'coll-locked', scopeCollectionName: 'Locked' } as FavroConfig;

const COLLECTION_REFUSAL =
  'Scope violation: target collection "coll-other" is not the locked collection "Locked".\n' +
  "  Run 'favro scope show' to see your current lock.\n" +
  "  Run 'favro scope set <collectionId>' to change it, or pass --force to override.";

describe('a scope refusal reaches the caller', () => {
  it('writes the envelope to stdout and nothing to stderr, exit 1', async () => {
    const { root, leaf } = program();
    leaf.action(run(async () => checkCollectionScope('coll-other', LOCKED)));

    await parse(root, ['thing']);

    expect(JSON.parse(stdout()[0]).error).toEqual({
      message: COLLECTION_REFUSAL,
      // The lock is configuration: the identical call refuses identically until
      // someone runs `favro scope set`. #120's reason, still measured here.
      retryable: false,
    });
    expect(stderr()).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it('writes the envelope for the BOARD helper too — one defect, two callers', async () => {
    const { root, leaf } = program();
    leaf.action(run(async (ctx: Ctx) => checkScope('', ctx.client, LOCKED)));

    await parse(root, ['thing']);

    const { error } = JSON.parse(stdout()[0]);
    expect([error.message.split('\n')[0], error.retryable]).toEqual([
      'Scope violation: this write names no board, so the scope lock ("Locked") cannot be checked.',
      false,
    ]);
    expect(process.exitCode).toBe(1);
  });

  it('does not serialise a refusal the way it serialises an empty result', async () => {
    // THE DISCRIMINATING ARM. "Nothing matched" and "I refused to look" are
    // different answers, and before #133 the refusal's shape was a third thing
    // — no stdout at all — which reads to an agent as neither. An empty result
    // is a positive claim about the world, so it keeps its envelope and exit 0;
    // a refusal makes no claim, so it carries `error` and exit 1. A fix that
    // collapsed the two would pass the test above and fail this one.
    const shapeOf = async (action: () => Promise<AnyResult>) => {
      out.mockClear();
      process.exitCode = undefined;
      const { root, leaf } = program();
      leaf.action(run(action));
      await parse(root, ['thing']);
      return { stdout: stdout(), code: process.exitCode };
    };

    const empty = await shapeOf(async () => ({ rows: [] }));
    const refused = await shapeOf(async () => checkCollectionScope('coll-other', LOCKED));

    expect(empty).toEqual({ stdout: ['{"rows":[]}'], code: undefined });
    expect(Object.keys(JSON.parse(refused.stdout[0]))).toEqual(['error']);
    expect(refused.code).toBe(1);
  });

  it('says nothing at all when no lock is configured', async () => {
    // The omit arm. The guard keys on `scopeCollectionId`, so a config without
    // one must leave the command untouched — otherwise the two tests above
    // would also pass against a `checkCollectionScope` that refuses everything.
    const { root, leaf } = program();
    leaf.action(
      run(async () => {
        checkCollectionScope('coll-other', {} as FavroConfig);
        return { item: { ok: true } };
      }),
    );

    await parse(root, ['thing']);

    expect(stdout()).toEqual(['{"ok":true}']);
    expect(process.exitCode).toBeUndefined();
  });

  it('keeps the human line the lock has always printed', async () => {
    // #133's other acceptance criterion: only the JSON path gains anything.
    // `✗ Scope violation:` — NOT `✗ Error:` — is what `checkCollectionScope`
    // printed for itself before the exit was removed, and `logError` prints it
    // now. Asserted on the joined stream because the heading moved from three
    // `console.error` calls to one, which is the same bytes and a different
    // call count.
    const { root, leaf } = program();
    leaf.action(run(async () => checkCollectionScope('coll-other', LOCKED)));

    await parse(root, ['thing', '--human']);

    expect(stripAnsi(stderr().join('\n'))).toBe(`✗ ${COLLECTION_REFUSAL}`);
    expect(stdout()).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it('lets a write through when the target IS the locked collection', async () => {
    // THE MATCH ARM. Deleting the equality return — so the lock refuses even its
    // own collection — passed 162 suites / 3070 tests. The refusal arms above
    // all pass against a guard that refuses everything, and the omit arm only
    // covers "no lock configured", so nothing asserted that a lock LETS the
    // in-scope write through.
    const { root, leaf } = program();
    leaf.action(
      run(async () => {
        checkCollectionScope('coll-locked', LOCKED);
        return { item: { ok: true } };
      }),
    );

    await parse(root, ['thing']);

    expect(stdout()).toEqual(['{"ok":true}']);
    expect(stderr()).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it('--force overrides the COLLECTION lock, warning rather than refusing', async () => {
    // Deleting the `force` arm also passed all 3070: `--force` was pinned for
    // the BOARD lock (`attachments.test.ts`) and for nothing on the collection
    // side, so the escape hatch could have been removed by this ticket's rewrite
    // without a single failure. The warning goes to `console.warn`, which is
    // neither of the two streams the rest of this file spies on.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { root, leaf } = program();
    leaf.action(
      run(async () => {
        checkCollectionScope('coll-other', LOCKED, true);
        return { item: { ok: true } };
      }),
    );

    await parse(root, ['thing']);

    expect(stdout()).toEqual(['{"ok":true}']);
    expect(stripAnsi(String(warn.mock.calls[0]?.[0]))).toBe(
      '⚠ Warning: Target collection coll-other is outside your locked scope (Locked), ' +
        'but proceeding because --force was used.',
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('rewords a 404 from the board GET, and does not call it a scope violation', async () => {
    // `checkScope`'s ONLY remaining behaviour of its own once #133 removed the
    // print-and-exit — and deleting it, letting axios' bare
    // "Request failed with status code 404" through, passed all 3070 tests. The
    // reword is reachable: `http-client.get` is `(await this.client.get(...)).data`
    // with no catch, so the axios error arrives with `response.status` intact.
    //
    // Not a `ScopeError`, and asserted as such: a missing board is the id being
    // wrong, which the lock has no opinion about. So the envelope must NOT say
    // "Scope violation", and `retryable` must still be false — a deleted board
    // does not come back on a retry.
    const notFound = Object.assign(new Error('Request failed with status code 404'), {
      response: { status: 404 },
    });
    const client = {
      get: async () => {
        throw notFound;
      },
    } as unknown as FavroHttpClient;

    const { root, leaf } = program();
    leaf.action(run(async () => checkScope('board-gone', client, LOCKED)));

    await parse(root, ['thing']);

    expect(JSON.parse(stdout()[0]).error).toEqual({
      message: 'Scope check failed: Board board-gone not found.',
      retryable: false,
    });
    expect(process.exitCode).toBe(1);
  });

  it('passes a NON-404 wire error through untouched', async () => {
    // The foreign arm for the reword: only a 404 is reworded, so a 403 keeps
    // whatever the classifier makes of it. Without this, the reword could be
    // widened to every status and nothing would notice.
    const forbidden = Object.assign(new Error('Request failed with status code 403'), {
      response: { status: 403 },
    });
    const client = {
      get: async () => {
        throw forbidden;
      },
    } as unknown as FavroHttpClient;

    const { root, leaf } = program();
    leaf.action(run(async () => checkScope('board-locked-out', client, LOCKED)));

    await parse(root, ['thing']);

    expect(JSON.parse(stdout()[0]).error.message).not.toContain('Scope check failed');
    expect(process.exitCode).toBe(1);
  });
});

// ─── the context ─────────────────────────────────────────────────────────────

describe('the context the handler receives', () => {
  it('takes ctx.verbose from #85’s one latch', async () => {
    const record = async (argv: string[]): Promise<boolean | undefined> => {
      // A fresh program per parse: commander keeps option values between
      // parses, so reusing one would make the second run read the first's flags.
      const { root, leaf } = program();
      let verbose: boolean | undefined;
      leaf.action(run(async (ctx) => void (verbose = ctx.verbose)));
      await parse(root, argv);
      return verbose;
    };

    expect(await record(['--verbose', 'thing'])).toBe(true);
    expect(await record(['thing'])).toBe(false);
  });

  it('is verbose even where the leaf’s own opts say nothing', async () => {
    // #85 in miniature. With both nodes declaring the flag, commander stores
    // the value on the ROOT and the leaf's own opts come back empty — which is
    // exactly why `cmd.opts()?.verbose`, one of the fifteen spellings, read
    // false for a user who had typed `--verbose`. The latch does not care which
    // node holds it.
    const { root, leaf } = program();
    leaf.option('--verbose');
    let verbose: boolean | undefined;
    let leafSaw: unknown;
    leaf.action(
      run(async (ctx) => {
        verbose = ctx.verbose;
        leafSaw = leaf.opts().verbose;
      }),
    );

    await parse(root, ['thing', '--verbose']);

    expect(leafSaw).toBeUndefined();
    expect(verbose).toBe(true);
  });

  it('passes commander’s own arguments straight through, after ctx', async () => {
    const { root } = program();
    const seen: unknown[] = [];
    root
      .command('grab <id>')
      .option('--body')
      .action(
        run(async (_ctx, id: string, opts: { body?: boolean }) => {
          seen.push(id, opts.body);
        }),
      );

    await parse(root, ['grab', 'CLA-1', '--body']);

    expect(seen).toEqual(['CLA-1', true]);
  });

  it('reads the config once and hands it over', async () => {
    fs.writeFileSync(
      path.join(tmpConfigDir, 'config.json'),
      JSON.stringify({ scopeCollectionId: 'col-1' }),
    );
    const { root, leaf } = program();
    let scope: string | undefined;
    leaf.action(run(async (ctx) => void (scope = ctx.config.scopeCollectionId)));

    await parse(root, ['thing']);

    expect(scope).toBe('col-1');
    fs.rmSync(path.join(tmpConfigDir, 'config.json'));
  });

  it('builds the client eagerly', async () => {
    const { root, leaf } = program();
    let ctx: Ctx | undefined;
    leaf.action(run(async (c) => void (ctx = c)));

    await parse(root, ['thing']);

    expect(ctx!.client).toBeInstanceOf(FavroHttpClient);
  });
});

// ─── #135: a dry run pays for what its preview reaches for ───────────────────

/**
 * The rule: on `--dry-run`, a missing credential is deferred to first touch of
 * `ctx.client` / `ctx.api` rather than refused up front.
 *
 * Every arm below asserts something PRESENT — a printed preview, or the refusal
 * itself on stdout. Nothing here asserts that an error was absent: an absence
 * assertion under a mocked `console.log` cannot fail for the right reason, and
 * this suite has shipped that shape before. The pair that discriminates is the
 * credential-free preview (prints, exit undefined) against the same command
 * touching the client (refuses, exit 1).
 */
describe('--dry-run defers the credential refusal, it does not skip it', () => {
  /** A leaf with `--dry-run`, and no credentials anywhere to resolve. */
  function dryRunProgram(): { root: Command; leaf: Command } {
    delete process.env.FAVRO_API_KEY;
    delete process.env.FAVRO_EMAIL;
    const { root, leaf } = program();
    leaf.option('--dry-run');
    return { root, leaf };
  }

  it('prints a preview built from argv and config with no credentials at all', async () => {
    // The seven measured commands — `boards create/update/delete`,
    // `collections create/update/delete`, `webhooks create` — are this shape:
    // the preview reads `ctx.config` and its arguments and returns.
    const { root, leaf } = dryRunProgram();
    leaf.action(
      run(async (ctx, opts: { dryRun?: boolean }) =>
        opts.dryRun ? { item: { dryRun: true, lock: ctx.config.scopeCollectionId ?? null } } : undefined,
      ),
    );

    await parse(root, ['thing', '--dry-run']);

    expect(stdout()).toEqual(['{"dryRun":true,"lock":null}']);
    expect(process.exitCode).toBeUndefined();
  });

  it('refuses the same command without --dry-run — the omit arm', async () => {
    // Deletes the `opts.dryRun` conjunct if it survives: the real write must
    // still meet the missing key before the handler runs.
    const { root, leaf } = dryRunProgram();
    let ran = false;
    leaf.action(run(async () => void (ran = true)));

    await parse(root, ['thing']);

    expect(stdout()).toEqual([
      JSON.stringify({
        error: { message: "API key not found. Run 'favro auth login' first", retryable: false },
      }),
    ]);
    expect(process.exitCode).toBe(1);
    expect(ran).toBe(false);
  });

  it('refuses a dry run that reaches for ctx.client — the comments trio', async () => {
    // `checkResolvedScope(ctx.client, …)` evaluates its first argument eagerly,
    // so this is exactly what `comments add/update/delete --dry-run` does. The
    // refusal is the same message at the same boundary.
    const { root, leaf } = dryRunProgram();
    let reached = false;
    leaf.action(
      run(async (ctx) => {
        void ctx.client;
        reached = true;
      }),
    );

    await parse(root, ['thing', '--dry-run']);

    expect(stdout()).toEqual([
      JSON.stringify({
        error: { message: "API key not found. Run 'favro auth login' first", retryable: false },
      }),
    ]);
    expect(process.exitCode).toBe(1);
    expect(reached).toBe(false);
  });

  it('refuses a dry run that reaches for ctx.api — every class needs a client', async () => {
    const { root, leaf } = dryRunProgram();
    let reached = false;
    leaf.action(
      run(async (ctx) => {
        void ctx.api;
        reached = true;
      }),
    );

    await parse(root, ['thing', '--dry-run']);

    expect(stdout()).toEqual([
      JSON.stringify({
        error: { message: "API key not found. Run 'favro auth login' first", retryable: false },
      }),
    ]);
    expect(process.exitCode).toBe(1);
    expect(reached).toBe(false);
  });

  it('defers the SAME error object, so it is still a RefusalError at the boundary', async () => {
    // Pins the TYPE, not the message. `toThrow(RefusalError)` matches by
    // constructor name up the chain, and the envelope's `retryable: false` is
    // what a bare `Error` gets too — so neither discriminates. A getter that
    // re-wrapped the refusal (`throw new Error(error.message)`) passes every
    // other arm in this describe block.
    const { root, leaf } = dryRunProgram();
    let caught: unknown;
    leaf.action(
      run(async (ctx) => {
        try {
          void ctx.client;
        } catch (error) {
          caught = error;
        }
        return { item: { caught: (caught as Error).name } };
      }),
    );

    await parse(root, ['thing', '--dry-run']);

    expect(caught).toBeInstanceOf(RefusalError);
    expect((caught as Error).name).toBe('RefusalError');
    // The second touch hands back that same object rather than a fresh one.
    expect(stdout()).toEqual(['{"caught":"RefusalError"}']);
  });

  it('does NOT defer a malformed environment — only a RefusalError is deferred', async () => {
    // The third failure `createFavroClient` can raise, and it is not a decline:
    // `resolveApiKey` throws a bare `Error` for a key that is SET but empty. That
    // is the one thing that throw exists to be loud about, so a preview must not
    // swallow it. Measured against the built CLI before the narrowing landed:
    // `FAVRO_API_KEY= favro boards delete board-1 --dry-run` printed the preview
    // at exit 0 and never mentioned the broken variable.
    const { root, leaf } = dryRunProgram();
    process.env.FAVRO_API_KEY = '';
    let ran = false;
    leaf.action(run(async () => void (ran = true)));

    await parse(root, ['thing', '--dry-run']);

    expect(stdout()).toEqual([
      JSON.stringify({
        error: {
          message:
            'FAVRO_API_KEY is set but empty. Unset it or provide a valid key.\n' +
            '  Run `favro auth login` to configure a key.',
          retryable: false,
        },
      }),
    ]);
    expect(process.exitCode).toBe(1);
    // The other polarity of the same arm: the preview did not run either.
    expect(ran).toBe(false);
  });

  it('the same malformed environment refuses without --dry-run too — unchanged', async () => {
    // The foreign arm for the narrowing: it must not have changed the non-dry-run
    // path, which already refused here.
    const { root, leaf } = dryRunProgram();
    process.env.FAVRO_API_KEY = '';
    let ran = false;
    leaf.action(run(async () => void (ran = true)));

    await parse(root, ['thing']);

    expect(stdout()[0]).toContain('FAVRO_API_KEY is set but empty');
    expect(process.exitCode).toBe(1);
    expect(ran).toBe(false);
  });

  it('still builds a real client on a dry run when credentials DO resolve', async () => {
    // The foreign arm for the deferral: `--dry-run` must not become a way to get
    // a poisoned context when there was nothing wrong. Credentials are restored
    // here rather than deleted, so the getter path is not taken at all.
    process.env.FAVRO_API_KEY = 'test-key';
    process.env.FAVRO_EMAIL = 'runner@example.com';
    const { root } = program();
    const leaf = root.commands[0];
    leaf.option('--dry-run');
    let ctx: Ctx | undefined;
    leaf.action(run(async (c) => void (ctx = c)));

    await parse(root, ['thing', '--dry-run']);

    expect(ctx!.client).toBeInstanceOf(FavroHttpClient);
    expect(process.exitCode).toBeUndefined();
  });
});

// ─── the api namespace ───────────────────────────────────────────────────────

describe('ctx.api is lazy and memoised', () => {
  it('constructs the one class that was touched and none of the other 19', () => {
    // Counting real constructions, on the real modules: `apiNamespace` reads
    // each class off its module at ACCESS time, so a spy installed here sees
    // every `new` it performs. `mockImplementation` because a jest spy calls
    // through as a plain function, and an ES2020 class refuses that.
    const spies = API_MODULES.map(([modulePath, name]) =>
      jest
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        .spyOn(require(modulePath) as Record<string, never>, name as never)
        .mockImplementation((() => undefined) as never),
    );

    const api = apiNamespace({} as FavroHttpClient);
    expect(spies.every((spy) => !spy.mock.calls.length)).toBe(true);

    void api.cards;

    const constructed = API_MODULES.filter((_, i) => spies[i].mock.calls.length).map(
      ([, name]) => name,
    );
    expect(constructed).toEqual(['CardsAPI']);
  });

  it('returns the same instance every time', () => {
    const api = apiNamespace({} as FavroHttpClient);
    expect(api.boards).toBe(api.boards);
  });

  it('gives every class a getter — the namespace is the whole set', () => {
    const api = apiNamespace({} as FavroHttpClient);
    expect(Object.keys(api).length).toBe(API_MODULES.length);
  });
});

describe('run({ anonymous: true }) drops the client from the TYPE', () => {
  it('is a compile error to touch ctx.client, not a runtime one', async () => {
    // Nothing to authenticate with: the eager arm would refuse here, so the
    // command running at all is the runtime half of the claim.
    delete process.env.FAVRO_API_KEY;
    delete process.env.FAVRO_EMAIL;
    const { root, leaf } = program();
    leaf.action(
      run({ anonymous: true }, async (ctx) => {
        // @ts-expect-error — `client` is absent from the anonymous context by
        // design: four commands declare `anonymous`, and reaching for a client
        // the runner never built must not compile.
        void ctx.client;
        // @ts-expect-error — and `api` with it; every class it builds needs one.
        void ctx.api;
        expect(ctx.config).toBeDefined();
      }),
    );

    await parse(root, ['thing']);

    expect(process.exitCode).toBeUndefined();
  });

  it('will not take a handler that annotates the full Ctx either', () => {
    // Never invoked — the assertion is that it does not compile. Contravariance
    // closes the hole the test above would otherwise leave: declaring the
    // parameter as `Ctx` must be refused too, or `anonymous` would be advice
    // rather than a guarantee.
    // @ts-expect-error — `AnonymousCtx` is missing `client` and `api`.
    const registered = run({ anonymous: true }, async (_ctx: Ctx) => undefined);
    expect(typeof registered).toBe('function');
  });
});
