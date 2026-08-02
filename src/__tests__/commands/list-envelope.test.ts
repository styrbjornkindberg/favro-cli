/**
 * The envelope, asserted by running the commands — the behavioural half of #99.
 *
 * `list-envelope-coverage.test.ts` proves statically that no command puts a
 * bare array on stdout. That is a proof about source text; it cannot tell you
 * that what actually reaches stdout parses as `{rows}`, that `--limit` marks
 * the cut, or — the defect this ticket is really about — that the cap did not
 * quietly move back down into the fetch.
 *
 * So this file drives a representative set end to end and asserts all three,
 * uniformly, off one table. The set is chosen for the SHAPES it covers, not for
 * breadth:
 *
 *   - a plain board-scoped read (`columns list`)
 *   - a plain org-scoped read (`users list`, `members list`)
 *   - a card-scoped read (`tasks list`)
 *   - a read that was already enveloped but had no cap, so `truncated` was
 *     unreachable (`tags list`)
 *   - the `--format json` spelling rather than `--json` (`webhooks list`)
 *   - a read whose cap used to live inside the API client (`activity`)
 *   - a read that FILTERS before it caps, where the order matters
 *     (`cards blocked-by`)
 *
 * The third assertion is the load-bearing one. `--limit` truncating the fetch
 * is what #44 fixed for `cards list`, what #91 found nine more of, and what
 * #136 removed from `listComments`; "the client was called with no cap" is the
 * only assertion that stays true when someone re-adds one.
 */
import { Command } from 'commander';

import { registerColumnsCommands } from '../../commands/columns';
import { registerUsersCommands } from '../../commands/users';
import { registerTasksCommands } from '../../commands/tasks';
import { registerTagsCommands } from '../../commands/tags';
import { registerWebhooksCommand } from '../../commands/webhooks';
import { registerActivityCommand } from '../../commands/activity';
import { registerCardsLinkCommands } from '../../commands/cards-link';
import { registerMembersCommand } from '../../commands/members';

import * as config from '../../lib/config';
import ColumnsAPI from '../../lib/columns-api';
import UsersAPI from '../../lib/users-api';
import TasksAPI from '../../lib/tasks-api';
import TagsAPI from '../../lib/tags-api';
import CardsAPI from '../../lib/cards-api';
import { FavroWebhooksAPI } from '../../api/webhooks';
import ActivityApiClient from '../../api/activity';
import { FavroApiClient } from '../../api/members';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../lib/columns-api');
jest.mock('../../lib/users-api');
jest.mock('../../lib/tasks-api');
jest.mock('../../lib/tags-api');
jest.mock('../../lib/cards-api');
jest.mock('../../api/webhooks');
jest.mock('../../api/activity');
jest.mock('../../api/members');

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

/** Three rows, so a `--limit 2` is a real cut with a row left over. */
const THREE = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

/**
 * One list read: how to stub its client, how to invoke it, and how it spells
 * "give me JSON". The stub is installed per test rather than in `beforeEach`
 * so each row owns exactly the mock it asserts on.
 */
interface ListRead {
  name: string;
  /** Returns the jest.fn the command's read goes through. */
  stub: (rows: unknown[]) => jest.Mock;
  register: (program: Command) => void;
  argv: string[];
  json: string[];
}

const proto = <T>(cls: { prototype: T }, method: keyof T) => (rows: unknown[]): jest.Mock => {
  const fn = jest.fn().mockResolvedValue(rows);
  (cls.prototype as Record<string, unknown>)[method as string] = fn;
  return fn;
};

