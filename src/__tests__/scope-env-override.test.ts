/**
 * `FAVRO_SCOPE_COLLECTION_ID` must never reach `~/.favro/config.json` — #174,
 * measured against the REAL FILE rather than against an exit code.
 *
 * This is the regression that matters, and it is the one a mocked filesystem
 * cannot settle. The override is merged in `readConfig`, and six writers spread a
 * `readConfig()`-derived object straight into `writeConfig`. The nastiest of them
 * is `resolveUserId`: it fires automatically on `next`, `my-cards`, `my-standup`
 * and every `@me`, with no flag and no prompt. If it persisted the session lock,
 * the per-session override would become the GLOBAL one — the exact bug #174
 * closes, arriving later and harder to see, from a command nobody thought of as a
 * config write.
 *
 * The seam is the mocked `http-client`, for the reason
 * `resolve-user-id-pagination.test.ts` records: `resolveUserId` constructs its
 * OWN client from the config's credentials and there is no `baseURL` seam to
 * point at a stand-in, so a real-socket arm here would reach favro.com. The
 * FILESYSTEM is real, which is the half this suite is about.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tempConfigDir } from '../test-support/config-dir';

const EMAIL = 'me@example.com';
const ME = 'user-me';
const FILE_LOCK = { scopeCollectionId: 'coll-file', scopeCollectionName: 'File Lock' };
const BASE = { apiKey: 'k', email: EMAIL, organizationId: 'org-1' };

const CONFIG_DIR = tempConfigDir('favro-scope-env-', BASE);

// Left set by the developer's shell, these would override the config below.
delete process.env.FAVRO_API_KEY;
delete process.env.FAVRO_API_TOKEN;
delete process.env.FAVRO_EMAIL;
delete process.env.FAVRO_ORGANIZATION_ID;

jest.mock('../lib/http-client', () => ({
  __esModule: true,
  default: class FakeClient {
    async get() {
      return { entities: [{ userId: ME, name: 'Me', email: EMAIL }] };
    }
  },
}));

const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const onDisk = (): Record<string, unknown> => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
const seed = (config: Record<string, unknown>): void =>
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config));

const origScope = process.env.FAVRO_SCOPE_COLLECTION_ID;

beforeEach(() => {
  seed({ ...BASE, ...FILE_LOCK });
  jest.resetModules();
});

afterEach(() => {
  if (origScope === undefined) delete process.env.FAVRO_SCOPE_COLLECTION_ID;
  else process.env.FAVRO_SCOPE_COLLECTION_ID = origScope;
});

describe('the session lock does not reach disk (#174)', () => {
  it("resolveUserId caches the userId and leaves the file's OWN lock alone", async () => {
    process.env.FAVRO_SCOPE_COLLECTION_ID = 'coll-env';
    const { resolveUserId } = await import('../lib/config');

    expect(await resolveUserId()).toBe(ME);

    const after = onDisk();
    // The write it was actually for landed…
    expect(after.userId).toBe(ME);
    // …and the lock on disk is still the FILE's, not this shell's.
    expect(after.scopeCollectionId).toBe('coll-file');
    expect(after.scopeCollectionName).toBe('File Lock');
  });

  it('an unlocked file stays unlocked — the key is absent, not blanked', async () => {
    seed({ ...BASE });
    process.env.FAVRO_SCOPE_COLLECTION_ID = 'coll-env';
    const { resolveUserId } = await import('../lib/config');

    expect(await resolveUserId()).toBe(ME);

    const after = onDisk();
    expect(after.userId).toBe(ME);
    expect('scopeCollectionId' in after).toBe(false);
    expect('scopeCollectionName' in after).toBe(false);
  });

  it('the OPPOSITE polarity: with the var unset, a write persists normally', async () => {
    // Without this arm "nothing was written" is unfalsifiable — a guard that
    // suppressed the lock unconditionally would pass every arm above.
    seed({ ...BASE });
    const { readConfig, writeConfig } = await import('../lib/config');
    await writeConfig({ ...(await readConfig()), scopeCollectionId: 'coll-new', scopeCollectionName: 'New' });

    expect(onDisk()).toMatchObject({ scopeCollectionId: 'coll-new', scopeCollectionName: 'New' });
  });

  it('the override is what every reader sees, while the file keeps its own', async () => {
    process.env.FAVRO_SCOPE_COLLECTION_ID = 'coll-env';
    const { readConfig } = await import('../lib/config');

    const config = await readConfig();
    expect(config.scopeCollectionId).toBe('coll-env');
    // The cached name is the FILE collection's; carrying it forward would make
    // every refusal name the wrong collection.
    expect(config.scopeCollectionName).toBeUndefined();
    expect(onDisk().scopeCollectionId).toBe('coll-file');
  });

  it('an EMPTY override refuses instead of falling back to the file lock', async () => {
    process.env.FAVRO_SCOPE_COLLECTION_ID = '   ';
    const { readConfig } = await import('../lib/config');

    await expect(readConfig()).rejects.toThrow('FAVRO_SCOPE_COLLECTION_ID is set but empty');
  });
});
