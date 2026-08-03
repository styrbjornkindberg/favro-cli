/**
 * Containment for ORG-LEVEL writes, against a real server (#125).
 *
 * Nine writes in this CLI land on no board — `tags`, `groups`, `webhooks`,
 * `collections create` — so the collection scope lock structurally cannot
 * govern them (#104, and `scope-lock-coverage.test.ts` records that decision).
 * The three org-level DELETES are the blast radius that decision left open:
 * `tags delete` strips the tag from every card in the organization.
 *
 * Two holes, two guards, and both are asserted against a real socket rather
 * than a mock, because a queued mock answers whatever it was handed next — a
 * containment test built on one passes whether or not the request was
 * contained. This file starts an HTTP server and asks which URLs arrived.
 *
 *   1. UNBOUNDED TARGET. Every single-resource write is `/<resource>/${id}`.
 *      An empty id does not make a malformed request, it makes a valid one
 *      against the COLLECTION — `deleteTag('')` sends `DELETE /tags/`. That is
 *      #138's shape (an empty filter reading as "everything" instead of
 *      "nothing"), and `favro tags delete "$TAG" --yes` with `TAG` unset is the
 *      way in. `http-client` refuses before the wire.
 *
 *   2. ORG-WIDE DESTRUCTIVE WRITE UNDER A LOCK. A configured scope lock is the
 *      user saying "my writes stay in this collection". An org-wide delete
 *      provably does not, so it refuses unless `--force` — the same escape
 *      hatch `assertScope` has. With no lock configured: no refusal and no
 *      extra request, which #102/#104 both make a criterion.
 *
 * The assertions are on `served` — what reached the server — not on a return
 * value, so "refused" and "wrote, then threw" cannot be confused.
 */
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import { Command } from 'commander';

import FavroHttpClient from '../lib/http-client';
import { RefusalError } from '../lib/refusal';
import { ScopeError, assertOrgScope } from '../lib/safety';
import TagsAPI from '../lib/tags-api';
import UsersAPI from '../lib/users-api';

// The command layer runs for real; only WHERE THE CLIENT COMES FROM is swapped,
// so the guard, the config read and the API modules are all the live ones.
jest.mock('../lib/client-factory');
import { createFavroClient } from '../lib/client-factory';

/** Every request that reached the server, in order. */
interface Served {
  method: string;
  path: string;
}

const running: http.Server[] = [];
const tmpDirs: string[] = [];

/** A Favro stand-in that records what it is asked and answers blandly. */
async function startStand(): Promise<{ client: FavroHttpClient; served: Served[] }> {
  const served: Served[] = [];
  const server = http.createServer((req, res) => {
    served.push({ method: req.method ?? '', path: (req.url ?? '').split('?')[0] });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // Enough of a body for every path here: a tag, a group, or nothing at all.
    res.end(JSON.stringify({ tagId: 'tag-1', userGroupId: 'grp-1', name: 'served', entities: [] }));
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

/** A config dir holding exactly `config`, and the client every command will get. */
async function standWithConfig(config: Record<string, unknown>): Promise<{ served: Served[] }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favro-org-scope-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  process.env.FAVRO_CONFIG_DIR = dir;
  const { client, served } = await startStand();
  (createFavroClient as jest.Mock).mockResolvedValue(client);
  return { served };
}

/** The real command tree, silenced, driven once. */
async function runCli(args: string[]): Promise<void> {
  const { registerTagsCommands } = await import('../commands/tags');
  const { registerUsersCommands } = await import('../commands/users');
  const { registerWebhooksCommand } = await import('../commands/webhooks');
  const program = new Command();
  program.exitOverride();
  program.option('--verbose', 'Show stack traces');
  registerTagsCommands(program);
  registerUsersCommands(program);
  registerWebhooksCommand(program);
  // A refusal reaches the boundary as an exit or a throw depending on the
  // command's era (`tags`/`groups` predate `run()`, `webhooks` does not). Both
  // are legitimate; what this file asserts is the absence of the request.
  await program.parseAsync(['node', 'favro', ...args]).catch(() => undefined);
}

const originalConfigDir = process.env.FAVRO_CONFIG_DIR;

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.FAVRO_CONFIG_DIR;
  else process.env.FAVRO_CONFIG_DIR = originalConfigDir;
  jest.restoreAllMocks();
});

