/**
 * The documented-command ratchet (#127).
 *
 * WHAT IT GUARDS
 * A doc that teaches a command the binary refuses is the same failure as a
 * broken build, one layer out: the agent reading `API-REFERENCE.md` runs
 * `favro activity log board-x --offset 50` and gets `unknown command`. #124
 * swept three of these by hand and left three more (`activity log`, `cards
 * blockers`, `git install-hooks`) — which is the actual finding. Manual sweeps
 * leave a remainder every time, so this reads the docs against the binary.
 *
 * IT WALKS THE REAL SURFACE, NOT A LIST
 * The right-hand side is `buildProgram()` — the same tree the CLI hands to
 * commander, indexed by argv path (`cards blocking`, `git sync`, …). A hand-kept
 * list of valid names would be a second thing to forget to update, which is the
 * bug this file exists to stop.
 *
 * WHAT COUNTS AS "A DOCUMENTED COMMAND", AND WHY THE LINE IS DRAWN HERE
 * Only a `favro …` invocation that a reader would copy and run:
 *
 *   - it lives inside a fenced code block or an inline `code span`, and
 *   - after the segment is split on shell operators (`|`, `&&`, `;`, `$(`, `)`,
 *     backtick, em dash), the fragment STARTS with `favro` — optionally behind a
 *     `$ ` prompt or `npx `.
 *
 * Prose is deliberately out. "the favro binary path (same package)" inside a
 * code comment is not a command, and a scanner that flagged it would be loosened
 * by the next person until it flagged nothing — the over-eager regex dies the
 * same death as the under-eager one, just louder. Backticks are the line because
 * that is the convention the docs already follow, without exception, for every
 * runnable example.
 *
 * The reverse risk — a scan so narrow it silently matches nothing — is what the
 * self-check block at the bottom exists for.
 *
 * WHAT IS CHECKED, ONCE A FRAGMENT IS A COMMAND
 *   1. UNRESOLVED — the first word is not a registered command (`favro propose`).
 *   2. GROUPONLY  — the first word is a group with no action of its own, so the
 *      doc must name a subcommand that exists (`favro cards blockers`,
 *      `favro git install-hooks`). This is the arm that catches a renamed or
 *      deleted subcommand.
 *   3. ARITY      — the invocation passes more positional arguments than the
 *      command declares. This is the only arm that can see `favro activity log
 *      board-001`: `activity` is a LEAF taking one `<card>`, so `log` is
 *      structurally an argument, not a subcommand, and no name-resolution check
 *      can tell the two apart. Arity can: two positionals into a one-argument
 *      command is a fact about the surface, not a heuristic. It also catches
 *      every `--offset` line for free, since they are all on `activity log`.
 *
 * Unknown OPTIONS are not reported. Measured before it was dropped, that arm
 * found ~30 pre-existing findings across `specs/` and `docs/research/` — dead
 * flags on commands whose design changed — and an allowlist of thirty entries is
 * a dumping ground, not a ratchet. They are reported on #127 instead. What is
 * kept is the part needed to count positionals correctly:
 *
 *   ponytail: an UNRECOGNISED option is assumed to take one value when the next
 *   token is not itself an option. That is right for `--offset 10` and for every
 *   dead `--board <id>` in `specs/`, and wrong only for a boolean flag written
 *   immediately before a positional — a shape that appears nowhere in the docs
 *   today. If one shows up as a false ARITY, teach this the real option list for
 *   that command rather than loosening the arity check.
 *
 * THE ALLOWLIST IS ONE LIST, ON PURPOSE
 * Seven entries survive, keyed `<file>  <command the doc claims>` — no line
 * numbers, so an edit above an example does not invalidate its entry. Some are
 * debt (a doc passing an argument the command does not take) and one is a
 * decision (an ADR whose subject IS a deleted command, so it will always name
 * it). At seven entries, with each reason naming what would delete it, a second
 * list would be ceremony; `scope-lock-coverage.test.ts` splits its two because
 * it carries twenty-one. Revisit if this one grows.
 *
 * Every entry is checked for STALENESS: an allowlisted line that has been fixed,
 * or that no longer exists under that key, fails the build. A list nobody prunes
 * turns into a permanent exemption that reads like debt.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import { Command } from 'commander';
import { buildProgram } from '../cli';

/**
 * Documented invocations that do not resolve, and are not #127's to fix.
 * Keyed `<file>  <command the doc claims>`, valued with why it is still here.
 * A new entry is a new lie in the docs — fix the doc, do not add a line.
 */
