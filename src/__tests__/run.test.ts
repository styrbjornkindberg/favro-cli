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
import { run, apiNamespace, Ctx } from '../lib/run';
import FavroHttpClient from '../lib/http-client';
import { RefusalError } from '../lib/refusal';
import { DispatchResult } from '../lib/dispatch';
import { latchVerbose } from '../lib/error-handler';

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
  ['../api/aggregate', 'AggregateAPI'],
  ['../api/context', 'ContextAPI'],
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

    expect(seen).toEqual([['a', 'b']]);
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
        throw new Error('wire down');
      }),
    );

    await parse(root, ['thing']);

    expect(JSON.parse(stdout()[0])).toEqual({ error: { message: 'wire down', retryable: true } });
    expect(stderr()).toEqual([]);
    expect(process.exitCode).toBe(1);
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

// ─── the api namespace ───────────────────────────────────────────────────────

describe('ctx.api is lazy and memoised', () => {
  it('constructs the one class that was touched and none of the other 17', () => {
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
