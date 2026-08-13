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

// The two `git` subjects of the #155 half read the LOCAL repo, which a test
// cannot depend on — a worktree's branches and TODOs are not a fixture. Only
// those two reads are stubbed; `safety`, `config` and the wire stay live.
jest.mock('../../lib/git-integration');
jest.mock('../../lib/todo-scanner');
import * as gitIntegration from '../../lib/git-integration';
import * as todoScanner from '../../lib/todo-scanner';

const LOCKED = 'coll-locked';
const LOCK = { scopeCollectionId: LOCKED, scopeCollectionName: 'Locked' };

/** Boards the stand knows, and the collection each one sits in. */
const BOARDS: Record<string, string[]> = {
  'brd-inside': [LOCKED],
  'brd-other': ['coll-elsewhere'],
};

/**
 * Cards the stand knows, and the board each sits on — for the #155 five, whose
 * guards resolve a CARD before they can name a board. `card-missing` is absent
 * on purpose: it is the foreign arm's non-scope failure.
 */
const CARDS: Record<string, string> = {
  'card-inside': 'brd-inside',
  'card-1': 'brd-other',
  'card-2': 'brd-other',
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
    // `git todos --board` resolves a name-or-id through the board LIST (#82).
    if (/\/widgets\/?$/.test(url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          entities: Object.keys(BOARDS).map((id) => ({
            widgetCommonId: id,
            name: `Board ${id}`,
            collectionIds: BOARDS[id],
          })),
        }),
      );
      return;
    }
    const card = /\/cards\/([^/]+)$/.exec(url);
    if (card) {
      const id = decodeURIComponent(card[1]);
      const boardId = CARDS[id];
      if (!boardId) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Not Found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ cardId: id, cardCommonId: id, name: id, widgetCommonId: boardId }));
      return;
    }
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

// ─── the five UNMIGRATED sites (#155) ─────────────────────────────────────────

/**
 * The same defect, at the five sites #152's own CONTEXT.md paragraph named as
 * the gap and then generalised over: `dependencies delete`, `dependencies
 * delete-all`, `custom-fields set`, `git todos` and `git sync`. All five
 * returned from their `--dry-run` preview before consulting the lock. Measured
 * on the built CLI at `8754500` against a local stand, config outside the lock:
 * exit 0 with 55 B / 61 B / 64 B / a `Would create N cards on board <outside>`
 * block / 4678 B of sync plan, and ZERO requests in every case. `git sync` is
 * the one the ticket left "stated unverified"; it is measured here.
 *
 * ALL FIVE GRADUATED IN #119. They used to end in
 * `catch { logError; a hard exit }`, so their refusal landed on STDERR as
 * `✗ Scope violation: …` with stdout carrying no envelope at all — the half of
 * #155 this file was written unable to assert. Every one of them is on `run()`
 * now, so the arms below are driven with `--human` to keep the stderr render and
 * the preview wording the SAME measurement they were, plus a second block that
 * asserts what the migration bought: exit 1 with the refusal parseable on stdout
 * and nothing on stderr.
 *
 * The stderr render is asserted EXACTLY, because `✗ Scope violation:` alone does
 * not discriminate: `logError` renders a bare `Error` carrying the identical
 * message as `✗ Error: Scope violation: …`, which is the trap #152's own
 * assertion fell into. `toBe` on the whole render, plus the `instanceof
 * ScopeError` / `.name` pin recorded off the real thrown object, closes it in
 * both directions.
 *
 * Every subject gets the same arms as the four above: outside → refusal with the
 * preview ABSENT, inside → preview PRESENT at exit 0, no lock → preview with no
 * credential asked for, an id-only lock → still refuses (the gate keys on
 * `scopeCollectionId`), `--force` → warn and preview anyway, and the real run
 * → refuses with nothing written.
 */
interface Target {
  argv: string[];
  /** Distinguishing text of the write preview, per target. */
  preview: string;
  /** Per-target arrangement for the two `git` subjects' local reads. */
  arrange?: () => void;
}

interface Graduated {
  label: string;
  outside: Target;
  inside: Target;
  /** argv for the REAL run of the out-of-lock target. */
  real: string[];
}

