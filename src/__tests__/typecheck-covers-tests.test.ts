/**
 * The type-check ratchet (#121).
 *
 * WHAT IT GUARDS
 * Two configs that must disagree, on purpose:
 *
 *   - `tsconfig.json` BUILDS, so it excludes the test-only directories and
 *     `**\/*.test.ts` to keep test code out of `dist/`.
 *   - `tsconfig.test.json` CHECKS, so it must not.
 *
 * Before #121 only the first existed, and `tsc --noEmit` — the CI gate — never
 * looked at a single one of the ~130 test files. Four calls in
 * `cards.integration.test.ts` passed an argument `listCards` had already
 * dropped, and both green gates stayed green.
 *
 * Reads the real file lists through the TypeScript config parser rather than
 * eyeballing the `exclude` arrays, because what matters is which files each
 * config ends up compiling, not how it got there.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function fileNamesOf(configName: string): string[] {
  const configPath = path.join(REPO_ROOT, configName);
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  expect(read.error).toBeUndefined();

  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, REPO_ROOT);
  expect(parsed.errors).toEqual([]);

  return parsed.fileNames.map((f) => path.relative(REPO_ROOT, f));
}

/**
 * Test-only code, by DIRECTORY and not just by extension (#128).
 *
 * #121 filtered on `.test.ts` and so never noticed `src/__integration__/helpers.ts`
 * or `src/test-support/*` — neither is named `*.test.ts`, both were in the build
 * config's file list, and both were emitted into `dist/` and shipped.
 */
const TEST_ONLY = /(^|\/)(__tests__|__integration__|test-support)(\/|$)|\.test\.ts$/;

const posix = (f: string): string => f.split(path.sep).join('/');

describe('type-check coverage', () => {
  it('keeps test-only code out of the build config, so dist/ stays clean', () => {
    const built = fileNamesOf('tsconfig.json');

    // Self-check: a scan that enumerated nothing would pass the filter vacuously.
    expect(built.length).toBeGreaterThan(50);
    expect(built).toContain(path.join('src', 'cli.ts'));

    expect(built.filter((f) => TEST_ONLY.test(posix(f)))).toEqual([]);

    // `exclude` only prunes the ROOT list — tsc still compiles and emits whatever
    // those roots import. So a production `import '../test-support/x'` would put
    // test code back in dist/ with the filter above still green.
    const importers = built.filter((f) =>
      [...fs.readFileSync(path.join(REPO_ROOT, f), 'utf8').matchAll(/from '([^']+)'/g)].some(
        ([, spec]) => TEST_ONLY.test(spec)
      )
    );
    expect(importers).toEqual([]);
  });

  it('checks the unit and integration suites through tsconfig.test.json', () => {
    const checked = fileNamesOf('tsconfig.test.json');

    expect(checked).toContain(path.join('src', '__integration__', 'cards.integration.test.ts'));
    expect(checked.filter((f) => f.startsWith(path.join('src', '__tests__'))).length).toBeGreaterThan(100);
  });

  it('checks everything the build config compiles', () => {
    const checked = new Set(fileNamesOf('tsconfig.test.json'));
    const missing = fileNamesOf('tsconfig.json').filter((f) => !checked.has(f));

    expect(missing).toEqual([]);
  });
});
