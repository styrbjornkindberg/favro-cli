/**
 * The scope lock runs BEFORE the `--dry-run` preview, on all four of
 * `boards update/delete` and `collections update/delete` (#152).
 *
 * All four returned from the preview and checked afterwards, so a target outside
 * the locked collection previewed cheerfully at exit 0 while the real run refused.
 * A preview that promises an action the guardrail will not allow is worse than no
 * preview: `--dry-run` is the flag a careful caller reaches for FIRST.
 * #103/#104 settled this order for `members add` and the `batch` writes, and
 * `CONTEXT.md` described it as universal; these four never implemented it.
 *
 * WHY A REAL SOCKET, not a mocked `safety`. The sibling suites mock the whole
 * `safety` module, which is fine for asserting that a call happened but cannot
 * tell a `ScopeError` from a renamed bare `Error` — and `toThrow(ScopeError)`
 * cannot either, since jest matches by constructor NAME up the chain. So the
 * guard, the config read and the `/widgets/` resolution here are all live; only
 * WHERE THE CLIENT COMES FROM is swapped. The refusal's identity is then pinned
 * through the two real readers that key on it:
 *
 *   - JSON mode (the default): the `{error:{message,retryable}}` envelope on
 *     STDOUT with `retryable: false`, decided by `retryAdvice` (ADR-0002).
 *   - `--human`: the line is headed `Scope violation:`, which `error-handler.ts`
 *     derives from `.name === 'ScopeError'` (#133). A bare `Error` carrying the
 *     same message renders `Error:` and fails that assertion.
 *
 * EVERY ARM HAS ITS OPPOSITE POLARITY, because "no preview was printed" is an
 * absence, and an absence asserted alone is unfalsifiable exactly in the case the
 * test exists for. Each of the four gets all of:
 *
 *   - outside the lock → refusal, and the preview text is ABSENT       (the fix)
 *   - INSIDE the lock  → the preview is PRESENT, exit 0, no refusal    (omit arm)
 *   - a non-scope failure → its OWN wording, not the scope refusal  (foreign arm)
 *   - no lock at all   → preview, and no credential demanded         (#135's arm)
 */
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import { Command } from 'commander';

import FavroHttpClient from '../../lib/http-client';
import { RefusalError } from '../../lib/refusal';

// The command layer runs for real; only the CLIENT's origin is swapped, so the
// guard, the config read and `assertScope`'s resolving GET are the live ones.
jest.mock('../../lib/client-factory');
import { createFavroClient } from '../../lib/client-factory';

const LOCKED = 'coll-locked';
const LOCK = { scopeCollectionId: LOCKED, scopeCollectionName: 'Locked' };

/** Boards the stand knows, and the collection each one sits in. */
const BOARDS: Record<string, string[]> = {
  'brd-inside': [LOCKED],
  'brd-other': ['coll-elsewhere'],
};

interface Served {
  method: string;
  path: string;
}

const running: http.Server[] = [];
const tmpDirs: string[] = [];

/**
 * A Favro stand-in that records what it is asked. An unknown board 404s, which
 * is how the boards foreign arm gets a NON-scope failure out of the same path.
 */
async function startStand(): Promise<{ client: FavroHttpClient; served: Served[] }> {
  const served: Served[] = [];
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0];
    served.push({ method: req.method ?? '', path: url });
    const widget = /\/widgets\/(.+)$/.exec(url);
    if (widget) {
      const id = decodeURIComponent(widget[1]);
      const collectionIds = BOARDS[id];
      if (!collectionIds) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Not Found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ widgetCommonId: id, name: `Board ${id}`, collectionIds }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  running.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new FavroHttpClient({
    baseURL,
    auth: { token: 't', email: 'e@x', organizationId: 'org-1' },
  });
  return { client, served };
}

/** A config dir holding exactly `config`, plus the client every command will get. */
async function stand(config: Record<string, unknown>): Promise<{ served: Served[] }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favro-dryrun-scope-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  process.env.FAVRO_CONFIG_DIR = dir;
  const { client, served } = await startStand();
  (createFavroClient as jest.Mock).mockResolvedValue(client);
  return { served };
}