/** Every one of the five resolves its way to `brd-other`, so one wording fits. */
const OUTSIDE_MESSAGE =
  'Scope violation: board "Board brd-other" is not in locked collection "Locked".\n' +
  "  Run 'favro scope show' to see your current lock.\n" +
  "  Run 'favro scope set <collectionId>' to change it, or pass --force to override.";
const OUTSIDE_RENDER = `✗ Scope violation: ${OUTSIDE_MESSAGE.slice('Scope violation: '.length)}`;

const TODO = { file: 'src/a.ts', line: 3, type: 'TODO', text: 'fix me' };

/** `git sync`'s branch mapping, swapped per target since it takes no argument. */
const syncBranches = (cardId: string) => () => {
  (gitIntegration.analyzeBranches as jest.Mock).mockReturnValue([
    { branch: 'feature/one', cardId, status: 'merged' },
  ]);
};

/**
 * The five, all of them on `run()` since #119. `--human` on every drive so the
 * refusal render and the preview wording below are the same measurement they
 * were when these were legacy; the exit code is the one thing that had to
 * change, and it comes off `process.exitCode` now.
 */
const GRADUATED: Graduated[] = [
  {
    label: 'dependencies delete',
    outside: { argv: ['dependencies', 'delete', 'card-1', 'card-2', '--dry-run', '--human'], preview: 'remove the edge where card-2 blocks card-1' },
    inside: { argv: ['dependencies', 'delete', 'card-inside', 'card-2', '--dry-run', '--human'], preview: 'remove the edge where card-2 blocks card-inside' },
    real: ['dependencies', 'delete', 'card-1', 'card-2', '--yes', '--human'],
  },
  {
    label: 'dependencies delete-all',
    outside: { argv: ['dependencies', 'delete-all', 'card-1', '--dry-run', '--human'], preview: 'remove every blocking edge on card-1' },
    inside: { argv: ['dependencies', 'delete-all', 'card-inside', '--dry-run', '--human'], preview: 'remove every blocking edge on card-inside' },
    real: ['dependencies', 'delete-all', 'card-1', '--yes', '--human'],
  },
  {
    label: 'custom-fields set',
    outside: { argv: ['custom-fields', 'set', 'card-1', 'field-1', 'v', '--dry-run', '--human'], preview: '[dry-run] update card card-1' },
    inside: { argv: ['custom-fields', 'set', 'card-inside', 'field-1', 'v', '--dry-run', '--human'], preview: '[dry-run] update card card-inside' },
    real: ['custom-fields', 'set', 'card-1', 'field-1', 'v', '--yes', '--human'],
  },
  {
    label: 'git todos',
    outside: { argv: ['git', 'todos', '--board', 'brd-other', '--dry-run', '--human'], preview: 'Would create 1 cards on board brd-other' },
    inside: { argv: ['git', 'todos', '--board', 'brd-inside', '--dry-run', '--human'], preview: 'Would create 1 cards on board brd-inside' },
    real: ['git', 'todos', '--board', 'brd-other', '--create', '--yes', '--human'],
  },
  {
    label: 'git sync',
    outside: { argv: ['git', 'sync', '--dry-run', '--human'], preview: 'Would move cards', arrange: syncBranches('card-1') },
    inside: { argv: ['git', 'sync', '--dry-run', '--human'], preview: 'Would move cards', arrange: syncBranches('card-inside') },
    real: ['git', 'sync', '--yes', '--human'],
  },
];

/** The real command tree for the five, driven once. */
async function runFive(args: string[]): Promise<void> {
  const { registerDependenciesCommands } = await import('../../commands/dependencies');
  const { registerCustomFieldsCommands } = await import('../../commands/custom-fields');
  const { registerGitCommands } = await import('../../commands/git');

  const program = new Command();
  program.exitOverride();
  program.option('--verbose', 'Show stack traces').option('--human').option('--pretty');
  registerDependenciesCommands(program);
  registerCustomFieldsCommands(program);
  registerGitCommands(program);
  await program.parseAsync(['node', 'favro', ...args]);
}

/**
 * Drive one of the five and capture both streams.
 *
 * The error object `logError` was handed is recorded too: that is the only place
 * the refusal's TYPE is observable end-to-end, and `toThrow(ScopeError)` could
 * not establish it anyway (jest matches by constructor name up the chain).
 */
