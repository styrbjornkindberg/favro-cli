/**
 * `FAVRO_SCOPE_COLLECTION_ID` is the lock every write guard enforces — #174.
 *
 * The lock used to live in one file that every reader loaded fresh per
 * invocation, so two shells could not hold different locks: `favro scope set X`
 * in one silently retargeted the other's next write. The env var makes the lock
 * per-session, and this suite is the behavioural half — the guard, the config
 * read and `assertScope`'s resolving `GET /widgets/{id}` are all LIVE, exactly as
 * `dry-run-scope-order-wire.test.ts` argues they must be: mocking `safety` can
 * assert that a call happened but cannot tell a `ScopeError` from a renamed bare
 * `Error`. Only WHERE THE CLIENT COMES FROM is swapped.
 *
 * "Two shells" is two invocations with different values of the variable. That is
 * not a simplification of the subject, it IS the subject: nothing is cached
 * between invocations, so a per-process env read is precisely what a per-shell
 * export gives the CLI.
 *
 * EVERY ARM HAS ITS OPPOSITE POLARITY. "The write was refused" asserted alone is
 * unfalsifiable in the case that matters — a guard that refused everything would
 * pass it — so each env value gets both a target inside its lock and a target
 * outside it, and the two values disagree about which is which.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { AddressInfo } from 'net';
import { Command } from 'commander';

import FavroHttpClient from '../../lib/http-client';
import { tempConfigDir } from '../../test-support/config-dir';

// The command layer runs for real; only the CLIENT's origin is swapped, so the
// guard, the config read and `assertScope`'s resolving GET are the live ones.
jest.mock('../../lib/client-factory');
import { createFavroClient } from '../../lib/client-factory';

const FILE_LOCK = { scopeCollectionId: 'coll-file', scopeCollectionName: 'File Lock' };
const CONFIG_DIR = tempConfigDir('favro-scope-env-wire-', { apiKey: 'k', ...FILE_LOCK });
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

/** Boards the stand knows, and the collection each one sits in. */
const BOARDS: Record<string, string[]> = {
  'brd-a': ['coll-a'],
  'brd-b': ['coll-b'],
  'brd-file': ['coll-file'],
};

const running: http.Server[] = [];

/** A Favro stand-in. An unknown board 404s — that is the uncheckable arm. */
async function startStand(): Promise<FavroHttpClient> {
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0];
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
    res.end(JSON.stringify({ collectionId: 'coll-a', name: 'Collection A' }));
  });
  running.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return new FavroHttpClient({
    baseURL,
    auth: { token: 't', email: 'e@x', organizationId: 'org-1' },
  });
}

const onDisk = (): Record<string, unknown> => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
const seed = (config: Record<string, unknown>): void =>
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config));

interface Outcome {
  code: number | undefined;
  stdout: string;
  stderr: string;
}

/** One invocation of the real command tree, with both streams captured apart. */
async function drive(args: string[]): Promise<Outcome> {
  process.exitCode = undefined;
  const out: string[] = [];
  const err: string[] = [];
  (console.log as unknown as jest.Mock).mockImplementation((...a: unknown[]) =>
    void out.push(a.map(String).join(' ')));
  (console.error as unknown as jest.Mock).mockImplementation((...a: unknown[]) =>
    void err.push(a.map(String).join(' ')));
  (console.warn as unknown as jest.Mock).mockImplementation((...a: unknown[]) =>
    void err.push(a.map(String).join(' ')));

  const { registerBoardsDeleteCommand } = await import('../../commands/boards-delete');
  const { registerScopeCommand } = await import('../../commands/scope');
  const { registerAuthCommand } = await import('../../commands/auth');

  const program = new Command();
  program.exitOverride();
  program.option('--verbose', 'Show stack traces').option('--human').option('--pretty');
  registerBoardsDeleteCommand(program.command('boards'));
  registerScopeCommand(program);
  registerAuthCommand(program);

  await program.parseAsync(['node', 'favro', ...args]);

  return { code: process.exitCode, stdout: out.join('\n'), stderr: err.join('\n') };
}

const origScope = process.env.FAVRO_SCOPE_COLLECTION_ID;

beforeEach(async () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  seed({ apiKey: 'k', ...FILE_LOCK });
  (createFavroClient as jest.Mock).mockResolvedValue(await startStand());
});

afterEach(() => {
  if (origScope === undefined) delete process.env.FAVRO_SCOPE_COLLECTION_ID;
  else process.env.FAVRO_SCOPE_COLLECTION_ID = origScope;
  jest.restoreAllMocks();
  process.exitCode = undefined;
});

afterAll(async () => {
  await Promise.all(running.map((s) => new Promise<void>((r) => s.close(() => r()))));
});

// ─── the lock every write guard enforces ──────────────────────────────────────