const ALLOWLIST: Record<string, string> = {
  // DEBT — real doc drift, filed on #127, not absorbed by it. Each is a
  // positional argument the command does not declare (all four take flags).
  'EXAMPLES.md  standup': '#127 — `standup` takes no board argument, only --board',
  'EXAMPLES.md  sprint-plan': '#127 — `sprint-plan` takes no board argument, only --board',
  'docs/git-integration.md  git link': '#127 — `git link` takes no card argument, only --card',
  'docs/git-integration.md  git commit': '#127 — `git commit` takes no card/message argument, only -m/--card',
  'specs/SPEC-002-enhanced-api.md  cards search': '#127 — specced, never built; the spec is a dated record',
  // DECISION — an ADR titled "delete propose/execute" has to name them.
  'docs/adr/0004-delete-propose-execute.md  propose': 'the ADR that deleted it; naming it is the point',
  'docs/adr/0004-delete-propose-execute.md  execute': 'the ADR that deleted it; naming it is the point',
};

// ─── the real command surface ────────────────────────────────────────────────

/** Every argv path `buildProgram()` answers to, including aliases. */
function indexSurface(): Map<string, Command> {
  const byPath = new Map<string, Command>();
  (function walk(cmd: Command, prefix: string[]) {
    if (prefix.length) byPath.set(prefix.join(' '), cmd);
    for (const sub of cmd.commands) {
      walk(sub, [...prefix, sub.name()]);
      for (const alias of sub.aliases()) byPath.set([...prefix, alias].join(' '), sub);
    }
  })(buildProgram(), []);
  // Commander adds `help [command]` lazily, so it is absent from `.commands`
  // above while `favro help issue-tracker` works. Registered by hand rather
  // than special-cased at the call site.
  byPath.set('help', new Command('help').argument('[command]'));
  return byPath;
}

const SURFACE = indexSurface();

// ─── reading the docs ────────────────────────────────────────────────────────

/**
 * Tracked Markdown. `git ls-files` rather than a directory walk: tracked is the
 * definition that matters (an untracked scratch file teaches nobody), and it
 * skips `node_modules` and any stale `dist/` for free — #128 owns that mess and
 * this scan must not trip over it.
 */
