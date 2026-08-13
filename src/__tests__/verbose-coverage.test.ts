/**
 * The --verbose ratchet (#85).
 *
 * WHAT IT GUARDS
 * `--verbose` is declared once, on the root program. Commander's `.opts()`
 * returns a command's OWN options only, so an action that reads its own — or an
 * intermediate parent's — opts always sees `undefined`, and the flag is dead on
 * that command. That was 28 sites across nine command families, plus 25 more
 * that passed no flag at all. The shape is one template copied across a family
 * of files, which is exactly why reading one subcommand tells you nothing about
 * its siblings.
 *
 * THE FIX IS ONE SEAM, SO THIS TEST GUARDS ONE SEAM
 * `latchVerbose(program)` puts a `preAction` hook on the ROOT program that
 * resolves `optsWithGlobals().verbose` off the command whose action is about to
 * run — self plus every ancestor — and hands it to `logError` as the default.
 * No command has to read the flag, so no command can read it wrong. What can
 * still break is the seam itself, or a subtree the flag cannot reach.
 *
 * SO IT WALKS THE REAL SURFACE
 * Every command in `buildProgram()` that has an action handler is parsed with
 * `--verbose` appended, aborting in a second `preAction` hook before the action
 * body runs. Placeholder values are synthesised for required arguments and
 * mandatory options; nothing is executed and nothing reaches the network. A
 * 29th subcommand added under a parent the flag cannot cross — or a group that
 * shadows `--verbose` in a way that no longer resolves — fails here.
 *
 * The floor assertion exists because a walker that enumerated nothing would
 * pass forever.
 */
import { Command } from 'commander';
import { tempConfigDir } from '../test-support/config-dir';

// Set before the CLI is loaded. NOT because `config.ts` freezes anything —
// `configDir()` has resolved per call since #65 and says so at `config.ts:43`.
// The reason is the tree being required: any module that reads the config
// during its own import would read it too early, and the run would land in the
// developer's own ~/.favro.
tempConfigDir('favro-cli-verbose-config-');

// The single seam every command's error path funnels through: the factory that
// builds the API client. Making it throw is the shortest route to a real
// stack-carrying failure inside a real action.
const BOOM = 'client factory exploded';
jest.mock('../lib/client-factory', () => ({
  __esModule: true,
  createFavroClient: jest.fn(async () => {
    throw new Error(BOOM);
  }),
  default: jest.fn(async () => {
    throw new Error(BOOM);
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildProgram } = require('../cli') as typeof import('../cli');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isVerbose } = require('../lib/error-handler') as typeof import('../lib/error-handler');

/** Silence commander's own exits so a parse error surfaces as a throw. */
function exitOverrideDeep(cmd: Command): void {
  cmd.exitOverride();
  cmd.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  cmd.commands.forEach(exitOverrideDeep);
}

interface Leaf {
  path: string[];
  cmd: Command;
}

/** Every command with an action handler, with the argv path that reaches it. */
function actionCommands(cmd: Command, prefix: string[] = []): Leaf[] {
  const found: Leaf[] = [];
  if ((cmd as any)._actionHandler && prefix.length > 0) found.push({ path: prefix, cmd });
  for (const sub of cmd.commands) {
    if (sub.name() === 'help') continue;
    found.push(...actionCommands(sub, [...prefix, sub.name()]));
  }
  return found;
}

/**
 * Enough argv for commander to reach the action: a placeholder per required
 * argument, and per mandatory option on the command or any ancestor (commander
 * checks ancestors too). Values are never read — the run aborts first.
 */
function satisfyingArgs(leaf: Leaf): string[] {
  const args: string[] = [];
  for (const arg of (leaf.cmd as any).registeredArguments ?? []) {
    if (arg.required) args.push('x');
  }
  for (let c: Command | null = leaf.cmd; c; c = c.parent) {
    for (const opt of c.options) {
      if (!opt.mandatory) continue;
      args.push(opt.long ?? opt.short!);
      if (opt.required) args.push('x');
    }
  }
  return args;
}

const ABORT = Symbol('abort-before-action');

/** Parse `path --verbose`, stopping at the action, and report what the seam saw. */
async function verboseSeenBy(leaf: Leaf): Promise<boolean> {
  const program = buildProgram();
  exitOverrideDeep(program);
  let seen = false;
  // Registered after `latchVerbose`'s hook, so it observes the latched value.
  program.hook('preAction', () => {
    seen = isVerbose();
    throw ABORT;
  });
  try {
    await program.parseAsync(['node', 'favro', ...leaf.path, ...satisfyingArgs(leaf), '--verbose']);
  } catch (err) {
    if (err !== ABORT) throw new Error(`favro ${leaf.path.join(' ')}: ${(err as Error).message}`);
  }
  return seen;
}

describe('--verbose reaches every command that can report an error', () => {
  const leaves = actionCommands(buildProgram());

  it('finds the commands it is meant to be reading', () => {
    // 125 today. Kept close to the real count on purpose: this floor exists to
    // catch a walker that resolves nothing (a commander rename of the private
    // `_actionHandler` returns 0), and a floor with 25 commands of slack stops
    // gripping as #80 keeps deleting. Raise it when the surface grows.
    expect(leaves.length).toBeGreaterThan(120);
  });

  it('resolves true on every action in the real command surface', async () => {
    const dead: string[] = [];
    for (const leaf of leaves) {
      if (!(await verboseSeenBy(leaf))) dead.push(`favro ${leaf.path.join(' ')}`);
    }
    // A name here is a command where `--verbose` is silently ignored. Fix the
    // seam or the subtree; do not add an exemption list.
    expect(dead).toEqual([]);
  });
});

describe('a deep subcommand prints a stack trace under --verbose', () => {
  let stderr: string[];
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    stderr = [];
    jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      stderr.push(a.map(String).join(' '));
    });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
  });

  afterEach(() => jest.restoreAllMocks());

  /**
   * `--human`: the stack trace is a `logError` rendering, and `logError` only
   * runs on the human arm of the runner's boundary. Under the JSON default the
   * same failure is `{"error":{…}}` on stdout — the arm below asserts that too,
   * so the flag here is a choice of stream rather than a way around the check.
   */
  async function run(args: string[]): Promise<string> {
    const program = buildProgram();
    exitOverrideDeep(program);
    process.exitCode = undefined;
    await program.parseAsync(['node', 'favro', '--human', ...args]);
    return stderr.join('\n');
  }

  it('favro tags list --verbose shows the stack', async () => {
    const output = await run(['tags', 'list', '--verbose']);
    expect(output).toContain(BOOM);
    expect(output).toContain('Stack trace:');
    // `process.exitCode`, not a hard exit: #119 put `tags list` on `run()`.
    expect(process.exitCode).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
    process.exitCode = undefined;
  });

  it('favro tags list without it shows only the message', async () => {
    const output = await run(['tags', 'list']);
    expect(output).toContain(BOOM);
    expect(output).not.toContain('Stack trace:');
    process.exitCode = undefined;
  });
});