async function driveFive(args: string[]): Promise<Outcome & { thrown: unknown }> {
  const out: string[] = [];
  const err: string[] = [];
  let code: number | undefined;
  let thrown: unknown;
  // All five set `process.exitCode` instead of exiting since #119. The `exit`
  // spy stays as a TRIPWIRE — a hard exit from any of them is a regression, and
  // `code` would then be read from it rather than from `process.exitCode`.
  process.exitCode = undefined;

  const log = console.log as unknown as jest.Mock;
  const error = console.error as unknown as jest.Mock;
  const warn = console.warn as unknown as jest.Mock;
  log.mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(' ')));
  error.mockImplementation((...a: unknown[]) => void err.push(a.map(String).join(' ')));
  warn.mockImplementation((...a: unknown[]) => void err.push(a.map(String).join(' ')));
  jest.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    code = c;
  }) as never);

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const errorHandler = require('../../lib/error-handler');
  const real = errorHandler.logError;
  jest.spyOn(errorHandler, 'logError').mockImplementation((...args: unknown[]) => {
    thrown = args[0];
    real(...args);
  });

  await runFive(args);

  const outcome = { code: code ?? process.exitCode, stdout: out.join('\n'), stderr: err.join('\n'), logOrder: log.mock.invocationCallOrder, thrown };
  process.exitCode = undefined;
  return outcome;
}

describe.each(GRADUATED)('$label --dry-run takes the scope lock first (#155)', (s: Graduated) => {
  beforeEach(() => {
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    (gitIntegration.isGitRepo as jest.Mock).mockReturnValue(true);
    (gitIntegration.findProjectRoot as jest.Mock).mockReturnValue('/repo');
    (gitIntegration.readProjectConfig as jest.Mock).mockReturnValue({ boardId: 'brd-other' });
    (gitIntegration.analyzeBranches as jest.Mock).mockReturnValue([
      { branch: 'feature/one', cardId: 'card-1', status: 'merged' },
    ]);
    (todoScanner.scanTodos as jest.Mock).mockReturnValue([TODO]);
    (todoScanner.groupByFile as jest.Mock).mockReturnValue([{ file: TODO.file, items: [TODO] }]);
    (todoScanner.todoToCardTitle as jest.Mock).mockReturnValue('TODO: fix me');
    (todoScanner.formatTodoAsCardDescription as jest.Mock).mockReturnValue('src/a.ts:3');
  });

  it('a target OUTSIDE the lock refuses at exit 1, and prints no preview', async () => {
    await stand(LOCK);
    s.outside.arrange?.();

    const { code, stdout, stderr, thrown } = await driveFive(s.outside.argv);

    expect(code).toBe(1);
    // Unmigrated, so the refusal is on STDERR and there is no envelope. Exact,
    // because a bare `Error` with the same message renders `✗ Error: Scope
    // violation: …` and a `toContain('Scope violation:')` cannot tell them apart.
    expect(stderr).toContain(OUTSIDE_RENDER);
    expect(stderr).not.toContain('✗ Error:');
    // The type, off the object the reader was actually handed.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ScopeError } = require('../../lib/safety');
    expect(thrown).toBeInstanceOf(ScopeError);
    expect(thrown).toBeInstanceOf(RefusalError);
    expect((thrown as Error).name).toBe('ScopeError');
    expect((thrown as Error).message).toBe(OUTSIDE_MESSAGE);
    // The positive half of this pair is the omit arm below, which asserts this
    // very string IS printed — so the absence here is falsifiable.
    expect(stdout).not.toContain(s.outside.preview);
  });

  it('a target INSIDE the lock still previews, at exit 0, with no refusal', async () => {
    await stand(LOCK);
    s.inside.arrange?.();

    const { code, stdout, stderr } = await driveFive(s.inside.argv);

    expect(code).toBeUndefined();
    expect(stdout).toContain(s.inside.preview);
    expect(stderr).not.toContain('Scope violation');
  });

  it('with NO lock configured it previews, and never asks for a credential', async () => {
    // #135's rule, and the whole reason each of the five call sites gates on the
    // lock: with nothing locked there is no verdict to produce, so the preview
    // must not pay for one. Ungating the guard makes this arm refuse — the
    // credential is resolved eagerly by `createFavroClient`, which is what this
    // stand rejects.
    await standWithoutCredentials({});
    s.outside.arrange?.();

    const { code, stdout, stderr } = await driveFive(s.outside.argv);

    expect(code).toBeUndefined();
    expect(stdout).toContain(s.outside.preview);
    expect(stderr).toBe('');
  });

  it('under a lock with NO credential it refuses instead of previewing', async () => {
    // The #135 pricing decision, stated as behaviour: under a lock these five
    // previews genuinely reach for the wire, so they pay for it — and they fail
    // CLOSED. This is the arm that catches the fail-open #135's reviewer found,
    // where deferring the credential error turned exit 1 into exit 0 previewing
    // the write.
    await standWithoutCredentials(LOCK);
    s.outside.arrange?.();

    const { code, stdout, stderr } = await driveFive(s.outside.argv);

    expect(code).toBe(1);
    expect(stderr).toContain('API key not found');
    expect(stdout).not.toContain(s.outside.preview);
  });

  it('a lock with NO scopeCollectionName still refuses — the gate keys on the id', async () => {
    // Each of the five call sites carries a SECOND copy of the guard's own "is a
    // lock configured" test, and #152's review measured that keying that copy on
    // `scopeCollectionName` instead passed the whole suite — a silent fail-open
    // for a config with an id and no name, which is a supported shape. This arm
    // is what fails on that drift, at all five sites at once.
    await stand({ scopeCollectionId: LOCKED });
    s.outside.arrange?.();

    const { code, stdout, stderr } = await driveFive(s.outside.argv);

    expect(code).toBe(1);
    expect(stderr).toContain(
      `✗ Scope violation: board "Board brd-other" is not in locked collection "${LOCKED}".`,
    );
    expect(stderr).not.toContain('✗ Error:');
    expect(stdout).not.toContain(s.outside.preview);
  });

  it('--force previews anyway, at exit 0, and says so', async () => {
    // `--force` is the one escape hatch and it means the same thing on a preview
    // as on a real run: proceed, but warn. Passed for real rather than asserted
    // about — #126 shipped a `--force` claim that held only because no test ever
    // passed the flag.
    await stand(LOCK);
    s.outside.arrange?.();

    const { code, stdout, stderr } = await driveFive([...s.outside.argv, '--force']);

    expect(code).toBeUndefined();
    expect(stdout).toContain(s.outside.preview);
    expect(stderr).toContain('--force was used');
    expect(stderr).not.toContain('Scope violation: board');
  });

  it('the REAL run still refuses, and issues no write', async () => {
    const { served } = await stand(LOCK);
    s.outside.arrange?.();

    const { code, stderr } = await driveFive(s.real);

    expect(code).toBe(1);
    expect(stderr).toContain(OUTSIDE_RENDER);
    // What matters is not "it threw" but that nothing was mutated. The guard's
    // own resolving GETs are legitimate; a POST, PUT or DELETE is not.
    expect(served.filter((r) => r.method !== 'GET')).toEqual([]);
  });
});

