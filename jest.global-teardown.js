/**
 * Fail the run if it left anything in its private `os.tmpdir()` (#leak).
 *
 * See `jest.global-setup.js` for why the tmpdir is private. Because it is, the
 * predicate needs no prefix list and no per-file audit: anything still in there
 * when the last worker exits was created by this run and never removed.
 */
const fs = require('fs');

module.exports = async function globalTeardown() {
  const root = process.env.FAVRO_JEST_TMPROOT;
  if (!root) {
    throw new Error(
      'tmpdir leak check did not run: jest.global-setup.js never set FAVRO_JEST_TMPROOT. ' +
        'A check that inspects nothing passes for the wrong reason — fix the setup wiring.'
    );
  }

  const leaked = fs.readdirSync(root).sort();

  // Remove it either way. Leaving it on failure would leak one directory per
  // failing run, which is the bug this check exists to catch.
  fs.rmSync(root, { recursive: true, force: true });

  if (leaked.length === 0) return;

  // Grouped by mkdtemp prefix — its random suffix is the last 6 chars — because
  // one unfixed call site leaks one name per test, and the SITE is what the
  // reader has to go find.
  const byPrefix = new Map();
  for (const name of leaked) {
    const prefix = name.length > 6 ? name.slice(0, -6) : name;
    byPrefix.set(prefix, (byPrefix.get(prefix) || 0) + 1);
  }

  throw new Error(
    `tmpdir leak: ${leaked.length} entr${leaked.length === 1 ? 'y' : 'ies'} survived the test run.\n` +
      [...byPrefix]
        .sort((a, b) => b[1] - a[1])
        .map(([prefix, n]) => `  ${n} x ${prefix}*`)
        .join('\n') +
      '\n\nEvery mkdtemp needs a matching removal. For a per-suite config dir use ' +
      "tempConfigDir() from src/test-support/config-dir.ts; for a per-test one use useTempConfigDir()."
  );
};
