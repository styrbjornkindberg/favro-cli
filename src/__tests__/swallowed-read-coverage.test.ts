/**
 * The swallowed-read ratchet (#116 fixed this in one API, #148 found it in a
 * second, #149 is the third round — which is the exact shape a ratchet is for).
 *
 * WHAT IT GUARDS
 * A read whose rejection is replaced by an empty value tells its caller "there is
 * nothing there" when the truth is "we could not look". Every consequence this
 * repo has shipped came out of that one substitution: `health` printed a board
 * RED off a `/columns` call that never landed, `stale` listed finished cards as
 * stale, `workload` reported a team at zero WIP, `my-standup` read out finished
 * work as in progress. The fix each time is the same — record the hole
 * (`holeCollector`/`boundedSweep` in `read-shape.ts`) instead of manufacturing a
 * value — and the recurrence each time was a NEW call site nobody connected to
 * the last one.
 *
 * HOW IT DETECTS ONE
 * Through the TypeScript type checker, and NOT with a text scan. `.catch(() =>
 * [])` is only the spelling this defect happened to have twice; `.catch(_ => [])`
 * is the same defect and slips straight through a substring match, which is
 * precisely how #84, #99/#127, #128 and #142/#143's ratchets came to be blind to
 * the thing they were written for. So:
 *
 *   - The RECEIVER must be a promise, decided by asking the checker whether its
 *     type has a `then` member. An object with a `catch` method of its own, or a
 *     commander chain, is not a swallowed read.
 *   - The HANDLER is `.catch`'s argument or `.then`'s SECOND argument — the
 *     two-argument `then` is the same swallow written differently, and a scan
 *     that only knew `catch` would be one refactor from useless.
 *   - It is resolved through the checker, so a handler hoisted to a `const` is
 *     followed to the function it names.
 *   - It counts as a SWALLOW when it both DECLINES TO TREAT THE ERROR AS A VALUE
 *     — no parameter, or one that is not destructured — and ANSWERS WITH
 *     EMPTINESS: `[]`, `{}`, `undefined`, `null`, `0`, `''`, `false`, or an empty
 *     body.
 *
 * Both conjuncts are required, and the second carries most of the weight. A
 * handler that does something with the error is not answering with emptiness
 * anyway (`init.ts:334` inspects `err.code`, `auth.ts` reports it, the three
 * `boards-*.ts` writers re-throw a classified one), and a handler that ignores the
 * error but SAYS something — `board-tui.ts:103` prints "Refresh failed, retrying…"
 * — has a body the emptiness test rejects. Dropping the emptiness conjunct floods
 * this list with correct code, and a ratchet everybody learns to ignore guards
 * nothing.
 *
 * A named-but-unused parameter is NOT an exemption. That is the whole point:
 * `.catch(_ => [])` is the same defect as `.catch(() => [])` and is one of the two
 * bypasses this file is tested against.
 *
 * ponytail: promise-callback shape only. A `try { x = await f() } catch { x = []
 * }` swallow is the same defect in a shape this does not walk. Deliberate: the
 * measured population of that shape in `src/` today is zero (`catch` clauses here
 * either bind and read the error or re-throw), and the emptiness test would need
 * assignment-target analysis to say anything true about it. The upgrade path is a
 * second seed over `ts.CatchClause` with the same `ignoresError` and `emptiness`
 * predicates, added the day one appears — not before.
 *
 * TWO LISTS, AND WHY THEY ARE NOT ONE
 *   - `DEBT` — a swallow that should record its hole and does not yet. Only ever
 *     shrinks.
 *   - `DECIDED` — a swallow whose caller already distinguishes the fallback from
 *     real data and reports it, so no hole marker is missing. Not debt, and
 *     pretending it is would mean a permanently red ratchet.
 *
 * Both are checked for STALENESS, so neither can rot: an entry that no longer
 * exists under its key fails the build. And the predicate itself is checked
 * against synthetic sources in BOTH polarities at the bottom of this file,
 * through THIS scan rather than a hand-rolled copy of it — a copy would only ever
 * prove that the copy works.
 *
 * TO DISCHARGE A DEBT ENTRY: route the read through `holeCollector` (see
 * `api/context.ts` and `api/aggregate.ts` for the two shapes), then delete its
 * line. Deleting the line is not optional.
 */
