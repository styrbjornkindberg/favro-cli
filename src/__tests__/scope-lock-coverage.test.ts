/**
 * The scope-lock ratchet (#77/#78/#79 closed three holes; this stops the fourth).
 *
 * WHAT IT GUARDS
 * The scope lock is the write guardrail — `--dry-run` is only a preview — so a
 * command that writes to Favro without taking it is a command that can write to
 * a board outside the user's locked collection. The recurring failure is not a
 * command written without a lock on purpose; it is a HALF-LOCKED COMMAND GROUP:
 * `comments add` checks and `comments update`/`delete` do not, `attachments
 * upload` checks and `upload-to-comment` does not, `git sync` checks and `git
 * branch` does not. Reading one subcommand tells you nothing about its siblings,
 * which is exactly why these survive review. This test reads all of them.
 *
 * HOW IT DETECTS A WRITE
 * Statically, through the TypeScript type checker, by the MUTATION performed —
 * never by the command's name. A verb heuristic ("create/update/delete") misses
 * `archive`, `claim`, `retag`, `complete`, `todos --create`, and would flag
 * read commands that merely resolve names. So instead:
 *
 *   - MUTATES  = the call closure of `FavroHttpClient.post/put/delete/patch`,
 *     plus any function calling `<something>client.post|put|delete|patch(…)`
 *     directly (`attachments-api.ts` bypasses the wrapper and posts multipart
 *     through the raw axios instance — a name-based scan would miss it).
 *   - GUARDED  = the call closure of `assertScope` / `checkScope` /
 *     `checkCollectionScope` in `src/lib/safety.ts`.
 *   - ROUTED   = the call closure of `dispatch()` in `src/lib/dispatch.ts`.
 *
 * Closures, not single frames, because both the write and the check are often a
 * helper or two down (`comments.ts:addComment`, `cards-tracker.ts:run`,
 * `cards-archive.ts:archiveAction`). Declaration identity, not method names, so
 * `commentsApi.add(…)` counts and `someSet.add(…)` does not — and so a dynamic
 * `const { checkScope } = await import('../lib/safety')`, which most guarded
 * commands use, still resolves to the real function.
 *
 * A dispatch-routed command is COVERED, not exempt: `dispatch.ts` runs
 * `assertScope` over every distinct board of every intent before any write, so
 * demanding a second inline check would be demanding a redundant one. That
 * exemption is only worth as much as the check inside dispatch, so this file
 * asserts that check is still there, and that something still routes through it.
 *
 * Read-only commands need no exemption list — they never enter MUTATES. Nor do
 * `auth`, `scope set` or `init`, which write only local config.
 *
 * TWO LISTS, AND WHY THEY ARE NOT ONE
 * An unguarded write is one of two things, and collapsing them is how a decision
 * turns back into debt six months later:
 *
 *   - ALLOWLIST — debt. A write that SHOULD take the lock and does not yet. Each
 *     entry names the issue that will delete it. The list only ever shrinks; it
 *     is empty today, and an empty debt list is the point, not an accident.
 *   - OUT_OF_REMIT — a decision. A write the lock structurally cannot govern,
 *     with the reason stated here and again in the command's own source. These
 *     are not going away, and pretending they are debt would mean a permanently
 *     red ratchet that everyone learns to ignore.
 *
 * Both are exempt from the "no new holes" test and both are checked for
 * staleness, so neither can rot: an entry in either list that is now guarded, or
 * that no longer exists under that key, fails the build.
 *
 * TO DISCHARGE AN ALLOWLIST ENTRY: add the scope check to the command, then
 * delete its line. Deleting the line is not optional. TO MOVE ONE TO
 * OUT_OF_REMIT: argue it on the issue first — this file records calls, it does
 * not make them.
 */
import * as path from 'path';
import * as ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * DEBT: writes that should take the scope lock and do not yet, keyed
 * `<file> <command path>`, valued with the issue that will delete the line.
 *
 * Empty. It held 22 entries before #102/#103/#104; ten took the lock and twelve
 * were decided out of remit below. Do NOT add to this list to make a red build
 * green — a new entry is a new hole, and the only correct response to one is to
 * guard the command.
 */
