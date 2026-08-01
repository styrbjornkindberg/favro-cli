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
 * THE ALLOWLIST
 * ~22 writes in the tree today have never taken the lock. This test is a
 * RATCHET, not a green-field assertion: the allowlist below makes it pass on the
 * tree as it stands while failing the moment a NEW unguarded write appears.
 * Every entry names the issue that will delete it, so the debt is visible and
 * shrinking the list is the definition of done for those issues.
 *
 * TO DISCHARGE AN ENTRY: add the scope check to the command, then delete its
 * line here. Deleting the line is not optional — the second test below fails on
 * an entry that is no longer unguarded, so the list cannot rot into a permanent
 * exemption that nobody prunes.
 */
import * as path from 'path';
import * as ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Writes that have never taken the scope lock, keyed `<file> <command path>`.
 * Do NOT add to this list to make a red build green — a new entry is a new hole.
 */
const ALLOWLIST: Record<string, string> = {
  // #104 — card-child writes that have never taken the lock. Each names a card
  // (or a task/tasklist id that belongs to one), so each has a board to check.
  'src/commands/tasks.ts tasks add': '#104',
  'src/commands/tasks.ts tasks update': '#104',
  'src/commands/tasks.ts tasks complete': '#104',
  'src/commands/tasks.ts tasks delete': '#104',
  'src/commands/tasklists.ts tasklists create': '#104',
  'src/commands/tasklists.ts tasklists update': '#104',
  'src/commands/tasklists.ts tasklists delete': '#104',
  // The half-locked group that names the pattern: `comments add` checks.
  'src/commands/comments.ts comments update': '#104',
  'src/commands/comments.ts comments delete': '#104',

  // #104 — org-level writes. Whether a COLLECTION lock should govern these at
  // all is the call #104 asks to be made deliberately; until it is made, they
  // are listed rather than quietly exempted.
  'src/commands/tags.ts tags create': '#104 (org-level)',
  'src/commands/tags.ts tags update': '#104 (org-level)',
  'src/commands/tags.ts tags delete': '#104 (org-level)',
  'src/commands/users.ts groups create': '#104 (org-level)',
  'src/commands/users.ts groups update': '#104 (org-level)',
  'src/commands/users.ts groups delete': '#104 (org-level)',
  'src/commands/webhooks.ts webhooks create': '#104 (org-level)',
  'src/commands/webhooks.ts webhooks delete': '#104 (org-level)',
  // `collections update`/`delete` both call `checkCollectionScope`; create does
  // not, and arguably cannot — a collection that does not exist yet is outside
  // the lock by construction. Same deliberate call as the rest of this group.
  'src/commands/collections-create.ts create': '#104 (org-level)',

  // #102 — no board is resolvable from a commentId, so this one needs a
  // decision (resolve the comment's card first, or refuse), not just a call.
  // Its sibling `attachments upload` was locked in 32e6b93.
  'src/commands/attachments.ts attachments upload-to-comment': '#102',

  // UNFILED — found by this test, not previously known. All three are the
  // half-locked-sibling shape the file's header describes.
  //   `cards update --from-csv` took the lock in 32e6b93 (#79); `batch update
  //   --from-csv` is the same CSV write through BulkTransaction and did not.
  'src/commands/batch.ts update': 'UNFILED — sibling of the #79 fix',
  //   `git sync` and `git todos --create` took the lock in 32e6b93 (#78);
  //   `git branch` moves the card to In Progress and `git commit --comment`
  //   comments on it, both unlocked.
  'src/commands/git.ts git branch': 'UNFILED — sibling of the #78 fix',
  'src/commands/git.ts git commit': 'UNFILED — sibling of the #78 fix',
};

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
 * The body of an action, however it was passed: an inline arrow, a named
 * function, or a factory call (`.action(archiveAction(cardsCmd, true))`, which
 * is how `cards archive` registers).
 */
function actionBody(arg: ts.Expression | undefined): ts.Node | undefined {
  if (!arg) return undefined;
  if (isFunctionish(arg)) return arg;
  if (ts.isCallExpression(arg)) return calleeDeclaration(arg);
  const decl = unalias(checker.getSymbolAtLocation(arg))?.declarations?.[0];
  return isFunctionish(decl) ? decl : undefined;
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

  it('no command writes without taking the lock, outside the allowlist', () => {
    // A new name here is a new hole. Add the scope check to the command; do not
    // add it to ALLOWLIST.
    expect(unguarded.filter((key) => !(key in ALLOWLIST))).toEqual([]);
  });

  it('no allowlist entry is stale — a fixed command must be removed from it', () => {
    // An allowlist nobody prunes is worse than no test: it becomes a permanent
    // exemption that reads like debt. An entry that is now guarded, or that no
    // longer exists under that key, has to go.
    const live = new Set(unguarded);
    expect(Object.keys(ALLOWLIST).filter((key) => !live.has(key)).sort()).toEqual([]);
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
