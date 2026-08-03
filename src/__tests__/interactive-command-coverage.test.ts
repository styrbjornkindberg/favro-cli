/**
 * The interactive-command ratchet (#147).
 *
 * WHAT IT GUARDS
 * `lib/interactive-commands.ts` is a LIST, and a list is the shape that drifts.
 * Both readers — `favro shell` and `favro_run` — decide before the child process
 * exists, so neither can consult a marker on a `Command` object built inside it;
 * the list has to be the marker. An interactive command missing from it does not
 * fail loudly, it HANGS: vi on a pipe inside `favro shell`, or the whole 60s MCP
 * timeout followed by an `isError` an agent reads as "retry". #82's fix
 * enumerated nine entry points and missed a tenth, and that tenth printed a
 * success message for a write that never landed. This is the same shape.
 *
 * HOW IT DETECTS ONE — THE REAL SURFACE, NOT A PROXY
 * Three ratchets in this repo were proven blind to exactly what they were built
 * for, every one because they scanned a textual proxy. So this walks the
 * commander registration tree and the call graph through the TypeScript checker:
 *
 *   PRIMITIVES (AST shapes, not spellings):
 *     - `<x>.createInterface(…)`     — a readline prompt (`auth login`)
 *     - `new <x>(…)` where `<x>` is bound by `require('enquirer')` / an import
 *       of it — an arrow-key picker (`browse`, the main menu). Resolved through
 *       the require binding rather than a list of class names, because
 *       `Select`/`AutoComplete`/`Confirm` is not a closed set.
 *     - any call carrying `stdio: …'inherit'…` — a child handed this process's
 *       terminal (`skill edit`, and `shell`'s own passthrough)
 *   CLOSURE: every function that transitively CALLS one, by declaration
 *     identity — so `auth login` → `promptInput` → `readline.createInterface`
 *     resolves, and a helper two frames down cannot hide a prompt.
 *   COMMANDS: every `.action(…)` in `src/cli.ts` and `src/commands/`, keyed by
 *     the command path read off the commander chain, unwrapped through `run()`.
 *
 * THE ONE BARRIER, AND WHY IT IS NOT AN ALLOWLIST OF FORTY
 * `safety.ts:confirmAction` calls `readline.createInterface`, and about forty
 * write commands call `confirmAction`. Left alone, the closure would swallow
 * every write in the CLI and the allowlist would be longer than the codebase.
 * It is cut instead, because it is measurably safe on a pipe: it throws on
 * `!process.stdin.isTTY` before creating the interface, so it refuses fast
 * rather than blocking, and `-y` is the non-interactive path every caller
 * already carries. That is one named decision rather than forty exemptions —
 * and `confirmAction` itself stays under the primitive check, so if the TTY
 * guard is ever deleted the barrier's justification goes with it.
 *
 * TO DISCHARGE AN ALLOWLIST ENTRY: add the command to `INTERACTIVE_COMMANDS`,
 * then delete its line. Deleting the line is not optional — the staleness arm
 * keeps the build red until you do.
 *
 * WHAT IT DOES NOT SEE, STATED
 * A command that takes the terminal over without touching any of the three
 * primitives. `board --watch` is exactly that — it writes an ANSI clear and
 * loops on `setInterval` until SIGINT, and `board-tui.ts` spawns nothing and
 * prompts for nothing. It is listed in `INTERACTIVE_COMMANDS` anyway, so this
 * ratchet's set is a SUBSET of the list rather than an equal — which is why
 * there is no staleness arm over the list itself, only over the allowlist.
 * ponytail: no fourth heuristic for "renders forever"; one such command exists
 * and a second should have to be argued on an issue.
 *
 * ponytail: the AST helpers below are a second copy of the ones in
 * `scope-lock-coverage.test.ts`. Extract both into `src/test-support/` when a
 * third ratchet needs them; refactoring a proven ratchet was not this ticket's
 * to do.
 */