// ─── the ordering itself, not just the verdict ────────────────────────────────

describe('the five consult the lock BEFORE they print anything of the plan (#155)', () => {
  it.each(GRADUATED.map((s) => [s.label, s] as const))(
    '%s issues its resolving GETs and then prints no preview at all',
    async (_label, s) => {
      const { served } = await stand(LOCK);
      (gitIntegration.isGitRepo as jest.Mock).mockReturnValue(true);
      (gitIntegration.findProjectRoot as jest.Mock).mockReturnValue('/repo');
      (gitIntegration.readProjectConfig as jest.Mock).mockReturnValue({ boardId: 'brd-other' });
      (todoScanner.scanTodos as jest.Mock).mockReturnValue([TODO]);
      (todoScanner.groupByFile as jest.Mock).mockReturnValue([{ file: TODO.file, items: [TODO] }]);
      (todoScanner.todoToCardTitle as jest.Mock).mockReturnValue('TODO: fix me');
      (todoScanner.formatTodoAsCardDescription as jest.Mock).mockReturnValue('src/a.ts:3');
      jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      s.outside.arrange?.();

      const { code, stdout } = await driveFive(s.outside.argv);

      // The verdict is now genuinely wire-derived: the preview reaches for the
      // wire, so #135's rule prices it rather than contradicting it.
      expect(code).toBe(1);
      expect(served.filter((r) => /^\/widgets\/.+/.test(r.path))).not.toEqual([]);
      expect(stdout).not.toContain(s.outside.preview);
    },
  );
});

// ─── what graduating onto run() bought: the envelope (#119) ──────────────────