/**
 * A config dir with `config`, and NO resolvable credential.
 *
 * `createFavroClient` rejecting with a `RefusalError` is what an absent API key
 * produces, and it is what makes `run()`'s #135 deferral fire: on a `--dry-run`
 * the runner hands back a context whose `client` getter re-throws this error on
 * FIRST TOUCH. So a preview that never touches the client still previews, and one
 * that does refuses — which is exactly the property the lock gate decides.
 */
async function standWithoutCredentials(config: Record<string, unknown>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favro-dryrun-nocreds-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  process.env.FAVRO_CONFIG_DIR = dir;
  (createFavroClient as jest.Mock).mockRejectedValue(
    new RefusalError("API key not found. Run 'favro auth login' first"),
  );
}

/** The real command tree for all four, driven once. */
async function runCli(args: string[]): Promise<void> {
  const { registerBoardsUpdateCommand } = await import('../../commands/boards-update');
  const { registerBoardsDeleteCommand } = await import('../../commands/boards-delete');
  const { registerCollectionsUpdateCommand } = await import('../../commands/collections-update');
  const { registerCollectionsDeleteCommand } = await import('../../commands/collections-delete');

  const program = new Command();
  program.exitOverride();
  program.option('--verbose', 'Show stack traces').option('--human').option('--pretty');
  const boards = program.command('boards');
  registerBoardsUpdateCommand(boards);
  registerBoardsDeleteCommand(boards);
  const collections = program.command('collections');
  registerCollectionsUpdateCommand(collections);
  registerCollectionsDeleteCommand(collections);

  await program.parseAsync(['node', 'favro', ...args]);
}

interface Outcome {
  code: number | undefined;
  stdout: string;
  stderr: string;
  /** `console.log` call order, for "the refusal replaced the preview" ordering. */
  logOrder: number[];
}

/** Drive one invocation and capture both streams separately. */
async function drive(args: string[]): Promise<Outcome> {
  process.exitCode = undefined;
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log as unknown as jest.Mock;
  const error = console.error as unknown as jest.Mock;
  const warn = console.warn as unknown as jest.Mock;
  log.mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(' ')));
  error.mockImplementation((...a: unknown[]) => void err.push(a.map(String).join(' ')));
  warn.mockImplementation((...a: unknown[]) => void err.push(a.map(String).join(' ')));

  await runCli(args);

  return {
    code: process.exitCode,
    stdout: out.join('\n'),
    stderr: err.join('\n'),
    logOrder: log.mock.invocationCallOrder,
  };
}

const originalConfigDir = process.env.FAVRO_CONFIG_DIR;

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.FAVRO_CONFIG_DIR;
  else process.env.FAVRO_CONFIG_DIR = originalConfigDir;
  jest.restoreAllMocks();
  process.exitCode = undefined;
});

