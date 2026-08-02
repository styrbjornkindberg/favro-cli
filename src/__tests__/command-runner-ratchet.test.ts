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
 * NOT YET MIGRATED to `run()`. Started as every file that had a preamble to
 * lose — sixty of the sixty-one scanned — and only ever shrinks, one line per
 * file, as #114 → #119 work through them.
 *
 * Do NOT add a line to make a red build green. A new name here is either a new
 * command written against the old preamble, which should be written against
 * `run()` instead, or a migrated command regressing, which should be fixed.
 */
const ALLOWLIST: readonly string[] = [
  'src/cli.ts',
  'src/commands/activity.ts',
  'src/commands/attachments.ts',
  'src/commands/auth.ts',
  'src/commands/batch-smart.ts',
  'src/commands/batch.ts',
  'src/commands/board-tui.ts',
  'src/commands/boards-create.ts',
  'src/commands/boards-delete.ts',
  'src/commands/boards-get.ts',
  'src/commands/boards-list.ts',
  'src/commands/boards-update.ts',
  'src/commands/browse.ts',
  'src/commands/cards-archive.ts',
  'src/commands/cards-delete.ts',
  'src/commands/cards-export.ts',
  'src/commands/cards-find.ts',
  'src/commands/cards-get.ts',
  'src/commands/cards-link.ts',
  'src/commands/cards-tracker.ts',
  'src/commands/collections-create.ts',
  'src/commands/collections-delete.ts',
  'src/commands/collections-get.ts',
  'src/commands/collections-list.ts',
  'src/commands/collections-update.ts',
  'src/commands/columns.ts',
  'src/commands/comments.ts',
  'src/commands/context.ts',
  'src/commands/custom-fields.ts',
  'src/commands/dependencies.ts',
  'src/commands/diff.ts',
  'src/commands/execute.ts',
  'src/commands/git.ts',
  'src/commands/health.ts',
  'src/commands/init.ts',
  'src/commands/main-menu.ts',
  'src/commands/members.ts',
  'src/commands/my-cards.ts',
  'src/commands/my-standup.ts',
  'src/commands/next.ts',
  'src/commands/overview.ts',
  'src/commands/propose.ts',
  'src/commands/query.ts',
  'src/commands/release-check.ts',
  'src/commands/risks.ts',
  'src/commands/scope.ts',
  'src/commands/shell.ts',
  'src/commands/skill.ts',
  'src/commands/sprint-plan.ts',
  'src/commands/stale.ts',
  'src/commands/standup.ts',
  'src/commands/tags.ts',
  'src/commands/tasklists.ts',
  'src/commands/tasks.ts',
  'src/commands/team.ts',
  'src/commands/tracker-init.ts',
  'src/commands/users.ts',
  'src/commands/webhooks.ts',
  'src/commands/widgets.ts',
  'src/commands/workload.ts',
];

// ─── the scan ────────────────────────────────────────────────────────────────

/** `src/cli.ts` plus every command module, repo-relative and slash-separated. */
function scannedFiles(): string[] {
  const commands = fs
    .readdirSync(path.join(REPO_ROOT, 'src', 'commands'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `src/commands/${name}`);
  return ['src/cli.ts', ...commands].sort();
}

/** Which banned spellings a file still contains. Empty means migrated. */
function offencesIn(file: string): string[] {
  const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf-8');
  return BANNED.filter(({ pattern }) => pattern.test(source)).map(({ what }) => what);
}

const files = scannedFiles();
const offences = new Map(files.map((file) => [file, offencesIn(file)]));
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

  it('no allowlisted file has been renamed or deleted out from under the list', () => {
    expect(ALLOWLIST.filter((file) => !files.includes(file))).toEqual([]);
  });
});
