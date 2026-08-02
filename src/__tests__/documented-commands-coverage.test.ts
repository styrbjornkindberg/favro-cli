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
 *     `$ ` prompt, an `npx `, or an environment prefix (`DEBUG=favro:* favro …`).
 *
 * Prose is deliberately out. "the favro binary path (same package)" inside a
 * code comment is not a command, and a scanner that flagged it would be loosened
 * by the next person until it flagged nothing — the over-eager regex dies the
 * same death as the under-eager one, just louder.
 *
 * Backticks and `~~~` are the line because that is the convention every runnable
 * example in the docs follows today. It is a convention, not a rule this file
 * enforces: a 4-space-indented block or an HTML `<pre>` would be read as prose
 * and scanned only for its inline code spans. Nothing in the repo is written
 * that way, and the per-file floor below is what would notice if a file
 * converted wholesale.
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
 *      command is a fact about the surface, not a heuristic.
 *   4. OPTION     — the invocation passes a flag the command and its ancestors
 *      do not declare. `--help`/`-h` are exempt: commander adds them itself, so
 *      they are absent from `.options` while every command answers to them.
 *
 * ARITY DOES NOT SUBSUME OPTION, WHICH IS WHY BOTH ARE HERE
 * It looks as though arity already covers #127's headline `--offset`, because
 * all nine occurrences sat on `activity log` and died with the `log`. That is a
 * coincidence of this sweep, not a property. `favro activity card-abc123
 * --offset 50` — the half-fixed form the next person writes — passes exactly one
 * positional into a one-argument command and sails through arity while teaching
 * the same phantom flag the ticket was opened about. So does `favro git todos
 * --all`, and `favro git commit --move Review -m "x"`. The option arm is the one
 * that reads those.
 *
 *   ponytail: an UNRECOGNISED option is assumed to take one value when the next
 *   token is not itself an option, so that positionals still count correctly in
 *   the same pass. Right for `--offset 10`, wrong only for a boolean flag
 *   written immediately before a positional — which would report as a spurious
 *   ARITY on top of the real OPTION finding. Fix the flag; if a doc ever needs
 *   the shape, teach this the real option list for that command rather than
 *   loosening arity.
 *
 * WHERE THE OPTION ARM STOPS, AND THE SPEC POLICY
 * Names are checked in every tracked doc. Flags are checked everywhere except
 * `specs/`. The two are not the same claim:
 *
 *   - A command NAME that the binary refuses is greppable and copy-pasteable
 *     wherever it is written, which is why #127's acceptance criterion is
 *     repo-wide ("`favro activity log` appears nowhere in tracked docs"). Two
 *     lines in SPEC-002 were corrected on this branch for exactly that reason:
 *     both sat in delivered-work sections — `SPEC-002-tasks.md:148` is the
 *     acceptance criteria of T010, which shipped — so naming a command that
 *     never existed described the delivery wrongly.
 *   - A FLAG list inside a `specs/` proposal IS the proposal. `--offset` in
 *     SPEC-002 records what was asked for; rewriting it to today's surface would
 *     erase the request rather than fix a lie. Measured: dropping the scope adds
 *     20 findings, every one of them in `specs/` — `cards create --title`,
 *     `cards update --where`, `cards export --board`, flags from a design that
 *     was proposed and then built differently.
 *
 * The surviving `specs/SPEC-002-enhanced-api.md  cards search` entry is the same
 * distinction one level down: it sits under "Extend SPEC-001 query parser to
 * support:", an explicit wish list, not a delivery claim.
 *
 * `docs/research/` is deliberately NOT exempt, though it reads like a sibling of
 * `specs/`. Measured, it holds two findings and neither is a proposal: both are
 * claims about what the code does today, and both are wrong. They are
 * allowlisted with that reason rather than hidden behind a directory rule.
 *
 * THE ALLOWLIST IS ONE LIST, ON PURPOSE
 * Keyed `<file>  <what the doc claims>` with an expected COUNT — no line
 * numbers, so an edit above an example does not invalidate its entry, but a
 * second lie under the same key is a count mismatch and fails. Without the count
 * an allowlisted `EXAMPLES.md  standup` pre-forgave every future `favro standup
 * …` lie in that file, which is the failure this file exists to stop. Four
 * entries survive: three decisions (a spec wish list, an ADR whose subject IS a
 * deleted command) and one piece of debt too big for a rename. Everything else
 * the arms found was fixed in the docs instead. At this size, with each reason
 * naming what would delete it, a second list would be ceremony;
 * `scope-lock-coverage.test.ts` splits its two because the distinction there was
 * argued issue by issue across #102/#103/#104 and its decided list runs to nine
 * on its own. Revisit if this one grows.
 *
 * Every entry is checked for STALENESS: an allowlisted line that has been fixed,
 * or that no longer exists under that key in that number, fails the build. A
 * list nobody prunes turns into a permanent exemption that reads like debt.
 *
 * TODAY: 35 tracked docs, 632 documented invocations across 24 files, 602 of
 * them naming a real command, against 148 argv paths. The floors below are kept
 * near those numbers on purpose — see the self-check test.
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import { Command } from 'commander';
import { buildProgram } from '../cli';