const DOC_FILES: string[] = execSync('git ls-files "*.md"', {
  cwd: `${__dirname}/../..`,
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(Boolean);

/** Fragment boundaries: past one of these, the words belong to something else. */
const SHELL_SPLIT = /\|\||&&|[|;`]|\$\(|\)|—/;

/**
 * The argv a documented `favro …` fragment would produce, or nothing.
 *
 * Quote-aware, because `--title "Fix login bug"` is one value and three
 * whitespace-separated words. A quoted run collapses to `_` so it stays a single
 * token without smuggling its contents in as flags. `${{ … }}` (GitHub Actions)
 * is flattened first for the same reason.
 */
function invocations(segment: string): string[][] {
  const flattened = segment.replace(/\$\{\{[^}]*\}\}/g, '$PLACEHOLDER');
  const found: string[][] = [];
  for (const fragment of flattened.split(SHELL_SPLIT)) {
    const match = /^\s*(?:[$>#]\s+)?(?:npx\s+)?favro\s+(\S.*?)\s*$/.exec(fragment);
    if (!match) continue;
    const tokens: string[] = [];
    let current = '';
    let quote: string | null = null;
    for (const ch of match[1]) {
      if (quote) {
        if (ch === quote) quote = null;
        else current += ch;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        current += '_';
        continue;
      }
      if (/\s/.test(ch)) {
        if (current) tokens.push(current);
        current = '';
        continue;
      }
      // A comment or a redirect ends the command; `2>` counts as a redirect.
      if ((ch === '#' || ch === '>') && !current) break;
      if (ch === '>' && /^\d$/.test(current)) break;
      current += ch;
    }
    // A trailing lone `\` is a line continuation, not an argument.
    if (current && current !== '\\') tokens.push(current);
    found.push(
      tokens.map((t) => t.replace(/^\[+/, '').replace(/[\],.]+$/, '')).filter(Boolean),
    );
  }
  return found;
}

interface Invocation {
  file: string;
  line: number;
  tokens: string[];
}

/** Every `favro …` invocation in every tracked doc, with where it was written. */
function readDocs(): Invocation[] {
  const found: Invocation[] = [];
  for (const file of DOC_FILES) {
    let inFence = false;
    fs.readFileSync(`${__dirname}/../../${file}`, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (/^\s*```/.test(line)) {
          inFence = !inFence;
          return;
        }
        // In a fence the whole line is code; outside it, only the code spans are.
        const segments = inFence
          ? [line]
          : [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
        for (const segment of segments) {
          for (const tokens of invocations(segment)) found.push({ file, line: i + 1, tokens });
        }
      });
  }
  return found;
}

const INVOCATIONS = readDocs();

// ─── the check ───────────────────────────────────────────────────────────────

interface Finding {
  /** `<file>  <command the doc claims>` — the allowlist key. No line number. */
  key: string;
  /** Human-readable, for the failure message. */
  report: string;
}

/** A `<placeholder>`, `$VAR` or quoted run — never a command name. */
const PLACEHOLDER = /^[<$_]|^\.{3}/;

/** What is wrong with this invocation, if anything. */
function inspect(inv: Invocation): Finding | undefined {
  const positional = inv.tokens.filter((t) => !t.startsWith('-'));
  // `favro --help`, or a doc showing the shape rather than a command.
  if (!positional.length || PLACEHOLDER.test(positional[0])) return undefined;

  const at = `${inv.file}:${inv.line}  favro ${inv.tokens.join(' ')}`;
  const finding = (key: string, what: string): Finding => ({
    key: `${inv.file}  ${key}`,
    report: `${at}  — ${what}`,
  });

  let cmd: Command | undefined;
  let depth = 0;
  for (const d of [2, 1]) {
    const candidate = positional.slice(0, d).join(' ');
    if (d <= positional.length && SURFACE.has(candidate)) {
      cmd = SURFACE.get(candidate);
      depth = d;
      break;
    }
  }
  if (!cmd) return finding(positional[0], 'no such command');
  // A group named with no subcommand (`favro batch`, `favro cards --help`) is a
  // reference to the family, not a claim that it runs — commander prints help.
  // Only a group followed by a word that is not one of its subcommands is a lie.
  if (
    depth === 1 &&
    positional[1] &&
    !(cmd as { _actionHandler?: unknown })._actionHandler &&
    cmd.commands.length
  ) {
    const claimed = `${positional[0]} ${positional[1]}`;
    return finding(claimed, `\`${claimed}\` is not a subcommand of \`${positional[0]}\``);
  }

  const options = new Map<string, { required: boolean; optional: boolean }>();
  for (let c: Command | null | undefined = cmd; c; c = c.parent) {
    for (const opt of c.options) {
      if (opt.long) options.set(opt.long, opt);
      if (opt.short) options.set(opt.short, opt);
    }
  }

  let extras = 0;
  let consumedPath = 0;
  for (let i = 0; i < inv.tokens.length; i++) {
    const token = inv.tokens[i];
    if (token.startsWith('-') && token !== '-' && token !== '--' && !/^-\d/.test(token)) {
      const [flag, inline] = token.split('=');
      const known = options.get(flag);
      const next = inv.tokens[i + 1];
      // See the `ponytail:` note in the header for the unknown-option rule.
      const takesValue = known ? known.required || known.optional : !!next && !next.startsWith('-');
      if (inline === undefined && takesValue) i++;
      continue;
    }
    if (consumedPath < depth) {
      consumedPath++;
      continue;
    }
    extras++;
  }

  const declared = (cmd as unknown as { registeredArguments?: Array<{ variadic: boolean }> })
    .registeredArguments ?? [];
  const max = declared.some((a) => a.variadic) ? Infinity : declared.length;
  if (extras > max) {
    const claimed = positional.slice(0, depth).join(' ');
    return finding(
      claimed,
      `\`${claimed}\` declares ${max} argument(s), the doc passes ${extras}`,
    );
  }
  return undefined;
}

