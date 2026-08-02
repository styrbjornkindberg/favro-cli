/**
 * The list-envelope ratchet (#99).
 *
 * WHAT IT GUARDS
 * `read-shape.ts` states the contract flatly: a list read emits
 * `{ rows, truncated?, unreachable? }`, always, "never an array unless
 * something went wrong". The value of that promise is that an agent parses one
 * shape. Before this file it held for four of eighteen list reads, so the shape
 * an agent got depended on which command it called — and `truncated` could only
 * ever appear on `cards list`, which means every other capped list cut rows off
 * the end and said nothing.
 *
 * The recurring failure is not a command written bare on purpose. It is that a
 * new list read is written by copying the nearest sibling, and the nearest
 * sibling was bare. #77/#78/#79 became three issues for the same reason on the
 * scope lock; this file is the same instrument pointed at output shape, and it
 * is deliberately built like `scope-lock-coverage.test.ts` so a reader who knows
 * one knows both.
 *
 * HOW IT DETECTS A LIST READ
 * Statically, through the TypeScript type checker, by the TYPE of what reaches
 * stdout — never by the command's name. A name heuristic ("list") misses
 * `activity`, `cards dependencies`, `cards blocking`, `cards blocked-by` and
 * `custom-fields values`, and would flag `tags list`'s siblings that return one
 * row. So instead, two detectors:
 *
 *   - BARE      = `console.log(JSON.stringify(x, …))` or the `process.stdout`
 *     twin, where the checker says `x` is an array. That is a list on stdout
 *     wearing no envelope, and it is the violation.
 *   - ENVELOPED = an action whose call closure reaches `writeEnvelope`, or a
 *     `run()` handler returning an object literal with a `rows` property —
 *     which the runner turns into `writeEnvelope` for it (ADR-0002).
 *
 * An action can be both: `tags list` was enveloped in JSON mode long before its
 * siblings were, and a half-migrated command is exactly what this catches.
 *
 * THE SECOND HALF OF THE CONTRACT
 * An envelope with no way to cap it can never set `truncated`, so
 * "every list read emits an envelope" and "every list read takes `--limit`" are
 * one requirement, not two. Both are asserted here, off the same detector, so
 * neither can be satisfied alone. `--limit` is read off the commander chain,
 * not off the handler, because that is where a missing flag actually is.
 *
 * TWO LISTS, AND WHY THEY ARE NOT ONE
 * Same split as the scope-lock ratchet, for the same reason — a decision that
 * gets filed as debt turns back into debt six months later:
 *
 *   - ALLOWLIST — debt. A list read that should wear the envelope and does not
 *     yet. Each entry names the issue that will delete it. Shrinking this list
 *     is what "done" means.
 *   - OUT_OF_REMIT — a decision. An array on stdout that is not a list read at
 *     all, with the reason stated here.
 *
 * Both are checked for staleness, so neither can rot.
 */
import * as path from 'path';
import * as ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * DEBT: list reads still emitting a bare array, keyed `<file> <command path>`,
 * valued with the issue that will delete the line.
 *
 * Empty, and an empty debt list is the point rather than an accident. It held
 * one entry while this ticket was written — `comments list`, capped inside its
 * API client and fixed on #136's own branch — and #136 landing is what deleted
 * it. That is the whole lifecycle this list is for.
 *
 * Do NOT add to this list to make a red build green. A new entry is a new
 * shape an agent has to branch on; the correct response to one is
 * `writeEnvelope(capRows(rows, limit))`, which is two lines.
 */
const ALLOWLIST: Record<string, string> = {};

/**
 * DECIDED: arrays on stdout that are not list reads.
 *
 * The envelope is the shape of a READ. Two other things put an array on stdout
 * and neither is answering "what rows are there":
 *
 *   - A write echo. `cards create --bulk` and `deps add` print what the write
 *     produced, under a `✓ …` line, after `reportDispatch` has already had its
 *     say. Wrapping those in `{rows}` would give one write two machine shapes
 *     and imply a `--limit` that would be a data-loss flag on a write receipt.
 *   - An export. `cards export` serialises to a FORMAT — the same bytes go to
 *     `--out file.json` as to stdout, and CSV is the sibling arm. An envelope
 *     there would either change the file format or make the file and the pipe
 *     disagree, and `--limit` on an export is `head`.
 *
 * These are not going away. Recording them here is what stops the next sweep
 * "fixing" them.
 */
const OUT_OF_REMIT: Record<string, string> = {
  'src/cli.ts cards create': '#99 — write echo, not a read; reportDispatch owns the machine shape',
  'src/commands/dependencies.ts dependencies add': '#99 — write echo of the post-link edge set',
  'src/cli.ts cards export': '#99 — a serialisation format, shared with --out; CSV is its sibling',
  'src/commands/cards-export.ts cards': '#99 — a serialisation format, shared with --out',
};

/** Exempt either way: debt and decision are both non-failing, for different reasons. */
const EXEMPT = { ...ALLOWLIST, ...OUT_OF_REMIT };

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