afterAll(async () => {
  await Promise.all(running.map((s) => new Promise<void>((r) => s.close(() => r()))));
  tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

// ─── the four, with identical arms ────────────────────────────────────────────

/**
 * One table, four commands, because the failure this ticket closes is a
 * HALF-FIXED FAMILY: fixing `collections` and leaving `boards` (or either one of
 * a pair) rebuilds the exact shape #103/#104 exist to stop, where reading one
 * subcommand tells you nothing about its sibling. Every arm below runs for all
 * four, so a fix that reaches only some of them cannot go green.
 */
interface Subject {
  label: string;
  /** argv tail for a target OUTSIDE the lock, and for one INSIDE it. */
  outside: string[];
  inside: string[];
  /** The preview line's distinguishing text, per target. */
  previewOutside: string;
  previewInside: string;
  /** The refusal's wording — the two guards word it differently, on purpose. */
  refusal: string;
  /** Whether this command's guard resolves its target over the wire. */
  wire: boolean;
}

const SUBJECTS: Subject[] = [
  {
    label: 'boards delete',
    outside: ['boards', 'delete', 'brd-other', '--dry-run'],
    inside: ['boards', 'delete', 'brd-inside', '--dry-run'],
    previewOutside: '[dry-run] Would delete board brd-other',
    previewInside: '[dry-run] Would delete board brd-inside',
    refusal: 'Scope violation: board "Board brd-other" is not in locked collection "Locked".',
    wire: true,
  },
  {
    label: 'boards update',
    outside: ['boards', 'update', 'brd-other', '--name', 'X', '--dry-run'],
    inside: ['boards', 'update', 'brd-inside', '--name', 'X', '--dry-run'],
    previewOutside: '[dry-run] Would update board brd-other with: {"name":"X"}',
    previewInside: '[dry-run] Would update board brd-inside with: {"name":"X"}',
    refusal: 'Scope violation: board "Board brd-other" is not in locked collection "Locked".',
    wire: true,
  },
  {
    label: 'collections delete',
    outside: ['collections', 'delete', 'coll-other', '--dry-run'],
    inside: ['collections', 'delete', LOCKED, '--dry-run'],
    previewOutside: '[dry-run] Would delete collection coll-other',
    previewInside: `[dry-run] Would delete collection ${LOCKED}`,
    refusal:
      'Scope violation: target collection "coll-other" is not the locked collection "Locked".',
    wire: false,
  },
  {
    label: 'collections update',
    outside: ['collections', 'update', 'coll-other', '--name', 'X', '--dry-run'],
    inside: ['collections', 'update', LOCKED, '--name', 'X', '--dry-run'],
    previewOutside: '[dry-run] Would update collection coll-other with: {"name":"X"}',
    previewInside: `[dry-run] Would update collection ${LOCKED} with: {"name":"X"}`,
    refusal:
      'Scope violation: target collection "coll-other" is not the locked collection "Locked".',
    wire: false,
  },
];

describe.each(SUBJECTS)('$label --dry-run takes the scope lock first', (s: Subject) => {
  it('a target OUTSIDE the lock refuses at exit 1, and prints no preview', async () => {
    await stand(LOCK);

    const { code, stdout, stderr } = await drive(s.outside);

    expect(code).toBe(1);
    // The envelope is on STDOUT in machine mode, which is the default (ADR-0002).
    // Asserting the stream and not merely the exit code: #133's whole finding was
    // a refusal that exited 1 having written nothing an agent could read.
    expect(JSON.parse(stdout)).toEqual({
      error: { message: expect.stringContaining(s.refusal), retryable: false },
    });
    expect(stderr).toBe('');
    // The positive half of this pair is the omit arm below, which asserts this
    // very string IS printed — so the absence here is falsifiable.
    expect(stdout).not.toContain(s.previewOutside);
    expect(stdout).not.toContain('[dry-run]');
  });

  it('a target INSIDE the lock still previews, at exit 0, with no refusal', async () => {
    await stand(LOCK);

    const { code, stdout, stderr } = await drive(s.inside);

    expect(code).toBeUndefined();
    expect(stdout).toBe(s.previewInside);
    expect(stdout).not.toContain('Scope violation');
    expect(stderr).toBe('');
  });

  it('--human heads the refusal `Scope violation:`, which only a ScopeError does', async () => {
    await stand(LOCK);

    const { code, stdout, stderr } = await drive([...s.outside, '--human']);

    expect(code).toBe(1);
    // `error-handler.ts` picks this heading off `.name === 'ScopeError'` (#133), and
    // the DISCRIMINATOR is the absent `Error:` — measured: a `ScopeError` renders
    // `✗ Scope violation: …` while a bare `Error` carrying the identical message
    // renders `✗ Error: Scope violation: …`. So asserting only that the text contains
    // "Scope violation:" would be near-vacuous, since the message itself contains it.
    // The test below pins that this pair really does discriminate, in both polarities.
    expect(stderr.split('\n')[0]).toContain(`✗ Scope violation:`);
    expect(stderr).not.toContain('✗ Error:');
    expect(stdout).not.toContain('[dry-run]');
  });

  it('--force previews anyway, at exit 0, and says so on stderr', async () => {
    await stand(LOCK);

    const { code, stdout, stderr } = await drive([...s.outside, '--force']);

    // `--force` is the one escape hatch and it means the same thing on a preview
    // as on a real run: proceed, but warn. The preview is honest again because the
    // warning travels with it — and it is on STDERR, so a parsed stdout is still
    // just the preview line.
    expect(code).toBeUndefined();
    expect(stdout).toBe(s.previewOutside);
    expect(stderr).toContain('--force was used');
    expect(stdout).not.toContain('Scope violation');
  });

  it('with NO lock configured it previews, and never asks for a credential', async () => {
    // #135's rule, and the reason the two `boards` call sites gate on the lock:
    // with nothing locked there is no verdict to produce, so the preview must not
    // pay for one. Ungating the guard makes this arm refuse.
    await standWithoutCredentials({});

    const { code, stdout, stderr } = await drive(s.outside);

    expect(code).toBeUndefined();
    expect(stdout).toBe(s.previewOutside);
    expect(stderr).toBe('');
  });

  it('a lock with NO scopeCollectionName still refuses — the gate keys on the id', async () => {
    // The `boards` gate is a SECOND copy of the guard's own "is a lock configured"
    // test, and nothing else pinned that the copy is faithful. Measured on review:
    // `if (ctx.config?.scopeCollectionName)` in place of `scopeCollectionId` passed
    // 164 suites / 3193 tests at both `boards` sites — a silent fail-open for any
    // config carrying an id and no name, which is a supported shape (the name is
    // optional in `FavroConfig`, every reader spells it
    // `scopeCollectionName ?? scopeCollectionId`, and `scope set` only gets one if
    // the collection payload had a `name`). This arm is what fails on that drift.
    await stand({ scopeCollectionId: LOCKED });

    const { code, stdout, stderr } = await drive(s.outside);

    expect(code).toBe(1);
    // Same refusal, labelled with the id because there is no name to label it with.
    expect(JSON.parse(stdout)).toEqual({
      error: {
        message: expect.stringContaining(s.refusal.replace('"Locked"', `"${LOCKED}"`)),
        retryable: false,
      },
    });
    expect(stdout).not.toContain('[dry-run]');
    expect(stderr).toBe('');
  });

  it('the REAL run still refuses, and issues no write', async () => {
    const { served } = await stand(LOCK);

    const real = s.outside.filter((a) => a !== '--dry-run');
    const { code, stdout } = await drive([...real, '--yes']);

    expect(code).toBe(1);
    expect(JSON.parse(stdout).error.message).toContain(s.refusal);
    // What matters is not "it threw" but that nothing was mutated. The guard's own
    // resolving GET is legitimate; a PUT or DELETE is not.
    expect(served.filter((r) => r.method !== 'GET')).toEqual([]);
  });
});

// ─── what the wire-resolving pair pays, and what it must not ──────────────────

describe('the boards pair pays for the wire under a lock, and only under one', () => {
  it.each([
    ['boards delete', ['boards', 'delete', 'brd-other', '--dry-run']],
    ['boards update', ['boards', 'update', 'brd-other', '--name', 'X', '--dry-run']],
  ])('%s resolves the board over the wire BEFORE printing anything', async (_label, argv) => {
    const { served } = await stand(LOCK);

    const { code } = await drive(argv as string[]);

    expect(code).toBe(1);
    // The preview is now genuinely wire-derived: the verdict it carries came off
    // this request. That is the behaviour change #135's rule absorbs rather than
    // contradicts — a dry run pays for exactly what its preview reaches for.
    expect(served).toEqual([{ method: 'GET', path: '/widgets/brd-other' }]);
  });

  it.each([
    ['boards delete', ['boards', 'delete', 'brd-other', '--dry-run']],
    ['boards update', ['boards', 'update', 'brd-other', '--name', 'X', '--dry-run']],
  ])('%s under a lock and with no credential refuses instead of previewing', async (_label, argv) => {
    await standWithoutCredentials(LOCK);

    const { code, stdout } = await drive(argv as string[]);

    // Credential-gated, deliberately: the preview reaches for `ctx.client`, so
    // #135's deferred refusal fires on first touch. Stated in the ADR, not left
    // to be discovered.
    expect(code).toBe(1);
    expect(JSON.parse(stdout).error).toEqual({
      message: expect.stringContaining('API key not found'),
      retryable: false,
    });
    expect(stdout).not.toContain('[dry-run]');
  });

  it.each([
    ['boards delete', ['boards', 'delete', 'brd-other', '--dry-run']],
    ['boards update', ['boards', 'update', 'brd-other', '--name', 'X', '--dry-run']],
  ])('%s with NO lock issues no request at all', async (_label, argv) => {
    // The #102/#104 criterion, kept: no lock means no behaviour change and no
    // extra request. Asserted on the socket, not on a return value.
    const { served } = await stand({});

    const { code, stdout } = await drive(argv as string[]);

    expect(code).toBeUndefined();
    expect(stdout).toContain('[dry-run]');
    expect(served).toEqual([]);
  });
});

// ─── the heading the arms above lean on actually discriminates ────────────────

describe('the `--human` heading distinguishes a ScopeError from a lookalike', () => {
  /**
   * The four `--human` arms above rest on `✗ Scope violation:` appearing and
   * `✗ Error:` not. That is only worth asserting if the two renderings differ, and
   * `toThrow(ScopeError)` famously does not establish it: jest matches by
   * constructor NAME up the chain, so a renamed bare `Error` satisfies it. This
   * pins the real reader instead, in both polarities, so the assertions above
   * cannot quietly become unfalsifiable.
   *
   * `error-handler.ts` and `safety.ts` are exercised as-is — neither is touched.
   */
  const MESSAGE =
    'Scope violation: target collection "coll-other" is not the locked collection "Locked".';

  const render = (error: unknown): string => {
    const lines: string[] = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(' '));
    });
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { logError } = require('../../lib/error-handler');
      logError(error);
    } finally {
      spy.mockRestore();
    }
    return lines.join('\n');
  };

  it('heads a real ScopeError `Scope violation:` and never `Error:`', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ScopeError } = require('../../lib/safety');
    const scopeError = new ScopeError(MESSAGE, '', LOCKED);

    // The properties the readers actually key on, asserted rather than inferred
    // from where the object came from.
    expect(scopeError).toBeInstanceOf(ScopeError);
    expect(scopeError).toBeInstanceOf(RefusalError);
    expect(scopeError.name).toBe('ScopeError');

    const text = render(scopeError);
    expect(text.split('\n')[0]).toContain('✗ Scope violation:');
    expect(text).not.toContain('✗ Error:');
  });

  it('heads a bare Error carrying the SAME message `Error:` — the opposite polarity', () => {
    const text = render(new Error(MESSAGE));

    // If this ever stops holding, the `--human` arms above have gone vacuous and
    // this test is the one that says so.
    expect(text).toContain('✗ Error:');
    expect(text.split('\n')[0]).not.toContain('✗ Scope violation:');
  });
});