/**
 * Documented invocations that do not resolve, and are not #127's to fix.
 * Keyed `<file>  <what the doc claims>`, valued with how many times it may
 * appear and why. A NEW lie under an existing key bumps the live count past the
 * expected one and fails — fix the doc, do not raise the number.
 */
const ALLOWLIST: Record<string, { count: number; why: string }> = {
  // DECISION — a spec section headed "Extend SPEC-001 query parser to support:"
  // is a wish list, and `cards search` is the wish. Unlike the two T010
  // acceptance-criteria lines this branch corrected, nothing here claims it was
  // delivered. Deleted the day `cards search` is built, or the section is.
  'specs/SPEC-002-enhanced-api.md  cards search': {
    count: 1,
    why: 'proposed under "Extend SPEC-001 query parser to support:", never built',
  },
  // DECISION — an ADR titled "delete propose/execute" has to name them. Two
  // apiece: the pair as it worked (`:7-8`) and the argument for deleting it
  // (`:72`, `:101`). Deleted if the ADR is ever superseded.
  'docs/adr/0004-delete-propose-execute.md  propose': {
    count: 2,
    why: 'the ADR that deleted it; naming it is the point',
  },
  'docs/adr/0004-delete-propose-execute.md  execute': {
    count: 2,
    why: 'the ADR that deleted it; naming it is the point',
  },
  // DEBT, and bigger than a flag rename. `--parent` was added to `cards update`
  // in 3239633 and is gone now; §2.2's corollary and §4.6 are built on it, and
  // both cite `src/commands/cards-update.ts`, a file that no longer exists.
  // Re-verifying that research against today's code is its own job, not a
  // one-word edit — so it is held here rather than silently excluded.
  'docs/research/dependencies-and-parent-child-semantics.md  cards update --parent': {
    count: 2,
    why: '`cards update --parent` was real (3239633), is not now; the §2.2/§4.6 analysis needs re-verifying, not a rename',
  },
};

/**
 * Files whose flag lists are the proposal itself, not instructions. See the spec
 * policy in the header: command names are checked here like everywhere else,
 * options are not.
 */
const PROPOSALS = /^specs\//;

// ─── the real command surface ────────────────────────────────────────────────

/**
 * Every argv path `buildProgram()` answers to.
 *
 * Aliases are not indexed: `grep -rn "\.alias(" src` returns nothing, so the
 * loop that did it was dead, and it was dead-and-wrong — an alias on a GROUP
 * would have registered `card` but not `card blocking`, reporting a real
 * subcommand as "not a subcommand". If an alias is ever added, a doc using it
 * fails loudly here and this walker learns about aliases then.
 */
