/**
 * Rendering one `DispatchResult` for a terminal.
 *
 * Lives here rather than inside `cli.ts` because more than one commander action
 * now dispatches — `cards create`, `cards link`/`unlink`, `cards claim`/
 * `resolve`/`retag` — and a second copy of this is exactly the drift the shared
 * table exists to prevent: the retry advice ("safe to retry" vs "do NOT retry")
 * must read identically whichever command produced it.
 */
import { DispatchResult } from './dispatch';

/**
 * Print the result, and say whether the caller should exit non-zero.
 *
 * Reads the RESULT, never the intent name — so an action for an intent
 * registered by a later ticket renders correctly with no change here. A refusal
 * (scope lock, resolver, unknown intent) never arrives as a result: it throws,
 * and each action's catch is where the throw becomes an exit code.
 */
export function reportDispatch(result: DispatchResult<unknown>, json?: boolean): boolean {
  if (result.preview) {
    // A preview of the whole chain, and only a preview. The lock, not this flag,
    // is what stopped anything unsafe.
    result.preview.forEach((line) => console.log(`[dry-run] ${line}`));
    return false;
  }
  if (result.outcome === 'ok') return false;

  console.error(`✗ ${result.intent} failed: ${result.error}`);
  // Branch on the OUTCOME, which is the contract, not on `retryable`, which is
  // one derivation of it — `retryable` is a summary a wire-level misread can
  // set wrong (see #66), and the advice must not move when it does.
  if (result.outcome === 'rolled-back') {
    console.error('  Rolled back — nothing was left behind, so the same call is safe to retry.');
  } else if (result.orphans?.length) {
    console.error('  Rollback incomplete — do NOT retry. Left behind:');
    for (const orphan of result.orphans) console.error(`    - ${orphan.reason}`);
  } else {
    // A header with nothing under it claims wreckage that does not exist.
    console.error('  Rollback incomplete — do NOT retry.');
  }
  if (json) console.log(JSON.stringify(result));
  return true;
}

export default reportDispatch;
