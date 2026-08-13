/**
 * Commands removed in 4.0, kept registered so they can say what to run instead
 * (#110, step 5 of #92).
 *
 * `batch update`, `batch move`, `batch assign` and `batch-smart` are gone: three
 * of them derived their own write set from a board read, and between them they
 * carried two of this repo's three rollback engines — the three `batch`
 * subcommands wrote through `BulkTransaction`, and `batch-smart` had a
 * best-effort unwind of its own. `tx-cards` is the only one left.
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
 * WHY `allowUnknownOption`. The real invocation is `favro batch update
 * --from-csv cards.csv`, not `favro batch update`. Without it commander answers
 * `error: unknown option '--from-csv'` and the pointer below never prints —
 * which is the "unknown command" failure again, one token to the right.
 * Mutation-proven: dropping it turns four of `removed.test.ts`'s arms red, on
 * `unknown option '--from-csv'` / `'--board'` / `'--goal'`.
 *
 * All four registrations carried `.arguments('[args...]')` alongside it until the
 * same mutation run checked that half separately: commander 12.1.0 sets
 * `_allowExcessArguments = true` by default, so every one of those arms stayed
 * GREEN without it, `batch-smart board-1 --goal …`'s positional included. Those
 * four were deleted rather than left as a hedge — a line nothing can turn red is
 * not a guard, it is a claim. The `batch` GROUP keeps one, for a reason that is
 * not about parsing at all; see its own comment.
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
  `Decide the operations yourself, then 'favro cards update --from-csv'.`;

/**
 * A `RefusalError`, so the runner's error boundary owns the exit code and the
 * stream: exit 1, `{"error":{"message","retryable"}}` on stdout under the JSON
 * default, `✗ Error: …` on stderr under `--human` (ADR-0002). `retryable` is
 * false, which is the honest answer — running it again removes nothing.
 */
function refuse(spelling: string, replacement: string): never {
  throw new RefusalError(`'favro ${spelling}' was removed in 4.0.\n${replacement}`);
}

/**
 * A `RefusalError` for the sixth spelling, `cards update --board <board>` with
 * no card id, which is a FLAG COMBINATION on a command that still exists — so
 * commander cannot dispatch it and it cannot be registered here.
 *
 * `cli.ts` calls this at the top of that action, above the credential
 * resolution, and hands it the `Command`: that is what lets the runner resolve
 * `--human` and put the refusal on the same stream as the other five. Called
 * directly rather than re-implemented so there is one error boundary and not a
 * second, drifting copy of it.
 */
export const refusePredicateBatch = run(
  { anonymous: true },
  (_ctx: AnonymousCtx, ..._args: unknown[]): never =>
    refuse('cards update --board <board>', ENUMERATE_FIRST),
);

/**
 * The registrations, written out rather than looped.
 *
 * A table would be shorter and it costs the argv path. `interactive-command-coverage`
 * resolves a command's path by walking the chain from `.action(…)` back through
 * `.command(<string literal>)` calls; a name held in a variable contributes no
 * part. Measured, by writing the looped version and running that suite: the
 * `batch-smart` registration failed the "every .action() resolved to a command
 * path" arm with `src/commands/removed.ts ` — an empty path, which is the bare
 * main menu's key and therefore always exempt. The three `batch` subcommands did
 * NOT fail it: their walk still reaches the `batch` variable's own literal, so
 * all three collapse onto the path `batch` instead — wrong, but silently so.
 */
export function registerRemovedCommands(program: Command): void {
  // The GROUP takes an action of its own, which is what makes `favro batch
  // nonsense` a refusal naming the replacement rather than commander's `unknown
  // command 'nonsense'` — commander only reaches `unknownCommand()` when the
  // parent has no action handler. It also answers bare `favro batch`, which
  // printed help before. The description still carries the pointer because that
  // is what `favro --help` lists.
  //
  // `.arguments('[args...]')` here and not on the four below, which is not an
  // inconsistency: this is the one that takes an operand — the mis-typed
  // subcommand name — so declaring zero would make the CHANGELOG's own
  // `favro batch nonsense` a doc teaching an arity the surface denies, which
  // `documented-commands-coverage` reports (measured: it failed on exactly that).
  const batch = program
    .command('batch')
    .description(
      'Removed in 4.0. Bulk card operations are one command now:\n' +
      `  ${FROM_CSV}`
    )
    .arguments('[args...]')
    .allowUnknownOption()
    .action(run({ anonymous: true }, (_ctx: AnonymousCtx) => refuse('batch', FROM_CSV)));

  batch
    .command('update')
    .description(`Removed in 4.0 — ${FROM_CSV}`)
    .allowUnknownOption()
    .action(run({ anonymous: true }, (_ctx: AnonymousCtx) => refuse('batch update', FROM_CSV)));

  batch
    .command('move')
    .description(`Removed in 4.0 — ${ENUMERATE_FIRST}`)
    .allowUnknownOption()
    .action(run({ anonymous: true }, (_ctx: AnonymousCtx) => refuse('batch move', ENUMERATE_FIRST)));

  batch
    .command('assign')
    .description(`Removed in 4.0 — ${ENUMERATE_FIRST}`)
    .allowUnknownOption()
    .action(
      run({ anonymous: true }, (_ctx: AnonymousCtx) => refuse('batch assign', ENUMERATE_FIRST)),
    );

  program
    .command('batch-smart')
    .description(`Removed in 4.0 — ${DECIDE_YOURSELF}`)
    .allowUnknownOption()
    .action(run({ anonymous: true }, (_ctx: AnonymousCtx) => refuse('batch-smart', DECIDE_YOURSELF)));
}

export default registerRemovedCommands;