const ALLOWLIST: Record<string, string> = {};

/**
 * DECIDED: writes the collection lock structurally cannot govern.
 *
 * The lock resolves the BOARD a write lands on and asks whether that board is in
 * the locked collection (`assertScope`). Every entry here lands on no board at
 * all, so there is nothing to resolve — a check would either always pass (a lie)
 * or always refuse, since `assertScope` treats an unresolvable board as a
 * violation rather than an exemption. Always-refuse would break tag and group
 * management outright for every locked user, which is not the lock doing its
 * job. An org-level guardrail would have to be a DIFFERENT guardrail; one does
 * not exist today.
 *
 * The same reasoning is written at the head of each command's own source (#104),
 * because a reader hunting the missing check reads the command, not this file.
 *
 * The cost is named rather than hidden: `tags delete` strips the tag from every
 * card in the organization — a wider blast radius than anything the collection
 * lock guards. That is a real gap. It is not this lock's gap.
 */
const OUT_OF_REMIT: Record<string, string> = {
  'src/commands/tags.ts tags create': '#104 — org-scoped; no board to resolve',
  'src/commands/tags.ts tags update': '#104 — org-scoped; no board to resolve',
  'src/commands/tags.ts tags delete': '#104 — org-scoped; no board to resolve',
  'src/commands/users.ts groups create': '#104 — org-scoped; no board to resolve',
  'src/commands/users.ts groups update': '#104 — org-scoped; no board to resolve',
  'src/commands/users.ts groups delete': '#104 — org-scoped; no board to resolve',
  'src/commands/webhooks.ts webhooks create': '#104 — org-scoped; no board to resolve',
  'src/commands/webhooks.ts webhooks delete': '#104 — org-scoped; no board to resolve',
  // The sharpest case, and the reason this list exists rather than a silence:
  // `collections update`/`delete` DO call `checkCollectionScope`, so the group
  // is asymmetric on purpose. `create` cannot check — the collection does not
  // exist until the request returns, so it is outside the lock by construction.
  'src/commands/collections-create.ts create': '#104 — the collection does not exist yet',
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
  // `const { checkScope } = await import('../lib/safety')` binds a
  // BindingElement, not the function. Follow the TYPE back to the declaration —
  // without this, most of the guarded commands read as unguarded.
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

const HTTP_VERBS = ['post', 'put', 'delete', 'patch'];

/** Functions issuing a mutating request straight at an http client instance. */
const rawClientWriters: ts.Node[] = [];
for (const sf of sourceFiles) {
  walk(sf, (n) => {
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return;
    if (!HTTP_VERBS.includes(n.expression.name.text)) return;
    if (!/client$/i.test(n.expression.expression.getText())) return;
    const host = enclosingFunction(n);
    if (host) rawClientWriters.push(host);
  });
}

const MUTATES = callers([
  ...declarationsIn(path.join('src', 'lib', 'http-client.ts'), HTTP_VERBS),
  ...rawClientWriters,
]);
const SCOPE_CHECKS = declarationsIn(path.join('src', 'lib', 'safety.ts'), [
  'assertScope',
  'checkScope',
  'checkCollectionScope',
]);
const GUARDED = callers(SCOPE_CHECKS);
const DISPATCH = declarationsIn(path.join('src', 'lib', 'dispatch.ts'), ['dispatch']);
const ROUTED = callers(DISPATCH);

// ─── the commands ────────────────────────────────────────────────────────────

/**
 * The command path an `.action(…)` is registered under, read off the commander
 * chain — `.command('tasks')…command('update <taskId>')` reads as `tasks
 * update`. A variable in the chain (`tasksCommand`) is followed to its own
 * initializer. Paired with the file name it identifies the action; line numbers
 * deliberately are not part of the key, so an edit above a command does not
 * invalidate its allowlist entry.
 */
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

/**
 * The function an expression names, however it was written: the function
 * itself, an identifier bound to one, or an identifier whose TYPE is one.
 *
 * The last case is the whole reason this is not two lines: `const h = async
 * (ctx: Ctx) => {…}` binds a `VariableDeclaration`, which `isFunctionish`
 * rejects, so the symbol route misses it and only the type route finds the
 * arrow. `calleeDeclaration` above needs the same fallback for the same reason.
 */
function resolvedFunction(arg: ts.Expression): ts.Node | undefined {
  if (isFunctionish(arg)) return arg;
  const direct = unalias(checker.getSymbolAtLocation(arg))?.declarations?.[0];
  if (isFunctionish(direct)) return direct;
  const viaType = unalias(checker.getTypeAtLocation(arg).getSymbol())?.declarations?.[0];
  return isFunctionish(viaType) ? viaType : undefined;
}

/**
 * The body of an action, however it was passed: an inline arrow, a named
 * function, or a factory call (`.action(archiveAction(cardsCmd, true))`, which
 * is how `cards archive` registers).
 */
function actionBody(arg: ts.Expression | undefined): ts.Node | undefined {
  if (!arg) return undefined;
  if (isFunctionish(arg)) return arg;
  if (ts.isCallExpression(arg)) {
    // `.action(run(handler))` (#113/#114): the runner is the wrapper, the
    // handler is the command. Resolving the call to `run` itself would read
    // every migrated write as a non-write — the writes would silently leave
    // this ratchet's sight one migration step at a time, and nothing would go
    // red, because a command that writes nothing needs no lock. It has to find
    // the handler whether it was written inline, hoisted to a `function`, or
    // hoisted to a `const` — the last is what this ticket's own "test the
    // handler with a fake Ctx" criterion pushes authors towards. A factory with
    // no function argument (`archiveAction(cardsCmd, true)`) still resolves as
    // before.
    const handler = arg.arguments.map(resolvedFunction).find(isFunctionish);
    if (handler) return handler;
    return calleeDeclaration(arg);
  }
  return resolvedFunction(arg);
}

/**
 * Every call to the command runner in a command module, with the handler it
 * wraps.
 *
 * Resolved by DECLARATION, not by the name `run` — `cards-tracker.ts` has a
 * local `run<T>()` helper of its own, and matching on the spelling would report
 * its three call sites as untyped handlers.
 */
function runCalls(): Array<{ where: string; handler: ts.Node | undefined }> {
  const found: Array<{ where: string; handler: ts.Node | undefined }> = [];
  const isTheRunner = (callee: ts.Expression): boolean =>
    (unalias(checker.getSymbolAtLocation(callee))?.declarations ?? []).some((d) =>
      d.getSourceFile().fileName.endsWith(path.join('src', 'lib', 'run.ts')),
    );
  for (const sf of sourceFiles) {
    const rel = path.relative(REPO_ROOT, sf.fileName).split(path.sep).join('/');
    if (rel !== 'src/cli.ts' && !rel.startsWith('src/commands/')) continue;
    walk(sf, (n) => {
      if (!ts.isCallExpression(n) || !isTheRunner(n.expression)) return;
      const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
      found.push({ where: `${rel}:${line}`, handler: n.arguments.map(resolvedFunction).find(isFunctionish) });
    });
  }
  return found;
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
  writes: boolean;
  guarded: boolean;
  routed: boolean;
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
    actions.push({
      key: `${rel.split(path.sep).join('/')} ${commandPath(n)}`,
      writes: reaches(body, MUTATES),
      guarded: reaches(body, GUARDED),
      routed: reaches(body, ROUTED),
    });
  });
}

