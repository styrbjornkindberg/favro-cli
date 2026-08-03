/**
 * "Did the user press Ctrl+C at an enquirer prompt?" — one measured answer.
 *
 * WHAT ENQUIRER ACTUALLY THROWS, measured against `enquirer@2.4.1` under a real
 * pty: `prompt.run()` rejects with the **empty string**, not an Error. Not an
 * `Error` whose `message` is empty — the primitive `''`.
 *
 * `browse` and `main-menu` both guarded this as `error?.message === ''`, which
 * reads plausibly and is false for a string: `''.message` is `undefined`. So
 * neither guard had ever fired, and Ctrl+C out of `favro browse` took the
 * failure path — under #113's runner that surfaced as
 * `{"error":{"message":"","retryable":true}}` and exit 1, where before it was a
 * bare `✗ Error:` line and the same exit 1. Loud rather than new (#118).
 *
 * `ERR_USE_AFTER_CLOSE` is kept: that is the readline error a SECOND interrupt
 * raises, arriving as a real `Error`, and it means the same thing to a caller.
 *
 * ponytail: an allow-list of two shapes, not a general "is this a cancellation".
 * If enquirer ever rejects with a typed `CancelError`, add the arm — do not
 * widen this to "anything falsy", which would swallow real failures.
 */
export function isPromptCancelled(error: unknown): boolean {
  if (error === '') return true;
  return (error as NodeJS.ErrnoException | null)?.code === 'ERR_USE_AFTER_CLOSE';
}

export default isPromptCancelled;