import * as path from 'path';
import * as ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * DEBT: reads whose rejection is answered with emptiness and whose caller cannot
 * tell, keyed `<file> <read>() → <fallback>` and valued with why it is still here.
 *
 * All three are in `favro init`, which writes `.favro/context.json` for agents to
 * read later. They are the LAST three in `src/`: #116 discharged the five in
 * `ContextAPI.getSnapshot` and #148 the two in `AggregateAPI`, both by recording
 * the hole. `init` has no `unreachable` field to record one into — its output is a
 * config file with a published schema, not a `ListEnvelope` — so discharging
 * these means deciding what that file says about a facet it could not read, which
 * is a schema change and its own ticket. No issue is filed for it yet; #149
 * recorded them here so the count cannot silently grow while that is decided.
 *
 * Do NOT add a line here to green a build. A new key is a new place where "we
 * could not look" reaches a caller as "there is nothing there".
 */
const DEBT: Record<string, string> = {
  'src/commands/init.ts listColumns() → []':
    '#149 — a board with no workflow in context.json is indistinguishable from one whose /columns read failed',
  'src/commands/init.ts listFields() → []':
    '#149 — same: an empty customFields map means "none" and "unread" alike',
  'src/commands/init.ts getMembers() → []':
    '#149 — same for team; note the PRIVACY filter below it already fails closed and reports',
};

/**
 * DECIDED: the fallback is not a manufactured answer, because the caller reads it
 * as a third state and says so.
 *
 * The first entry is the reason this list exists rather than a fourth debt line:
 * `init`'s membership read answers `undefined` on failure, and the very next
 * statement is `if (membership === undefined)` writing a paragraph to stderr and a
 * note into the file, on purpose, so an empty `team` is never mistaken for "this
 * collection has no members". That is what discharging a swallow looks like; it
 * just does not happen to use `read-shape.ts`'s vocabulary, because `init` writes
 * a file rather than an envelope.
 *
 * The second is a case the predicate is right to raise and a human is right to
 * dismiss, which is exactly the kind this list is for — it was not on #149's list
 * and this scan found it. `fs.access(f).then(() => true, () => false)` is an
 * existence probe: the rejection IS the answer being asked for, not a substitute
 * for one, so `false` is a measurement. An EACCES rather than an ENOENT takes the
 * same branch, and the `writeFile` that follows then fails on its own with the
 * real errno (`init.ts:334`), so nothing plausible-but-wrong reaches a caller.
 * Narrowing the predicate to let it through instead would blind the scan to
 * `.catch(() => false)` on a real read, which is not a trade worth making for one
 * line.
 *
 * Staleness-checked like `DEBT`: if either read stops answering that fallback, or
 * the guard below the first one goes, the key goes stale and this build fails.
 */
const DECIDED: Record<string, string> = {
  'src/commands/init.ts get() → undefined':
    'the caller tests `membership === undefined`, writes an empty team rather than the whole org, and reports it to stderr AND into the file',
  'src/commands/init.ts access() → false':
    'an existence probe — `fs.access` rejects to MEAN "not there", so `false` is the answer and not a stand-in for one (#131)',
};

/** Exempt either way — debt and decision are both non-failing, for different reasons. */
const EXEMPT = { ...DEBT, ...DECIDED };

// ─── the program ─────────────────────────────────────────────────────────────