const READS: ListRead[] = [
  {
    name: 'columns list',
    stub: proto(ColumnsAPI, 'listColumns'),
    register: registerColumnsCommands,
    argv: ['columns', 'list', 'board-1'],
    json: ['--json'],
  },
  {
    name: 'users list',
    stub: proto(UsersAPI, 'listUsers'),
    register: registerUsersCommands,
    argv: ['users', 'list'],
    json: ['--json'],
  },
  {
    name: 'tasks list',
    stub: proto(TasksAPI, 'listTasks'),
    register: registerTasksCommands,
    argv: ['tasks', 'list', 'card-1'],
    json: ['--json'],
  },
  {
    name: 'tags list',
    stub: proto(TagsAPI, 'listTags'),
    register: registerTagsCommands,
    argv: ['tags', 'list'],
    json: ['--json'],
  },
  {
    name: 'webhooks list',
    stub: proto(FavroWebhooksAPI, 'list'),
    register: registerWebhooksCommand,
    argv: ['webhooks', 'list'],
    json: ['--format', 'json'],
  },
  {
    name: 'activity',
    stub: proto(ActivityApiClient, 'getCardActivity'),
    register: registerActivityCommand,
    argv: ['activity', 'card-1'],
    json: ['--json'],
  },
  {
    name: 'members list',
    stub: proto(FavroApiClient, 'getMembers'),
    register: registerMembersCommand,
    argv: ['members', 'list'],
    json: ['--json'],
  },
  {
    name: 'cards blocked-by',
    // Every edge has `isBefore`, so the command's filter keeps all three and
    // the cap is what cuts — which is the order this asserts.
    stub: (rows) => {
      const fn = jest.fn().mockResolvedValue(rows.map((r) => ({ ...(r as object), isBefore: true })));
      CardsAPI.prototype.getCardLinks = fn;
      return fn;
    },
    register: (program) => registerCardsLinkCommands(program.command('cards')),
    argv: ['cards', 'blocked-by', 'card-1'],
    json: ['--json'],
  },
];

let logSpy: jest.SpyInstance;

async function runCli(read: ListRead, extra: string[]): Promise<void> {
  const program = new Command();
  program.option('--verbose', 'Show stack traces');
  read.register(program);
  program.exitOverride();
  await program.parseAsync(['node', 'favro', ...read.argv, ...extra]).catch((e) => {
    if (!(e instanceof ExitCalled)) throw e;
  });
}

/** The one JSON line a list read writes. Compact, so it starts with `{`. */
const envelope = (): { rows: unknown[]; truncated?: true } =>
  JSON.parse(logSpy.mock.calls.map((c) => String(c[0])).find((c) => c.startsWith('{"rows"'))!);

beforeEach(() => {
  jest.clearAllMocks();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'table').mockImplementation(() => {});
  jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitCalled(code ?? 0);
  }) as never);

  (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
  (config.readConfig as jest.Mock).mockResolvedValue({ scopeCollectionId: 'coll-1' });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe.each(READS.map((r) => [r.name, r] as const))('%s', (_name, read) => {
  it('emits an envelope, never a bare array', async () => {
    read.stub(THREE);

    await runCli(read, read.json);

    const parsed = envelope();
    expect(Array.isArray(parsed)).toBe(false);
    expect(parsed.rows).toHaveLength(3);
    // Absent, not `false`: an empty `rows` with no marker means true-empty, and
    // a marker that is always present would make every reader test its value.
    expect(parsed.truncated).toBeUndefined();
  });

  it('is still an envelope when there is nothing to list', async () => {
    // The arm an agent exercises least and needs most — a read that answers
    // "nothing" must not answer it in a different shape.
    read.stub([]);

    await runCli(read, read.json);

    expect(envelope()).toEqual({ rows: [] });
  });

  it('--limit caps the rows and says so', async () => {
    read.stub(THREE);

    await runCli(read, [...read.json, '--limit', '2']);

    expect(envelope()).toMatchObject({ truncated: true });
    expect(envelope().rows).toHaveLength(2);
  });

  it('--limit never reaches the read — the fetch runs to completion', async () => {
    // The whole point of capping at the command layer. A cap pushed down into
    // the client makes every count and every filter downstream answer a
    // plausible wrong number, silently (#44, #91, #136).
    //
    // Asserted as "the same call, capped or not" rather than by hunting the
    // number in the arguments: that stays true whatever a command's other
    // arguments happen to contain, and it fails the moment `--limit` starts
    // changing the request.
    const capped = read.stub(THREE);
    await runCli(read, [...read.json, '--limit', '2']);

    const uncapped = read.stub(THREE);
    await runCli(read, read.json);

    expect(capped).toHaveBeenCalledTimes(1);
    expect(capped.mock.calls[0]).toEqual(uncapped.mock.calls[0]);
  });

  it('an unparseable --limit is no cap, never an empty list', async () => {
    // `parseInt('banana')` is NaN, and `NaN < 1` is false — the guard used to
    // fall through to `slice(0, NaN)` and answer zero rows marked `truncated`.
    read.stub(THREE);

    await runCli(read, [...read.json, '--limit', 'banana']);

    expect(envelope().rows).toHaveLength(THREE.length);
    expect(envelope().truncated).toBeUndefined();
  });
});
