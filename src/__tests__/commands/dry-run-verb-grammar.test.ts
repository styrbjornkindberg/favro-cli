/**
 * `dryRunLog`'s verb is an INFINITIVE — #162 item 10.
 *
 * The template is `Would ${verb} ${targetType} "${targetName}"`, and 17 of its
 * 19 call sites passed a participle, so the CLI said `Would creating tag "x"`.
 * The two that read correctly (`git.ts`) were the two that passed a bare verb,
 * which is what settled which half to change.
 *
 * A scan, not one arm per command: the defect is a call-site convention, and a
 * single command's arm would leave the other eighteen free to reintroduce it —
 * as one nearly did, since `Would creating tag` was pinned verbatim by
 * `tags-create-dry-run-wire.test.ts` and green.
 *
 * Text over types, the same trade `command-runner-ratchet.test.ts` names: what
 * is banned is a spelling, and a scanner people can predict is one they do not
 * work around.
 */
import * as fs from 'fs';
import * as path from 'path';
import { dryRunLog } from '../../lib/safety';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const COMMANDS = path.join(REPO_ROOT, 'src', 'commands');

/**
 * `dryRunLog('creating', …` — the verb is the first argument, always a literal.
 *
 * Two things this scan cannot see, both true of `src/commands` today and neither
 * asserted: `readdirSync` is NOT recursive, so a call site in a future
 * subdirectory is invisible, and the pattern matches single-quoted literals only,
 * so a template literal or a double-quoted verb passes unread. The floor below is
 * the only thing that notices a scan that stopped resolving anything.
 */
const CALL = /dryRunLog\(\s*'([^']+)'/g;

function callSites(): Array<{ file: string; verb: string }> {
  return fs
    .readdirSync(COMMANDS)
    .filter((f) => f.endsWith('.ts'))
    .flatMap((f) => {
      const source = fs.readFileSync(path.join(COMMANDS, f), 'utf-8');
      return [...source.matchAll(CALL)].map((m) => ({ file: `src/commands/${f}`, verb: m[1] }));
    });
}

const sites = callSites();

describe('every dry-run preview reads as English (#162 item 10)', () => {
  it('finds the call sites it is meant to be reading', () => {
    // A scan that resolved nothing would pass forever. A floor, not a count to
    // keep updated — 19 at the time of writing.
    expect(sites.length).toBeGreaterThan(15);
    expect(sites.map((s) => s.file)).toContain('src/commands/tags.ts');
  });

  it('no call site passes a participle', () => {
    // A SPELLING heuristic, not a parser: `/ing$/` would also flag a legitimate
    // infinitive ending in those letters (`ping`, `bring`, `string`). None of the
    // 19 verbs is one, and a `dryRunLog('ping', …)` would have to be spelled
    // around this rather than reasoned with.
    const participles = sites.filter((s) => /ing$/.test(s.verb));
    expect(participles).toEqual([]);
  });

  it('renders the sentence a caller actually sees', () => {
    // The real function, not a restatement of the rule: the ban above only
    // means something if this is the sentence the verb lands in.
    const printed: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((...a) => { printed.push(String(a[0])); });
    try {
      dryRunLog('create', 'tag', 'release');
    } finally {
      spy.mockRestore();
    }
    expect(printed.join('\n')).toContain('Would create tag "release"');
  });
});