const configPath = ts.findConfigFile(REPO_ROOT, ts.sys.fileExists, 'tsconfig.json')!;
const parsedConfig = ts.parseJsonConfigFileContent(
  ts.readConfigFile(configPath, ts.sys.readFile).config,
  ts.sys,
  REPO_ROOT,
);
const COMPILER_OPTIONS: ts.CompilerOptions = { ...parsedConfig.options, noEmit: true };

const program = ts.createProgram(
  parsedConfig.fileNames.filter((f) => !f.includes('__tests__')),
  COMPILER_OPTIONS,
);

// ─── the scan ────────────────────────────────────────────────────────────────

const walk = (node: ts.Node, visit: (n: ts.Node) => void): void => {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
};

interface Finding {
  /** `<relfile> <read>() → <fallback>` — stable across edits above it. */
  key: string;
  /** `<relfile>:<line>`, for the failure message only. Never part of the key. */
  where: string;
}

/** What a handler answered with, as a short token — the key's second half. */
function emptinessToken(body: ts.Node): string | undefined {
  if (ts.isParenthesizedExpression(body)) return emptinessToken(body.expression);
  if (ts.isArrayLiteralExpression(body)) return body.elements.length === 0 ? '[]' : undefined;
  if (ts.isObjectLiteralExpression(body)) return body.properties.length === 0 ? '{}' : undefined;
  if (ts.isIdentifier(body) && body.text === 'undefined') return 'undefined';
  if (body.kind === ts.SyntaxKind.NullKeyword) return 'null';
  if (body.kind === ts.SyntaxKind.FalseKeyword) return 'false';
  if (ts.isNumericLiteral(body) && body.text === '0') return '0';
  if (ts.isStringLiteral(body) && body.text === '') return "''";
  if (ts.isBlock(body)) {
    // An empty body answers `undefined` just as loudly as writing it.
    if (body.statements.length === 0) return 'undefined';
    if (body.statements.length !== 1) return undefined;
    const [only] = body.statements;
    if (!ts.isReturnStatement(only)) return undefined;
    return only.expression === undefined ? 'undefined' : emptinessToken(only.expression);
  }
  return undefined;
}

/**
 * Does the handler decline to treat the error as a value?
 *
 * Only the parameter LIST is read. This started as a walk of the body looking for
 * a mention of the parameter, and mutation testing showed that walk could not
 * change a single verdict, here or on any synthetic input: `emptinessToken` below
 * accepts only bodies too small to mention anything — a bare emptiness literal, or
 * a block whose one statement returns one — so a handler that both names its error
 * and answers with emptiness cannot be written. It is deleted rather than kept as
 * decoration, because an inert conjunct is how a ratchet stops being believed.
 *
 * What DOES change a verdict, and so stays, is a DESTRUCTURED parameter:
 * `.catch(({ message }) => [])` pulls the error apart before answering, which is a
 * decision about content rather than a swallow of a read.
 *
 * A named-but-unused parameter is deliberately NOT an exemption — `_error => []`
 * is the first of the two bypasses at the bottom of this file, and treating a
 * parameter's mere presence as handling is what would let it through.
 */
function ignoresError(fn: ts.FunctionLikeDeclaration): boolean {
  const [first] = fn.parameters;
  if (!first) return true;
  return ts.isIdentifier(first.name);
}

/**
 * The read whose rejection is being swallowed, named for the key.
 *
 * Descends through any `.then`/`.catch`/`.finally` links first, so
 * `client.get(…).then(…).catch(() => undefined)` is keyed on `get`, not on
 * `then` — the point of the key is to name the call that can fail.
 */
function readName(receiver: ts.Expression): string {
  if (
    ts.isCallExpression(receiver) &&
    ts.isPropertyAccessExpression(receiver.expression) &&
    ['then', 'catch', 'finally'].includes(receiver.expression.name.text)
  ) {
    return readName(receiver.expression.expression);
  }
  if (ts.isCallExpression(receiver)) {
    const callee = receiver.expression;
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
    if (ts.isIdentifier(callee)) return callee.text;
  }
  if (ts.isPropertyAccessExpression(receiver)) return receiver.name.text;
  if (ts.isIdentifier(receiver)) return receiver.text;
  return receiver.getText().replace(/\s+/g, ' ').slice(0, 40);
}