import * as path from 'path';
import * as ts from 'typescript';
import { INTERACTIVE_COMMANDS, findInteractiveCommand } from '../lib/interactive-commands';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * KNOWN interactive commands NOT yet listed in `INTERACTIVE_COMMANDS`, keyed
 * `<file> <command path>`.
 *
 * Empty, and an empty list is the point. A new entry here is a command that
 * hangs under `favro_run` and inside `favro shell`; the correct response is to
 * list it, not to exempt it.
 */
const ALLOWLIST: Record<string, string> = {};

// ─── the program ─────────────────────────────────────────────────────────────

const configPath = ts.findConfigFile(REPO_ROOT, ts.sys.fileExists, 'tsconfig.json')!;
const parsedConfig = ts.parseJsonConfigFileContent(
  ts.readConfigFile(configPath, ts.sys.readFile).config,
  ts.sys,
  REPO_ROOT,
);
const program = ts.createProgram(
  parsedConfig.fileNames.filter((f) => !f.includes('__tests__')),
  { ...parsedConfig.options, noEmit: true },
);
const checker = program.getTypeChecker();
const sourceFiles = program
  .getSourceFiles()
  .filter((sf) => !sf.isDeclarationFile && sf.fileName.startsWith(path.join(REPO_ROOT, 'src')));

const walk = (node: ts.Node, visit: (n: ts.Node) => void): void => {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
};

const unalias = (sym: ts.Symbol | undefined): ts.Symbol | undefined =>
  sym && sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;

const isFunctionish = (node: ts.Node | undefined): boolean =>
  !!node &&
  (ts.isMethodDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodSignature(node));

/** The declaration a call resolves to — the whole point of using the checker. */
function calleeDeclaration(call: ts.CallExpression): ts.Node | undefined {
  const direct = unalias(checker.getSymbolAtLocation(call.expression))?.declarations?.[0];
  if (isFunctionish(direct)) return direct;
  // `const { confirmAction } = await import('../lib/safety')` binds a
  // BindingElement, not the function. Follow the TYPE back to the declaration.
  const viaType = unalias(checker.getTypeAtLocation(call.expression).getSymbol())?.declarations?.[0];
  return isFunctionish(viaType) ? viaType : direct;
}

/** The function-ish node a call sits inside. */
function enclosingFunction(node: ts.Node): ts.Node | undefined {
  for (let n = node.parent; n; n = n.parent) {
    if (isFunctionish(n) || ts.isConstructorDeclaration(n) || ts.isPropertyDeclaration(n)) return n;
  }
  return undefined;
}

/** Top-level functions/methods declared in `file` with one of `names`. */
function declarationsIn(file: string, names: string[]): ts.Node[] {
  const found: ts.Node[] = [];
  for (const sf of sourceFiles) {
    if (!sf.fileName.endsWith(file)) continue;
    walk(sf, (n) => {
      if (
        (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) &&
        n.name &&
        ts.isIdentifier(n.name) &&
        names.includes(n.name.text)
      ) {
        found.push(n);
      }
    });
  }
  return found;
}

// ─── the primitives ──────────────────────────────────────────────────────────

/** `confirmAction`: cut out of the graph, for the reason argued in the header. */
const BARRIERS = new Set(declarationsIn(path.join('src', 'lib', 'safety.ts'), ['confirmAction']));

/** Identifiers in this file that came out of `require('enquirer')` or an import of it. */
function enquirerBindings(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  walk(sf, (n) => {
    if (ts.isImportDeclaration(n) && (n.moduleSpecifier as ts.StringLiteral).text === 'enquirer') {
      walk(n, (inner) => {
        if (ts.isImportSpecifier(inner) || ts.isImportClause(inner)) {
          const name = (inner as ts.ImportSpecifier).name;
          if (name && ts.isIdentifier(name)) names.add(name.text);
        }
      });
      return;
    }
    if (!ts.isVariableDeclaration(n) || !n.initializer) return;
    const init = n.initializer;
    if (
      !ts.isCallExpression(init) ||
      !ts.isIdentifier(init.expression) ||
      init.expression.text !== 'require' ||
      !init.arguments[0] ||
      !ts.isStringLiteral(init.arguments[0]) ||
      init.arguments[0].text !== 'enquirer'
    ) {
      return;
    }
    // `const { Select, AutoComplete } = require('enquirer')`, and the whole-module
    // form too.
    if (ts.isObjectBindingPattern(n.name)) {
      for (const element of n.name.elements) {
        if (ts.isIdentifier(element.name)) names.add(element.name.text);
      }
    } else if (ts.isIdentifier(n.name)) {
      names.add(n.name.text);
    }
  });
  return names;
}

