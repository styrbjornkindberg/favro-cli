/**
 * Wire-level tests for `tags get`, `users get` and assignee resolution — #42.
 *
 * Same discipline as the other wire suites: no client mock. A real `node:http`
 * server stands in for Favro, so the assertions are about what Favro receives
 * and what the caller observes — never about how we got there.
 *
 * Fixtures are pinned to the measured shapes in the live org:
 *
 * - `tagId` has TWO shapes side by side — hex-24 (27 of them) and base62-17
 *   (222). A hex-24-only classifier would read 11% of tagIds as names.
 * - `userId` is NEVER hex-24 — 135/135 are base62-17.
 * - Every one of the 135 user names contains a space, and the longest pure-alnum
 *   single-token tag name is 14 chars, so shape detection (not escalate-on-404)
 *   is what separates an id from a name.
 *
 * The client is built without an organizationId, so the persistent name cache is
 * inert here and every lookup is visible on the wire.
 */
import * as http from 'http';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import TagsAPI, { TagLookupError, isTagId } from '../lib/tags-api';
import UsersAPI, { UserLookupError, detectUserKey, isUserId } from '../lib/users-api';
import { resolveAssignee, resolveAssignees, AssigneeError } from '../lib/assignee';

interface Received {
  method: string;
  url: string;
}

const TAG_HEX = '0b49b86eba332b1b342f844c';
const TAG_B62 = '4HGKcSnW2xuXvnQqN';
const TAG_DUP_A = '1a2b3c4d5e6f7a8b9c0d1e2f';
const TAG_DUP_B = 'Zq8LmNp3RtVw5Xy7K';

const JAN = 'aB3dE5gH7jK9mN1pQ';
const JAN_TWIN = 'zY8xW6vU4tS2rQ0oP';
const ULF = 'mM4nN6bB8vV0cC2xZ';

const TAGS = [
  { tagId: TAG_HEX, name: 'Bug' },
  { tagId: TAG_B62, name: 'wayfinder:map' },
  { tagId: TAG_DUP_A, name: 'Release' },
  { tagId: TAG_DUP_B, name: 'release' },
];

const USERS = [
  { userId: JAN, name: 'Jan Book', email: 'jan@example.com', organizationRole: 'administrator' },
  { userId: JAN_TWIN, name: 'Jan Book', email: 'jan.book@example.com' },
  { userId: ULF, name: 'Ulf Anderson', email: 'ulf@example.com' },
];

/** A fake Favro that records what it was asked. */
function startServer(): Promise<{
  client: FavroHttpClient;
  received: Received[];
  close: () => Promise<void>;
}> {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      received.push({ method: req.method ?? '', url: req.url ?? '' });
      const entities = req.url?.startsWith('/api/v1/tags')
        ? TAGS
        : req.url?.startsWith('/api/v1/users')
          ? USERS
          : undefined;
      if (!entities) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Page not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entities }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        client: new FavroHttpClient({ baseURL: `http://127.0.0.1:${port}/api/v1` }),
        received,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

describe('shape detection', () => {
  it('reads both measured tagId shapes as ids', () => {
    expect(isTagId(TAG_HEX)).toBe(true);
    expect(isTagId(TAG_B62)).toBe(true);
  });

  it('reads tag names as names', () => {
    // The longest pure-alnum single-token tag name measured is 14 chars.
    expect(isTagId('wayfinder:map')).toBe(false);
    expect(isTagId('Bug')).toBe(false);
    expect(isTagId('documentation')).toBe(false);
  });

  it('never reads a hex-24 string as a userId', () => {
    expect(isUserId(TAG_HEX)).toBe(false);
    expect(isUserId(JAN)).toBe(true);
  });

  it('splits the three user keys on shape', () => {
    expect(detectUserKey('jan@example.com')).toBe('email');
    expect(detectUserKey(JAN)).toBe('userId');
    expect(detectUserKey('Jan Book')).toBe('name');
  });
});