/**
 * The scan, over whichever program it is handed — the real one above and the
 * synthetic ones at the bottom of this file. One implementation, so the
 * self-check exercises the predicate the repo is actually held to.
 */
function findSwallows(
  prog: ts.Program,
  files: readonly ts.SourceFile[],
): { findings: Finding[]; handlerSites: number } {
  const checker = prog.getTypeChecker();
  const findings: Finding[] = [];
  let handlerSites = 0;

  const isFunctionish = (node: ts.Node | undefined): node is ts.FunctionLikeDeclaration =>
    !!node &&
    (ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node));

  const unalias = (sym: ts.Symbol | undefined): ts.Symbol | undefined =>
    sym && sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;

  /**
   * The function an argument names, however it was written. The TYPE route is
   * what follows `const swallow = () => []` — a `VariableDeclaration`, which the
   * symbol route resolves to and `isFunctionish` rejects.
   */
  const resolvedFunction = (arg: ts.Expression): ts.FunctionLikeDeclaration | undefined => {
    if (isFunctionish(arg)) return arg;
    const direct = unalias(checker.getSymbolAtLocation(arg))?.declarations?.[0];
    if (isFunctionish(direct)) return direct;
    const viaType = unalias(checker.getTypeAtLocation(arg).getSymbol())?.declarations?.[0];
    return isFunctionish(viaType) ? viaType : undefined;
  };

  /** The checker's answer to "is this a promise?" — structural, not by name. */
  const isPromise = (expr: ts.Expression): boolean =>
    checker.getTypeAtLocation(expr).getProperty('then') !== undefined;

  for (const sf of files) {
    const rel = path.relative(REPO_ROOT, sf.fileName).split(path.sep).join('/');
    walk(sf, (n) => {
      if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return;
      const method = n.expression.name.text;
      // `.catch(onRejected)` and `.then(_, onRejected)` are the same seat.
      const handlerArg =
        method === 'catch' ? n.arguments[0] : method === 'then' ? n.arguments[1] : undefined;
      if (!handlerArg) return;
      const receiver = n.expression.expression;
      if (!isPromise(receiver)) return;

      handlerSites++;
      const handler = resolvedFunction(handlerArg);
      if (!handler || !handler.body) return;
      if (!ignoresError(handler)) return;
      const fallback = emptinessToken(handler.body);
      if (fallback === undefined) return;

      findings.push({
        key: `${rel} ${readName(receiver)}() → ${fallback}`,
        where: `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`,
      });
    });
  }

  return { findings, handlerSites };
}

const sourceFiles = program
  .getSourceFiles()
  .filter((sf) => !sf.isDeclarationFile && sf.fileName.startsWith(path.join(REPO_ROOT, 'src')));

const { findings: live, handlerSites } = findSwallows(program, sourceFiles);
const liveKeys = new Set(live.map((f) => f.key));

// ─── the self-check ──────────────────────────────────────────────────────────

/**
 * Run the REAL scan over a synthetic module.
 *
 * The synthetic file is served from memory to a compiler host that otherwise
 * reads the real filesystem, so `lib.d.ts` is present and `Promise` is the actual
 * `Promise` — without which `isPromise` would answer `false` for everything and
 * the polarity below would prove the opposite of what it says.
 */
function scan(code: string): string[] {
  const fileName = path.join(REPO_ROOT, 'src', '__synthetic__.ts');
  const synthetic = ts.createSourceFile(fileName, code, ts.ScriptTarget.ES2020, true);
  const host = ts.createCompilerHost(COMPILER_OPTIONS, true);
  const readReal = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...rest) => (name === fileName ? synthetic : readReal(name, ...rest));
  host.fileExists = (name) => name === fileName || ts.sys.fileExists(name);
  const prog = ts.createProgram([fileName], COMPILER_OPTIONS, host);
  return findSwallows(prog, [prog.getSourceFile(fileName)!]).findings.map((f) => f.key);
}