function indexSurface(): Map<string, Command> {
  const byPath = new Map<string, Command>();
  (function walk(cmd: Command, prefix: string[]) {
    if (prefix.length) byPath.set(prefix.join(' '), cmd);
    for (const sub of cmd.commands) walk(sub, [...prefix, sub.name()]);
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

/**
 * Fragment boundaries: past one of these, the words belong to something else.
 *
 * ponytail: this runs BEFORE quote handling, so an em dash inside a quoted
 * argument (`--title "Fix — login"`) truncates the invocation instead of
 * surviving as one token. Nothing in the docs is written that way, and the cost
 * of getting it wrong is a missed check, not a false one. Split on quotes first
 * if a real example ever needs it.
 */
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
    // `DEBUG=favro:* favro context <board>` is an invocation; the env prefix is
    // not part of it. Without this the whole line reads as prose.
    const match = /^\s*(?:[$>#]\s+)?(?:[A-Z_][A-Z0-9_]*=\S+\s+)*(?:npx\s+)?favro\s+(\S.*?)\s*$/.exec(
      fragment,
    );
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
      // …and the fd it redirects is part of the redirect, not an argument.
      if (ch === '>' && /^\d$/.test(current)) {
        current = '';
        break;
      }
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
        // `~~~` is the standard escape when a block must contain backticks; a
        // file written that way would otherwise be scanned as pure prose.
        if (/^\s*(```|~~~)/.test(line)) {
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

/** Commander adds these itself, so they are absent from `.options`. */
const IMPLICIT_OPTIONS = new Set(['--help', '-h']);

interface Walked {
  /** Positionals beyond the command path — compared against declared arity. */
  extras: number;
  /** The first flag the command and its ancestors do not declare. */
  unknownFlag?: string;
}

/**
 * Positionals and flags in one pass, because whether a token is a positional
 * depends on whether the flag before it swallowed a value.
 */
function walkTokens(cmd: Command, tokens: string[], depth: number): Walked {
  const options = new Map<string, { required: boolean; optional: boolean }>();
  for (let c: Command | null | undefined = cmd; c; c = c.parent) {
    for (const opt of c.options) {
      if (opt.long) options.set(opt.long, opt);
      if (opt.short) options.set(opt.short, opt);
    }
  }

  let extras = 0;
  let unknownFlag: string | undefined;
  let consumedPath = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith('-') && token !== '-' && token !== '--' && !/^-\d/.test(token)) {
      const [flag, inline] = token.split('=');
      const known = options.get(flag);
      const next = tokens[i + 1];
      if (!known && !unknownFlag && !IMPLICIT_OPTIONS.has(flag)) unknownFlag = flag;
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
  return { extras, unknownFlag };
}

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
  // `favro cards <subcommand>` is the same: a shape, not a claim. Only a group
  // followed by a real word that is not one of its subcommands is a lie.
  if (
    depth === 1 &&
    positional[1] &&
    !PLACEHOLDER.test(positional[1]) &&
    !(cmd as { _actionHandler?: unknown })._actionHandler &&
    cmd.commands.length
  ) {
    const claimed = `${positional[0]} ${positional[1]}`;
    return finding(claimed, `\`${claimed}\` is not a subcommand of \`${positional[0]}\``);
  }

  const { extras, unknownFlag } = walkTokens(cmd, inv.tokens, depth);
  const claimed = positional.slice(0, depth).join(' ');

  const declared = (cmd as unknown as { registeredArguments?: Array<{ variadic: boolean }> })
    .registeredArguments ?? [];
  const max = declared.some((a) => a.variadic) ? Infinity : declared.length;
  if (extras > max) {
    return finding(
      claimed,
      `\`${claimed}\` declares ${max} argument(s), the doc passes ${extras}`,
    );
  }
  // Flags are not checked in proposals — see the spec policy in the header.
  if (unknownFlag && !PROPOSALS.test(inv.file)) {
    return finding(`${claimed} ${unknownFlag}`, `\`${claimed}\` has no \`${unknownFlag}\` option`);
  }
  return undefined;
}

const FINDINGS = INVOCATIONS.map(inspect).filter((f): f is Finding => !!f);

/** How many times each allowlist key actually occurs right now. */
const LIVE_COUNTS = FINDINGS.reduce(
  (counts, f) => counts.set(f.key, (counts.get(f.key) ?? 0) + 1),
  new Map<string, number>(),
);

/**
 * Invocations whose leading word(s) name a real command. This, not the raw
 * invocation count, is what proves the two halves actually met: a tokenizer
 * that mangled every fragment would still enumerate 600-odd invocations and
 * still report no findings, because a mangled token resolves to nothing and
 * falls out of `inspect` as a placeholder rather than as a violation.
 */
const RESOLVED = INVOCATIONS.filter((inv) => {
  const positional = inv.tokens.filter((t) => !t.startsWith('-'));
  return (
    positional.length > 0 &&
    (SURFACE.has(positional.slice(0, 2).join(' ')) || SURFACE.has(positional[0]))
  );
}).length;

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
    expect(INVOCATIONS.length).toBeGreaterThan(600); // 626 today
    // …and almost all of them met the real surface. See RESOLVED above: this is
    // the assertion a silently-matching-nothing walker cannot pass.
    expect(RESOLVED).toBeGreaterThan(570); // 597 today; the rest are `<placeholder>` and bare `favro --help`
    // Belt and braces on the global floor, which has ~26 slack against 626 and
    // so cannot notice a whole small file going dark. One unbalanced ``` inverts
    // fence state for the rest of a file, and `docs/commands.md` (18) or
    // `docs/git-integration.md` (16) fits inside that slack twice over.
    expect(new Set(INVOCATIONS.map((i) => i.file)).size).toBeGreaterThan(22); // 24 today
  });

  it('detects each of the four shapes it claims to detect', () => {
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
    // The phantom flag on a REAL command — the shape arity cannot see, and the
    // one #127's headline `--offset` becomes the moment someone half-fixes it.
    expect(detect('favro activity card-abc123 --offset 50')).toContain('has no `--offset`');
    expect(detect('favro git todos --all')).toContain('has no `--all`');
    expect(detect('favro git commit --move Review -m "x"')).toContain('has no `--move`');
    // And it stays quiet on the real forms of all four.
    expect(detect('favro cards blocking CARD-A')).toBeUndefined();
    expect(detect('favro activity CARD-A --since 1d')).toBeUndefined();
    expect(detect('favro git sync --dry-run')).toBeUndefined();
    expect(detect('favro git commit -m "x" --no-prefix')).toBeUndefined();
    // `--help` is commander's, not the command's, and every command answers it.
    expect(detect('favro git todos --help')).toBeUndefined();
    // A tilde fence carries the same weight as a backtick one, and an env
    // prefix does not stop a fragment being an invocation.
    expect(detect('DEBUG=favro:* favro nonsense foo')).toContain('no such command');
  });

  it('reads tilde-fenced blocks, not just backtick-fenced ones', () => {
    // `~~~` is what a doc reaches for when the block must contain backticks.
    // Zero occurrences today, so this is the only thing holding the branch open.
    const read = (body: string): string[][] => {
      let inFence = false;
      const out: string[][] = [];
      for (const line of body.split('\n')) {
        if (/^\s*(```|~~~)/.test(line)) {
          inFence = !inFence;
          continue;
        }
        if (inFence) out.push(...invocations(line));
      }
      return out;
    };
    expect(read('~~~bash\nfavro nonsense foo\n~~~')).toEqual([['nonsense', 'foo']]);
  });

  it('resolves every documented invocation outside the allowlist', () => {
    // A name here is a doc teaching a command the CLI refuses. Fix the doc.
    // Adding a line to ALLOWLIST to make this green is the failure it guards.
    const unlisted = FINDINGS.filter((f) => !(f.key in ALLOWLIST)).map((f) => f.report);
    expect(unlisted.sort()).toEqual([]);
  });

  it('no allowlist entry is stale, and none has grown a second occurrence', () => {
    // An exemption nobody prunes is worse than no test: it reads like debt
    // forever. Without the count it is worse still — an allowlisted
    // `EXAMPLES.md  standup` forgives every future `favro standup …` lie in that
    // file, so a brand-new phantom lands green under an old key.
    expect(
      Object.entries(ALLOWLIST)
        .filter(([key, entry]) => (LIVE_COUNTS.get(key) ?? 0) !== entry.count)
        .map(([key, entry]) => `${key}: expected ${entry.count}, live ${LIVE_COUNTS.get(key) ?? 0}`)
        .sort(),
    ).toEqual([]);
  });
});