/** Does this node's subtree contain the string literal `inherit`? */
function mentionsInherit(node: ts.Node): boolean {
  let found = false;
  walk(node, (n) => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === 'inherit') found = true;
  });
  return found;
}

/** Which primitive kinds were seen, so the self-check can prove each is live. */
const PRIMITIVE_KINDS = ['readline', 'enquirer', 'stdio-inherit'] as const;
type PrimitiveKind = (typeof PRIMITIVE_KINDS)[number];

const seeds = new Map<ts.Node, PrimitiveKind>();

/**
 * Seed EVERY enclosing function, not just the innermost.
 *
 * `auth login` is why. `promptInput` wraps its `readline.createInterface` in a
 * `new Promise((resolve) => …)`, so the innermost enclosing function is that
 * arrow — and nothing ever *calls* an arrow passed as an argument, so the call
 * graph cannot reach it and `auth login` read as non-interactive. Callback
 * arrows are executed by the function they are handed to, so attributing the
 * primitive upward is the honest reading. The one over-reach it buys is that a
 * `register…Command` function containing an interactive `.action(…)` also lands
 * in the set, which changes no verdict: nothing's action body calls a registrar.
 */
const seed = (node: ts.Node, kind: PrimitiveKind): void => {
  for (let host = enclosingFunction(node); host; host = enclosingFunction(host)) {
    seeds.set(host, kind);
  }
};

for (const sf of sourceFiles) {
  const pickers = enquirerBindings(sf);
  walk(sf, (n) => {
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && pickers.has(n.expression.text)) {
      seed(n, 'enquirer');
      return;
    }
    if (!ts.isCallExpression(n)) return;
    if (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'createInterface') {
      seed(n, 'readline');
      return;
    }
    // `stdio` is a child_process-only option, so an object-literal argument
    // carrying it and the string `inherit` IS a terminal handover.
    for (const arg of n.arguments) {
      if (!ts.isObjectLiteralExpression(arg)) continue;
      const stdio = arg.properties.find(
        (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'stdio',
      ) as ts.PropertyAssignment | undefined;
      if (stdio && mentionsInherit(stdio.initializer)) seed(n, 'stdio-inherit');
    }
  });
}

// ─── the closure ─────────────────────────────────────────────────────────────

/** caller → declarations it calls, with the barrier edges cut. */
const callGraph = new Map<ts.Node, Set<ts.Node>>();
for (const sf of sourceFiles) {
  walk(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
    const callee = calleeDeclaration(n);
    const caller = enclosingFunction(n);
    if (!callee || !caller || BARRIERS.has(callee)) return;
    if (!callGraph.has(caller)) callGraph.set(caller, new Set());
    callGraph.get(caller)!.add(callee);
  });
}

/** Everything that can reach a primitive, transitively. */
function callers(from: Iterable<ts.Node>): Set<ts.Node> {
  const reaching = new Set(from);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [caller, callees] of callGraph) {
      if (reaching.has(caller)) continue;
      for (const callee of callees) {
        if (reaching.has(callee)) {
          reaching.add(caller);
          changed = true;
          break;
        }
      }
    }
  }
  return reaching;
}

const INTERACTIVE = callers(seeds.keys());

// ─── the commands ────────────────────────────────────────────────────────────