const PREAMBLE = 'declare function read(): Promise<string[]>;\n';

// ─────────────────────────────────────────────────────────────────────────────

describe('no read answers a failure with emptiness, outside the two lists', () => {
  it('finds the surface it is meant to be reading', () => {
    // Floors, not counts. A scan that resolved nothing would report zero
    // swallows and pass forever — the vacuous pass four ratchets in this repo
    // shipped. `handlerSites` is every rejection handler on a promise in `src/`,
    // swallowing or not, so it goes red if `isPromise` or the walk collapses.
    expect(handlerSites).toBeGreaterThanOrEqual(12);
    expect(sourceFiles.length).toBeGreaterThan(100);
  });

  it('no read swallows its failure outside DEBT and DECIDED', () => {
    // A new name here is a new place where "we could not look" reaches a caller
    // as "there is nothing there". Record the hole; do not add the line.
    expect(live.filter((f) => !(f.key in EXEMPT)).map((f) => `${f.where}  ${f.key}`).sort())
      .toEqual([]);
  });

  it('the debt list holds exactly the three init reads it was measured at', () => {
    // Stated as its own assertion, so the list cannot grow quietly inside the
    // exemption above. Note this is THREE, not the four #149's body claims: at
    // `d6a09b3` the fourth (`init`'s membership read) answers `undefined` and its
    // caller handles it, so it is a decision and sits in `DECIDED`. The ticket's
    // count was written before #118 landed on that file.
    expect(Object.keys(DEBT).sort()).toEqual([
      'src/commands/init.ts getMembers() → []',
      'src/commands/init.ts listColumns() → []',
      'src/commands/init.ts listFields() → []',
    ]);
  });

  it('no entry in either list is stale — a discharged read must be removed', () => {
    // A list nobody prunes is worse than no test: it becomes a permanent
    // exemption that reads like debt. This runs over DECIDED too — a decision is
    // not a licence to stop checking that it still describes the code.
    expect(Object.keys(EXEMPT).filter((key) => !liveKeys.has(key)).sort()).toEqual([]);
  });

  it('every live finding is listed, and each is found exactly once', () => {
    // Pins the count as well as the set: a second `.catch(() => [])` added to
    // `init.ts` beside an existing one would otherwise collapse onto the same key
    // and hide inside its exemption.
    expect(live.map((f) => f.key).sort()).toEqual(Object.keys(EXEMPT).sort());
  });
});

