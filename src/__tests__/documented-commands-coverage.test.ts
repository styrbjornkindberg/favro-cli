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
 * A fenced command written across a trailing `\` is joined into one line first
 * (#156) — see `readBody`. Without that only its first line was ever scanned.
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
 * Fence state is one toggle, so a single stray marker inverts it and blinds the
 * rest of a file. The floors cannot see that — measured, a stray ``` near the
 * top of `docs/commands.md` hides every example after it and leaves the suite
 * green. A parity check on each file catches it at the source instead.
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
 * ARM 4 ALSO READS OPTION TABLES, WHICH IT USED NOT TO (#156)
 * The four arms above all begin with a fragment that starts with `favro`. An
 * options TABLE ROW is a `| \`--json\` | Output raw JSON |` — an inline code span
 * holding a flag and nothing else — so it built no fragment and no arm ever ran
 * on it. Every option table in every doc was invisible. Measured at the time:
 * `command-reference.md` gave a `--json` row to 19 commands that have no `--json`
 * option, and a reader copying it out of the table gets `unknown option '--json'`
 * — the exact failure this file exists to stop, one column over.
 *
 * `readOptionTables` closes that. It walks the table STRUCTURE (row → cells →
 * code spans in the first cell) rather than matching a line shape, and asks the
 * SAME question arm 4 asks, through the same `walkTokens`, so the answer cannot
 * drift from the invocation arm's. What a row is attributed to:
 *
 *   - the nearest preceding heading, when its first code span names a registered
 *     command (`### \`collections list\``) — this is 385 of the 391 rows today;
 *   - failing that, the first `favro …` example FENCED under that heading, which
 *     is how `docs/git-integration.md` documents `git link` and `git commit`
 *     under prose headings. A prose MENTION does not count and must not: a
 *     `` use `favro cards find` to get one `` inside an argument table hijacked the
 *     scope of `activity`'s option table and reported three of its real flags as
 *     phantom — measured, which is why the heading wins and the example must be
 *     inside a fence;
 *   - failing both, the root program, which is exactly right for the six
 *     `## Global Options` rows (`--verbose`, `--help`).
 *
 *   ponytail: a row is read only when its first cell IS a flag declaration —
 *   code spans, commas and slashes, no prose. That is what separates an option
 *   table from README's troubleshooting table, whose first column holds
 *   `` `--column` not working ``. The ceiling: a flag written anywhere but the
 *   first cell of a row is a MENTION, not a declaration, and is not read.
 *
 *   That ceiling is load-bearing rather than hypothetical, and the numbers say so
 *   in both directions. Measured over the tracked docs: 15 flag-shaped code spans
 *   sit in a second or third column today, and every one is a cross-reference —
 *   `` requires `--board` ``, `` same as `--filter "tag:…"` ``, `` Kanban view
 *   (`--compact`, `--watch`, `--ids`) ``. All 15 name real flags, so nothing is
 *   hidden behind the ceiling right now; four of them are in rows the first cell
 *   already scopes and checks. Reading them as declarations is the loosening the
 *   header warns about — it is the same claim as reading a flag out of a
 *   paragraph, which is where the prose line is drawn. One row in README has the
 *   two mixed in the first cell and is the reason the residue check exists;
 *   deleting that check reports `--column` against whatever heading precedes it.
 *
 *   Five further shapes were constructed as bypasses and all five get through: a
 *   GFM table written with no leading `|`, a double-backtick code span, a
 *   `<value>` placeholder written outside the span, a bold `**`--flag`**` first
 *   cell, and an HTML `<table>`. A sixth mis-scopes: a setext-underlined heading
 *   is not a heading to this walker, so its section's rows fall to the previous
 *   scope or to the root program. Measured: zero occurrences of any of the six in
 *   the tracked docs, which is why they are recorded rather than handled — the
 *   row floor above is what notices if a doc converts wholesale. The scope-bleed
 *   shape is the one worth watching: `example` is reset only by an ATX heading, so
 *   two commands' tables under one prose heading both take the FIRST fenced
 *   example's scope.
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
 * TODAY: 41 tracked docs, 700 documented invocations across 29 files, 670 of
 * them naming a real command, against 148 argv paths — plus 308 option-table
 * rows, 302 of them attributed to a named command. The floors below are kept near
 * those numbers on purpose — see the self-check test.
 *
 * Every number in that line was re-measured by instrumenting this module's own
 * expressions on the tree that ships it (#161). The invocation pair read 696/666
 * and the row pair 350/344 — the rows from before #119 deleted 39 `--json` rows,
 * which the assertion comments 600 lines down recorded and this block did not.
 * The flag COUNT that used to sit here (394) is gone rather than refreshed:
 * nothing in this file counts flags, so it could not be re-measured, and a number
 * no expression produces is the kind that goes stale unnoticed.
 *
 * This block read `38 / 680 / 28 / 650 / 391 / 438 / 385` until #110's review:
 * #110 corrected the two row counts at their own assertion, 580 lines down, and
 * left the identical pair here — which is how a "TODAY" turns into a date stamp
 * nobody re-reads. Every number above was re-measured by instrumenting this
 * module's own expressions, not carried forward.
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
  // DECISION — same category as the two ADR entries above: a CHANGELOG entry
  // announcing that 3.0.0 removed `--json` has to show the flag it removed. Both
  // occurrences sit in the "before / after" block of Breaking #1, where `--json`
  // appears as the 2.4.1 spelling beside the 3.0.0 replacement. A CHANGELOG is
  // the one document whose job is to name what no longer works.
  //
  // Count is exactly 2, so a third occurrence — someone teaching `--json` in a
  // later entry as though it still worked — fails here.
  'CHANGELOG.md  boards list --json': {
    count: 2,
    why: 'the release note that removed it; showing the old spelling is the point',
  },
  // DECISION — same category, one release later. 4.0.0's first breaking entry
  // shows what an agent that still runs `batch update` now SEES: the invocation,
  // then the refusal and the pointer. Removing the flag from that block would
  // leave a before/after with no before.
  //
  // Count is exactly 1: the four table rows below it were written without their
  // flags precisely so this stays at one, and a second occurrence — someone
  // teaching `--from-csv` on `batch update` as though it worked — fails here.
  'CHANGELOG.md  batch update --from-csv': {
    count: 1,
    why: 'the release note that removed it; showing the old spelling is the point',
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
const PROGRAM = buildProgram();

function indexSurface(): Map<string, Command> {
  const byPath = new Map<string, Command>();
  (function walk(cmd: Command, prefix: string[]) {
    if (prefix.length) byPath.set(prefix.join(' '), cmd);
    for (const sub of cmd.commands) walk(sub, [...prefix, sub.name()]);
  })(PROGRAM, []);
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

/** Files whose fence markers do not pair up — see UNBALANCED below. */
const unbalanced: string[] = [];

/** How many fenced commands were joined across a trailing `\` — see readDocs. */
let CONTINUED = 0;

/**
 * Every `favro …` invocation in one document, plus whether its fences balanced.
 *
 * A named function and not a loop body inside `readDocs`, because the tests below
 * run THIS on synthetic Markdown. The tilde-fence arm used to keep its own copy
 * of this walk, which proved the copy read tildes.
 */
function readBody(file: string, body: string): { found: Invocation[]; open: boolean } {
  const found: Invocation[] = [];
  let inFence = false;
  {
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      // `~~~` is the standard escape when a block must contain backticks; a
      // file written that way would otherwise be scanned as pure prose.
      if (/^\s*(```|~~~)/.test(lines[i])) {
        inFence = !inFence;
        continue;
      }
      let line = lines[i];
      const at = i + 1;
      // A SHELL LINE CONTINUATION IS ONE COMMAND (#156).
      //
      // `invocations` already knew a trailing lone `\` is not an argument — but
      // nothing joined the lines, so every flag after the first line of a
      // `favro cards export … \` block was invisible to arm 4. Measured over the
      // tracked docs: 22 fenced commands are written this way, carrying flags on
      // lines that no arm ever read. They all check out today; that is luck, not
      // a property, and it is the same shape as the option-table hole above.
      //
      // ponytail: only inside a fence, and never across a fence marker. A prose
      // line ending in `\` is not a continuation of anything.
      while (inFence && /\\\s*$/.test(line) && !/^\s*(```|~~~)/.test(lines[i + 1] ?? '```')) {
        line = `${line.replace(/\\\s*$/, ' ')}${lines[++i].trim()}`;
        CONTINUED++;
      }
      // In a fence the whole line is code; outside it, only the code spans are.
      const segments = inFence ? [line] : [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
      for (const segment of segments) {
        for (const tokens of invocations(segment)) found.push({ file, line: at, tokens });
      }
    }
  }
  return { found, open: inFence };
}

/** Every `favro …` invocation in every tracked doc, with where it was written. */
function readDocs(): Invocation[] {
  const found: Invocation[] = [];
  for (const file of DOC_FILES) {
    const read = readBody(file, fs.readFileSync(`${__dirname}/../../${file}`, 'utf8'));
    found.push(...read.found);
    if (read.open) unbalanced.push(file);
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

/** The longest registered argv path the leading positionals name, if any. */
function resolve(positional: string[]): { cmd: Command; depth: number } | undefined {
  for (const depth of [2, 1]) {
    const candidate = positional.slice(0, depth).join(' ');
    const cmd = depth <= positional.length ? SURFACE.get(candidate) : undefined;
    if (cmd) return { cmd, depth };
  }
  return undefined;
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

  const resolved = resolve(positional);
  if (!resolved) return finding(positional[0], 'no such command');
  const { cmd, depth } = resolved;
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

// ─── reading option TABLES (#156) ────────────────────────────────────────────

/** A registered command plus the argv path it was named by. */
interface Scope {
  cmd: Command;
  path: string;
}

/** The command a heading's or an example's leading words name, if any. */
function scopeOf(positional: string[]): Scope | undefined {
  const resolved = resolve(positional);
  return resolved
    ? { cmd: resolved.cmd, path: positional.slice(0, resolved.depth).join(' ') }
    : undefined;
}

/**
 * The flags a table row declares, or nothing.
 *
 * Structural: a row is its cells, and the first cell of an option table holds
 * code spans and nothing else. `| Flag | Description |` and `|---|---|` have no
 * spans and fall out here, as does README's `` | `--column` not working | `` —
 * see the `ponytail:` note in the header for that boundary. `-y, --yes` is two
 * flags in one span; `--limit <n>` is one flag and its value placeholder.
 *
 * TWO OF THE FOUR LINES BELOW ARE LOAD-BEARING, MEASURED SEPARATELY. Deleting the
 * leading-`|` test, or the residue test, each fails the suite — the residue test
 * against a real document, `README.md:424`, which reports `--column` against the
 * root program without it. `!spans.length` and `!spans.every(startsWith('-'))` are
 * both EQUIVALENT MUTANTS: an empty first cell yields no flags anyway, and a cell
 * mixing a command span with a flag span is already emptied by the trailing
 * `.filter`. They are kept as one readable "is this a flag declaration" statement,
 * not as the protection; do not read them as load-bearing.
 */
function tableRowFlags(line: string): string[] {
  if (!/^\s*\|/.test(line)) return [];
  const first = line.replace(/^\s*\|/, '').split('|')[0].trim();
  const spans = [...first.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
  if (!spans.length || !spans.every((s) => s.startsWith('-'))) return [];
  if (first.replace(/`[^`]+`/g, '').replace(/[\s,/]+/g, '')) return [];
  return spans
    .flatMap((s) => s.split(','))
    .map((s) => s.trim().split(/[\s=]/)[0])
    .filter((s) => s.startsWith('-'));
}

/** Rows read, for the self-check floor — a reader that matched nothing passes everything. */
let ROWS_READ = 0;
/** Rows attributed to a real command rather than falling back to the root program. */
let ROWS_SCOPED = 0;

/**
 * Every phantom flag an option table in `body` attributes to a command.
 *
 * Exported shape, not inlined into the file loop, because the self-check below
 * runs THIS function on synthetic Markdown. A self-check that re-implemented the
 * predicate would only ever prove the copy works, which is how the nine blind
 * ratchets before this one passed their own tests.
 */
function readOptionTables(file: string, body: string): Finding[] {
  const out: Finding[] = [];
  let inFence = false;
  let heading: Scope | undefined;
  let example: Scope | undefined;
  body.split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) {
      // THE `if (inFence)` IS THE GUARD THAT DOES THE WORK. Measured by mutation:
      // letting a code span on a PROSE line set the scope immediately reports
      // `cards find --since/--until/--limit` as phantom, because `activity`'s
      // argument table says `` use `favro cards find` to get one ``. Reordering
      // `heading ?? example`, or dropping the `!heading` guard below, are BOTH
      // equivalent mutants — they survive the whole suite. They are kept as
      // defence in depth, not as the protection; do not read them as load-bearing.
      if (!heading && !example) {
        for (const tokens of invocations(line)) {
          const found = scopeOf(tokens.filter((t) => !t.startsWith('-')));
          if (found) {
            example = found;
            break;
          }
        }
      }
      return;
    }
    const atx = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (atx) {
      const span = /`([^`]+)`/.exec(atx[1]);
      heading = span ? scopeOf(span[1].trim().split(/\s+/)) : undefined;
      example = undefined;
      return;
    }
    const flags = tableRowFlags(line);
    if (!flags.length) return;
    ROWS_READ++;
    const scope = heading ?? example;
    if (scope) ROWS_SCOPED++;
    const cmd = scope?.cmd ?? PROGRAM;
    const claimed = scope?.path ?? 'favro';
    for (const flag of flags) {
      // The SAME resolver arm 4 uses, so a table row and an invocation can never
      // disagree about whether a command declares a flag.
      const { unknownFlag } = walkTokens(cmd, [flag], 0);
      if (!unknownFlag) continue;
      out.push({
        key: `${file}  ${claimed} ${unknownFlag}`,
        report: `${file}:${i + 1}  option table under \`${claimed}\` lists \`${unknownFlag}\`  — \`${claimed}\` has no \`${unknownFlag}\` option`,
      });
    }
  });
  return out;
}

const FINDINGS = [
  ...INVOCATIONS.map(inspect).filter((f): f is Finding => !!f),
  // Flags in `specs/` are the proposal, not instructions — the same scope the
  // invocation arm applies. No `specs/` file holds an option table today.
  ...DOC_FILES.filter((f) => !PROPOSALS.test(f)).flatMap((f) =>
    readOptionTables(f, fs.readFileSync(`${__dirname}/../../${f}`, 'utf8')),
  ),
];

/**
 * THE REAL DOCUMENTS' COUNTS, FROZEN BEFORE ANY SELF-CHECK CAN PAD THEM.
 *
 * `ROWS_READ`, `ROWS_SCOPED` and `CONTINUED` are module-level counters that
 * `readOptionTables` and `readBody` increment — and the self-check tests below
 * call BOTH of those functions on synthetic Markdown. Asserting the floors
 * against the live counters therefore counts roughly twenty synthetic rows and a
 * handful of synthetic joins as though the docs had supplied them, which is
 * exactly enough slack to hide a real drop: delete every option table from
 * `command-reference.md` and the floor still passes on the self-check's own
 * contributions. That is the "module-level state satisfying a counter" trap, and
 * a floor that its own prover can satisfy is not a floor.
 *
 * It happens to be harmless today only because jest runs `it` bodies in
 * declaration order and the floor arm is declared first. That is an ordering
 * accident, not a property — `-t`, `.only`, a reorder or a future `--randomize`
 * all break it. Freezing here makes the floors a fact about the tracked docs.
 */
const DOC_ROWS_READ = ROWS_READ;
const DOC_ROWS_SCOPED = ROWS_SCOPED;
const DOC_CONTINUED = CONTINUED;

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
    // The four counts below carried `35`, `631`, `601` and `24` as their "today"
    // numbers, measured when #127 was written. Re-measured against the same
    // scanner: 38, 681, 651 and 28. The docs grew; the floors did not move, so the
    // comments were the only wrong part — corrected rather than left, because a
    // floor annotated with a number nobody re-measures is how a floor stops being
    // evidence (ADR-0003). `681`/`651` and not `680`/`650`: the #158 ADR amendment
    // on this same branch wrote `favro init` in an inline code span, which is one
    // more documented invocation, and one that resolves.
    // Every "today" below was re-measured by instrumenting these same
    // expressions, twice: once when #110 landed (38→41, 681→685, 651→655, 28→29,
    // 55→58, none of which turned a floor red — what slack buys and costs) and
    // again in its review, after the CHANGELOG and specs edits of the review
    // round itself moved the invocation counts a second time (685→696, 655→666).
    // Written down as the invocation-count pair drifting for the same reason
    // twice: the docs are edited by the ticket that writes these numbers.
    //
    // A THIRD time, and the same half-fix: #161 re-measured the pair for the
    // header block (696/666 → 700/670) and left these two comments reading the
    // old numbers, which is the drift above happening to the line that describes
    // it. Both spellings are corrected together now.
    expect(DOC_FILES.length).toBeGreaterThan(30); // 41 today
    expect(SURFACE.size).toBeGreaterThan(140); // 148 today: 125 actions + groups
    expect(INVOCATIONS.length).toBeGreaterThan(600); // 700 today
    // …and almost all of them met the real surface. See RESOLVED above: this is
    // the assertion a silently-matching-nothing walker cannot pass.
    expect(RESOLVED).toBeGreaterThan(570); // 670 today; the rest are `<placeholder>` and bare `favro --help`
    expect(new Set(INVOCATIONS.map((i) => i.file)).size).toBeGreaterThan(22); // 29 today
    // …and the option tables were read at all. `readOptionTables` matching
    // nothing is the #156 bug restored, and it would restore it silently: the
    // arms above never touched a table row, so every one of them stays green.
    // The frozen counters, not the live ones — see DOC_ROWS_READ.
    //
    // 370/370 against 391/385 until #110 deleted the option tables for `batch
    // update`, `batch move`, `batch assign` and `batch-smart` across
    // `API-REFERENCE.md` and the skill reference, and added one for
    // `cards update --from-csv`. Net 41 rows either way: 391→350 and 385→344.
    // The replacement floors are EXACT-FIT rather than re-slackened:
    // the counters exist to notice `readOptionTables` going blind, and a floor
    // sitting 21 below the live count cannot notice a whole file's tables
    // vanishing.
    //
    // 350/344 until #119 deleted the `--json` row from EVERY migrated command's
    // option tables. The flag stops existing when JSON becomes the DEFAULT and
    // `--human` is the way out (ADR-0002), so those rows documented a flag the
    // binary now refuses by name. 39 rows over `API-REFERENCE.md`, the skill
    // reference and `docs/commands.md`; nothing was moved or reworded, so the
    // whole drop is the deletion. Re-measured by instrumenting this expression
    // on the finished tree rather than estimated from the diff.
    //
    // 311/305 until #161 deleted `cards move --position` — a flag that never
    // worked, so its three option-table rows (one each in `API-REFERENCE.md`,
    // `docs/commands.md` and the skill reference) documented a `400`. Three rows
    // out of both counters, nothing moved or reworded. Re-measured on the
    // finished tree by instrumenting these two expressions, not subtracted from
    // the diff.
    expect(DOC_ROWS_READ).toBeGreaterThan(307); // 308 today, over 5 files
    expect(DOC_ROWS_SCOPED).toBeGreaterThan(301); // 302 today; the other 6 are `## Global Options`
    // …and the `\`-continued commands were joined rather than read one line at a
    // time. Zero here means every flag past the first line went unchecked again.
    expect(DOC_CONTINUED).toBeGreaterThan(45); // 58 joins today
  });

  it('every doc closes the fences it opens', () => {
    // Not tidiness — correctness. Fence state is a single toggle, so ONE stray
    // ``` inverts it for the rest of the file and every later example reads as
    // prose. The floors above cannot see that: measured, a stray marker near the
    // top of `docs/commands.md` (18 invocations) hides everything after it and
    // leaves the suite green, because 18 fits inside the global floor's slack
    // and the file still contributes inline code spans, so it never goes dark
    // enough for the per-file count to notice. Parity catches it at the source.
    //
    // ponytail: parity, not a real Markdown parser — an EVEN number of strays
    // still balances. One typo'd marker is the realistic case and this sees it.
    expect(unbalanced).toEqual([]);
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

  it('catches a phantom flag written as an option TABLE row (#156)', () => {
    // The other self-check, and it runs the REAL `readOptionTables` on synthetic
    // Markdown rather than a re-implementation of it. Every case below was
    // constructed as an attempted BYPASS of the predicate first and is recorded
    // here with its verdict — including the two that still get through, because a
    // named ceiling is a decision and an unnamed one is the next #156.
    const detect = (body: string): string[] =>
      readOptionTables('synthetic.md', body).map((f) => f.report);

    const table = (heading: string, cell: string) =>
      `${heading}\n\n| Flag | Description |\n|------|-------------|\n| ${cell} | why |\n`;

    // 1. The shape the whole ticket is about: a bare flag under a command heading.
    expect(detect(table('### `cards list`', '`--nonsense`'))).toEqual([
      expect.stringContaining('`cards list` has no `--nonsense` option'),
    ]);
    // 2. Two flags in one cell. Checking only the long one lets `-Z` through, and
    //    `-y, --yes` is how this repo writes every confirmation flag.
    expect(detect(table('### `cards list`', '`-Z, --nonsense`')).sort()).toEqual([
      expect.stringContaining('has no `--nonsense`'),
      expect.stringContaining('has no `-Z`'),
    ]);
    // 3. A flag with a value placeholder — the token is `--nonsense`, not
    //    `--nonsense <v>`, or every valued row in the docs reads as a phantom.
    expect(detect(table('### `cards list`', '`--nonsense <v>`'))).toEqual([
      expect.stringContaining('has no `--nonsense`'),
    ]);
    // 4. A heading that names no command, with the command in a FENCED example —
    //    `docs/git-integration.md`'s shape. Bypassed the first draft, which only
    //    looked at headings.
    expect(
      detect(`## Link it up\n\n\`\`\`bash\nfavro git link --board abc\n\`\`\`\n${table('', '`--nonsense`')}`),
    ).toEqual([expect.stringContaining('`git link` has no `--nonsense` option')]);
    // 5. No command in scope at all: the row is the ROOT program's, which is what
    //    `## Global Options` is. Bypassed a draft that fed `inspect` a synthesised
    //    `favro …` invocation, because a lone flag has no positional and
    //    `inspect` returns early on it — 6 real rows would have gone unchecked.
    expect(detect(table('## Global Options', '`--nonsense`'))).toEqual([
      expect.stringContaining('`favro` has no `--nonsense` option'),
    ]);
    expect(detect(table('## Global Options', '`--verbose`'))).toEqual([]);
    // 6. A heading naming a two-word command whose GROUP declares the flag: the
    //    ancestor walk in `walkTokens` has to be reached, or every inherited flag
    //    reports as a phantom.
    expect(detect(table('### `git sync`', '`--dry-run`'))).toEqual([]);
    expect(detect(table('### `git sync`', '`--pretty`'))).toEqual([]); // root's
    // 7. `--help` is commander's. A doc listing it is not a lie.
    expect(detect(table('### `cards list`', '`--help`, `-h`'))).toEqual([]);
    // 8. Prose in the first cell is not an option declaration. README's
    //    troubleshooting table is `` `--column` not working ``, and reading it as
    //    a row reported `--column` against whatever command came last.
    expect(detect(table('### `cards list`', '`--column` not working'))).toEqual([]);
    // 9. The header and separator rows of the table itself.
    expect(detect(table('### `cards list`', '`--board <board>`'))).toEqual([]);

    // STILL GETS THROUGH, measured and accepted. See the ponytail note in the
    // header for why a MENTION is not a declaration, and for the live counts.
    //  a. a flag in the SECOND column. 15 live instances, all cross-references,
    //     all naming real flags.
    expect(detect('### `cards list`\n\n| What | Flag |\n|---|---|\n| nonsense | `--nonsense` |\n')).toEqual([]);
    //  b. a table INSIDE a fence, which is a code sample of a table, not a table.
    expect(detect('### `cards list`\n\n```\n| `--nonsense` | why |\n```\n')).toEqual([]);
    //  c. a GFM table written with no leading `|`. Zero live instances.
    expect(detect('### `cards list`\n\nFlag | Description\n-----|---\n`--nonsense` | why\n')).toEqual([]);
    //  d. a double-backtick code span — the residue check sees the leftover
    //     backticks and reads the cell as prose. Zero live instances.
    expect(detect(table('### `cards list`', '``--nonsense``'))).toEqual([]);
    //  e. a `<value>` placeholder written OUTSIDE the span. Zero live instances.
    expect(detect(table('### `cards list`', '`--nonsense` <v>'))).toEqual([]);
    //  f. a bold first cell — `**` is residue. Zero live instances.
    expect(detect(table('### `cards list`', '**`--nonsense`**'))).toEqual([]);
    //  g. an HTML table. The header's prose rule already covers HTML blocks.
    expect(detect('### `cards list`\n\n<table><tr><td><code>--nonsense</code></td></tr></table>\n')).toEqual([]);
    //  h. MIS-SCOPED, not missed: a setext-underlined heading is not a heading
    //     here, so the row falls to the previous scope — the root program in this
    //     case, which still reports, but against `favro` rather than `cards list`.
    //     A flag that is real on the fallback scope and phantom on the setext one
    //     would go quiet. Zero live setext headings.
    expect(detect('## Prose\n\n`cards list`\n-----------\n' + table('', '`--nonsense`'))).toEqual([
      expect.stringContaining('`favro` has no `--nonsense` option'),
    ]);
    //  i. SCOPE BLEED, the one to watch: `example` is reset only by an ATX
    //     heading, so a second command's table under the same prose heading takes
    //     the FIRST fenced example's scope. `--create` is real on `git todos` and
    //     phantom on `git link`, and this reports nothing.
    expect(
      detect(
        '## How linking works\n\n```bash\nfavro git todos --create\n```\n\nOptions for `git link`:\n' +
          table('', '`--create`'),
      ),
    ).toEqual([]);
  });

  it('reads tilde-fenced blocks, not just backtick-fenced ones', () => {
    // `~~~` is what a doc reaches for when the block must contain backticks.
    // Zero occurrences today, so this is the only thing holding the branch open.
    // Runs the REAL `readBody`; it used to run a private copy of the fence walk,
    // which proved the copy read tildes and nothing about the scanner.
    const read = (body: string): string[][] =>
      readBody('synthetic.md', body).found.map((i) => i.tokens);
    expect(read('~~~bash\nfavro nonsense foo\n~~~')).toEqual([['nonsense', 'foo']]);
  });

  it('joins a fenced shell line continuation into one command (#156)', () => {
    // 22 fenced commands in the tracked docs are written across a trailing `\`.
    // Before this, only their FIRST line was scanned, so a flag on any later line
    // was invisible to arm 4 — the option-table hole in a second costume.
    const read = (body: string): string[][] =>
      readBody('synthetic.md', body).found.map((i) => i.tokens);
    const inspectAll = (body: string): string[] =>
      readBody('synthetic.md', body)
        .found.map((i) => inspect(i)?.report)
        .filter((r): r is string => !!r);

    // It bites: the phantom flag is on the continuation line, not the first.
    expect(
      inspectAll('```bash\nfavro git todos \\\n  --all\n```'),
    ).toEqual([expect.stringContaining('has no `--all`')]);
    // …and it stays quiet on the real form, which is what the docs actually hold.
    expect(inspectAll('```bash\nfavro git sync \\\n  --dry-run\n```')).toEqual([]);
    // The join itself, so a `\` that silently ate the next line would show up.
    expect(read('```bash\nfavro cards list \\\n  --board abc \\\n  --limit 5\n```')).toEqual([
      ['cards', 'list', '--board', 'abc', '--limit', '5'],
    ]);
    // It must not run off the end of the block. A `\` on the last line of a fence
    // has nothing to continue into, and swallowing the ``` would invert the fence
    // toggle for the rest of the file — the failure `unbalanced` exists to catch.
    const runaway = readBody('synthetic.md', '```bash\nfavro cards list \\\n```\n\nprose\n');
    expect(runaway.found.map((i) => i.tokens)).toEqual([['cards', 'list']]);
    expect(runaway.open).toBe(false);
    // A prose line ending in `\` is not a continuation of anything.
    expect(read('see `favro git todos` \\\nand `favro git sync`')).toEqual([
      ['git', 'todos'],
      ['git', 'sync'],
    ]);
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
