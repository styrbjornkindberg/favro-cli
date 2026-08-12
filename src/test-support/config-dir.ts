/**
 * A private config directory for a test file (#97).
 *
 * This owns only what the migration in #97 actually moved. There is no builder
 * API, no seam registry and no `entities` factory: the three seams this suite
 * uses (real socket, mocked `http-client`, mocked API class) all survive for the
 * reasons ADR-0007 records, and a helper that tried to abstract over all three
 * would be a fourth seam rather than one fewer.
 *
 * TWO CONFIG-DIR HELPERS LIVE IN THIS DIRECTORY, AND THE DIFFERENCE IS LIFETIME.
 * Pick by when the redirect has to be in place:
 *
 *   - `useTempConfigDir()` in `filter-vocabulary.ts` — per TEST, async, via
 *     `beforeEach`/`afterEach`, and writes no `config.json`. Right when each test
 *     wants a clean slate and nothing read the config at import time.
 *   - `tempConfigDir()` here — per SUITE, synchronous, callable at module scope,
 *     and writes a `config.json`. Right when the redirect must already be in
 *     place before the module under test is even required.
 *
 * The second exists because the first structurally cannot do that job: a
 * `beforeEach` runs long after the file's imports have been evaluated.
 */
// `node:fs`, not `fs`, and that is load-bearing: two suites that call this
// helper also `jest.mock('fs')`, and an auto-mocked `mkdtempSync` returns
// undefined — the redirect would silently point at "undefined" and the cleanup
// would delete nothing. Jest does not intercept the `node:`-prefixed specifier,
// which is why those files already reach for it directly.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A private `~/.favro` for one test file: a fresh temp dir holding
 * `config.json`, with `FAVRO_CONFIG_DIR` pointed at it.
 *
 * This replaces a three-line triple that stood in nine files byte for byte —
 * `mkdtempSync` / `writeFileSync(config.json)` / `process.env.FAVRO_CONFIG_DIR =`
 * — plus the teardown line that only some of them remembered.
 *
 * CALL IT AT MODULE SCOPE, above the `require()` of anything that reads config.
 * That is not stylistic. `configDir()` resolves per call (#65), but a module
 * that reads config during its own import reads it before any `beforeEach`
 * could steer it, and would then be pinned to the developer's real
 * `~/.favro/config.json` — which on this repo carries a live scope lock. Being
 * synchronous is therefore part of the contract; it cannot become async.
 *
 * `prefix` stays per-file rather than being a constant, so a temp dir that does
 * survive a crash still names the suite that made it.
 *
 * Cleanup registers itself. That is the point: the teardown was the most
 * duplicated line in the suite and the easiest to leave out, and a cleanup that
 * silently does nothing is indistinguishable from one that works — so
 * `__tests__/temp-config-dir.test.ts` asserts from an OUTER `afterAll`, after this one has
 * run, that the directory is gone and the previous env value is back.
 */
/**
 * What `FAVRO_CONFIG_DIR` held before this suite touched it. Captured once per
 * suite — Jest gives each test file a fresh module registry, so this is
 * per-suite state, not global state shared across the run.
 *
 * It is the FIRST value, not the previous one, because Jest runs `afterAll`
 * hooks in registration order (measured, not assumed). A per-call `previous`
 * therefore unwinds forwards: with two calls, the first hook restores the
 * original and the second then puts the first call's — by then deleted —
 * directory back. Restoring the same baseline from every hook is
 * order-independent and correct for any number of calls.
 */
let baseline: string | undefined;
let baselineCaptured = false;

export function tempConfigDir(prefix: string, config: unknown = {}): string {
  if (!baselineCaptured) {
    baseline = process.env.FAVRO_CONFIG_DIR;
    baselineCaptured = true;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  process.env.FAVRO_CONFIG_DIR = dir;

  // Restoring matters, not just deleting: a Jest worker runs suites one after
  // another in ONE process, so a leftover FAVRO_CONFIG_DIR is inherited by the
  // next suite in that worker.
  afterAll(() => {
    if (baseline === undefined) delete process.env.FAVRO_CONFIG_DIR;
    else process.env.FAVRO_CONFIG_DIR = baseline;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return dir;
}
