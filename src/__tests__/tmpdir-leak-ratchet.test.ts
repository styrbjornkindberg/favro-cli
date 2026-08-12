/**
 * The tmpdir leak check has to keep BEING a check (#leak).
 *
 * `jest.global-teardown.js` guards one way it can inspect nothing — it throws if
 * `FAVRO_JEST_TMPROOT` is unset, so a broken setup cannot pass vacuously. It does
 * not guard the other way, and that one is bigger: `globalTeardown` runs after the
 * last suite, so NO test can observe its effect, and deleting its line from
 * `jest.config.js` removes the entire ratchet in silence. Measured: with that one
 * line deleted and a suite leaking a temp dir, `npx jest` exits **0**.
 *
 * `silence-output.test.ts` pins its own wiring for free, because a test can watch
 * the writers it swapped. This one cannot, so the wiring is asserted directly.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const jestConfig = require('../../jest.config.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const globalTeardown = require('../../jest.global-teardown.js') as () => Promise<void>;

describe('tmpdir leak ratchet', () => {
  it('still wires both halves into jest.config.js', () => {
    expect(jestConfig.globalSetup).toBe('<rootDir>/jest.global-setup.js');
    expect(jestConfig.globalTeardown).toBe('<rootDir>/jest.global-teardown.js');
  });

  it('put this worker inside the private tmpdir, so a leak here is visible there', () => {
    const root = process.env.FAVRO_JEST_TMPROOT;
    expect(root).toBeTruthy();
    // The redirect, not the env var: a worker is a forked process, and one that
    // did not inherit TMPDIR would leak to the real $TMPDIR unseen by the check.
    const dir = mkdtempSync(join(tmpdir(), 'favro-leak-ratchet-'));
    try {
      expect(dir.startsWith(String(root))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * "Is it empty", never "does the name look familiar". A plain file and a nested
   * directory both count — an emptiness test that only counted mkdtemp-shaped
   * directory names would be the allowlist the design exists to avoid.
   */
  it.each([
    ['a leaked directory', (r: string) => mkdirSync(join(r, 'favro-somethingXXXXXX'))],
    ['a leaked plain file', (r: string) => writeFileSync(join(r, 'stray.json'), '{}')],
    ['a nested non-empty directory', (r: string) => mkdirSync(join(r, 'a', 'b'), { recursive: true })],
  ])('fails the run on %s', async (_label, leak) => {
    const saved = process.env.FAVRO_JEST_TMPROOT;
    // A throwaway stand-in root: the teardown removes whatever it is pointed at,
    // and pointing it at the real one would delete the run's tmpdir mid-run.
    const root = mkdtempSync(join(tmpdir(), 'favro-leak-probe-'));
    leak(root);
    process.env.FAVRO_JEST_TMPROOT = root;
    try {
      await expect(globalTeardown()).rejects.toThrow(/tmpdir leak: 1 entry survived/);
    } finally {
      process.env.FAVRO_JEST_TMPROOT = saved;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to pass when the setup never ran', async () => {
    const saved = process.env.FAVRO_JEST_TMPROOT;
    delete process.env.FAVRO_JEST_TMPROOT;
    try {
      await expect(globalTeardown()).rejects.toThrow(/did not run/);
    } finally {
      process.env.FAVRO_JEST_TMPROOT = saved;
    }
  });
});
