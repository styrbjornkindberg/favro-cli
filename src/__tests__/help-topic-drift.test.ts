/**
 * The drift test for `favro help issue-tracker` (#57).
 *
 * The topic is hand-written prose — generation was rejected, it fails the
 * human-CLI constraint — so nothing but a test stops it from quietly going
 * stale. What it holds the prose against is the live thing in each case: the
 * real dispatch table, the real `skills/builtin/` directory, and the real
 * commander tree. Prose naming something that no longer exists is exactly the
 * class of defect this catches — `favro audit` survived in the shipped skill
 * docs for a whole release after the command was deleted.
 *
 * Nothing here asserts wording. Asserting the prose against a copy of the prose
 * would pass forever and detect nothing.
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// Set at module scope, before the command tree is imported. `config.ts` reads
// the environment per call now (#65 unfroze it), so a `beforeEach` would work
// for `readConfig` — but building the program imports every command, and any
// module that captures a path at import time would still land on the
// developer's own `~/.favro`. Earliest possible is the safe place for it.
// Nothing here talks to a network.
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'favro-cli-drift-config-'));
fs.writeFileSync(path.join(CONFIG_DIR, 'config.json'), '{}');
process.env.FAVRO_CONFIG_DIR = CONFIG_DIR;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildProgram } = require('../cli') as typeof import('../cli');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ISSUE_TRACKER_TOPIC } = require('../commands/issue-tracker-help') as typeof import('../commands/issue-tracker-help');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { intentNames } = require('../lib/dispatch') as typeof import('../lib/dispatch');

import type { Command } from 'commander';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUILTIN_DIR = path.join(REPO_ROOT, 'skills', 'builtin');

afterAll(() => {
  fs.rmSync(CONFIG_DIR, { recursive: true, force: true });
});

// ─── reading the topic ───────────────────────────────────────────────────────

const TOPIC_LINES = ISSUE_TRACKER_TOPIC.replace(/^\n+|\n+$/g, '').split('\n');

/** A section header is an all-caps line at column 0. */
const isHeader = (line: string) => /^[A-Z][A-Z0-9 ,’'—-]*$/.test(line.split('—')[0].trimEnd()) && !/^\s/.test(line) && line.trim() !== '';

/** The body lines under one all-caps section header. */
function section(name: string): string[] {
  const start = TOPIC_LINES.findIndex((l) => l.startsWith(name));
  if (start === -1) throw new Error(`The topic has no "${name}" section — the drift test cannot check it.`);
  const rest = TOPIC_LINES.slice(start + 1);
  const end = rest.findIndex(isHeader);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The names in a two-column block: `  <name>` then two-or-more spaces, then
 * prose. Continuation lines are indented past the name column and so are
 * skipped by construction.
 */
const namesIn = (lines: string[]): string[] =>
  lines.map((l) => /^ {2}(\S+) {2,}\S/.exec(l)?.[1]).filter((n): n is string => Boolean(n));

// ─── reading the command tree ────────────────────────────────────────────────

const program = buildProgram();

/** Every command path the CLI answers to, as space-joined tokens. */
function commandPaths(cmd: Command, prefix: string[] = []): string[] {
  return cmd.commands.flatMap((sub) => {
    const here = [...prefix, sub.name()];
    return [here.join(' '), ...commandPaths(sub, here)];
  });
}

const PATHS = new Set(commandPaths(program));
/**
 * Top-level names, including the aliases commander answers to, plus `help` —
 * commander adds its own help command lazily, so it is not in `.commands`.
 */
const TOP = new Set(['help', ...program.commands.flatMap((c) => [c.name(), ...c.aliases()])]);

/**
 * Does the CLI answer to this invocation?
 *
 * Deliberately shallow: the first token must be a real top-level command, and
 * if a second token was given and the parent has subcommands, that token must
 * be one of them unless the parent takes a positional argument of its own.
 * Anything deeper is argument territory, and guessing at it would make this
 * test fail on valid prose — which is how a drift test gets deleted.
 */
function invocationExists(tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  if (!TOP.has(tokens[0])) return false;
  if (tokens.length === 1) return true;
  const parent = program.commands.find((c) => c.name() === tokens[0] || c.aliases().includes(tokens[0]));
  if (!parent || parent.commands.length === 0) return true;
  if (PATHS.has(`${tokens[0]} ${tokens[1]}`)) return true;
  // A parent that also takes its own positional argument (`favro skill <name>`
  // style) can legitimately be followed by something that is not a subcommand.
  return parent.registeredArguments.length > 0;
}

/**
 * Every `favro …` invocation in a blob of prose, as token lists.
 *
 * Stops at the first token that is a flag, a placeholder or a quoted string —
 * those are arguments, not command names.
 *
 * `CLI: <tokens>` counts too, and it is the form that actually mattered: the
 * INTENTS block names each intent's command that way, WITHOUT the `favro `
 * prefix, so a `\bfavro` scan saw two invocations in the whole topic and none of
 * them. Unregistering the tracker commands deleted `cards claim`, `cards
 * resolve` and `cards retag` outright and this test still passed — precisely the
 * `favro audit` failure mode its own docstring cites.
 */
function invocations(text: string): string[][] {
  const found: string[][] = [];
  const take = (phrase: string) => {
    const tokens: string[] = [];
    for (const raw of phrase.trim().split(/ +/)) {
      if (!/^[a-z][a-z0-9-]*$/.test(raw)) break;
      tokens.push(raw);
    }
    if (tokens.length > 0) found.push(tokens);
  };
  for (const match of text.matchAll(/\bfavro((?: +[^\s`"'|)>\n]+)+)/g)) take(match[1]);
  // A clause runs to the first `.` or `,` — "CLI: cards get, minus the children
  // arm." names one command, not five.
  for (const match of text.matchAll(/\bCLI: ([^.,\n]+)/g)) take(match[1]);
  return found;
}

/**
 * The command-reference declares one command per `### \`<cmd> …\`` heading, and
 * drops the `favro ` prefix — so those headings need reading as invocations too,
 * or a whole deleted command's section stays invisible to this test. (`audit`
 * did exactly that.)
 */
function declaredHeadings(text: string): string[][] {
  const found: string[][] = [];
  for (const match of text.matchAll(/^#{2,4} `([^`]+)`/gm)) {
    const tokens: string[] = [];
    for (const raw of match[1].trim().split(/ +/)) {
      if (!/^[a-z][a-z0-9-]*$/.test(raw)) break;
      tokens.push(raw);
    }
    if (tokens.length > 0) found.push(tokens);
  }
  return found;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('the topic is reachable the way its consumers reach it', () => {
  /** Run an invocation and hand back everything it wrote to stdout. */
  const helpOutput = (...argv: string[]): string => {
    const written: string[] = [];
    const spy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      written.push(String(chunk));
      return true;
    });
    try {
      const p = buildProgram();
      p.exitOverride();
      p.commands.forEach((c) => c.exitOverride());
      try { p.parse(['node', 'favro', ...argv]); } catch { /* commander exits via throw under exitOverride */ }
    } finally {
      spy.mockRestore();
    }
    return written.join('');
  };

  it('`favro help issue-tracker` prints the topic', () => {
    expect(helpOutput('help', 'issue-tracker')).toContain('ROLLBACK GUARD');
  });

  it('`favro issue-tracker --help` prints it too — that is what MCP favro_help sends', () => {
    // MCP shells out to `favro <tokens> --help`, so the topic has to survive
    // that spelling as well or the primary consumer never reaches it.
    expect(helpOutput('issue-tracker', '--help')).toContain('ROLLBACK GUARD');
  });

  it('leads with the rollback guard, before any intent is named', () => {
    const guard = ISSUE_TRACKER_TOPIC.indexOf('ROLLBACK GUARD');
    const intents = ISSUE_TRACKER_TOPIC.indexOf('INTENTS');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(intents);
  });

  it('is a model, not a field reference — roughly 60 to 80 lines of content', () => {
    const content = TOPIC_LINES.filter((l) => l.trim() !== '');
    expect(content.length).toBeGreaterThanOrEqual(60);
    expect(content.length).toBeLessThanOrEqual(80);
  });

  it('maps Favro before/after onto blocking exactly once', () => {
    // Twice would be two statements of the same rule, free to disagree.
    const said = ISSUE_TRACKER_TOPIC.match(/before\/after/g) ?? [];
    expect(said).toHaveLength(1);
  });
});

describe('every name in the topic is a live name', () => {
  it('the INTENTS block and the dispatch table hold the same names', () => {
    // Both directions: a name the table dropped, and an intent the table gained
    // that the topic never mentions, are the same kind of stale.
    //
    // No hardcoded count. Pinning the number to 7 would fail a legitimate eighth
    // intent that the topic documents correctly, and the cheapest fix for that
    // red is to bump the literal — which teaches the next person that this
    // file's numbers are decoration.
    expect(namesIn(section('INTENTS')).sort()).toEqual(intentNames());
  });

  it('the INTENTS prose counts the intents the table actually has', () => {
    // The block opens "Seven, one call each". That word is the only place the
    // count is stated, so it is the only place it can go stale.
    const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
    expect(section('INTENTS').join(' ').toLowerCase()).toContain(words[intentNames().length]);
  });

  it('every skill the topic names exists in skills/builtin/', () => {
    for (const name of namesIn(section('BUILT-IN SKILLS'))) {
      expect(fs.existsSync(path.join(BUILTIN_DIR, `${name}.yaml`))).toBe(true);
    }
  });

  it('every built-in skill is named in the topic', () => {
    const shipped = fs.readdirSync(BUILTIN_DIR).filter((f) => f.endsWith('.yaml')).map((f) => f.replace(/\.yaml$/, ''));
    const named = namesIn(section('BUILT-IN SKILLS'));
    // `daily-digest` is a read-only convenience, not a tracker composite, so the
    // topic does not carry it. Every OTHER shipped skill must be named.
    expect(shipped.filter((s) => s !== 'daily-digest').sort()).toEqual([...named].sort());
  });
});

describe('every built-in skill is runnable against the code that ships with it', () => {
  // The four skills deleted in this change had steps naming `ask` and `do` —
  // commands removed long ago. They parsed, listed and failed on the first
  // write. A skill that cannot run is documentation drift with a .yaml suffix.
  const READ_COMMANDS = ['context', 'standup', 'sprint-plan', 'query'];

  const files = fs.readdirSync(BUILTIN_DIR).filter((f) => f.endsWith('.yaml'));

  it.each(files)('%s only uses commands that exist', (file) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { loadSkillFromFile } = require('../lib/skill-store') as typeof import('../lib/skill-store');
    const skill = loadSkillFromFile(path.join(BUILTIN_DIR, file));
    for (const step of skill.steps) {
      expect([...READ_COMMANDS, ...intentNames()]).toContain(step.command);
    }
  });
});

describe('shipped prose never names a command the CLI does not have', () => {
  // This is the `favro audit` class: the command was deleted, the prose was not,
  // and an agent reading it burns a turn on a command that cannot run.
  const DOCS = [
    path.join(REPO_ROOT, 'skills', 'favro-cli', 'SKILL.md'),
    path.join(REPO_ROOT, 'skills', 'favro-cli', 'references', 'command-reference.md'),
  ];

  it.each([...DOCS, '<help topic>'])('%s', (file) => {
    const text = file === '<help topic>' ? ISSUE_TRACKER_TOPIC : fs.readFileSync(file, 'utf-8');
    const dead = [...invocations(text), ...declaredHeadings(text)]
      .filter((tokens) => !invocationExists(tokens))
      .map((tokens) => `favro ${tokens.join(' ')}`);
    expect([...new Set(dead)]).toEqual([]);
  });
});