/**
 * The half of #155 this file was written unable to assert.
 *
 * The two `git` previews refused correctly and wrote the refusal to STDERR with
 * ZERO bytes on stdout, because they ended in the legacy
 * `catch { logError; a hard exit }`. A live smoke run against the real API
 * re-measured exactly that on the sibling write family and called it the dead
 * end #110 existed to remove. `run()` is what removes it, and this is the arm
 * that says so: the machine DEFAULT — no `--human`, which is what an agent gets.
 *
 * All five subjects get this arm — the last three joined when #119 migrated
 * `dependencies` and `custom-fields` alongside the two `git` commands.
 */
describe.each(GRADUATED)('$label refuses into the envelope on stdout (#119)', (s: Graduated) => {
  const machine = (argv: string[]) => argv.filter((a) => a !== '--human');

  beforeEach(() => {
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    (gitIntegration.isGitRepo as jest.Mock).mockReturnValue(true);
    (gitIntegration.findProjectRoot as jest.Mock).mockReturnValue('/repo');
    (gitIntegration.readProjectConfig as jest.Mock).mockReturnValue({ boardId: 'brd-other' });
    (todoScanner.scanTodos as jest.Mock).mockReturnValue([TODO]);
    (todoScanner.groupByFile as jest.Mock).mockReturnValue([{ file: TODO.file, items: [TODO] }]);
    (todoScanner.todoToCardTitle as jest.Mock).mockReturnValue('TODO: fix me');
    (todoScanner.formatTodoAsCardDescription as jest.Mock).mockReturnValue('src/a.ts:3');
  });

  it('exit 1, the refusal parseable on stdout, and NOTHING on stderr', async () => {
    await stand(LOCK);
    s.outside.arrange?.();

    const { code, stdout, stderr } = await driveFive(machine(s.outside.argv));

    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toEqual({
      error: { message: expect.stringContaining(OUTSIDE_MESSAGE), retryable: false },
    });
    expect(stderr).toBe('');
    expect(stdout).not.toContain(s.outside.preview);
  });

  it('and the preview it DOES allow costs no exit code and no stderr', async () => {
    // The other polarity. `code` undefined is what stops the arm above passing
    // against a build that refuses everything.
    //
    // Asserted as far as it is TRUE for all five, and no further: the two `git`
    // previews are `item:` results, so their stdout is one JSON document, while
    // the three dispatch previews render `[dry-run] …` prose through
    // `reportDispatch` in BOTH modes. That prose-on-stdout shape is
    // `reportDispatch`'s, shared by every dispatch preview in the CLI, and
    // predates this ticket — #119 did not introduce it and does not change it.
    await stand(LOCK);
    s.inside.arrange?.();

    const { code, stdout, stderr } = await driveFive(machine(s.inside.argv));

    expect(code).toBeUndefined();
    expect(stderr).toBe('');
    expect(stdout).not.toBe('');
  });
});

// ─── git sync's second conjunct: a lock is not enough, there must be work ─────

describe('git sync with nothing to move needs no credential (#155)', () => {
  it('previews at exit 0 under a lock when every branch is `current`', async () => {
    // `git sync`'s hoisted guard is gated on `targets.length > 0 &&` as well as on
    // the lock, and this is the arm that pays for that conjunct. Deleting it left
    // the whole suite green — measured — because the resolve loop and the check
    // loop both iterate empty sets either way. What it changes is that the CLIENT
    // is constructed, so a sync with nothing to sync starts demanding a
    // credential; here there is none to find, and that is what fails.
    await standWithoutCredentials(LOCK);
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    (gitIntegration.isGitRepo as jest.Mock).mockReturnValue(true);
    (gitIntegration.readProjectConfig as jest.Mock).mockReturnValue({ boardId: 'brd-other' });
    (gitIntegration.analyzeBranches as jest.Mock).mockReturnValue([
      { branch: 'main', cardId: 'card-1', status: 'current' },
    ]);

    const { code, stdout, stderr } = await driveFive(['git', 'sync', '--dry-run']);

    expect(code).toBeUndefined();
    expect(stderr).toBe('');
    // The local report still runs — it describes the repo, not the write — but
    // #119 moved it to STDERR, so stdout is the envelope alone and what it
    // reports is an empty plan.
    expect(JSON.parse(stdout)).toMatchObject({ dryRun: true, wouldMove: [] });
    expect(stdout).not.toContain('Would move cards');
  });
});