/** caller → declarations it calls. */
const callGraph = new Map<ts.Node, Set<ts.Node>>();
for (const sf of sourceFiles) {
  walk(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
    const callee = calleeDeclaration(n);
    const caller = enclosingFunction(n);
    if (!callee || !caller) return;
    if (!callGraph.has(caller)) callGraph.set(caller, new Set());
    callGraph.get(caller)!.add(callee);
  });
}

/** Everything that can reach `seeds`, transitively. */
function callers(seeds: Iterable<ts.Node>): Set<ts.Node> {
  const reaching = new Set(seeds);
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

/** Top-level functions declared in `file` with one of `names`. */
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

const READ_SHAPE = path.join('src', 'lib', 'read-shape.ts');
const WRITE_ENVELOPE = declarationsIn(READ_SHAPE, ['writeEnvelope']);
const CAP_ROWS = declarationsIn(READ_SHAPE, ['capRows']);
const ENVELOPES = callers(WRITE_ENVELOPE);

// ─── the commands ────────────────────────────────────────────────────────────

/**
 * The command path an `.action(…)` is registered under, read off the commander
 * chain, together with every long flag declared on the way up.
 *
 * One walk for both because they come from the same chain:
 * `.command('tags')…command('list').option('--limit <n>', …)` reads as
 * `tags list` with `--limit`. A variable in the chain (`tagsCommand`) is
 * followed to its own initializer, so a two-statement registration resolves the
 * same as a fluent one. Line numbers are deliberately not part of the key: an
 * edit above a command must not invalidate its allowlist entry.
 */
function chainOf(actionCall: ts.CallExpression): { path: string; flags: Set<string> } {
  const parts: string[] = [];
  const flags = new Set<string>();
  let node: ts.Node | undefined = (actionCall.expression as ts.PropertyAccessExpression).expression;
  while (node) {
    if (ts.isCallExpression(node)) {
      if (!ts.isPropertyAccessExpression(node.expression)) break;
      const method = node.expression.name.text;
      const [first] = node.arguments;
      if (first && ts.isStringLiteral(first)) {
        if (method === 'command') parts.unshift(first.text.split(' ')[0]);
        if (method === 'option' || method === 'requiredOption') {
          flags.add(first.text.split(/[ ,<[]/)[0]);
        }
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
  return { path: parts.join(' '), flags };
}

/** The function an expression names, however it was written. */
function resolvedFunction(arg: ts.Expression): ts.Node | undefined {
  if (isFunctionish(arg)) return arg;
  const direct = unalias(checker.getSymbolAtLocation(arg))?.declarations?.[0];
  if (isFunctionish(direct)) return direct;
  const viaType = unalias(checker.getTypeAtLocation(arg).getSymbol())?.declarations?.[0];
  return isFunctionish(viaType) ? viaType : undefined;
}

/**
 * The body of an action, however it was passed: an inline arrow, a named
 * function, or `run(handler)` — where the handler is the command and the runner
 * is the wrapper. Resolving `.action(run(h))` to `run` itself would make every
 * migrated list read invisible here, one migration at a time, with nothing
 * going red (#114, #115, #119 migrate 128 of them).
 */
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

function isArrayish(type: ts.Type): boolean {
  if (type.isUnion()) return type.types.some(isArrayish);
  return checker.isArrayType(type) || checker.isTupleType(type);
}

/**
 * Every value this file's detector inspects, with the type the checker gave it.
 *
 * Collected separately from the violation scan because the TYPE is this
 * detector's input: an `any` reaching `JSON.stringify` is neither array nor
 * object as far as `isArrayish` is concerned, so a bare list behind one leaves
 * this ratchet's sight with nothing going red. Asserted below rather than
 * trusted — the same reason `scope-lock-coverage.test.ts` asserts every
 * `run()` handler types its `ctx`.
 */
const stdoutJson: Array<{ where: string; type: string }> = [];
for (const sf of sourceFiles) {
  const rel = path.relative(REPO_ROOT, sf.fileName).split(path.sep).join('/');
  if (rel !== 'src/cli.ts' && !rel.startsWith('src/commands/')) continue;
  walk(sf, (n) => {
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return;
    const isStdout =
      (n.expression.name.text === 'log' && n.expression.expression.getText() === 'console') ||
      (n.expression.name.text === 'write' && n.expression.expression.getText() === 'process.stdout');
    if (!isStdout) return;
    let arg = n.arguments[0];
    if (!arg) return;
    if (ts.isBinaryExpression(arg)) arg = arg.left;
    if (!ts.isCallExpression(arg) || arg.expression.getText() !== 'JSON.stringify') return;
    const value = arg.arguments[0];
    if (!value) return;
    const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
    stdoutJson.push({ where: `${rel}:${line}`, type: checker.typeToString(checker.getTypeAtLocation(value)) });
  });
}

/**
 * A bare array on stdout: `console.log(JSON.stringify(rows, …))`, or the
 * `process.stdout.write(… + '\n')` spelling `cards export` uses.
 *
 * By the checker's type, not by the argument's name — `deps`, `blocked`,
 * `entries`, `opts` and `normalized` are all arrays and none of them says so.
 */
function emitsBareArray(body: ts.Node): boolean {
  let bare = false;
  walk(body, (n) => {
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return;
    const isStdout =
      (n.expression.name.text === 'log' && n.expression.expression.getText() === 'console') ||
      (n.expression.name.text === 'write' && n.expression.expression.getText() === 'process.stdout');
    if (!isStdout) return;
    let arg = n.arguments[0];
    if (!arg) return;
    if (ts.isBinaryExpression(arg)) arg = arg.left;
    if (!ts.isCallExpression(arg) || arg.expression.getText() !== 'JSON.stringify') return;
    const value = arg.arguments[0];
    if (value && isArrayish(checker.getTypeAtLocation(value))) bare = true;
  });
  return bare;
}

/**
 * A `run()` handler answering the rows arm. The runner calls `writeEnvelope`
 * for it, so the handler itself never mentions the envelope and the call-graph
 * detector cannot see it (ADR-0002).
 */
function returnsRows(body: ts.Node): boolean {
  let rows = false;
  walk(body, (n) => {
    if (!ts.isObjectLiteralExpression(n)) return;
    if (!ts.isReturnStatement(n.parent) && !ts.isParenthesizedExpression(n.parent)) return;
    if (n.properties.some((p) => p.name && ts.isIdentifier(p.name) && p.name.text === 'rows')) {
      rows = true;
    }
  });
  return rows;
}

interface ActionInfo {
  key: string;
  /** Puts a list on stdout with no envelope around it. */
  bare: boolean;
  /** Emits the envelope, directly or through the runner's rows arm. */
  enveloped: boolean;
  /** Declares `--limit` somewhere in its commander chain. */
  capped: boolean;
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
    const chain = chainOf(n);
    actions.push({
      key: `${rel.split(path.sep).join('/')} ${chain.path}`,
      bare: emitsBareArray(body),
      enveloped: reaches(body, ENVELOPES) || returnsRows(body),
      capped: chain.flags.has('--limit'),
    });
  });
}

const bare = actions.filter((a) => a.bare).map((a) => a.key).sort();
const listReads = actions.filter((a) => a.enveloped);
const uncapped = listReads.filter((a) => !a.capped).map((a) => a.key).sort();

// ─────────────────────────────────────────────────────────────────────────────

describe('every list read wears the envelope', () => {
  it('finds the commands and the contract it is meant to be reading', () => {
    // Floors, not counts to keep updated. A detector that resolved nothing
    // would report zero violations and pass forever — which is precisely how a
    // ratchet stops being one.
    expect(actions.length).toBeGreaterThan(100);
    expect(WRITE_ENVELOPE).toHaveLength(1);
    expect(CAP_ROWS).toHaveLength(1);
    expect(listReads.length).toBeGreaterThanOrEqual(18);
  });

  it('no command puts a bare array on stdout, outside the two lists', () => {
    // A new name here is a new output shape for an agent to branch on. The fix
    // is `writeEnvelope(capRows(rows, limit))` in the command; do not add it to
    // either list.
    expect(bare.filter((key) => !(key in EXEMPT))).toEqual([]);
  });

  it('the debt list is empty and stays that way', () => {
    // Stated as its own assertion rather than left implicit in the one above,
    // so the next entry has to be argued for rather than slipped in beside
    // existing lines. Shrinking this list is what "done" means here.
    expect(Object.keys(ALLOWLIST)).toEqual([]);
  });

  it('no entry in either list is stale — a fixed command must be removed', () => {
    // A list nobody prunes is worse than no test: it becomes a permanent
    // exemption that reads like debt. This runs over OUT_OF_REMIT too — a
    // decision is not a licence to stop checking that it still describes
    // the code.
    const live = new Set(bare);
    expect(Object.keys(EXEMPT).filter((key) => !live.has(key)).sort()).toEqual([]);
  });
});

describe('the detector stays able to detect', () => {
  it('reads a resolved type for everything a command JSON-stringifies to stdout', () => {
    // `JSON.stringify(rows as any)` is an array this file cannot see, and it
    // would not go red — it would go quiet, which is worse. The fix when this
    // fails is to type the value, never to widen `isArrayish`.
    expect(stdoutJson.filter((s) => s.type === 'any').map((s) => s.where)).toEqual([]);
    expect(stdoutJson.length).toBeGreaterThan(20);
  });
});

describe('every list read can be capped, so `truncated` is reachable', () => {
  it('declares --limit on the command that emits the envelope', () => {
    // An envelope with no cap can never carry `truncated`, which is how
    // `truncated` came to exist on exactly one command while `capRows` sat in
    // `read-shape.ts` looking adopted. The flag is asserted on the commander
    // chain because that is where a missing one is.
    expect(uncapped).toEqual([]);
  });
});
