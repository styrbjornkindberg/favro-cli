/**
 * That the output silencer is actually installed (#97).
 *
 * `test-support/silence-output.ts` is loaded for every suite by
 * `setupFilesAfterEnv`, and its whole effect is invisible from inside the
 * process: it stops bytes reaching the real file descriptors, which only the
 * thing that spawned the run can see. Measured from outside, a full run went
 * from 821 bytes of `Validating credentials…` on stdout to 0.
 *
 * That measurement is not a regression test, and the obvious substitute — spy on
 * stdout and assert nothing was written — is one of this repo's known ways to
 * write a test that cannot fail: an absence assertion passes just as happily
 * when the code under test never ran.
 *
 * So this checks the MECHANISM instead, which is observable and falsifiable: the
 * writers are swapped for the duration of the suite. The pristine references are
 * captured at module scope, which runs after `setupFilesAfterEnv` has registered
 * its hooks but before `beforeAll` has fired — so at that point the real writers
 * are still in place, and inside a test body they must not be.
 */
const pristineStdoutWrite = process.stdout.write;
const pristineStderrWrite = process.stderr.write;

describe('silence-output', () => {
  it('swaps both writers while a suite runs', () => {
    expect(process.stdout.write).not.toBe(pristineStdoutWrite);
    expect(process.stderr.write).not.toBe(pristineStderrWrite);
  });

  it('keeps the write contract: returns true and invokes a completion callback', () => {
    // A `false` return means "wait for 'drain'", and a dropped callback hangs any
    // caller awaiting the flush — either would turn silencing into a deadlock.
    let called = false;
    expect(process.stdout.write('swallowed', () => { called = true; })).toBe(true);
    expect(called).toBe(true);
  });
});
