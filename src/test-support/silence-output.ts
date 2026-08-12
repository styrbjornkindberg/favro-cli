/**
 * Keep the suite's own console clean — loaded for every suite via
 * `setupFilesAfterEnv`, so it is one place rather than 170.
 *
 * Jest captures `console.*` and replays it under the suite that produced it. It
 * does NOT capture direct `process.stdout.write` / `process.stderr.write`, and
 * two places in this CLI write that way on purpose:
 *
 *   - `commands/auth.ts` prints the credential-validation progress lines
 *     (`Validating credentials... ✓`) with `process.stdout.write`.
 *   - `lib/progress.ts` renders `ProgressBar` and `Spinner` frames with
 *     `process.stderr.write` on an 80 ms interval, and the interval is `unref`'d
 *     rather than stopped, so a spinner a test starts keeps drawing until the
 *     worker exits.
 *
 * Measured on `a67e657`: a full run leaked 30 lines / 821 bytes of credential
 * text onto the real stdout and 420 spinner frames onto the real stderr, the
 * latter arriving as one unbroken line spliced in front of an unrelated suite's
 * `PASS`. That is what buries a real failure in a CI log.
 *
 * WHY THE PATCH IS PER-SUITE rather than installed once at module scope: with
 * `--runInBand` the worker IS the main process, so a module-scope patch of
 * `process.stderr.write` would also silence Jest's own reporter and the run
 * would print no results at all. Jest emits a suite's reporter output after the
 * suite's `afterAll`, so `beforeAll`/`afterAll` silences exactly the product
 * code under test and nothing else.
 *
 * It is deliberately not `beforeEach`/`afterEach`, which leaves the gaps between
 * tests unsilenced. Measured over a full run: 420 frames unpatched, 135 with
 * per-test scoping, and with per-suite scoping anywhere between 5 and 152 —
 * because the residue was never really a scoping problem. `cards export` started
 * a `Spinner` and skipped `stop()` whenever the fetch threw, and that interval is
 * `unref`'d rather than cleared, so it kept firing for the rest of the WORKER's
 * life, across however many later suites that worker happened to be handed. That
 * is fixed at the source now (a `finally` in `cli.ts`), and the frame count is a
 * deterministic 0 over four consecutive full runs rather than a range.
 *
 * So this file silences the DELIBERATE writes. It is not load-bearing for a
 * leaked timer and should not be made to compensate for one.
 *
 * This does NOT weaken assertions about output. A test that wants to read what
 * was written installs its own spy (`jest.spyOn(process.stdout, 'write')`) and
 * asserts on the recorded calls; the spy records regardless of whether the
 * underlying function draws to a terminal. Tests that drive the CLI as a child
 * process write to real file descriptors and are untouched by an in-process
 * patch.
 */

type Write = typeof process.stdout.write;

const saved: Array<[NodeJS.WriteStream, Write]> = [];

beforeAll(() => {
  for (const stream of [process.stdout, process.stderr] as NodeJS.WriteStream[]) {
    saved.push([stream, stream.write.bind(stream) as Write]);
    // Swallow the bytes but keep the contract: `write` returns whether the
    // caller may keep writing, and a `false` here would make product code
    // wait for a 'drain' event that is never coming.
    stream.write = ((
      _chunk: unknown,
      encodingOrCallback?: unknown,
      callback?: unknown
    ): boolean => {
      // `write` may carry a completion callback in either trailing position;
      // dropping it would hang any caller that awaits the flush.
      const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
      if (typeof done === 'function') (done as (error?: Error | null) => void)(null);
      return true;
    }) as Write;
  }
});

afterAll(() => {
  // Restores in reverse, and also lifts any spy a test installed on top.
  for (const [stream, write] of saved.reverse()) stream.write = write;
  saved.length = 0;
});
