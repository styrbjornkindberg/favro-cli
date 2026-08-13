/**
 * The command-runner ratchet (#113, ADR-0002).
 *
 * WHAT IT GUARDS
 * `run()` (`src/lib/run.ts`) owns the preamble, the output and the exit code, so
 * a command that still builds its own client, prints its own JSON or exits the
 * process is a command the runner does not govern. There are 128 actions and
 * they migrate over seven steps (#113 → #119); without a ratchet, step seven
 * would be a re-audit of everything steps one to six touched, and command #129
 * could reintroduce the preamble the day after the last one landed.
 *
 * HOW IT DETECTS ONE
 * Five literal patterns, over the text of `src/cli.ts` and `src/commands/`:
 *
 *   - `createFavroClient(`        the runner builds the client (114 sites)
 *   - `process.exit(`             the runner sets `process.exitCode` (292 sites)
 *   - `console.log(JSON.stringify` the runner writes the envelope (91 sites)
 *   - `.opts()?.verbose`          `ctx.verbose`, resolved from the root (#85)
 *   - `new […]API(`               `ctx.api`, lazy and memoised (113 sites)
 *
 * Text, not the type checker, unlike `scope-lock-coverage.test.ts`: every one of
 * these is a *spelling* rather than a behaviour, so the thing to ban is the
 * spelling. A match inside a comment or a string counts — false positives here
 * cost a file its place on the allowlist for one more step, which is cheap, and
 * a scanner nobody can predict is a scanner people work around.
 *
 * WHY THE ALLOWLIST FAILS IN BOTH DIRECTIONS
 * A non-allowlisted file containing a banned pattern fails — that is the
 * obvious half, and it is what stops a migrated command regressing. The other
 * half is the point: AN ALLOWLISTED FILE THAT IS ALREADY CLEAN ALSO FAILS,
 * until it is struck off. Without it the list rusts into permanent cover — it
 * would still be sixty lines long when only three files were dirty, and nobody
 * reading it could tell which. When the list empties, the ban is absolute.
 *
 * WHY THE BAN ALONE IS NOT ENOUGH
 * "Contains none of five strings" is not "migrated". A migrator who hoisted
 * `createFavroClient` into a shared helper instead of adopting `run()` would go
 * clean, get struck off, and leave the ratchet green over a command the runner
 * never touched. So a file leaving the allowlist must also IMPORT `run` —
 * unless it is named in `RUNNER_FREE` below, which is the short, argued list of
 * commands that legitimately have no runner to adopt.
 *
 * TO DISCHARGE AN ENTRY: migrate the file to `run()`, then delete its line.
 * Deleting the line is not optional; the build stays red until you do.
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** The preamble, by its spellings. Each is one thing `run()` took over. */
const BANNED: ReadonlyArray<{ readonly what: string; readonly pattern: RegExp }> = [
  { what: 'createFavroClient(', pattern: /createFavroClient\(/ },
  { what: 'process.exit(', pattern: /process\.exit\(/ },
  { what: 'console.log(JSON.stringify', pattern: /console\.log\(JSON\.stringify/ },
  { what: '.opts()?.verbose', pattern: /\.opts\(\)\?\.verbose/ },
  { what: 'new […]API(', pattern: /new \w*API\(/ },
];

/**
 * `import … from '…/lib/run'`. The prefix is left loose because it depends on
 * depth — `./lib/run` from `cli.ts`, `../lib/run` from `src/commands/`, one
 * more `../` from any subdirectory a later step introduces.
 */
const IMPORTS_RUN = /from '[./]*lib\/run'/;

/**
 * Off the allowlist, and legitimately not a `run()` caller.
 *
 * `issue-tracker-help.ts` registers a `--help` topic: no client, no output of
 * its own, nothing for the runner to own. It is the reason this list exists
 * rather than a blanket "everything must import run" — but it is one file, and
 * a second entry should have to be argued on the issue.
 */
const RUNNER_FREE: readonly string[] = ['src/commands/issue-tracker-help.ts'];

/**
 * NOT YET MIGRATED to `run()`. Started as every file that had a preamble to
 * lose — all but one of the files scanned — and only ever shrinks, one line per
 * file, as #114 → #119 work through them.
 *
 * Do NOT add a line to make a red build green. A new name here is either a new
 * command written against the old preamble, which should be written against
 * `run()` instead, or a migrated command regressing, which should be fixed.
 */
const ALLOWLIST: readonly string[] = [
  'src/cli.ts',
  'src/commands/attachments.ts',
  // `batch-smart.ts` and `batch.ts` were here until #110 DELETED them. They were
  // struck off by deletion rather than by migration, which is the other way a
  // line leaves this list.
  'src/commands/cards-archive.ts',
  'src/commands/cards-delete.ts',
  'src/commands/cards-link.ts',
  'src/commands/cards-tracker.ts',
  'src/commands/columns.ts',
  'src/commands/custom-fields.ts',
  'src/commands/dependencies.ts',
  'src/commands/scope.ts',
  'src/commands/tags.ts',
  'src/commands/tasklists.ts',
  'src/commands/tasks.ts',
  'src/commands/users.ts',
  'src/commands/widgets.ts',
];

// ─── the scan ────────────────────────────────────────────────────────────────

/**
 * `src/cli.ts` plus every command module, repo-relative and slash-separated.
 *
 * Recursive: a future `src/commands/boards/` must not drop out of scope
 * silently. Hand-rolled rather than `readdirSync(…, { recursive: true })`,
 * which needs Node 20 and CI still runs the matrix on 18.
 */
function scannedFiles(): string[] {
  const walk = (dir: string): string[] =>
    fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
      if (entry.isDirectory()) return walk(`${dir}/${entry.name}`);
      return entry.name.endsWith('.ts') ? [`${dir}/${entry.name}`] : [];
    });
  return ['src/cli.ts', ...walk('src/commands')].sort();
}

const sourceOf = (file: string): string =>
  fs.readFileSync(path.join(REPO_ROOT, file), 'utf-8');

/** Which banned spellings a file still contains. Empty is necessary, not sufficient. */
function offencesIn(source: string): string[] {
  return BANNED.filter(({ pattern }) => pattern.test(source)).map(({ what }) => what);
}

const files = scannedFiles();
const sources = new Map(files.map((file) => [file, sourceOf(file)]));
const offences = new Map(files.map((file) => [file, offencesIn(sources.get(file)!)]));
const dirty = files.filter((file) => offences.get(file)!.length > 0);

// ─────────────────────────────────────────────────────────────────────────────

describe('the command-runner ratchet', () => {
  it('finds the files it is meant to be reading', () => {
    // A scanner that resolved nothing would report zero violations and pass
    // forever. A floor, not a count to keep updated.
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain('src/cli.ts');
  });

  it('bans nothing that has already vanished from the codebase', () => {
    // A pattern matching nothing anywhere is a dead ban: it would keep passing
    // if it were misspelled. Every one of the five must still have a live
    // example somewhere, until the allowlist empties and this stops holding —
    // at which point the ban is absolute and this assertion is what to delete.
    const live = BANNED.filter(({ what }) =>
      dirty.some((file) => offences.get(file)!.includes(what)),
    );
    expect(live.map(({ what }) => what)).toEqual(BANNED.map(({ what }) => what));
  });

  it('no file outside the allowlist carries the old preamble', () => {
    const violations = dirty
      .filter((file) => !ALLOWLIST.includes(file))
      .map((file) => `${file} — ${offences.get(file)!.join(', ')}`);
    expect(violations).toEqual([]);
  });

  it('no allowlisted file is already clean — a migrated file must be struck off', () => {
    // The direction that stops the list rusting into permanent cover. If this
    // fails, the fix is to DELETE the named lines, never to re-dirty the file.
    const struck = ALLOWLIST.filter((file) => !dirty.includes(file));
    expect(struck).toEqual([]);
  });

  it('every file off the allowlist actually adopted run()', () => {
    // The positive half. Without it the ban means "quiet", not "migrated": a
    // file whose preamble moved into a shared helper reads clean and gets
    // struck off while the runner governs nothing it does.
    const quiet = files
      .filter((file) => !ALLOWLIST.includes(file) && !RUNNER_FREE.includes(file))
      .filter((file) => !IMPORTS_RUN.test(sources.get(file)!));
    expect(quiet).toEqual([]);
  });

  it('no allowlisted file has been renamed or deleted out from under the list', () => {
    expect(ALLOWLIST.filter((file) => !files.includes(file))).toEqual([]);
  });

  it('no RUNNER_FREE entry is stale', () => {
    // Same staleness rule the scope-lock ratchet applies to its two lists: an
    // entry that no longer exists, or that now imports `run`, has to go.
    const stale = RUNNER_FREE.filter(
      (file) => !files.includes(file) || IMPORTS_RUN.test(sources.get(file) ?? ''),
    );
    expect(stale).toEqual([]);
  });
});

// ─── the hard-exit ban, over every production module (#133) ──────────────────

/**
 * WHY THIS IS A SECOND SCAN AND NOT A SIXTH PATTERN
 * The five bans above are the command PREAMBLE, and nothing outside
 * `src/commands/` has one to lose: `safety.ts` legitimately writes
 * `new CardsAPI(`, and no library module has a `run()` to adopt, so widening the
 * scan above would need both allowlists re-argued for files the runner will
 * never govern.
 *
 * One of the five DOES belong everywhere. A hard exit in a library is worse than
 * in a command, which is exactly what #133 was: `safety.ts`'s scope guards
 * exited the process from four call depths down, so the runner's error boundary
 * never ran and a scope violation under the JSON default wrote NOTHING to
 * stdout. `src/lib/` was invisible to the scan above, so the spelling was not
 * banned anywhere and nothing caught it for six migration steps.
 *
 * WHY IT WALKS ALL OF `src/` AND NOT JUST `src/lib/`
 * #133 first shipped this scoped to `src/lib/`, which left the identical hole
 * one directory over. Measured on the review of that branch, both on a
 * green tree: a live `process.exit(1)` added to `src/api/comments.ts` — a module
 * `git.ts`, `comments.ts` and `attachments.ts` all import — passed 162 suites /
 * 3084 tests. `src/api/`, `src/test-support/` and the two server entry points
 * were as invisible as `src/lib/` had been. A ban that names the directory it
 * was written for is a ban on one bug, so the walk is now every non-test file
 * under `src/`, and the unmigrated commands are excused by the ALLOWLIST above
 * rather than by being out of scope — which means they lose the excuse
 * automatically when #115–#119 strike them off.
 *
 * WHY TWO SPELLINGS
 * Same measurement: `import { exit } from 'node:process'` and then `exit(1)` is
 * a live hard exit that `process.exit(` cannot see, and it too passed all 162
 * suites / 3084 tests from inside `src/lib/read-shape.ts`. Banning the IMPORT
 * rather than trying to enumerate call spellings keeps the scan text-literal and
 * covers every re-spelling of it (`{ exit }`, `{ default as process }`,
 * `require('node:process')`). Nothing in `src/` imports that module today, which
 * is why the pattern needs the self-check arm below: it has no live example to
 * prove it is not simply misspelled.
 *
 * The ban is text-literal, same as above, so a match in a comment counts —
 * which is why `safety.ts`'s prose now says `process.exit` without the call
 * parens where it used to spell the whole thing out. That is the cost, and it is
 * the cheap side: a scanner that has to parse before it bans can be wrong.
 */
const EXIT_SPELLINGS: ReadonlyArray<{ readonly what: string; readonly pattern: RegExp }> = [
  { what: 'process.exit(', pattern: /process\.exit\(/ },
  { what: "import from 'process'", pattern: /(?:from|require\()\s*['"](?:node:)?process['"]/ },
];

const EXIT_ALLOWED: readonly string[] = [
  // `ErrorFormatter.fatal` — declared `never`, so the exit IS its contract. It
  // has no production caller left (only its own test), and deleting a module
  // export from a published package is a semver call, not a ratchet's.
  'src/lib/error-handler.ts',
  // The stdio MCP entry point, under `require.main === module`: a transport that
  // will not connect has no boundary to report to and no command to fail.
  'src/mcp-server.ts',
];

/** Every production module. Tests and integration tests are not shipped. */
function productionFiles(): string[] {
  const walk = (dir: string): string[] =>
    fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
      if (entry.isDirectory()) {
        return entry.name.startsWith('__') ? [] : walk(`${dir}/${entry.name}`);
      }
      return entry.name.endsWith('.ts') ? [`${dir}/${entry.name}`] : [];
    });
  return walk('src').sort();
}

/** THE scan. The self-check arm runs this, not a hand-rolled copy of it. */
const exitOffencesIn = (source: string): string[] =>
  EXIT_SPELLINGS.filter(({ pattern }) => pattern.test(source)).map(({ what }) => what);

describe('no module exits the process', () => {
  const production = productionFiles();
  const exiting = production.filter((file) => exitOffencesIn(sourceOf(file)).length > 0);
  // An unmigrated command is expected to exit — that is what ALLOWLIST above
  // records, and it shrinks as #115–#119 land. Reused rather than copied so the
  // two lists cannot disagree.
  const excused = (file: string) => EXIT_ALLOWED.includes(file) || ALLOWLIST.includes(file);

  it('finds the files it is meant to be reading', () => {
    // A floor, not a count to keep updated. A scanner resolving nothing would
    // report zero violations and pass forever. One name per directory the
    // `src/lib`-only version of this scan could not see.
    expect(production.length).toBeGreaterThan(100);
    expect(production).toEqual(
      expect.arrayContaining([
        'src/cli.ts',
        'src/lib/safety.ts',
        'src/api/comments.ts',
        'src/test-support/scope-passthrough.ts',
        'src/mcp-http-server.ts',
      ]),
    );
    expect(production.filter((f) => f.includes('__tests__'))).toEqual([]);
  });

  it('detects each banned spelling — the scan itself, on a known-dirty string', () => {
    // The self-check. `import from 'process'` has no live example in the tree, so
    // nothing else would notice it being misspelled into a pattern that matches
    // nothing. Both arms of every spelling: it fires, and it does not fire on the
    // shape it must tolerate.
    expect(exitOffencesIn('  process.exit(1);')).toEqual(['process.exit(']);
    expect(exitOffencesIn("import { exit } from 'node:process';")).toEqual([
      "import from 'process'",
    ]);
    expect(exitOffencesIn("const { exit } = require('process');")).toEqual([
      "import from 'process'",
    ]);
    // `process.exitCode` is the sanctioned replacement, and `process-title` is
    // not the process module — neither may trip either pattern.
    expect(exitOffencesIn("process.exitCode = 1;\nimport x from './process-title';")).toEqual([]);
  });

  it('bans the spelling everywhere it is not argued for', () => {
    expect(exiting.filter((file) => !excused(file))).toEqual([]);
  });

  it('has no stale entry on the short list of exceptions', () => {
    // Both directions, same as the allowlist above: an entry that has gone
    // clean, or been renamed away, must be struck off rather than left as cover.
    expect(EXIT_ALLOWED.filter((file) => !exiting.includes(file))).toEqual([]);
  });
});
