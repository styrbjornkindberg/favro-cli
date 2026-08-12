/**
 * `--human` declared on the ROOT reaches all eight persona commands (#115).
 *
 * This is a regression test for a live bug, not a formality. #114 added
 * `--human` to the root program while these eight still declared their own.
 * Commander does not let a leaf shadow an ancestor's flag: it binds the value
 * to the ancestor that declared it, so the leaf's `.opts()` came back WITHOUT
 * `human` and `resolveFormat(options)` fell through to its JSON default. Every
 * one of these commands printed JSON under `--human` on main.
 *
 * `run()` reads the flag through `optsWithGlobals()`, which is the resolution
 * that survives the flag being declared at any depth. The assertion below is
 * therefore "not JSON, and recognisably this command's own render" — deliberately
 * shallow, because the exact wording is each command's business and is covered
 * in its own suite.
 */
import { join } from 'node:path';
import { tempConfigDir } from '../../test-support/config-dir';

// Before any require that might touch the real ~/.favro.
tempConfigDir('favro-human-flag-');

import { Command } from 'commander';
import * as config from '../../lib/config';
import AggregateAPI, { AggregateCard } from '../../api/aggregate';

import { registerNextCommand } from '../../commands/next';
import { registerOverviewCommand } from '../../commands/overview';
import { registerWorkloadCommand } from '../../commands/workload';
import { registerHealthCommand } from '../../commands/health';
import { registerMyCardsCommand } from '../../commands/my-cards';
import { registerTeamCommand } from '../../commands/team';
import { registerStaleCommand } from '../../commands/stale';
import { registerMyStandupCommand } from '../../commands/my-standup';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../api/aggregate');

const MockAggregate = AggregateAPI as jest.MockedClass<typeof AggregateAPI>;

const USER = 'user-me';
const DAY = 24 * 60 * 60 * 1000;

const CARD = {
  id: 'c-1',
  title: 'Fix login',
  assignees: [USER],
  tags: [],
  blockedBy: [],
  stage: 'active',
  column: 'In Progress',
  boardName: 'Sprint 42',
  collectionName: 'Platform',
  createdAt: new Date(Date.now() - 60 * DAY).toISOString(),
} as unknown as AggregateCard;

const SNAPSHOT = {
  allCards: [CARD],
  members: [{ id: USER, name: 'Alice', email: 'alice@example.com' }],
};

let logSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  process.exitCode = undefined;
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
  (config.resolveUserId as jest.Mock).mockResolvedValue(USER);
  (config.readConfig as jest.Mock).mockResolvedValue({});
  MockAggregate.prototype.getMultiBoardSnapshot = jest.fn().mockResolvedValue(SNAPSHOT);
  MockAggregate.prototype.getCollectionSnapshot = jest.fn().mockResolvedValue(SNAPSHOT);
});

afterEach(() => {
  jest.restoreAllMocks();
  process.exitCode = undefined;
});

/** The root program exactly as `cli.ts` builds it: `--human` declared HERE. */
async function runWithRootHuman(register: (p: Command) => void, name: string): Promise<string> {
  const program = new Command();
  // Before the first `.command()`: `copyInheritedSettings` copies
  // `_exitCallback` when the subcommand is created, not when it runs.
  program.exitOverride();
  program
    .option('--verbose', 'Show stack traces')
    .option('--human', 'Human-readable output instead of the default JSON')
    .option('--pretty', 'Indent JSON output (default: compact)');
  register(program);
  await program.parseAsync(['node', 'favro', name, '--human']);
  return logSpy.mock.calls.map((c) => String(c[0])).join('\n');
}

const PERSONAS: Array<{ name: string; register: (p: Command) => void; heading: RegExp }> = [
  { name: 'next', register: registerNextCommand, heading: /^What to work on next \(/ },
  { name: 'overview', register: registerOverviewCommand, heading: /^Overview — / },
  { name: 'workload', register: registerWorkloadCommand, heading: /^Workload — / },
  { name: 'health', register: registerHealthCommand, heading: /^Health — / },
  { name: 'my-cards', register: registerMyCardsCommand, heading: /^My Cards \(/ },
  { name: 'team', register: registerTeamCommand, heading: /^Team — / },
  // `days or more`, not `>`: the header is derived from the same threshold the
  // filter applies, and that boundary is inclusive (#145).
  { name: 'stale', register: registerStaleCommand, heading: /^Stale Cards \(inactive \d+ days? or more\)/ },
  { name: 'my-standup', register: registerMyStandupCommand, heading: /^My Standup \(/ },
];

describe('a root --human reaches every persona', () => {
  it.each(PERSONAS)('$name renders its own prose, not JSON', async ({ name, register, heading }) => {
    const out = await runWithRootHuman(register, name);

    expect(out).toMatch(heading);
    // The failure mode this guards is silent: JSON where prose was asked for.
    expect(() => JSON.parse(out)).toThrow();
    expect(process.exitCode).toBeUndefined();
  });
});