// ─── the ratchet that makes the whole-CLI claim self-defending ────────────────

/**
 * This paragraph of `CONTEXT.md` has now been wrong three times: #135 found the
 * lock ran AFTER the preview on four commands, #152 fixed those four and
 * generalised the fix over five more that still had the bug, and #155 is those
 * five. Nine sites and two false whole-CLI claims later, the honest way to state
 * the rule is to make it checkable.
 *
 * `scope-lock-coverage.test.ts` ratchets WHETHER a write closure has a guard,
 * never its ORDER, which is why it caught none of the three. This is the order.
 *
 * FALSIFIABLE, measured rather than asserted: run against `src/commands` as of
 * `8754500` this predicate reports exactly five gaps, at exactly the lines #155
 * names — `dependencies.ts:129`, `:162`, `custom-fields.ts:174`, `git.ts:302`
 * and `:436`. Run against the tree it ships in, zero. It is textual and
 * therefore conservative in one direction: the condition has to be exactly
 * `options.dryRun`, so `if (!options.dryRun)` (a confirm gate) and
 * `if (options.create || options.dryRun)` (a block ENTRY, not a preview) are not
 * previews and are correctly not hits.
 *
 * The GUARD list was a hand-written enumeration of five names in review, and it
 * did not include this repo's own local guard helpers — `checkTaskScope`
 * (`tasks.ts`) and `checkTargetScope` (`members.ts`) — so `members add` and
 * `tasks update/complete/delete` were four guarded previews the scan skipped
 * entirely, four of the nine subjects `CONTEXT.md` names among them. It matches
 * the SHAPE now (`check…Scope` / `assert…Scope`), which raised the denominators
 * from 33/29 to 38/33 and left the five historical gaps identical. That was the
 * exact failure mode of #149's ratchet, blind to the repo's own dominant
 * spelling; an enumeration of names is one.
 *
 * CEILING, measured against constructed bypasses rather than guessed at. These
 * four still slip past, and the nine behavioural subjects above are why that is
 * survivable: a preview hoisted into a HELPER defined above the first
 * `.command(` (the block window never sees it); a preview gated on a differently
 * spelled flag (`if (!options.execute)`); a guard reached through an alias
 * (`const g = checkScope; await g(…)` — `guard === -1`, and the block is then
 * skipped rather than reported); and a condition wrapped across lines by a
 * formatter. A same-line body (`if (options.dryRun) { …; return; }`) used to
 * slip past too and no longer does — the `{?$` anchor is gone, which changed
 * nothing on the real tree in either polarity.
 *
 * ponytail: a text scan, not an AST walk. Upgrade to the TypeScript compiler API
 * (already a devDependency) if any of the four remaining bypasses ever becomes a
 * spelling this repo actually uses.
 */
