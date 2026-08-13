/**
 * Rendering one `DispatchResult` for a terminal.
 *
 * Lives here rather than inside `cli.ts` because more than one commander action
 * now dispatches — `cards create`, `cards link`/`unlink`, `cards claim`/
 * `resolve`/`retag` — and a second copy of this is exactly the drift the shared
 * table exists to prevent: the retry advice ("safe to retry" vs "do NOT retry")
 * must read identically whichever command produced it.
 */
import { DispatchResult, getIntent, UnknownIntentError, intentNames } from './dispatch';
import { RefusalError } from './refusal';

/**
 * Print the result, and say whether the caller should exit non-zero.
 *
 * Reads the RESULT — `retryable` for the advice, the outcome and the orphan
 * list for the detail — never the intent name, so an action for an intent
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
  // Branch on `retryable`, which since #66 is the table's ONE derivation of the
  // retry advice — the outcome alone cannot express it, because a deterministic
  // refusal unwinds perfectly cleanly and is still not worth repeating, and the
  // three-outcome contract must not grow a fourth state to say so.
  // `rolled-back` is the only outcome that means the unwind was clean, so it
  // gates the sentence that says so. `isRetryable` never sets `retryable` on
  // any other outcome — but this function takes ANY `DispatchResult`, and the
  // one sentence promising no wreckage must not rest on a caller's invariant.
  if (result.outcome === 'rolled-back' && result.retryable) {
    console.error('  Rolled back — nothing was left behind, so the same call is safe to retry.');
  } else if (result.outcome === 'rolled-back') {
    console.error(
      '  Rolled back — nothing was left behind, but the failure is deterministic: ' +
        'the same call will fail the same way. Do NOT retry it unchanged.',
    );
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

/**
 * The intent's own preview lines, with NO dispatch — the `--dry-run` path for a
 * caller with **no scope lock configured** (#109).
 *
 * `dispatch(…, {dryRun: true})` is the normal preview, and it is what runs when a
 * lock IS configured: it takes the lock before previewing, which is the ordering
 * #155 exists for. With no lock there is nothing to take, and everything the
 * dispatch does on the way to the preview costs the caller money —
 * `createFavroClient()` resolves a credential eagerly and `intent.board()` makes a
 * request per card. #102/#104 price an unlocked path at zero extra requests and
 * #135 keeps a preview free; `dependencies delete`, `dependencies delete-all` and
 * `custom-fields set` all have that property pinned in
 * `dry-run-scope-order-wire.test.ts`, and routing them must not quietly take it
 * away.
 *
 * `preview()` is a PURE function of its args by design — every intent's is, and
 * `archive`'s comment says why one may not read — so producing the lines here
 * touches no wire and needs no credential. They are the same lines through the
 * same renderer, so the two paths cannot word a preview differently.
 *
 * What it deliberately does NOT show: anything only a read could know. An
 * unlocked `dependencies delete-all --dry-run` will not tell you the card is over
 * the cap, because finding that out is the request this exists to avoid. The
 * refusal is on the real run.
 *
 * **The config is a REQUIRED argument, and a configured lock REFUSES.** All three
 * callers gate on `!scopeCollectionId` correctly today, and that gate is
 * invisible from here — a fourth call site calling this unconditionally would
 * rebuild #155's hole exactly, a preview promising a write the lock refuses, and
 * nothing else would catch it. A convention every caller has to remember is not a
 * guardrail; this is.
 */
export function previewOnly(
  intent: string,
  args: Record<string, unknown>,
  config: { scopeCollectionId?: string } | undefined,
): void {
  if (config?.scopeCollectionId) {
    throw new RefusalError(
      `previewOnly("${intent}") was called with a scope lock configured ` +
        `("${config.scopeCollectionId}"). It renders a preview WITHOUT taking the lock, so under one ` +
        `it would promise a write the real run refuses — the defect #155 closed.\n` +
        `It exists for the unlocked path only, where there is no lock to take and the reads getting to ` +
        `one would cost are unbillable. Under a lock, dispatch with { dryRun: true }: the table takes ` +
        `the lock before it previews.`,
    );
  }
  const known = getIntent(intent);
  if (!known) throw new UnknownIntentError(intent, intentNames());
  reportDispatch({ intent, outcome: 'ok', retryable: false, preview: known.preview(args) });
}

export default reportDispatch;