afterAll(async () => {
  await Promise.all(running.map((s) => new Promise<void>((r) => s.close(() => r()))));
  tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

// ─── hole one: an empty id names the collection ───────────────────────────────

describe('a write whose target has an empty path segment never reaches the wire', () => {
  it('refuses DELETE /tags/ — the whole tag collection — and sends nothing', async () => {
    const { client, served } = await startStand();

    await expect(new TagsAPI(client).deleteTag('')).rejects.toThrow(RefusalError);

    // The assertion that matters is not "it threw" but "the organization's tag
    // collection was never addressed". A guard that threw after the request
    // would pass the line above and fail this one.
    expect(served).toEqual([]);
  });

  it('refuses the same widening on PUT, PATCH, POST and a nested path', async () => {
    const { client, served } = await startStand();

    await expect(new TagsAPI(client).updateTag('', { name: 'x' })).rejects.toThrow(RefusalError);
    await expect(new UsersAPI(client).deleteGroup('')).rejects.toThrow(RefusalError);
    // `/cards/${cardId}/dependencies` is a legitimate collection-level delete;
    // with an empty cardId it becomes `/cards//dependencies`, which is not.
    await expect(client.delete('/cards//dependencies')).rejects.toThrow(RefusalError);
    await expect(client.post('/collections//boards/b-1', {})).rejects.toThrow(RefusalError);
    // PATCH has no production caller today, which is exactly why it is asserted:
    // the guard's claim is "one chokepoint, not fourteen", and an unpinned verb
    // is how the fifteenth module gets to forget. Unguarding `patch` alone
    // otherwise passed the whole suite.
    await expect(client.patch('/collections//x', {})).rejects.toThrow(RefusalError);

    expect(served).toEqual([]);
  });

  it('refuses an id that URL RESOLUTION turns into a wider or different target', async () => {
    // The template string is not the string that gets sent. Measured against
    // this stand with the guard checking the raw path: `/tags/.` and `/tags/ `
    // both left as `DELETE /tags/`, and `/tags/../boards/b-1` left as
    // `DELETE /boards/b-1` — a tag delete arriving as a BOARD delete, which the
    // scope lock never saw because no board was ever resolved.
    const { client, served } = await startStand();

    await expect(new TagsAPI(client).deleteTag('.')).rejects.toThrow(RefusalError);
    await expect(new TagsAPI(client).deleteTag(' ')).rejects.toThrow(RefusalError);
    await expect(new TagsAPI(client).deleteTag('../boards/b-1')).rejects.toThrow(RefusalError);
    await expect(new UsersAPI(client).deleteGroup('..')).rejects.toThrow(RefusalError);

    expect(served).toEqual([]);
  });

  it('still lets a bounded write through — the guard is not always-refuse', async () => {
    const { client, served } = await startStand();

    await new TagsAPI(client).deleteTag('tag-1');
    await new TagsAPI(client).createTag('Bug');
    // The one collection-level delete in the codebase, with a real card id.
    await client.delete('/cards/card-1/dependencies');

    expect(served).toEqual([
      { method: 'DELETE', path: '/tags/tag-1' },
      { method: 'POST', path: '/tags' },
      { method: 'DELETE', path: '/cards/card-1/dependencies' },
    ]);
  });

  it('does not touch READS — a trailing slash on a GET is a list, and widening a read is free', async () => {
    const { client, served } = await startStand();

    await client.get('/tags/');

    expect(served).toEqual([{ method: 'GET', path: '/tags/' }]);
  });
});

// ─── hole two: an org-wide delete under a collection lock ─────────────────────

const LOCKED = { scopeCollectionId: 'col-locked', scopeCollectionName: 'My Project' };

/**
 * All three org-level deletes, each asserted BOTH ways in the same test.
 *
 * The locked arm alone would be vacuously green if the command never ran at all
 * — a typo in the argv, a registration that threw, a `.catch()` swallowing it.
 * Pairing it with the unlocked arm, which demands the exact DELETE arrive, makes
 * that impossible: the pair can only pass if the command runs and the guard is
 * what stops it.
 */
describe('an org-wide destructive write refuses while a collection lock is set', () => {
  it.each([
    ['tags delete', ['tags', 'delete', 'tag-1', '--yes'], '/tags/tag-1'],
    ['groups delete', ['groups', 'delete', 'grp-1', '--yes'], '/usergroups/grp-1'],
    ['webhooks delete', ['webhooks', 'delete', 'hook-1', '--yes'], '/webhooks/hook-1'],
  ])('refuses `%s` under a lock and performs it without one', async (_name, args, expected) => {
    const locked = await standWithConfig(LOCKED);
    await runCli(args as string[]);
    expect(locked.served.filter((s) => s.method === 'DELETE')).toEqual([]);

    const unlocked = await standWithConfig({});
    await runCli(args as string[]);
    expect(unlocked.served.filter((s) => s.method === 'DELETE')).toEqual([
      { method: 'DELETE', path: expected },
    ]);
  });

  it('refuses an EMPTY id through the CLI even with no lock — the #138 shape, end to end', async () => {
    // The actual attack path, not a unit of it: `favro tags delete "$TAG" --yes`
    // with TAG unset, and nothing locked so the org guard is a no-op. The scope
    // of this delete cannot be established, so it must refuse — never widen to
    // the whole tag collection.
    const { served } = await standWithConfig({});

    await runCli(['tags', 'delete', '', '--yes']);

    expect(served).toEqual([]);
  });

  it('costs an unlocked user no extra request — the guard reads config, never the API', async () => {
    const { served } = await standWithConfig({});

    await runCli(['tags', 'delete', 'tag-1', '--yes']);

    // Exactly one request in total, the delete itself: the #102/#104 criterion.
    expect(served).toEqual([{ method: 'DELETE', path: '/tags/tag-1' }]);
  });

  it('lets --force through under a lock, and warns rather than going quiet', async () => {
    const { served } = await standWithConfig(LOCKED);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await runCli(['tags', 'delete', 'tag-1', '--yes', '--force']);

    expect(served).toEqual([{ method: 'DELETE', path: '/tags/tag-1' }]);
    expect(warn).toHaveBeenCalled();
  });

  it('refuses the preview too — --dry-run is not a way past the lock', async () => {
    // `served` alone cannot test this: a preview makes no request either way, so
    // the empty-stand assertion passes whether the guard ran before the preview,
    // after it, or not at all — measured, by stripping the guard and watching
    // this test stay green. What distinguishes the orderings is the OUTPUT: a
    // refusal, or a "would delete" line. Assert on that.
    const { served } = await standWithConfig(LOCKED);
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    await runCli(['tags', 'delete', 'tag-1', '--dry-run']);

    expect(served).toEqual([]);
    const said = [...log.mock.calls, ...error.mock.calls].flat().join('\n');
    expect(said).toContain('ORGANIZATION-WIDE');
    expect(said).not.toContain('Would delete');
  });
});

// ─── the guard itself ────────────────────────────────────────────────────────

describe('assertOrgScope', () => {
  /** Config without a stand — this guard never makes a request. */
  function config(values: Record<string, unknown>): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favro-org-scope-'));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(values));
    process.env.FAVRO_CONFIG_DIR = dir;
  }

  it('is a RefusalError, so an agent is not told to retry a policy decline', async () => {
    config(LOCKED);

    const error = await assertOrgScope('Deleting tag tag-1').catch((e) => e);

    expect(error).toBeInstanceOf(RefusalError);
    expect(error).toBeInstanceOf(ScopeError);
    // ADR-0002: a refusal says WHAT it refused and WHY, and names the way out.
    expect(error.message).toContain('tag-1');
    expect(error.message).toContain('My Project');
    expect(error.message).toContain('--force');
  });

  it('is a no-op when nothing is locked', async () => {
    config({});

    await expect(assertOrgScope('Deleting tag tag-1')).resolves.toBeUndefined();
  });

  it('reads the LOCK, not the target — a lock on any collection still refuses', async () => {
    // The wrong-scope mutation: a guard comparing a target collection to the
    // lock would pass here, because an org-wide write has no collection to
    // compare. What makes it refuse is the PRESENCE of a lock.
    config({ scopeCollectionId: 'col-anything-at-all' });

    const error = await assertOrgScope('Deleting group grp-1').catch((e) => e);

    expect(error).toBeInstanceOf(ScopeError);
    // And it NAMES the lock even with no cached name, the way `scope show` does.
    // Dropping the `?? scopeCollectionId` fallback otherwise passed everything
    // and shipped a refusal reading `locked collection ("undefined")`.
    expect(error.message).toContain('col-anything-at-all');
    expect(error.message).not.toContain('undefined');
  });
});
