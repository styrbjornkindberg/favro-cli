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
 *   - a read migrated onto the command runner, where JSON is the DEFAULT and
 *     there is no output flag to pass at all (`webhooks list`, `members list`,
 *     `activity` — #116)
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
    // No flag: `--format json` left with #116's migration and JSON is the
    // default now (ADR-0002).
    json: [],
  },
  {
    name: 'activity',
    stub: proto(ActivityApiClient, 'getCardActivity'),
    register: registerActivityCommand,
    argv: ['activity', 'card-1'],
    // `--format`/`--json` left with #116's migration; JSON is the default.
    json: [],
  },
  {
    name: 'members list',
    stub: proto(FavroApiClient, 'getMembers'),
    register: registerMembersCommand,
    argv: ['members', 'list'],
    // `--json` left the leaf with #116's migration; JSON is the default.
    json: [],
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
    // `--json` left the leaf with #119's migration; JSON is the default.
    json: [],
  },
];

let logSpy: jest.SpyInstance;
/** Refusals reach stderr on the commands that own their own error boundary. */
let errSpy: jest.SpyInstance;

async function runCli(read: ListRead, extra: string[]): Promise<void> {
  const program = new Command();
  program.option('--verbose', 'Show stack traces');
  // The root's two output flags, spelled as `cli.ts` spells them — `--pretty`
  // is only reachable from the root, so a harness without it cannot see the
  // flag being ignored.
  program.option('--pretty', 'Indent JSON output (default: compact)');
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
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
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

  it('--pretty indents the envelope', async () => {
    // Compact by default is #113's intent; `--pretty` at the root is the
    // documented way back out. It parsed and did nothing on every writer this
    // ticket added — `users list --json` went from indented on main to compact
    // here with no flag able to restore it.
    read.stub(THREE);

    await runCli(read, [...read.json, '--pretty']);

    const line = logSpy.mock.calls.map((c) => String(c[0])).find((c) => c.startsWith('{'))!;
    expect(line).toMatch(/^\{\n {2}"rows"/);
    expect(JSON.parse(line).rows).toHaveLength(3);
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

  // `parseInt` stops at the first non-digit, so `1e9` parsed as 1 and a caller
  // asking for effectively no cap got ONE row marked `truncated` — the exact
  // "plausible wrong number" this ticket exists to remove (#44, #91, #136).
  // `banana` was the one bad input the old guard happened to survive.
  //
  // #99 made all of them "no cap", which is a strict improvement and still an
  // answer invented from input we could not read: the caller asked to be capped,
  // was not, and got a well-formed list with nothing saying the flag was
  // ignored. #142 refuses instead, so this asserts the ABSENCE of a result
  // rather than a different result — the one assertion that holds whether the
  // command reports through the runner's error envelope or its own boundary.
  // `0` is in the table by decision: it parses, and used to mean everything.
  it.each(['banana', '1e9', '2abc', '2.7', '5,000', '1_000', '-1', '', '0'])(
    'an unparseable --limit (%p) refuses, and emits no result at all',
    async (limit) => {
      const stub = read.stub(THREE);

      await runCli(read, [...read.json, '--limit', limit]);

      expect(() => envelope()).toThrow();
      const said = [...logSpy.mock.calls, ...errSpy.mock.calls]
        .map((c) => String(c[0]))
        .join('\n');
      expect(said).toContain('takes a whole number of 1 or more');
      // A refusal names the value, so a caller can see what was read. `''` has
      // nothing to name and still says what is accepted, above.
      if (limit !== '') expect(said).toContain(limit);
      // Nothing was fetched to throw away: the parse runs before the read on
      // every command that owns its own parse, and the runner's `capRows` refuses
      // before it writes. Either way there is no result line.
      expect(stub.mock.calls.length).toBeLessThanOrEqual(1);
    },
  );
});