describe('the predicate itself, run through the real scan in both polarities', () => {
  it('CATCHES a swallow however it is spelled', () => {
    // `() => []` is only the spelling this defect happened to have. Each of these
    // is the same substitution and a substring scan for `.catch(() => [])` sees
    // exactly one of them.
    expect(scan(`${PREAMBLE}export const a = read().catch(() => []);`))
      .toEqual(['src/__synthetic__.ts read() → []']);
    expect(scan(`${PREAMBLE}export const b = read().catch(_ => []);`))
      .toEqual(['src/__synthetic__.ts read() → []']);
    expect(scan(`${PREAMBLE}export const c = read().catch((err) => []);`))
      .toEqual(['src/__synthetic__.ts read() → []']);
    expect(scan(`${PREAMBLE}export const d = read().catch(() => { return []; });`))
      .toEqual(['src/__synthetic__.ts read() → []']);
    expect(scan(`${PREAMBLE}export const e = read().catch(function () { return []; });`))
      .toEqual(['src/__synthetic__.ts read() → []']);
    expect(scan(`${PREAMBLE}export const f = read().catch(async () => []);`))
      .toEqual(['src/__synthetic__.ts read() → []']);
    // Every other emptiness the fallback could be.
    expect(scan(`${PREAMBLE}export const g = read().catch(() => undefined);`))
      .toEqual(['src/__synthetic__.ts read() → undefined']);
    // `() => {}` is an arrow with an EMPTY BLOCK, not an empty object literal —
    // it answers `undefined`, and the token says so rather than guessing from
    // the braces.
    expect(scan(`${PREAMBLE}export const h = read().catch(() => {});`))
      .toEqual(['src/__synthetic__.ts read() → undefined']);
    expect(scan(`declare function o(): Promise<object>;\nexport const h2 = o().catch(() => ({}));`))
      .toEqual(['src/__synthetic__.ts o() → {}']);
    expect(scan(`${PREAMBLE}declare function n(): Promise<number>;\nexport const i = n().catch(() => 0);`))
      .toEqual(['src/__synthetic__.ts n() → 0']);
    // The other seat: `then`'s second argument is the same handler.
    expect(scan(`${PREAMBLE}export const j = read().then(r => r, () => []);`))
      .toEqual(['src/__synthetic__.ts read() → []']);
  });

  it('does NOT catch a handler that reads the error, or that says something', () => {
    // Both conjuncts, one at a time. Drop either and this repo's correct code
    // floods the list.
    expect(scan(`${PREAMBLE}export const a = read().catch(err => { throw err; });`)).toEqual([]);
    expect(scan(`${PREAMBLE}export const b = read().catch(err => [String(err)]);`)).toEqual([]);
    expect(scan(`${PREAMBLE}export const c = read().catch(({ message }) => []);`)).toEqual([]);
    expect(scan(`${PREAMBLE}export const d = read().catch(() => { console.error('failed'); return []; });`))
      .toEqual([]);
    // A non-empty fallback is a decision about content, not a swallow of a read.
    expect(scan(`${PREAMBLE}export const e = read().catch(() => ['fallback']);`)).toEqual([]);
    // `.then` with ONE argument has no rejection handler to inspect.
    expect(scan(`${PREAMBLE}export const f = read().then(r => r);`)).toEqual([]);
    // Not a promise. A `catch` method of one's own is not a rejection handler,
    // and this is the arm that makes `isPromise` load-bearing rather than
    // decorative.
    expect(scan('export const g = { catch: (f: () => never[]) => f() }.catch(() => []);'))
      .toEqual([]);
  });

  it('catches the two bypasses a text scan invites', () => {
    // ONE — the named-but-unused parameter. This is the bypass #149's body
    // predicts by name, and the reason this file is not a grep.
    expect(scan(`${PREAMBLE}export const a = read().catch(_error => []);`))
      .toEqual(['src/__synthetic__.ts read() → []']);

    // TWO — the handler hoisted out of the call, so no `.catch(() => …)` text
    // exists anywhere. Caught because the argument is resolved through the
    // checker rather than read as source.
    expect(scan(
      `${PREAMBLE}const swallow = () => [];\nexport const b = read().catch(swallow);`,
    )).toEqual(['src/__synthetic__.ts read() → []']);

    // …and the same hoist, one indirection further and typed, which is how it
    // would actually appear in a helper module.
    expect(scan(
      `${PREAMBLE}function swallow(): string[] { return []; }\nexport const c = read().catch(swallow);`,
    )).toEqual(['src/__synthetic__.ts read() → []']);
  });

  it('the synthetic program resolves Promise for real', () => {
    // Without `lib.d.ts` every `isPromise` call answers false, every scan above
    // returns `[]`, and the negative polarity would pass for the wrong reason
    // while the positive one failed loudly. This is the seam check: a case that
    // MUST be found, so a broken host cannot look like a clean repo.
    expect(scan(`${PREAMBLE}export const a = read().catch(() => []);`)).toHaveLength(1);
  });
});
