/**
 * The last error boundary in `cli.ts` — `reportUncaught` (#119).
 *
 * WHY THIS FILE EXISTS AT ALL
 * ADR-0002 opens with "the top-level catch at `src/cli.ts` is unreachable —
 * every action exits before it", and #119's acceptance asks for a test proving
 * it runs. It had never run in either sense: no production input reached it,
 * AND no test could, because the whole block lived inside
 * `if (require.main === module)`. Jest never executes that — every test in this
 * repo drives `buildProgram().parseAsync(…)`, which bypasses it, and nothing in
 * `src/__tests__/integration/` spawns the built binary. So the arm had no
 * reachable call site from either direction.
 *
 * `.catch(reportUncaught)` is what made it testable: one exported named
 * function, called directly here. That is the whole refactor.
 *
 * WHAT IS AND IS NOT REACHABLE — measured, not claimed
 * `run()` catches everything a handler can throw, so no ordinary command path
 * arrives here. What DOES is commander itself: `.exitOverride()` turns `--help`,
 * `--version`, an unknown command and a missing required option into a
 * `CommanderError` that `parseAsync` rejects with. That is the first arm, and it
 * is the live one — driven end to end below through the real program rather than
 * only with a constructed error.
 *
 * The second arm's live sources are the root `preAction` hook (`latchVerbose`)
 * and `commandFrom` / `resolveFormat` inside `run.ts`, all of which only call
 * `optsWithGlobals()`. No input was found that makes any of them throw, so that
 * arm is driven with a constructed error and this comment says so rather than
 * naming a command that does not exist (ADR-0003).
 */
import { Command, CommanderError } from 'commander';
import { buildProgram, reportUncaught } from '../cli';
import * as errorHandler from '../lib/error-handler';

let logged: unknown[];
let errorSpy: jest.SpyInstance;

beforeEach(() => {
  logged = [];
  process.exitCode = undefined;
  errorSpy = jest.spyOn(errorHandler, 'logError').mockImplementation((...args) => {
    logged.push(args[0]);
  });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  process.exitCode = undefined;
  jest.restoreAllMocks();
});

describe('reportUncaught — the boundary below the runner', () => {
  it('takes a CommanderError\'s own code and logs NOTHING', () => {
    // Commander has already written its own output by the time it rejects, so
    // logging again would put "✗ Error: (outputHelp)" under every `--help`.
    reportUncaught(new CommanderError(0, 'commander.helpDisplayed', '(outputHelp)'));

    expect(process.exitCode).toBe(0);
    expect(logged).toEqual([]);
  });

  it('carries a NON-zero commander code through unchanged', () => {
    // Not a spelling of the arm above: `0` and `2` cannot both be a constant.
    // An unknown option is exit 1, `--help` is exit 0, and the boundary must not
    // flatten either into the other.
    reportUncaught(new CommanderError(2, 'commander.unknownOption', "unknown option '--nope'"));

    expect(process.exitCode).toBe(2);
    expect(logged).toEqual([]);
  });

  it('logs anything else and sets exit 1', () => {
    const boom = new Error('boom');

    reportUncaught(boom);

    // The OBJECT, not a rendering of it: `logError` reads the error's type to
    // head a `ScopeError` differently, so handing it a rewrap would be the
    // defect #133 pinned one funnel over.
    expect(logged).toEqual([boom]);
    expect(process.exitCode).toBe(1);
  });

  it('sets the code, and never calls a hard exit', () => {
    // ADR-0002's second rule, at the one place in `cli.ts` that could still
    // break it: a hard exit terminates before a pending async write flushes,
    // and stdout is a pipe under MCP. `command-runner-ratchet.test.ts` bans the
    // spelling in the text; this is the behaviour behind the ban.
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit must not be called by reportUncaught');
    }) as never);

    reportUncaught(new Error('boom'));
    reportUncaught(new CommanderError(1, 'commander.unknownCommand', 'nope'));

    expect(exit).not.toHaveBeenCalled();
  });
});

describe('the boundary is reached by the real program, not only by a direct call', () => {
  it('an unknown command rejects with a CommanderError, which this boundary absorbs', async () => {
    // End to end through `buildProgram()`: `.exitOverride()` is what stops
    // commander short-circuiting the process, and it is what finally makes this
    // arm reachable at all (ADR-0002, "Mechanism"). Without the `.catch` an
    // unknown command would be an unhandled rejection.
    const program = buildProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });

    const thrown = await program
      .parseAsync(['node', 'favro', 'no-such-command'])
      .then(() => undefined, (error: unknown) => error);

    expect(thrown).toBeInstanceOf(CommanderError);

    reportUncaught(thrown);

    expect(process.exitCode).toBe((thrown as CommanderError).exitCode);
    expect(logged).toEqual([]);
  });
});

describe('the shape the boundary depends on', () => {
  it('`logError` takes no verbose argument here — #85 has one spelling', () => {
    // The `.catch` this replaced passed `prog.opts().verbose`. `logError` reads
    // the `isVerbose()` latch set by the root `preAction` hook, so passing the
    // flag re-introduces a second spelling of what #85 collapsed to one. It does
    // not trip the ratchet, which bans the optional-chain form, so nothing else
    // would notice.
    reportUncaught(new Error('boom'));

    expect(errorSpy).toHaveBeenCalledWith(expect.any(Error));
    expect(errorSpy.mock.calls[0]).toHaveLength(1);
  });

  it('a Command is not needed to report — the signature takes the error alone', () => {
    // Recorded because the ticket's sketch of this function took `(err, prog)`.
    // It does not, and cannot usefully: `prog.opts()` was only ever read for the
    // verbose flag the line above deletes.
    expect(reportUncaught).toHaveLength(1);
    expect(new Command()).toBeDefined();
  });
});