/** The command path an `.action(…)` is registered under, read off the chain. */
function commandPath(actionCall: ts.CallExpression): string {
  const parts: string[] = [];
  let node: ts.Node | undefined = (actionCall.expression as ts.PropertyAccessExpression).expression;
  while (node) {
    if (ts.isCallExpression(node)) {
      if (!ts.isPropertyAccessExpression(node.expression)) break;
      const [first] = node.arguments;
      if (node.expression.name.text === 'command' && first && ts.isStringLiteral(first)) {
        parts.unshift(first.text.split(' ')[0]);
      }
      node = node.expression.expression;
    } else if (ts.isPropertyAccessExpression(node)) {
      node = node.expression;
    } else if (ts.isIdentifier(node)) {
      const decl: ts.Declaration | undefined = checker.getSymbolAtLocation(node)?.declarations?.[0];
      if (!decl || !ts.isVariableDeclaration(decl) || !decl.initializer) break;
      node = decl.initializer;
    } else break;
  }
  return parts.join(' ');
}

/** The function an expression names, however it was written. */
function resolvedFunction(arg: ts.Expression): ts.Node | undefined {
  if (isFunctionish(arg)) return arg;
  const direct = unalias(checker.getSymbolAtLocation(arg))?.declarations?.[0];
  if (isFunctionish(direct)) return direct;
  const viaType = unalias(checker.getTypeAtLocation(arg).getSymbol())?.declarations?.[0];
  return isFunctionish(viaType) ? viaType : undefined;
}

/** The body of an action: inline arrow, named function, `run(handler)`, or factory. */
function actionBody(arg: ts.Expression | undefined): ts.Node | undefined {
  if (!arg) return undefined;
  if (isFunctionish(arg)) return arg;
  if (ts.isCallExpression(arg)) {
    const handler = arg.arguments.map(resolvedFunction).find(isFunctionish);
    if (handler) return handler;
    return calleeDeclaration(arg);
  }
  return resolvedFunction(arg);
}

/** Is any function in this subtree — including the root — in `set`? */
function reaches(body: ts.Node, set: Set<ts.Node>): boolean {
  let hit = false;
  walk(body, (n) => {
    if (set.has(n)) hit = true;
  });
  return hit;
}

interface ActionInfo {
  key: string;
  commandPath: string;
  interactive: boolean;
}

const actions: ActionInfo[] = [];
for (const sf of sourceFiles) {
  const rel = path.relative(REPO_ROOT, sf.fileName);
  if (rel !== path.join('src', 'cli.ts') && !rel.startsWith(path.join('src', 'commands'))) continue;
  walk(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
    if (!ts.isPropertyAccessExpression(n.expression) || n.expression.name.text !== 'action') return;
    const body = actionBody(n.arguments[0]);
    if (!body) return;
    const commandKey = commandPath(n);
    actions.push({
      key: `${rel.split(path.sep).join('/')} ${commandKey}`,
      commandPath: commandKey,
      interactive: reaches(body, INTERACTIVE),
    });
  });
}

/** Listed as interactive, by path. */
const listed = new Set(INTERACTIVE_COMMANDS.map((entry) => entry.path));

/** Detected as interactive and not on the list. */
const unlisted = actions
  .filter((a) => a.interactive && !listed.has(a.commandPath))
  .map((a) => a.key)
  .sort();

// ─────────────────────────────────────────────────────────────────────────────