// ─── the foreign arm: a non-scope failure keeps its own wording ───────────────

describe('a failure that is not a scope violation still says what it is', () => {
  it.each([
    ['boards delete', ['boards', 'delete', 'brd-missing', '--dry-run']],
    ['boards update', ['boards', 'update', 'brd-missing', '--name', 'X', '--dry-run']],
  ])('%s on an unknown id gives the 404 wording, not the scope refusal', async (_label, argv) => {
    await stand(LOCK);

    const { code, stdout } = await drive(argv as string[]);

    // `checkScope` rewords a bare 404 off `/widgets/{id}` (#133). A test asserting
    // only "exit 1" would pass with the scope refusal here and hide a confusing
    // message, so it pins WHICH refusal fired.
    expect(code).toBe(1);
    expect(JSON.parse(stdout).error.message).toBe(
      'Scope check failed: Board brd-missing not found.',
    );
    expect(stdout).not.toContain('Scope violation');
  });

  it.each([
    ['boards update', ['boards', 'update', 'brd-other', '--name', '   ', '--dry-run'], 'Board name cannot be empty or whitespace-only'],
    ['collections update', ['collections', 'update', 'coll-other', '--name', '   ', '--dry-run'], 'Collection name cannot be empty or whitespace-only'],
  ])('%s validates its arguments before the lock, credential-free', async (_label, argv, message) => {
    // Argument validation stays AHEAD of the guard, so an empty `--name` on an
    // out-of-lock target answers the argument question rather than the scope one —
    // and answers it with no credential, which is the property the #135 amendment
    // names. Hoisting the guard over the validation would trade one wrong answer
    // for another.
    await standWithoutCredentials(LOCK);

    const { code, stdout } = await drive(argv as string[]);

    expect(code).toBe(1);
    expect(JSON.parse(stdout).error.message).toBe(message);
    expect(stdout).not.toContain('Scope violation');
    expect(stdout).not.toContain('API key not found');
  });
});