/** Every command that writes to Favro without the lock ever being checked. */
const unguarded = actions
  .filter((a) => a.writes && !a.guarded && !a.routed)
  .map((a) => a.key)
  .sort();

// ─────────────────────────────────────────────────────────────────────────────

describe('the scope lock covers every write command', () => {
  it('finds the commands it is meant to be reading', () => {
    // A detector that resolved nothing would report zero unguarded writes and
    // pass forever. These are the floors, not counts to keep updated.
    expect(actions.length).toBeGreaterThan(100);
    expect(actions.filter((a) => a.writes).length).toBeGreaterThan(20);
    expect(actions.filter((a) => a.writes && a.guarded).length).toBeGreaterThan(15);
  });

  it('no command writes without taking the lock, outside the two lists', () => {
    // A new name here is a new hole. Add the scope check to the command; do not
    // add it to either list.
    expect(unguarded.filter((key) => !(key in EXEMPT))).toEqual([]);
  });

  it('the debt list is empty and stays that way', () => {
    // Stated as its own assertion rather than left implicit in the one above.
    // #102/#103/#104 emptied it; the next entry to appear should have to be
    // argued for, not slipped in beside twelve existing lines.
    expect(Object.keys(ALLOWLIST)).toEqual([]);
  });

  it('no entry in either list is stale — a fixed command must be removed', () => {
    // A list nobody prunes is worse than no test: it becomes a permanent
    // exemption that reads like debt. An entry that is now guarded, or that no
    // longer exists under that key, has to go. This runs over OUT_OF_REMIT too:
    // a decision is not a licence to stop checking whether it still describes
    // the code.
    const live = new Set(unguarded);
    expect(Object.keys(EXEMPT).filter((key) => !live.has(key)).sort()).toEqual([]);
  });
});

