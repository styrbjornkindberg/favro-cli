/**
 * That the ambient environment is actually scrubbed (#174/#175).
 *
 * `test-support/scrub-ambient-env.ts` runs via `setupFiles`, so by the time any
 * test body runs the variables are already gone — and asserting that they are gone
 * is the vacuous kind of check this repo keeps catching itself writing: it passes
 * identically on a machine that never had them set, which is most of them.
 *
 * So this sets each variable and re-runs the scrub, which is possible because the
 * module is pure — no hooks, nothing that needs the framework — and that is the
 * point of it being its own file. `jest.isolateModules` is load-bearing, not
 * decoration: the `setupFiles` module is already in this file's registry, so a
 * plain `require` is a cache hit and every arm passes with the `delete`s removed.
 *
 * The empty arm is not a duplicate of the set one: `FAVRO_SCOPE_COLLECTION_ID=` is
 * an ERROR by design (#174), so it fails the harness ten times harder than a set
 * value — 42 of `run.test.ts`'s 52 tests against 4.
 */
describe('scrub-ambient-env', () => {
  // The scrub itself is what clears these, so a PASSING arm needs no teardown.
  // This is for a FAILING one: without it a single red arm leaves the variable set
  // for the rest of the worker, and the one real failure arrives buried under a
  // cascade of suites that never mentioned it — the exact symptom being fixed.
  afterEach(() => {
    delete process.env.FAVRO_SCOPE_COLLECTION_ID;
    delete process.env.FAVRO_API_TOKEN;
  });

  it.each([
    ['FAVRO_SCOPE_COLLECTION_ID', 'a set value', 'coll-ambient'],
    ['FAVRO_SCOPE_COLLECTION_ID', 'an empty value, which readConfig throws on', ''],
    ['FAVRO_API_TOKEN', 'a set value', 'ambient-tok'],
  ] as const)('removes the inherited %s: %s', (name, _case, value) => {
    process.env[name] = value;

    jest.isolateModules(() => {
      require('../test-support/scrub-ambient-env');
    });

    // `toBeUndefined`, not `in`: assigning `undefined` to a `process.env` key
    // stores the STRING "undefined", and that would still refuse every write.
    expect(process.env[name]).toBeUndefined();
  });

  /**
   * The arms above prove the MODULE deletes the variables. They pass just as well
   * when nothing loads it — `jest.isolateModules` re-executes it either way.
   * Measured with the `setupFiles` entry taken out of `jest.config.js`: every arm
   * green, and a full run green too, because CI has no lock exported to inherit.
   * Dropping that one config line is therefore invisible to the suite and hands
   * every developer holding a lock its 142 failures back. This is the other half.
   */
  it('is wired into jest.config.js, not merely present in the tree', () => {
    expect(require('../../jest.config.js').setupFiles).toContain(
      '<rootDir>/src/test-support/scrub-ambient-env.ts'
    );
  });
});