describe('tags get', () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;
  beforeEach(async () => { ctx = await startServer(); });
  afterEach(async () => { await ctx.close(); });

  it('returns one tag by name', async () => {
    const tag = await new TagsAPI(ctx.client).getTag('wayfinder:map');
    expect(tag).toEqual({ tagId: TAG_B62, name: 'wayfinder:map' });
  });

  it('matches a name case-insensitively and trimmed', async () => {
    const tag = await new TagsAPI(ctx.client).getTag('  BUG  ');
    expect(tag.tagId).toBe(TAG_HEX);
  });

  it('returns one tag by a base62-17 tagId', async () => {
    const tag = await new TagsAPI(ctx.client).getTag(TAG_B62);
    expect(tag.name).toBe('wayfinder:map');
  });

  it('returns one tag by a hex-24 tagId', async () => {
    const tag = await new TagsAPI(ctx.client).getTag(TAG_HEX);
    expect(tag.name).toBe('Bug');
  });

  it('refuses an ambiguous name with every colliding tagId and a write-by-name instruction', async () => {
    expect.assertions(5);
    try {
      await new TagsAPI(ctx.client).getTag('Release');
    } catch (error) {
      const e = error as TagLookupError;
      expect(e).toBeInstanceOf(TagLookupError);
      expect(e.kind).toBe('ambiguous');
      expect(e.candidates.map((t) => t.tagId).sort()).toEqual([TAG_DUP_A, TAG_DUP_B].sort());
      expect(e.message).toContain(TAG_DUP_A);
      expect(e.message).toContain('--tags');
    }
  });

  it('refuses an unknown name without saying "not found"', async () => {
    await expect(new TagsAPI(ctx.client).getTag('nope')).rejects.toThrow(
      /missing or not visible to your key/
    );
  });

  it('refuses an unknown but shape-valid tagId', async () => {
    await expect(new TagsAPI(ctx.client).getTag('ffffffffffffffffffffffff')).rejects.toThrow(
      TagLookupError
    );
  });

  it('reads the tag list once, not per lookup attempt', async () => {
    await new TagsAPI(ctx.client).getTag('Bug');
    expect(ctx.received).toHaveLength(1);
    expect(ctx.received[0].method).toBe('GET');
    expect(ctx.received[0].url).toMatch(/^\/api\/v1\/tags/);
  });
});

describe('users get', () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;
  beforeEach(async () => { ctx = await startServer(); });
  afterEach(async () => { await ctx.close(); });

  it('resolves by email', async () => {
    const user = await new UsersAPI(ctx.client).getUser('ulf@example.com');
    expect(user.userId).toBe(ULF);
  });

  it('resolves by userId', async () => {
    const user = await new UsersAPI(ctx.client).getUser(ULF);
    expect(user.name).toBe('Ulf Anderson');
  });

  it('resolves by name', async () => {
    const user = await new UsersAPI(ctx.client).getUser('ulf anderson');
    expect(user.userId).toBe(ULF);
  });

  it('refuses an unknown userId instead of answering about nobody', async () => {
    expect.assertions(2);
    try {
      await new UsersAPI(ctx.client).getUser('aaaaaaaaaaaaaaaaa');
    } catch (error) {
      const e = error as UserLookupError;
      expect(e.kind).toBe('unknown');
      expect(e.key).toBe('userId');
    }
  });

  it('refuses a colliding name with userId and email for each collision', async () => {
    expect.assertions(3);
    try {
      await new UsersAPI(ctx.client).getUser('Jan Book');
    } catch (error) {
      const e = error as UserLookupError;
      expect(e.kind).toBe('ambiguous');
      expect(e.candidates.map((u) => u.userId)).toEqual([JAN, JAN_TWIN]);
      expect(e.message).toContain('jan.book@example.com');
    }
  });
});

describe('assignee resolution', () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;
  beforeEach(async () => { ctx = await startServer(); });
  afterEach(async () => { await ctx.close(); });

  it('resolves all three keys to the same userId', async () => {
    expect(await resolveAssignee(ctx.client, 'Ulf Anderson')).toBe(ULF);
    expect(await resolveAssignee(ctx.client, 'ulf@example.com')).toBe(ULF);
    expect(await resolveAssignee(ctx.client, ULF)).toBe(ULF);
  });

  it('refuses an unknown assignee with the value and a reachable next step, and no candidate list', async () => {
    expect.assertions(5);
    try {
      await resolveAssignee(ctx.client, 'Nobody Here');
    } catch (error) {
      const e = error as AssigneeError;
      expect(e).toBeInstanceOf(AssigneeError);
      expect(e.kind).toBe('unknown');
      expect(e.message).toContain('Nobody Here');
      expect(e.message).toContain('favro users list');
      // 135 users, every name holding a space — listing them would rebuild the
      // 16 KB read this replaces.
      expect(e.message).not.toContain('Ulf Anderson');
    }
  });

  it('refuses an unknown assignee id rather than silently matching nobody', async () => {
    await expect(resolveAssignee(ctx.client, 'aaaaaaaaaaaaaaaaa')).rejects.toBeInstanceOf(
      AssigneeError
    );
  });

  it('refuses an ambiguous assignee listing only the collided entries, with userId and email', async () => {
    expect.assertions(4);
    try {
      await resolveAssignee(ctx.client, 'Jan Book');
    } catch (error) {
      const e = error as AssigneeError;
      expect(e.kind).toBe('ambiguous');
      expect(e.candidates.map((u) => u.userId)).toEqual([JAN, JAN_TWIN]);
      expect(e.message).toContain(`${JAN}  Jan Book  <jan@example.com>`);
      expect(e.message).not.toContain('Ulf Anderson');
    }
  });

  it('resolves a list in order and refuses on the first bad value', async () => {
    expect(await resolveAssignees(ctx.client, ['Ulf Anderson', 'jan@example.com'])).toEqual([
      ULF,
      JAN,
    ]);
    await expect(resolveAssignees(ctx.client, ['Ulf Anderson', 'Nobody'])).rejects.toBeInstanceOf(
      AssigneeError
    );
  });
});
