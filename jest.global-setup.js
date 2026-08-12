/**
 * Give the whole test run a PRIVATE `os.tmpdir()` (#leak).
 *
 * Every `mkdtemp` under `src/` builds its path from `os.tmpdir()`, and
 * `os.tmpdir()` re-reads the env on every call — so pointing the env at a fresh
 * directory here puts every temp dir the run creates, under any prefix, inside
 * one place we own. `jest.global-teardown.js` then only has to ask whether that
 * place is empty.
 *
 * That question is the point. A per-prefix or per-file cleanup audit would only
 * catch the spellings someone remembered to list; "did the run leave anything
 * behind" catches a suite written tomorrow with a prefix nobody has typed yet.
 *
 * Jest runs this in the main process BEFORE it forks any worker, and workers
 * inherit `process.env` at fork time, so the redirect reaches them.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = async function globalSetup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'favro-jest-run-'));

  // TMPDIR is what Node reads on posix; TMP/TEMP are the Windows spellings.
  // ponytail: all three, because os.tmpdir()'s precedence is platform-dependent
  // and one missing name would make the redirect silently not apply.
  process.env.TMPDIR = root;
  process.env.TMP = root;
  process.env.TEMP = root;

  // ts-jest pulls in `v8-compile-cache-lib`, which parks a PERSISTENT code cache
  // at `os.tmpdir()/v8-compile-cache-<uid>` — so with the redirect above it would
  // land in the private root and read as a leak. Turning it off (the lib's own
  // switch, measured at v8-compile-cache-lib/v8-compile-cache.js:350) costs
  // nothing here: a fresh root every run means that cache is always cold anyway.
  // The alternative — an ignore-list in the teardown — would start the slide from
  // "did the run leave anything" back to "does the name match something we listed".
  process.env.DISABLE_V8_COMPILE_CACHE = '1';

  // Read back by the teardown. Its own absence is a failure there: without it
  // the teardown would have nothing to inspect and would pass vacuously.
  process.env.FAVRO_JEST_TMPROOT = root;
};