describe('no guarded write previews ahead of its own scope guard (#155)', () => {
  const GUARD = /\b(?:check|assert)\w*Scope\s*\(/;
  const PREVIEW = /^\s*if\s*\(\s*options\.dryRun\s*\)/;

  /** One entry per `.command(...)` registration that calls a scope guard. */
  const scan = (root: string) => {
    const gaps: string[] = [];
    let guarded = 0;
    let withPreview = 0;
    for (const file of fs.readdirSync(root).filter((f) => f.endsWith('.ts'))) {
      const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
      const starts: number[] = [];
      lines.forEach((l, i) => {
        if (/\.command\(/.test(l)) starts.push(i);
      });
      starts.push(lines.length);
      for (let b = 0; b < starts.length - 1; b++) {
        // Comment lines are blanked, so prose describing the old order is not a hit.
        const code = lines
          .slice(starts[b], starts[b + 1])
          .map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l));
        const guard = code.findIndex((l) => GUARD.test(l));
        const preview = code.findIndex((l) => PREVIEW.test(l));
        if (guard === -1) continue;
        guarded++;
        if (preview !== -1) withPreview++;
        if (preview !== -1 && preview < guard) gaps.push(`${file}:${starts[b] + 1 + preview}`);
      }
    }
    return { gaps, guarded, withPreview };
  };

  it('finds no command whose --dry-run preview precedes its guard', () => {
    const { gaps, guarded, withPreview } = scan(path.join(__dirname, '..', '..', 'commands'));

    expect(gaps).toEqual([]);
    // The denominators, so a scan that silently stopped reading files fails here
    // rather than passing vacuously with an empty gap list.
    //
    // 38 until #109, which routed eight of these commands through the dispatch
    // table — `dependencies` add/delete/delete-all, `custom-fields set`,
    // `widgets add`, `cards move` and two of `git`'s. Their guard is now the
    // table's `assertScope`, taken inside the intent and structurally before the
    // `dryRun` return, so the ordering this scan checks cannot be got wrong for
    // them at all. They leave the denominator because the TEXT this scanner reads
    // — a `checkScope(` call in the command file — is gone, not because a check
    // is. The scan's job is unchanged for the commands that still guard inline.
    //
    // 30/27 until #110, which DELETED `commands/batch.ts` and
    // `commands/batch-smart.ts`. Four blocks go with them, each guarded and each
    // previewing: `batch update`, `batch move`, `batch assign` and `batch-smart`.
    // (The `batch` GROUP registration was a fifth block and never counted — it
    // guards nothing.) The stubs that replace them add four more `.command(`
    // lines and no guards, so they are skipped exactly as the group was.
    //
    // Both are EXACT-FIT, measured by running this scanner, not rounded down: 26
    // and 23 are what it reports today. Slack here is the whole failure this arm
    // exists to stop — at 21, two commands could lose their preview or their
    // guard with the ratchet still green.
    expect(guarded).toBeGreaterThanOrEqual(26);
    expect(withPreview).toBeGreaterThanOrEqual(23);
  });

  it('reports a gap when the preview is moved back above the guard', () => {
    // The opposite polarity, on a synthetic block shaped like the five #155
    // closed. Without this the assertion above is an absence, and an absence
    // asserted alone passes for a scan that finds nothing at all.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favro-order-ratchet-'));
    tmpDirs.push(dir);
    fs.writeFileSync(
      path.join(dir, 'regressed.ts'),
      [
        "parent.command('delete <card>')",
        '  .action(async (cardId, options) => {',
        '    if (options.dryRun) {',
        "      dryRunLog('remove', 'thing', cardId);",
        '      return;',
        '    }',
        '    await checkScope(cardId, client, config, options.force);',
        '  });',
        '',
      ].join('\n'),
    );

    expect(scan(dir).gaps).toEqual(['regressed.ts:3']);
  });

  it('sees a preview whose body sits on the same line, and a LOCAL guard helper', () => {
    // Two constructed bypasses that both worked against the review version: the
    // whole preview on one line (the old `{?$` anchor could not match it), and a
    // guard named like the repo's own `checkTaskScope`/`checkTargetScope` rather
    // than one of five enumerated names (`guard === -1` skipped the block whole,
    // so no gap was reported and the block did not even count).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favro-order-ratchet-'));
    tmpDirs.push(dir);
    fs.writeFileSync(
      path.join(dir, 'sneaky.ts'),
      [
        "parent.command('update <taskId>')",
        '  .action(async (taskId, options) => {',
        "    if (options.dryRun) { dryRunLog('update', 'task', taskId); return; }",
        '    await checkTaskScope(client, options.card, options.force);',
        '  });',
        '',
      ].join('\n'),
    );

    const { gaps, guarded, withPreview } = scan(dir);
    expect(gaps).toEqual(['sneaky.ts:3']);
    expect(guarded).toBe(1);
    expect(withPreview).toBe(1);
  });
});

describe('a failure that is not a scope violation still says what it is (#155)', () => {
  it.each([
    ['dependencies delete', ['dependencies', 'delete', 'card-missing', 'card-2', '--dry-run', '--human']],
    ['dependencies delete-all', ['dependencies', 'delete-all', 'card-missing', '--dry-run', '--human']],
  ])('%s on an unknown card gives the read failure, not the scope refusal', async (_label, argv) => {
    // The card read is unwrapped at these two sites, so a 404 propagates as
    // itself. A test asserting only "exit 1" would pass with the scope refusal
    // here and hide a message naming the wrong problem.
    await stand(LOCK);

    const { code, stdout, stderr } = await driveFive(argv as string[]);

    expect(code).toBe(1);
    expect(stderr).toContain('404');
    expect(stderr).not.toContain('Scope violation');
    expect(stdout).not.toContain('Would remove');
  });
});
