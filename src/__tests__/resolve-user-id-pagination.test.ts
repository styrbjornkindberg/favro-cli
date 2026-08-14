/**
 * `resolveUserId` reads `/users` to the END — #162 item 7.
 *
 * The defect: it issued ONE `GET /users?limit=100` and matched the caller's
 * email against that page alone. Measured live 2026-08-14, the organization
 * this CLI is developed against answers `{page: 0, pages: 2, limit: 100}` for
 * 135 users and the caller's own account sits at index 112 — so the match
 * failed, `undefined` came back, and every `@me` path refused:
 * `cards claim` (whose default assignee is `@me`), `next`, `my-cards`,
 * `my-standup` and the interactive menu. `--assignee "<name>"` was unaffected,
 * because it resolves through `UsersAPI`, which pages.
 *
 * The seam is the mocked `http-client`, not a socket: `resolveUserId`
 * constructs its OWN client from the config's credentials and there is no
 * `baseURL` seam to point at a stand-in (`client-factory.ts` has none either) —
 * a real-socket arm here would reach favro.com. What matters is reachable
 * anyway, because the pager under test is `getAllPages`, which lives in its own
 * module and survives this mock: the fake below answers exactly what Favro
 * answered, cursor rules included, and the arms assert on the requests it saw.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tempConfigDir } from '../test-support/config-dir';

const EMAIL = 'me@example.com';
const ME = 'pk3qK36WHjnJt5jwr';

const CONFIG_DIR = tempConfigDir('favro-resolve-userid-', {
  apiKey: 'k', email: EMAIL, organizationId: 'org-1',
});
// Left set by the developer's shell these would override the config above and
// point the resolution at a different organization.
delete process.env.FAVRO_API_KEY;
delete process.env.FAVRO_API_TOKEN;
delete process.env.FAVRO_EMAIL;
delete process.env.FAVRO_ORGANIZATION_ID;

/** Every `params` object the pager sent, in order. */
const requests: Array<Record<string, unknown>> = [];

/** 135 users, the caller at index 112 — the measured shape, in miniature. */
const directory = () =>
  Array.from({ length: 135 }, (_, i) => ({
    userId: i === 112 ? ME : `u${i}`,
    name: `User ${i}`,
    email: i === 112 ? EMAIL : `user${i}@example.com`,
  }));

jest.mock('../lib/http-client', () => ({
  __esModule: true,
  default: class FakeClient {
    // Favro clamps a page to 100 and hands the cursor back as `requestId`; the
    // second request carries `page: 1`, which is where the caller's row is.
    async get(url: string, config?: { params?: Record<string, unknown> }) {
      const params = config?.params ?? {};
      requests.push({ url, ...params });
      const page = Number(params.page ?? 0);
      const all = directory();
      return {
        entities: all.slice(page * 100, page * 100 + 100),
        requestId: 'req-1',
        page,
        pages: 2,
        limit: 100,
      };
    }
  },
}));

const readCached = (): string | undefined =>
  JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'config.json'), 'utf-8')).userId;

const writeConfigFile = (config: Record<string, unknown>) =>
  fs.writeFileSync(path.join(CONFIG_DIR, 'config.json'), JSON.stringify(config));

beforeEach(() => {
  requests.length = 0;
  writeConfigFile({ apiKey: 'k', email: EMAIL, organizationId: 'org-1' });
  jest.resetModules();
});

describe('resolveUserId reads past the first page of /users (#162 item 7)', () => {
  it('finds the caller on page 1 and caches the userId', async () => {
    const { resolveUserId } = await import('../lib/config');

    expect(await resolveUserId()).toBe(ME);
    // Two requests, and the second is the one the single-page read never made.
    expect(requests.map(r => [r.url, r.page])).toEqual([['/users', undefined], ['/users', 1]]);
    // The cursor rules `getAllPages` owns: no `page` and no `requestId` on the
    // opening request, both on the next.
    expect(requests[1].requestId).toBe('req-1');
    // Resolved once — the next `@me` on this machine costs no call at all.
    expect(readCached()).toBe(ME);
  });

  it('still finds a caller who is on the FIRST page', async () => {
    // The polarity: a fix that simply always asked for page 1 would pass the arm
    // above and lose everyone the broken version could still find.
    writeConfigFile({ apiKey: 'k', email: `user7@example.com`, organizationId: 'org-1' });
    const { resolveUserId } = await import('../lib/config');

    expect(await resolveUserId()).toBe('u7');
  });

  it('a cached userId still costs no request', async () => {
    writeConfigFile({ apiKey: 'k', email: EMAIL, organizationId: 'org-1', userId: 'cached-one' });
    const { resolveUserId } = await import('../lib/config');

    expect(await resolveUserId()).toBe('cached-one');
    expect(requests).toEqual([]);
  });

  it('answers undefined, without writing, when the email matches nobody', async () => {
    writeConfigFile({ apiKey: 'k', email: 'nobody@example.com', organizationId: 'org-1' });
    const { resolveUserId } = await import('../lib/config');

    expect(await resolveUserId()).toBeUndefined();
    // The whole directory was read before answering — the emptiness is a
    // measurement, not a page boundary.
    expect(requests).toHaveLength(2);
    expect(readCached()).toBeUndefined();
  });
});