const FINDINGS = INVOCATIONS.map(inspect).filter((f): f is Finding => !!f);
const LIVE_KEYS = new Set(FINDINGS.map((f) => f.key));

// ─────────────────────────────────────────────────────────────────────────────

describe('every command the docs teach is a command the binary answers to', () => {
  it('finds the docs and the commands it is meant to be reading', () => {
    // SELF-CHECK. Every assertion below is vacuously true for a scan that read
    // nothing, resolved nothing, or matched nothing — the failure mode that
    // passes forever. These are floors kept close to the real numbers on
    // purpose, the way `verbose-coverage.test.ts:128-132` argues: a floor with
    // heavy slack stops gripping while #80 keeps deleting commands.
    expect(DOC_FILES.length).toBeGreaterThan(30); // 35 today
    expect(SURFACE.size).toBeGreaterThan(140); // 148 today: 125 actions + groups
    expect(INVOCATIONS.length).toBeGreaterThan(550); // 629 today
    // …and the scan resolved the great majority of them, so a tokenizer that
    // mangled every fragment could not hide behind an empty findings list.
    expect(INVOCATIONS.length - FINDINGS.length).toBeGreaterThan(550);
  });

  it('detects each of the three shapes it claims to detect', () => {
    // The other half of the self-check: proves the analyser BITES, not merely
    // that the walker read files. This is #127's "add `favro nonsense foo` to a
    // doc and watch it go red" acceptance criterion, run against a synthetic
    // segment so no doc has to be vandalised to keep the proof.
    const detect = (segment: string): string | undefined =>
      invocations(segment)
        .map((tokens) => inspect({ file: 'synthetic.md', line: 1, tokens })?.report)
        .find(Boolean);

    expect(detect('favro nonsense foo')).toContain('no such command');
    expect(detect('favro cards blockers CARD-A')).toContain('is not a subcommand');
    expect(detect('favro activity log board-001')).toContain('the doc passes 2');
    // And it stays quiet on the real forms of all three.
    expect(detect('favro cards blocking CARD-A')).toBeUndefined();
    expect(detect('favro activity CARD-A --since 1d')).toBeUndefined();
    expect(detect('favro git sync --dry-run')).toBeUndefined();
  });

  it('resolves every documented invocation outside the allowlist', () => {
    // A name here is a doc teaching a command the CLI refuses. Fix the doc.
    // Adding a line to ALLOWLIST to make this green is the failure it guards.
    const unlisted = FINDINGS.filter((f) => !(f.key in ALLOWLIST)).map((f) => f.report);
    expect(unlisted.sort()).toEqual([]);
  });

  it('no allowlist entry is stale — a corrected doc must lose its line', () => {
    // An exemption nobody prunes is worse than no test: it reads like debt
    // forever and quietly covers whatever drifts into the same key next.
    expect(Object.keys(ALLOWLIST).filter((key) => !LIVE_KEYS.has(key)).sort()).toEqual([]);
  });
});