describe('two shells, two locks', () => {
  /**
   * The table: each "shell" exports a different collection, and each one's
   * INSIDE board is the other's OUTSIDE board. A fix that read the env var once
   * for the whole process, or that fell back to the file lock, fails one row.
   */
  const shells = [
    { env: 'coll-a', inside: 'brd-a', outside: 'brd-b' },
    { env: 'coll-b', inside: 'brd-b', outside: 'brd-a' },
  ];

  for (const { env, inside, outside } of shells) {
    describe(`FAVRO_SCOPE_COLLECTION_ID=${env}`, () => {
      beforeEach(() => {
        process.env.FAVRO_SCOPE_COLLECTION_ID = env;
      });

      test(`a board INSIDE the session lock still previews at exit 0`, async () => {
        const r = await drive(['boards', 'delete', inside, '--dry-run']);

        expect(r.stdout).toContain(`[dry-run] Would delete board ${inside}`);
        expect(r.code).toBeUndefined();
      });

      test(`a board OUTSIDE it refuses, and the preview is absent`, async () => {
        const r = await drive(['boards', 'delete', outside, '--dry-run']);

        expect(r.code).toBe(1);
        // The refusal names the env collection, not the file's — proof of WHICH
        // lock was enforced, which an exit code alone cannot show.
        expect(r.stdout).toContain('Scope violation');
        expect(r.stdout).toContain(env);
        expect(r.stdout).not.toContain(FILE_LOCK.scopeCollectionId);
        expect(r.stdout).not.toContain('[dry-run] Would delete');
      });

      test(`the FILE's own collection is now outside the lock and refuses too`, async () => {
        // The file lock is inert, not merged. Without this arm an implementation
        // that unioned the two locks would pass every arm above.
        const r = await drive(['boards', 'delete', 'brd-file', '--dry-run']);

        expect(r.code).toBe(1);
        expect(r.stdout).toContain('Scope violation');
      });

      test('--force still overrides the session lock', async () => {
        const r = await drive(['boards', 'delete', outside, '--dry-run', '--force']);

        expect(r.stdout).toContain(`[dry-run] Would delete board ${outside}`);
        expect(r.code).toBeUndefined();
      });

      test('an unresolvable board is UNCHECKABLE, not exempt — --force does not rescue it', async () => {
        // Where the lock comes from changed; nothing about how it is enforced did.
        const r = await drive(['boards', 'delete', 'brd-ghost', '--dry-run', '--force']);

        expect(r.code).toBe(1);
        expect(r.stdout).not.toContain('[dry-run] Would delete');
      });
    });
  }

  test('with the var UNSET the FILE lock is enforced, unchanged', async () => {
    // The byte-identical-to-today arm. `brd-file` is inside the file lock and
    // `brd-a` is not, which is the exact inversion of every row above.
    const inside = await drive(['boards', 'delete', 'brd-file', '--dry-run']);
    expect(inside.stdout).toContain('[dry-run] Would delete board brd-file');
    expect(inside.code).toBeUndefined();

    const outside = await drive(['boards', 'delete', 'brd-a', '--dry-run']);
    expect(outside.code).toBe(1);
    expect(outside.stdout).toContain('Scope violation');
    expect(outside.stdout).toContain('File Lock');
  });

  test('an EMPTY var refuses the write rather than falling back to the file lock', async () => {
    process.env.FAVRO_SCOPE_COLLECTION_ID = '   ';

    // `brd-file` is inside the FILE lock, so a fall-through would preview here.
    const r = await drive(['boards', 'delete', 'brd-file', '--dry-run']);

    expect(r.code).toBe(1);
    expect(r.stdout).toContain('FAVRO_SCOPE_COLLECTION_ID is set but empty');
    expect(r.stdout).not.toContain('[dry-run] Would delete');
  });
});

// ─── the config file is never rewritten from the session lock ─────────────────

describe('the session lock does not reach the config file', () => {
  beforeEach(() => {
    process.env.FAVRO_SCOPE_COLLECTION_ID = 'coll-a';
  });

  test('`auth logout` rewrites the config and the file lock survives', async () => {
    // A real writer, driven end to end: it spreads a `readConfig()` result minus
    // the key. Asserted on FILE CONTENTS, because its exit code was always 0.
    const r = await drive(['auth', 'logout']);

    expect(r.code).toBeUndefined();
    const after = onDisk();
    expect(after.apiKey).toBeUndefined();
    expect(after.scopeCollectionId).toBe('coll-file');
    expect(after.scopeCollectionName).toBe('File Lock');
  });

  test('`scope set` refuses and writes nothing', async () => {
    const r = await drive(['scope', 'set', 'coll-b']);

    expect(r.code).toBe(1);
    expect(r.stdout).toContain('FAVRO_SCOPE_COLLECTION_ID');
    expect(r.stdout).toContain('coll-a');
    expect(onDisk()).toEqual({ apiKey: 'k', ...FILE_LOCK });
  });

  test('`scope clear` refuses and writes nothing', async () => {
    const r = await drive(['scope', 'clear']);

    expect(r.code).toBe(1);
    expect(r.stdout).toContain('FAVRO_SCOPE_COLLECTION_ID');
    expect(onDisk()).toEqual({ apiKey: 'k', ...FILE_LOCK });
  });

  test('the opposite polarity: with the var unset, `scope clear` still clears', async () => {
    delete process.env.FAVRO_SCOPE_COLLECTION_ID;

    const r = await drive(['scope', 'clear']);

    expect(r.code).toBeUndefined();
    expect(onDisk()).toEqual({ apiKey: 'k' });
  });
});

// ─── `scope show` names the source, or the two disagree with no explanation ────

describe('scope show names the source of the effective lock', () => {
  test('under the override it reports the env value AND the variable', async () => {
    process.env.FAVRO_SCOPE_COLLECTION_ID = 'coll-a';

    const r = await drive(['--human', 'scope', 'show']);

    expect(r.stdout).toContain('coll-a');
    expect(r.stdout).toContain('FAVRO_SCOPE_COLLECTION_ID');
    expect(r.stdout).not.toContain('File Lock');
  });

  test('the JSON surface carries the source too', async () => {
    process.env.FAVRO_SCOPE_COLLECTION_ID = 'coll-a';

    const r = await drive(['scope', 'show']);

    expect(JSON.parse(r.stdout)).toMatchObject({ scopeCollectionId: 'coll-a', source: 'env' });
  });

  test('with the var unset it names the config file', async () => {
    const r = await drive(['--human', 'scope', 'show']);

    expect(r.stdout).toContain('File Lock');
    expect(r.stdout).toContain('config file');
    expect(r.stdout).not.toContain('FAVRO_SCOPE_COLLECTION_ID');
  });
});