describe('every interactive command is on the list both parents read', () => {
  it('finds the surface it is meant to be reading', () => {
    // A detector that resolved nothing would report zero unlisted commands and
    // pass forever. Floors, not counts to keep updated.
    expect(actions.length).toBeGreaterThan(100);
    expect(actions.filter((a) => a.interactive).length).toBeGreaterThanOrEqual(4);
    expect(seeds.size).toBeGreaterThanOrEqual(4);
  });

  it('every primitive it looks for still has a live example', () => {
    // A primitive matching nothing is a dead check: it would keep passing if the
    // AST shape it looks for were wrong. All three must still fire somewhere.
    const live = new Set(seeds.values());
    expect(PRIMITIVE_KINDS.filter((kind) => !live.has(kind))).toEqual([]);
  });

  it('detects the four commands the ticket named, by name', () => {
    // The detector's own calibration. If `auth login` (a prompt two frames down
    // through `promptInput`) or `skill edit` (an `stdio: 'inherit'` spawn) stops
    // being detected, the ratchet has gone blind and every assertion below is
    // vacuously green.
    const detected = new Set(actions.filter((a) => a.interactive).map((a) => a.commandPath));
    expect([...detected].sort()).toEqual(expect.arrayContaining(['auth login', 'browse', 'shell', 'skill edit']));
  });

  it('no interactive command is missing from INTERACTIVE_COMMANDS', () => {
    // A new name here is a command that HANGS under favro_run and inside favro
    // shell. Add it to `lib/interactive-commands.ts`; do not add it here.
    expect(unlisted.filter((key) => !(key in ALLOWLIST))).toEqual([]);
  });

  it('the allowlist is empty and stays that way', () => {
    expect(Object.keys(ALLOWLIST)).toEqual([]);
  });

  it('no allowlist entry is stale — a listed command must be struck off', () => {
    // The direction that stops the list rusting into permanent cover. If this
    // fails, the fix is to DELETE the named line.
    const live = new Set(unlisted);
    expect(Object.keys(ALLOWLIST).filter((key) => !live.has(key))).toEqual([]);
  });

  it('every listed path is a real command on the commander surface', () => {
    // The other way the list drifts: a rename or a typo leaves an entry that
    // matches nothing, and the command it was meant to guard hangs again.
    const real = new Set(actions.map((a) => a.commandPath));
    const phantom = INTERACTIVE_COMMANDS.map((e) => e.path).filter((p) => p !== '' && !real.has(p));
    expect(phantom).toEqual([]);
  });

  it('the bare main menu is still covered, which no .action() can show', () => {
    // `cli.ts` opens `runMainMenu` on ZERO arguments, outside commander, so the
    // scan above cannot see it. Asserted directly instead.
    expect(findInteractiveCommand([])).toBeDefined();
  });
});

describe('the confirmAction barrier is founded', () => {
  it('confirmAction exists and is the only thing cut out of the graph', () => {
    expect(BARRIERS.size).toBe(1);
  });

  it('confirmAction still throws on stdin.isTTY before it creates an interface', () => {
    // Every write command in the CLI is exempted on the strength of this guard.
    // If it goes, they all block on a prompt that never answers and the barrier
    // is hiding forty hangs. Read off the AST of the real function, so the
    // justification cannot rot away from the code.
    //
    // Asserted as "reads isTTY, and throws before the readline call", by
    // POSITION — not as a particular condition shape. `!process.stdin.isTTY`
    // and `process.stdin.isTTY === false` are the same guard, and a ratchet that
    // reddens on the rewrite is a ratchet people route around.
    const [confirmAction] = [...BARRIERS];
    let readsTty = false;
    let firstThrow = Infinity;
    let interfaceAt = Infinity;
    walk(confirmAction, (n) => {
      if (ts.isPropertyAccessExpression(n) && n.name.text === 'isTTY') readsTty = true;
      if (ts.isThrowStatement(n)) firstThrow = Math.min(firstThrow, n.getStart());
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'createInterface') {
        interfaceAt = Math.min(interfaceAt, n.getStart());
      }
    });
    expect(readsTty).toBe(true);
    expect(interfaceAt).toBeLessThan(Infinity);
    expect(firstThrow).toBeLessThan(interfaceAt);
  });

  it('something still routes through it, so the cut is doing real work', () => {
    // If nothing called `confirmAction` any more, the barrier would be dead
    // weight — and a dead barrier is one nobody notices going wrong.
    const confirmCallers = [...callGraph.values()].filter((callees) =>
      [...BARRIERS].some((barrier) => callees.has(barrier)),
    );
    // Zero, by construction: the edges are cut when the graph is built. So count
    // them on an uncut pass instead.
    expect(confirmCallers).toEqual([]);
    let callSites = 0;
    for (const sf of sourceFiles) {
      walk(sf, (n) => {
        if (ts.isCallExpression(n) && BARRIERS.has(calleeDeclaration(n) as ts.Node)) callSites += 1;
      });
    }
    expect(callSites).toBeGreaterThan(20);
  });
});
