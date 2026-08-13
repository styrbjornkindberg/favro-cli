/**
 * Commands removed in 3.0, kept registered so they can say what to run instead
 * (#110, step 5 of #92).
 *
 * `batch update`, `batch move`, `batch assign` and `batch-smart` are gone: three
 * of them derived their own write set from a board read, and all four wrote
 * through `BulkTransaction`, the second of the three rollback engines this repo
 * carried. `tx-cards` is the only one left.
 *
 * WHY A STUB AND NOT A DELETION. An agent that hits `unknown command` has
 * nothing to recover with — it cannot tell a removal from a typo, and the next
 * thing it tries is the same command spelled differently. One that hits a stub
 * gets a next move. They are kept for one major.
 *
 * WHY NOT A DEPRECATION CYCLE. A warning that still performs the write keeps
 * alive exactly the behaviour this removes: an unbounded, unlocked, derived
 * batch. A grace period is only kind when the thing it grants time for is safe.
 *
 * WHY `allowUnknownOption` AND A VARIADIC ARGUMENT. The real invocation is
 * `favro batch update --from-csv cards.csv`, not `favro batch update`. Without
 * these, commander answers `error: unknown option '--from-csv'` and the pointer
 * below never prints — which is the "unknown command" failure again, one token
 * to the right.
 */
import { Command } from 'commander';
import { AnonymousCtx, run } from '../lib/run';
import { RefusalError } from '../lib/refusal';

/** The pointer for anything that took an enumerated CSV. */
const FROM_CSV = `Use 'favro cards update --from-csv <file>' — same CSV, one transaction, capped at 20 rows.`;

/** The pointer for anything that DERIVED its write set from a board read. */
const ENUMERATE_FIRST =
  `Enumerate first with 'favro cards list --filter …', then 'favro cards update --from-csv'.`;

/**
 * The pointer for `batch-smart`, whose replacement is not another command but a
 * different division of labour: the agent decides the operations, the CLI writes
 * the list it is handed.
 */
const DECIDE_YOURSELF =
  `Removed in 3.0. Decide the operations yourself, then 'favro cards update --from-csv'.`;

/**
 * A `RefusalError`, so the runner's error boundary owns the exit code and the
 * stream: exit 1, `{"error":{"message","retryable"}}` on stdout under the JSON
 * default, `✗ Error: …` on stderr under `--human` (ADR-0002). `retryable` is
 * false, which is the honest answer — running it again removes nothing.
 */
function refuse(spelling: string, replacement: string): never {
  throw new RefusalError(`'favro ${spelling}' was removed in 3.0.\n${replacement}`);
}

/**
 * The four registrations, written out rather than looped.
 *
 * A table would be shorter and it does not work: `interactive-command-coverage`
 * and `list-envelope-coverage` both resolve a command's argv path by walking the
 * chain from `.action(…)` back to a `.command(<literal>)`, and a name held in a
 * variable makes that walk return `''` — the one path that is always exempt. A
 * tracer miss reading as a pass is the bypass those ratchets exist to close, so
 * the literal is load-bearing.
 */
export function registerRemovedCommands(program: Command): void {
  const batch = program
    .command('batch')
    .description(
      'Removed in 3.0. Bulk card operations are one command now:\n' +
      `  ${FROM_CSV}`
    );

  // `.arguments('[args...]')` and `.allowUnknownOption()` on each: the real
  // invocation carries the old flags, and without them commander answers
  // `error: unknown option '--from-csv'` and the pointer never prints.
  batch
    .command('update')
    .description(`Removed in 3.0 — ${FROM_CSV}`)
    .arguments('[args...]')
    .allowUnknownOption()
    .action(run({ anonymous: true }, (_ctx: AnonymousCtx) => refuse('batch update', FROM_CSV)));

  batch
    .command('move')
    .description(`Removed in 3.0 — ${ENUMERATE_FIRST}`)
    .arguments('[args...]')
    .allowUnknownOption()
    .action(run({ anonymous: true }, (_ctx: AnonymousCtx) => refuse('batch move', ENUMERATE_FIRST)));

  batch
    .command('assign')
    .description(`Removed in 3.0 — ${ENUMERATE_FIRST}`)
    .arguments('[args...]')
    .allowUnknownOption()
    .action(
      run({ anonymous: true }, (_ctx: AnonymousCtx) => refuse('batch assign', ENUMERATE_FIRST)),
    );

  program
    .command('batch-smart')
    .description(`Removed in 3.0 — ${DECIDE_YOURSELF}`)
    .arguments('[args...]')
    .allowUnknownOption()
    .action(run({ anonymous: true }, (_ctx: AnonymousCtx) => refuse('batch-smart', DECIDE_YOURSELF)));
}

export default registerRemovedCommands;
