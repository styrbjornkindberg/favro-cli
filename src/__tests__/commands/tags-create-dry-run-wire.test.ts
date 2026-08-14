/**
 * `tags create --dry-run` resolves the name before it previews (#163).
 *
 * The dry-run branch used to return before the client existed, so it could not
 * ask whether the name was taken and printed `Would create` for a tag that was
 * already there. A live run read that as "this does not exist yet" and drew a
 * conclusion from it. A preview that cannot answer the one question it is asked
 * is worse than no preview.
 *
 * WIRE, not a mocked `TagsAPI`: what is under test is that the RESOLUTION
 * happens, and a mocked `getTag` would prove only that a mock was called. Here
 * `GET /tags` is served for real, `getTag` folds the name for real, and the two
 * arms are polarity opposites over the SAME stand — an existing name and an
 * absent one — so neither can pass by printing nothing.
 *
 * No write is exercised anywhere in this file: a tag is org-wide, and the whole
 * point of the fix is that the preview stays a read.
 */
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import { Command } from 'commander';

import FavroHttpClient from '../../lib/http-client';

jest.mock('../../lib/client-factory');
import { createFavroClient } from '../../lib/client-factory';

import { registerTagsCommands } from '../../commands/tags';

/** The org's tags, as `GET /tags` sends them. */
const TAGS = [
  { tagId: 'ZLAszhmCsDpuNGG66', name: 'wayfinder:map' },
  { tagId: 'aaaaaaaaaaaaaaaaa', name: 'bug' },
];

const running: http.Server[] = [];
const tmpDirs: string[] = [];
/** Every path the stand was asked for — a POST here would be the failure. */
let served: Array<{ method: string; path: string }> = [];

async function stand(): Promise<void> {
  served = [];
  const server = http.createServer((req, res) => {
    served.push({ method: req.method ?? '', path: (req.url ?? '').split('?')[0] });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ entities: TAGS }));
  });
  running.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  (createFavroClient as jest.Mock).mockResolvedValue(
    new FavroHttpClient({ baseURL, auth: { token: 't', email: 'e@x', organizationId: 'org-1' } }),
  );

  // Own config dir, so the name cache this resolution writes is the test's own
  // file and not the developer's.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favro-tags-dryrun-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({}));
  process.env.FAVRO_CONFIG_DIR = dir;
}

async function drive(args: string[]): Promise<{ code: number | undefined; stdout: string }> {
  process.exitCode = undefined;
  const out: string[] = [];
  (console.log as unknown as jest.Mock).mockImplementation(
    (...a: unknown[]) => void out.push(a.map(String).join(' ')),
  );

  const program = new Command();
  program.exitOverride();
  program.option('--verbose', 'Show stack traces').option('--human').option('--pretty');
  registerTagsCommands(program);
  await program.parseAsync(['node', 'favro', ...args]);

  return { code: process.exitCode, stdout: out.join('\n') };
}

const originalConfigDir = process.env.FAVRO_CONFIG_DIR;

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
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

describe('favro tags create --dry-run', () => {
  it('names the existing tag and its id instead of promising a create', async () => {
    await stand();

    const { code, stdout } = await drive(['tags', 'create', '--name', 'wayfinder:map', '--dry-run']);

    expect(code).toBeUndefined();
    expect(stdout).toContain('already exists');
    expect(stdout).toContain('ZLAszhmCsDpuNGG66');
    // The polarity that matters: the wrong answer is a preview promising a
    // create, and asserting only the presence of the new line would pass with
    // both lines printed.
    expect(stdout).not.toContain('Would creating');
    expect(served.some((r) => r.method === 'POST')).toBe(false);
  });

  it('still previews the create for a name the org does not carry', async () => {
    await stand();

    const { code, stdout } = await drive(['tags', 'create', '--name', 'wayfinder:absent', '--dry-run']);

    expect(code).toBeUndefined();
    expect(stdout).toContain('Would creating tag');
    expect(stdout).toContain('wayfinder:absent');
    expect(stdout).not.toContain('already exists');
    expect(served.some((r) => r.method === 'POST')).toBe(false);
  });
});