describe('the exemption for dispatch-routed commands is founded', () => {
  it('dispatch still checks the scope lock itself', () => {
    // `cards create`, `link`, `unlink`, `delete`, `archive`, `claim`, `resolve`
    // and `retag` are all exempted above on the strength of this one check. If
    // it goes, they are unguarded and the exemption is a lie.
    expect(DISPATCH).toHaveLength(1);
    expect(GUARDED.has(DISPATCH[0])).toBe(true);
  });

  it('commands actually route through it', () => {
    // If nothing routes, the exemption is silently doing nothing — which would
    // also be true if `dispatch` stopped resolving, and then the exemption would
    // start hiding real writes.
    expect(actions.filter((a) => a.routed).length).toBeGreaterThan(4);
  });
});

/**
 * The two ways a `run()`-migrated command drops out of this detector WITHOUT
 * anything going red — which is the dangerous kind, because a command that
 * appears to write nothing needs no lock and so raises no violation.
 *
 * Both are one ordinary refactor away from a migrated file, and #114 → #119
 * migrate 128 of them, so they are asserted rather than trusted.
 */
describe('every run() handler stays visible to this detector', () => {
  const calls = runCalls();

  it('finds the run() calls it is meant to be reading', () => {
    // A floor, not a count: a resolver that found nothing would pass the two
    // assertions below forever. Twelve commands migrated in #114.
    expect(calls.length).toBeGreaterThanOrEqual(12);
  });

  it('resolves the handler every one of them wraps', () => {
    // Fails if a handler is passed in a shape `resolvedFunction` cannot follow.
    // The fix is to teach it that shape, never to write the handler differently.
    expect(calls.filter((c) => !c.handler).map((c) => c.where)).toEqual([]);
  });

  it('types the ctx parameter, so the calls inside the handler resolve', () => {
    // `ctx: any` makes `ctx.api.boards.updateBoard(…)` unresolvable, the command
    // leaves MUTATES, and the lock stops being checked for it — silently. The
    // type IS the detector's input here, so it is part of the contract.
    const untyped = calls
      .map(({ where, handler }) => {
        const [first] = (handler as ts.FunctionLikeDeclaration | undefined)?.parameters ?? [];
        if (!first) return `${where} — handler takes no ctx`;
        const type = checker.typeToString(checker.getTypeAtLocation(first));
        return type === 'Ctx' || type === 'AnonymousCtx' ? undefined : `${where} — ctx is \`${type}\``;
      })
      .filter(Boolean);
    expect(untyped).toEqual([]);
  });
});
