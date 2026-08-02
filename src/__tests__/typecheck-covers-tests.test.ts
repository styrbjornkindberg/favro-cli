/**
 * The type-check ratchet (#121).
 *
 * WHAT IT GUARDS
 * Two configs that must disagree, on purpose:
 *
 *   - `tsconfig.json` BUILDS, so it excludes `**\/*.test.ts` to keep test files
 *     out of `dist/`.
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

describe('type-check coverage', () => {
  it('keeps test files out of the build config, so dist/ stays clean', () => {
    const built = fileNamesOf('tsconfig.json').filter((f) => f.endsWith('.test.ts'));
    expect(built).toEqual([]);
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
