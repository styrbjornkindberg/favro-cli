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
 * the thing they were written for. There are TWO SEEDS, because the same lie has
 * two grammars.
 *
 * SEED ONE — the promise callback (#116, #148, #149 all lived here):
 *
 *   - The RECEIVER must be a promise, decided by asking the checker whether its
 *     type has a `then` member. An object with a `catch` method of its own, or a
 *     commander chain, is not a swallowed read.
 *   - The HANDLER is `.catch`'s argument or `.then`'s SECOND argument — the
 *     two-argument `then` is the same swallow written differently, and a scan
 *     that only knew `catch` would be one refactor from useless.
 *   - It is resolved through the checker, so a handler hoisted to a `const` is
 *     followed to the function it names.
 *
 * SEED TWO — the `try`/`catch` STATEMENT (#153). `try { cards = await
 * listCards(b) } catch { cards = [] }` is the identical substitution in a shape
 * seed one does not walk at all, and #149 shipped asserting that population was
 * zero. It is not zero: 14 of the 155 `catch` clauses in non-test `src/` match,
 * re-measured under this commit and triaged into `CATCH_DEBT`/`CATCH_DECIDED`
 * below. The seed is `ts.CatchClause`, and the error binding — absent, or present
 * and not destructured — takes the place of the handler's parameter list.
 *
 * Either seed counts as a SWALLOW when it both DECLINES TO TREAT THE ERROR AS A
 * VALUE — no binding, one that only names it, or one that destructures NOTHING —
 * and ANSWERS WITH EMPTINESS: `[]`, `{}`, `undefined`, `null`, `0`, `''`,
 * `false`, an empty body, or a lone statement that RETURNS or ASSIGNS (`=`, `??=`,
 * `||=`, `&&=`) one of those. Each emptiness is read through any depth of
 * TYPE-ONLY wrapper (`as`, `<T>`, `satisfies`, `!`) and in its second spelling
 * (`void 0`, `new Array()`, `Array()`, an empty template literal), because a
 * spelling the scan cannot see is a bypass — #149's review found one, #154's
 * review found two, and #153's found five more, all closed here. Both predicates
 * (`ignoresError`, `emptinessToken`) are shared by the two seeds rather than
 * copied, so a spelling fix lands on both at once.
 *
 * SEED TWO IS LESS PRECISE THAN SEED ONE, deliberately. Seed one leans on
 * `isPromise` to know a read was attempted; a `try` block can wrap anything, so
 * the clauses it raises include parses and probes where the throw IS the answer
 * (`new URL(x)` in a validator, a base64 decode of an untrusted header). Those are
 * `CATCH_DECIDED` with the argument written out. Narrowing the seed to "the try
 * block awaits something" was measured and rejected: it drops
 * `todo-scanner.ts`'s `readFileSync`/`readdirSync`, which are reads. Broad and
 * triaged beats narrow and blind — narrow and blind is what six ratchets here
 * already were.
 *
 * Both conjuncts are required, and the second carries most of the weight. A
 * handler that does something with the error is not answering with emptiness
 * anyway (`init.ts:381` inspects `err.code`, `auth.ts` reports it, the three
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
 * ponytail: a swallow spread over MORE THAN ONE statement is out of reach —
 * `catch { log(e); return [] }` is exempted on purpose (it says something), but so
 * is `catch { a = []; b = [] }`, which is not. Two-statement catch bodies that
 * answer with nothing but emptiness are the real ceiling; none exist in `src/`
 * today (measured), and the upgrade is "every statement is a return-or-assign of
 * an emptiness token" rather than "exactly one".
 *
 * ponytail: so is a handful of emptiness spellings nobody writes — `[...[]]`,
 * `{ ...{} }`, `Object.create(null)`, `Array.of()`, a `catch { ; }` whose one
 * statement is the empty one, and a comma sequence. Each was CONSTRUCTED in review
 * of #153, confirmed to pass, and measured at ZERO in `src/`. Closing them needs a
 * constant folder, which is more machinery than the five plausible spellings that
 * were closed instead.
 *
 * FOUR LISTS, AND WHY THEY ARE NOT ONE
 *   - `DEBT` — a swallow that should record its hole and does not yet. Only ever
 *     shrinks.
 *   - `DECIDED` — a swallow whose caller already distinguishes the fallback from
 *     real data and reports it, so no hole marker is missing. Not debt, and
 *     pretending it is would mean a permanently red ratchet.
 *   - `CATCH_DEBT` / `CATCH_DECIDED` — the same split for seed two. Kept apart
 *     from the first pair because the two populations have different provenance
 *     and different precision (see above). All four feed one `EXEMPT`, so the
 *     exemption, staleness and exactly-once arms are shared and seed two got
 *     them for free.
 *
 *     #153 gave a second reason — that collapsing them would mean rewriting
 *     #149's "exactly the three init reads" assertion. That ASSERTION did not
 *     survive the merge (#154 discharged all three reads), but the REASON did, in
 *     a stricter form: `DEBT` is now pinned EMPTY, and the arm that pins it claims
 *     there is no swallowed read "IN THE SHAPE THIS SCAN WALKS" whose caller
 *     cannot tell — a claim scoped to seed one. Folding seed two's five debts into
 *     `DEBT` breaks the pin and falsifies the claim, so a collapse still costs a
 *     rewrite of the one line holding that population against growth. CORRECTED
 *     in review of #153: the merge resolution recorded this reason as dead, and it
 *     is not — only its wording moved.
 *
 * All four are checked for STALENESS, so none can rot: an entry that no longer
 * exists under its key fails the build. And the predicate itself is checked
 * against synthetic sources in BOTH polarities at the bottom of this file,
 * through THIS scan rather than a hand-rolled copy of it — a copy would only ever
 * prove that the copy works.
 *
 * TO DISCHARGE A DEBT ENTRY, one of two ways, then delete its line — deleting the
 * line is not optional:
 *   - A read that answers a QUERY records its hole and returns what it did get.
 *     `holeCollector`/`boundedSweep` in `read-shape.ts`; see `api/context.ts` and
 *     `api/aggregate.ts` for the two shapes.
 *   - A read feeding a DURABLE ARTEFACT propagates instead, because there is no
 *     envelope to carry a marker and the artefact outlives the warning. That is
 *     how #154 discharged `init`'s three. Unless the artefact has a PROSE field
 *     for the reason — `context.json`'s `notes` is one, and the `DECIDED` entry
 *     below is a swallow discharged through it. That route is for a facet whose
 *     absence would refuse a whole artefact over display text; the three above
 *     are keyed off, so they still propagate.
 *
 * For a `CATCH_DEBT` line, also drop the `5` in the count assertion to `4` — the
 * count is pinned in BOTH directions on purpose, because "moved it to
 * `CATCH_DECIDED`" is the cheap way to discharge a defect without fixing it, and a
 * shrink is a two-character edit next to the line you are already deleting.
 * Discharging ONE of a `skill-store.ts` pair renumbers its `#n`
 * siblings; the staleness arm will tell you, and the new numbers are in the
 * failure message.
 */
import * as path from 'path';
import * as ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * DEBT: reads whose rejection is answered with emptiness and whose caller cannot
 * tell, keyed `<file> <read>() → <fallback>` and valued with why it is still here.
 *
 * **EMPTY, and pinned empty below.** It held three entries, all in `favro init`,
 * and #154 discharged them. Not the way #116 and #148 discharged theirs — those
 * answer a QUERY, so they record an `unreachable` hole and hand back what they
 * did read. `init` writes a durable config file with a published schema and no
 * field for "unread", and it is cheap and idempotent to re-run, so it fails
 * closed instead: the three reads propagate, no file is written, and the schema
 * never had to grow a third state that only an LLM reading the file could be
 * trusted to honour. Both are discharges; the rung differs because the output
 * does.
 *
 * Do NOT add a line here to green a build. A new key is a new place where "we
 * could not look" reaches a caller as "there is nothing there".
 */
const DEBT: Record<string, string> = {};

/**
 * DECIDED: the fallback is not a manufactured answer, because the caller reads it
 * as a third state and says so.
 *
 * The first entry is the reason this list exists rather than a debt line:
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
 * same branch, and the write this probe guards then fails on its own with the real
 * errno — `fs.writeFile(contextFile, …)` at `init.ts:362`, which is unguarded and
 * propagates to the error boundary — so nothing plausible-but-wrong reaches a
 * caller. (Not the `.gitignore` read's `err.code` catch, which an earlier version
 * of this comment cited and which lives at `init.ts:381`. Both line numbers were
 * stale — they said `:315` and `:334`, neither of which is either read — and were
 * re-measured in review of #153.)
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

/**
 * CATCH_DEBT: seed two's half of the same debt — a `try`/`catch` that answers a
 * failed read with emptiness and leaves its caller unable to tell.
 *
 * Keyed `<file> <enclosing>() catch → <fallback>`, `#n` when one function has
 * several. NOT keyed on the line, which churns; see `enclosingName`.
 *
 * These FIVE are triage, not a parking space. Each was read at its site under this
 * commit and the reason states what a caller actually observes — not "looks
 * sloppy". Fixing them is #153's follow-up and deliberately not #153: four other
 * branches were live in these files when this landed, and the checker fix is what
 * stops the count growing while that is scheduled.
 *
 * There were TEN. `cards-api.ts getCardById()`'s FOUR are discharged — the
 * `--include board/collection/links/comments` reads now record an `unreachable`
 * hole on the card they return, the QUERY route of the two below, because
 * `cards get` answers a query. The whole `#1`–`#4` family went at once, so
 * nothing renumbered.
 *
 * `git-integration.ts isBranchMerged()`'s went next, by the OTHER route: a merge
 * check has no envelope and no entity to hang a hole on, and its consumer is a
 * write, so it PROPAGATES — `analyzeBranches` throws and `favro git sync` refuses
 * through its error boundary instead of reading "we could not check" as 'open'
 * and PATCHing finished cards back to "In Progress". `getDefaultBranch()` stopped
 * answering `'main'` for a repo with no `main` in the same change, which was the
 * trigger that failed every branch at once.
 */
const CATCH_DEBT: Record<string, string> = {
  'src/commands/tasklists.ts boardOfTaskList() catch → \'\'':
    "#153 — fails CLOSED (`assertScope` refuses on `''`, and `--force` does not rescue it), but SILENTLY: the refusal it produces says \"the underlying error is reported separately\" and on this path nothing reported it, unlike `boardOfCard` two hops down which console.errors first",
  'src/lib/skill-store.ts listSkills() catch → undefined':
    '#153 — a builtin skill file that exists but will not parse is dropped from `skills list` with no warning, so a broken skill and an uninstalled one read identically',
  'src/lib/skill-store.ts listSkills() catch → undefined #2':
    '#153 — same for the user skills directory, which overrides builtin, so a corrupt user file silently un-overrides too',
  'src/lib/todo-scanner.ts walk() catch → undefined':
    '#153 — an unreadable directory is skipped and the scan still reports its TODO list as the answer; the fix is a skipped-paths count in the result, not a throw',
  'src/lib/todo-scanner.ts scanFile() catch → undefined':
    '#153 — same for a single unreadable file',
};

/**
 * CATCH_DECIDED: the clause is real and the emptiness is the honest answer.
 *
 * NINE of them, and most are here because seed two has no `isPromise` gate to tell
 * a read from a parse (see the header). A validator whose `throw` IS its answer,
 * and a cache miss, are not the substitution this file guards — but writing the
 * predicate so it never raises them would blind it to `.catch(() => false)` on a
 * real read, which is the trade #149 already refused once.
 *
 * There were TEN. `isBranchMerged` was moved to `CATCH_DEBT` in review of #153 —
 * its entry argued `false` was conservative because the caller only reports, and
 * the caller writes — and has since been discharged from there by propagating, so
 * the clause is gone from both lists. A wrong line HERE discharges a real defect
 * permanently, since
 * no arm can ever complain about it — so every entry names what a caller does with
 * the fallback, not just what the fallback is.
 */
const CATCH_DECIDED: Record<string, string> = {
  'src/api/webhooks.ts isValidWebhookUrl() catch → false':
    'a VALIDATOR — `new URL(url.trim())` throwing IS the answer "not a valid URL", so `false` is a measurement and not a stand-in for one (same argument as the `fs.access` entry above)',
  'src/commands/browse.ts browseHandler() catch → undefined':
    'the empty body leaves `boardName` as the board ID the user typed, which is a TRUTHFUL label; and the very next statement `browseCards(…, options.board, …)` reads the same board unguarded, so an unreachable board still fails loudly',
  'src/lib/config.ts resolveUserId() catch → undefined':
    'measured all five callers (`assignee.ts:48`, `my-cards.ts:152`, `my-standup.ts:156`, `next.ts:142`, `main-menu.ts:276`) — every one tests `!userId` and REFUSES with a remedy rather than proceeding on an empty identity; the refusal does misattribute a transient read failure to "not configured", which is wording, not a fabricated answer',
  'src/lib/git-integration.ts isGitRepo() catch → false':
    'a PROBE — `git rev-parse --git-dir` exiting non-zero is precisely how one asks "is this a git repo", so the throw is the answer',
  "src/lib/http-client.ts wirePath() catch → ''":
    "documented FAIL-CLOSED: `assertBoundedTarget` reads `''` as unbounded and throws `RefusalError`, so an unparseable target refuses rather than escaping the comparison (the doc comment above it says so)",
  'src/lib/name-cache.ts readFile() catch → {}':
    'a cache MISS, which sends the caller to the real read; reasoned in place and deliberately not memoized so one failed open does not pin "no cache" for the process',
  'src/lib/name-cache.ts readFile() catch → undefined':
    'corrupt JSON reads as no cache, `data` stays `{}`, same miss path — memoized on purpose because re-parsing the same bad bytes cannot start succeeding',
  'src/lib/name-cache.ts writeFile() catch → undefined':
    'a failed cache WRITE, not a read: nothing downstream consumes a value from it, and the next read simply misses',
  'src/mcp-http-server.ts parseBasicAuth() catch → null':
    'a PARSE of an untrusted header — `null` means "no credentials", the caller 401s, and the same `null` is returned by the two explicit malformed-header guards on either side of it',
};

/** Exempt either way — debt and decision are both non-failing, for different reasons. */
const EXEMPT = { ...DEBT, ...DECIDED, ...CATCH_DEBT, ...CATCH_DECIDED };

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

/**
 * Assignments a lone catch statement can carry. `=` was the only one until review
 * of #153: `cards ??= []` is how the ticket's own `catch { cards = [] }` gets
 * written the moment `cards` is optional, and the header already CLAIMED "returns
 * or assigns", so the code was narrower than its own contract. `&&=` is here for
 * completeness of the set, not because anyone would write it.
 */
const ASSIGNMENT_TOKENS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
]);

/** What a handler answered with, as a short token — the key's second half. */
function emptinessToken(body: ts.Node): string | undefined {
  if (ts.isParenthesizedExpression(body)) return emptinessToken(body.expression);
  // A TYPE ASSERTION is not a decision about the value — `[] as Column[]` is the
  // same `[]`. This is not hypothetical politeness: `[] as Column[]` /
  // `[] as Member[]` / `[] as Card[]` is what the four live `orElse` fallbacks in
  // `aggregate.ts` and `context.ts` are literally spelled as, so
  // `.catch(() => [] as Column[])` is a MORE likely spelling of this defect in
  // this codebase than the bare one, and without this line the scan missed it
  // while claiming spelling could not defeat it (found in review of #149).
  // `!` is the FOURTH type-only wrapper beside the three above and was the one
  // left open — `return undefined!` typechecks and passed everything (review #153).
  if (
    ts.isAsExpression(body) ||
    ts.isTypeAssertionExpression(body) ||
    ts.isSatisfiesExpression(body) ||
    ts.isNonNullExpression(body)
  ) {
    return emptinessToken(body.expression);
  }
  if (ts.isArrayLiteralExpression(body)) return body.elements.length === 0 ? '[]' : undefined;
  if (ts.isObjectLiteralExpression(body)) return body.properties.length === 0 ? '{}' : undefined;
  if (ts.isIdentifier(body) && body.text === 'undefined') return 'undefined';
  // `void 0` and `new Array()` are `undefined` and `[]` in a second spelling, and
  // both passed 9 of 9 when planted in `init.ts` during #154's review — the same
  // hole the `as` line above closed, one spelling further out.
  if (ts.isVoidExpression(body)) return 'undefined';
  // `Array()` as well as `new Array()`: same function, same `[]`, and closing only
  // the `new` spelling in #154 left the shorter one open (review #153).
  if (
    (ts.isNewExpression(body) || ts.isCallExpression(body)) &&
    ts.isIdentifier(body.expression) &&
    body.expression.text === 'Array'
  ) {
    return (body.arguments?.length ?? 0) === 0 ? '[]' : undefined;
  }
  if (body.kind === ts.SyntaxKind.NullKeyword) return 'null';
  if (body.kind === ts.SyntaxKind.FalseKeyword) return 'false';
  if (ts.isNumericLiteral(body) && body.text === '0') return '0';
  // An empty TEMPLATE literal is `''` in a second spelling, and `''` is what two
  // live sites (`wirePath`, `boardOfTaskList`) already answer with (review #153).
  if ((ts.isStringLiteral(body) || ts.isNoSubstitutionTemplateLiteral(body)) && body.text === '') {
    return "''";
  }
  if (ts.isBlock(body)) {
    // An empty body answers `undefined` just as loudly as writing it.
    if (body.statements.length === 0) return 'undefined';
    if (body.statements.length !== 1) return undefined;
    const [only] = body.statements;
    // ASSIGNING the emptiness is the same answer as returning it, and it is the
    // shape #153 was filed for — `try { cards = await read() } catch { cards = [] }`
    // has no `return` anywhere, so a return-only test cannot see the ticket's own
    // example. Zero sites in `src/` are spelled this way today; the arm exists for
    // the next one, which is what a ratchet is.
    //
    // KNOWN PRECISION COST, measured and accepted: the TARGET is not checked
    // against what the `try` assigned, so `catch { ok = false }` — a plain error
    // flag, not a swallowed read — will be raised. Zero such sites exist in `src/`
    // today; the first one belongs in `CATCH_DECIDED` with that one-line argument,
    // which is cheaper than teaching this arm dataflow.
    if (
      ts.isExpressionStatement(only) &&
      ts.isBinaryExpression(only.expression) &&
      ASSIGNMENT_TOKENS.has(only.expression.operatorToken.kind)
    ) {
      return emptinessToken(only.expression.right);
    }
    if (!ts.isReturnStatement(only)) return undefined;
    return only.expression === undefined ? 'undefined' : emptinessToken(only.expression);
  }
  return undefined;
}

/**
 * Does the handler decline to treat the error as a value?
 *
 * Takes the BINDING rather than the function, so seed one hands it `.catch`'s first
 * parameter name and seed two hands it `catch (e)`'s — one predicate, not two that
 * can drift apart. `undefined` is both "`.catch(() => …)`" and "bare `catch {`".
 *
 * Only the binding is read. This started as a walk of the body looking for
 * a mention of the parameter, and mutation testing showed that walk could not
 * change a single verdict, here or on any synthetic input: `emptinessToken` below
 * accepts only bodies too small to mention anything — a bare emptiness literal, or
 * a block whose one statement returns one — so a handler that both names its error
 * and answers with emptiness cannot be written. It is deleted rather than kept as
 * decoration, because an inert conjunct is how a ratchet stops being believed.
 *
 * What DOES change a verdict, and so stays, is a DESTRUCTURED parameter that
 * destructures SOMETHING: `.catch(({ message }) => [])` pulls the error apart
 * before answering, which is a decision about content rather than a swallow of a
 * read.
 *
 * A named-but-unused parameter is deliberately NOT an exemption — `_error => []`
 * is the first of the two bypasses at the bottom of this file, and treating a
 * parameter's mere presence as handling is what would let it through. Neither is a
 * pattern that binds NOTHING: `catch ({})` and `.catch(({}) => [])` pull nothing
 * apart, so they are `catch {` and `() =>` with punctuation, and they were the
 * cheapest evasion of this whole file until review of #153 closed them. Zero live
 * clauses in `src/` use a binding pattern at all (measured), so this narrowing
 * cannot move the population.
 */
function ignoresError(bound: ts.BindingName | undefined): boolean {
  if (!bound) return true;
  if (ts.isIdentifier(bound)) return true;
  return bound.elements.length === 0;
}

/**
 * The named function, method or `const` a node sits inside — the discriminating
 * half of a `catch` clause's key.
 *
 * A `catch` clause has no read to name the way a promise handler's receiver does:
 * its `try` block can hold several calls, and naming the first one misnames 4 of
 * the 14 live sites (`isValidWebhookUrl/trim`, `writeFile/cacheFilePath`,
 * `parseBasicAuth/toString`, and `wirePath`, which has no
 * call at all). The enclosing declaration is stable under edits above it, unique
 * for 12 of the 14 on its own, and actually findable by a human — which the key's
 * whole job is.
 */
function enclosingName(node: ts.Node): string {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    const named =
      ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p) || ts.isFunctionExpression(p)
        ? p.name
        : ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p)
          ? p.name
          : undefined;
    if (named && ts.isIdentifier(named)) return named.text;
  }
  return '<module>';
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
): { findings: Finding[]; handlerSites: number; catchClauses: number } {
  // Also BINDS the program, which is what sets `node.parent` — `enclosingName` and
  // `getStart()` both walk parents and answer `undefined`/throw without it.
  const checker = prog.getTypeChecker();
  const findings: Finding[] = [];
  let handlerSites = 0;
  let catchClauses = 0;
  /** Occurrence counter per catch key, so two identical bases get `#2`, `#3`. */
  const seenCatchKey = new Map<string, number>();

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
      // ── SEED TWO: the `try`/`catch` statement (#153) ──
      if (ts.isCatchClause(n)) {
        catchClauses++;
        if (!ignoresError(n.variableDeclaration?.name)) return;
        const fallback = emptinessToken(n.block);
        if (fallback === undefined) return;
        // No line number in the key — it churns on every edit above it. The
        // ordinal is scoped to one file+function+fallback, so it only moves when
        // a sibling clause in the SAME function is added or discharged, and when
        // it moves the staleness arm says so.
        const base = `${rel} ${enclosingName(n)}() catch → ${fallback}`;
        const nth = (seenCatchKey.get(base) ?? 0) + 1;
        seenCatchKey.set(base, nth);
        findings.push({
          key: nth === 1 ? base : `${base} #${nth}`,
          where: `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`,
        });
        return;
      }

      // ── SEED ONE: the promise rejection handler (#116, #148, #149) ──
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
      if (!ignoresError(handler.parameters[0]?.name)) return;
      const fallback = emptinessToken(handler.body);
      if (fallback === undefined) return;

      findings.push({
        key: `${rel} ${readName(receiver)}() → ${fallback}`,
        where: `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`,
      });
    });
  }

  return { findings, handlerSites, catchClauses };
}

const sourceFiles = program
  .getSourceFiles()
  .filter((sf) => !sf.isDeclarationFile && sf.fileName.startsWith(path.join(REPO_ROOT, 'src')));

const { findings: live, handlerSites, catchClauses } = findSwallows(program, sourceFiles);
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
    // Seed two's floor. A collapse of the walk or of `ts.isCatchClause` would
    // report zero swallows and pass. Measured 135 clauses under this commit, by
    // instrumenting this expression; it was 155 at #109, and the three figures
    // this comment carried before (160, 156, 155) were each true when written
    // and none was re-measured when #110 deleted files out from under them.
    // Most of the drop is those deletions — grepping `catch (` on the files
    // themselves: 7 in `commands/batch.ts`, 5 in `commands/batch-smart.ts`, 3 in
    // `lib/bulk.ts`, and 3 that left `cli.ts` with the batch branches (11 → 8).
    // That is 18 of the 20; the last two are not accounted for here, and grep is
    // not the scan's own walk, so read this as the shape of the drop rather than
    // its ledger.
    //
    // #119 is the second deletion of the same kind and a much bigger one: every
    // `catch { logError; a hard exit }` in the sixteen migrating command files
    // is the runner's boundary now, so the clause simply stops existing. The
    // floor is re-measured by instrumenting THIS expression at each step of that
    // migration rather than being slackened once to cover it — a floor with room
    // for a whole file's clauses to vanish cannot notice the walk collapsing,
    // which is the only thing it is for.
    expect(catchClauses).toBeGreaterThanOrEqual(113);
  });

  it('no read swallows its failure outside DEBT and DECIDED', () => {
    // A new name here is a new place where "we could not look" reaches a caller
    // as "there is nothing there". Record the hole; do not add the line.
    expect(live.filter((f) => !(f.key in EXEMPT)).map((f) => `${f.where}  ${f.key}`).sort())
      .toEqual([]);
  });

  it('the debt list is EMPTY, and cannot grow back', () => {
    // Stated as its own assertion, so the list cannot grow quietly inside the
    // exemption above. It held the three `init` reads until #154 made them
    // propagate, so there is now no swallowed read IN THE SHAPE THIS SCAN WALKS
    // that its caller cannot tell about — not the same thing as none in `src/`,
    // which the header's fourteen untriaged `ts.CatchClause` sites forbid saying.
    // A new line here would be a regression rather than a record of one.
    expect(Object.keys(DEBT).sort()).toEqual([]);
  });

  it('the catch lists hold the fourteen clauses they were triaged at, split 5/9', () => {
    // The exemption and exactly-once arms already pin the SET of catch keys. What
    // they cannot see is the SPLIT: silently moving a key from `CATCH_DEBT` to
    // `CATCH_DECIDED` would discharge a defect by relabelling it, and parking a
    // sixth build in `CATCH_DEBT` is the failure mode #149's header names. Both
    // move a count.
    expect(Object.keys(CATCH_DEBT)).toHaveLength(5);
    expect(Object.keys(CATCH_DECIDED)).toHaveLength(9);
    // Disjoint, or `EXEMPT`'s spread would silently let the later list win and one
    // of the counts above would be describing a key nobody reads.
    expect(Object.keys(CATCH_DEBT).filter((k) => k in CATCH_DECIDED)).toEqual([]);
    // Every reason is a real reason. An empty string would pass the counts.
    expect(
      Object.entries({ ...CATCH_DEBT, ...CATCH_DECIDED })
        .filter(([, why]) => why.trim().length < 20)
        .map(([key]) => key),
    ).toEqual([]);
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
    // A type assertion around the emptiness, in all three of its spellings. This
    // is the shape the repo's own `orElse` fallbacks use (`[] as Column[]` at
    // `aggregate.ts:262`), so it is the likeliest way this defect would next be
    // written here — and the scan missed all three until #149's review.
    expect(scan(`${PREAMBLE}export const f2 = read().catch(() => [] as string[]);`))
      .toEqual(['src/__synthetic__.ts read() → []']);
    expect(scan(`${PREAMBLE}export const f3 = read().catch(() => <string[]>[]);`))
      .toEqual(['src/__synthetic__.ts read() → []']);
    expect(scan(`${PREAMBLE}export const f4 = read().catch(() => ([] satisfies string[]));`))
      .toEqual(['src/__synthetic__.ts read() → []']);
    // The two spellings this scan still missed after #149's review: `void 0` for
    // `undefined`, and a zero-argument `new Array()` for `[]`. Both typecheck and
    // both passed 9 of 9 when planted in `init.ts` (#154 review).
    expect(scan(`${PREAMBLE}export const f5 = read().catch(() => void 0 as never);`))
      .toEqual(['src/__synthetic__.ts read() → undefined']);
    expect(scan(`${PREAMBLE}export const f6 = read().catch(() => new Array<string>());`))
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
    // …and the polarity of the `new Array()` arm above: an ARGUMENT makes it a
    // length, which is a value the handler chose rather than an emptiness.
    expect(scan(`${PREAMBLE}export const e2 = read().catch(() => new Array<string>(5));`)).toEqual([]);
    // `.then` with ONE argument has no rejection handler to inspect.
    expect(scan(`${PREAMBLE}export const f = read().then(r => r);`)).toEqual([]);
    // Not a promise. A `catch` method of one's own is not a rejection handler,
    // and this is the arm that makes `isPromise` load-bearing rather than
    // decorative.
    expect(scan('export const g = { catch: (f: () => never[]) => f() }.catch(() => []);'))
      .toEqual([]);
  });

  it('catches the bypasses a text scan invites', () => {
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

    // …and the parameter that DESTRUCTURES NOTHING, which is the same trick as
    // `_error` one step further: a pattern is present, so a rule that treats mere
    // presence as handling lets it through, and nothing was pulled off the error.
    // It passed until review of #153.
    expect(scan(`${PREAMBLE}export const d = read().catch(({}) => []);`))
      .toEqual(['src/__synthetic__.ts read() → []']);
  });

  it('the synthetic program resolves Promise for real', () => {
    // Without `lib.d.ts` every `isPromise` call answers false, every scan above
    // returns `[]`, and the negative polarity would pass for the wrong reason
    // while the positive one failed loudly. This is the seam check: a case that
    // MUST be found, so a broken host cannot look like a clean repo.
    expect(scan(`${PREAMBLE}export const a = read().catch(() => []);`)).toHaveLength(1);
  });
});

describe('seed two — the try/catch statement, through the same scan (#153)', () => {
  /** A statement-shaped swallow, wrapped in the function the key names. */
  const inFn = (name: string, body: string): string =>
    `${PREAMBLE}export async function ${name}(): Promise<string[]> {\n${body}\n}`;

  it('CATCHES a statement swallow however it is spelled', () => {
    // The `return` form, bare `catch`.
    expect(scan(inFn('a', 'try { return await read(); } catch { return []; }')))
      .toEqual(['src/__synthetic__.ts a() catch → []']);
    // The ASSIGNMENT form — the shape #153's body is written in, which has no
    // `return` in the catch at all.
    expect(scan(inFn('b', 'let out: string[] = []; try { out = await read(); } catch { out = []; } return out;')))
      .toEqual(['src/__synthetic__.ts b() catch → []']);
    // A property target, which is how `cards-api.ts` spelled its four before they
    // were discharged — the shape is still the likeliest next one here.
    expect(scan(inFn('c', 'const o: { v?: string[] } = {}; try { o.v = await read(); } catch { o.v = []; } return o.v ?? [];')))
      .toEqual(['src/__synthetic__.ts c() catch → []']);
    // The empty body — `catch { /* best effort */ }`, which is the single most
    // common live spelling here (6 of the 14; the other eight are `return`s).
    expect(scan(inFn('d', 'const o: { v?: string[] } = {}; try { o.v = await read(); } catch { } return o.v ?? [];')))
      .toEqual(['src/__synthetic__.ts d() catch → undefined']);
    // A bare `return;`.
    expect(scan(inFn('e', 'try { await read(); } catch { return; } return [];')))
      .toEqual(['src/__synthetic__.ts e() catch → undefined']);
    // Every other emptiness a clause could answer with, on the shapes the live
    // sites actually use: `''`, `false`, `null`, `{}`.
    expect(scan(`declare function r2(): Promise<string>;\nexport async function f(): Promise<string> { try { return await r2(); } catch { return ''; } }`))
      .toEqual(['src/__synthetic__.ts f() catch → \'\'']);
    expect(scan(`declare function r3(): Promise<boolean>;\nexport async function g(): Promise<boolean> { try { return await r3(); } catch { return false; } }`))
      .toEqual(['src/__synthetic__.ts g() catch → false']);
    expect(scan(`declare function r4(): Promise<string | null>;\nexport async function h(): Promise<string | null> { try { return await r4(); } catch { return null; } }`))
      .toEqual(['src/__synthetic__.ts h() catch → null']);
    // A SYNCHRONOUS read. Seed two has no `isPromise` gate on purpose — dropping
    // these would drop `todo-scanner.ts`'s two `readFileSync`/`readdirSync` sites,
    // which are reads.
    expect(scan(`declare function sync(): string[];\nexport function i(): string[] { try { return sync(); } catch { return []; } }`))
      .toEqual(['src/__synthetic__.ts i() catch → []']);
    // Nested inside another `catch`, so the walk has to recurse into clause bodies
    // and not just past them. The outer clause reports the error, so only the
    // inner one is a swallow.
    expect(scan(inFn('j', "try { return await read(); } catch (e) { console.error(e); try { return await read(); } catch { return []; } }")))
      .toEqual(['src/__synthetic__.ts j() catch → []']);
  });

  it('does NOT catch a clause that reads the error, or that says something', () => {
    // Both conjuncts, one at a time — the same pair seed one is checked against.
    expect(scan(inFn('a', 'try { return await read(); } catch (e) { throw e; }'))).toEqual([]);
    expect(scan(inFn('b', 'try { return await read(); } catch (e) { return [String(e)]; }'))).toEqual([]);
    // DESTRUCTURED binding — the error was pulled apart before answering, which is
    // a decision about content. This is the one thing `ignoresError` still decides.
    expect(scan(inFn('c', 'try { return await read(); } catch ({ message }) { return []; }'))).toEqual([]);
    // Says something on the way out.
    expect(scan(inFn('d', "try { return await read(); } catch { console.error('failed'); return []; }"))).toEqual([]);
    // A non-empty fallback is a decision about content, not a swallow.
    expect(scan(inFn('e', "try { return await read(); } catch { return ['fallback']; }"))).toEqual([]);
    // No catch clause at all — `finally` is not a rejection handler.
    expect(scan(inFn('f', 'try { return await read(); } finally { }'))).toEqual([]);
    // Re-throwing something ELSE is still not emptiness.
    expect(scan(inFn('g', "try { return await read(); } catch { throw new Error('nope'); }"))).toEqual([]);
  });

  it('catches the two bypasses this seed invites', () => {
    // ONE — the ASSIGNMENT form with a type assertion around the emptiness. This
    // stacks the two holes this ratchet has actually had: the statement shape
    // (#153) and `[] as T`, which is this repo's dominant spelling and which
    // #149's scan missed while claiming spelling could not defeat it. It reaches
    // `emptinessToken` through the assignment arm and then through the `as` arm,
    // so a regression in either one lets it through.
    expect(scan(inFn(
      'bypassOne',
      'let out: string[] = []; try { out = await read(); } catch { out = [] as string[]; } return out;',
    ))).toEqual(['src/__synthetic__.ts bypassOne() catch → []']);
    // …and the double assertion, which is exactly how `cards-api.ts`'s
    // `getCardById` spells its board facet (`as unknown as Card['board']`).
    expect(scan(inFn(
      'bypassOneB',
      'let out: string[] = []; try { out = await read(); } catch { out = ([] as unknown) as string[]; } return out;',
    ))).toEqual(['src/__synthetic__.ts bypassOneB() catch → []']);

    // TWO — a NAMED but unread error binding, inside a nested arrow inside a
    // method, so nothing about it is at the shape a naive rule would look at:
    // "has a binding" is not handling, and the clause is two functions deep from
    // the export. `enclosingName` has to find the arrow's `const`, not the class
    // or the method, or the key names the wrong site.
    expect(scan(
      `${PREAMBLE}export class C {\n` +
        `  m(): () => Promise<string[]> {\n` +
        `    const swallow = async (): Promise<string[]> => {\n` +
        `      try { return await read(); } catch (unusedErr) { return []; }\n` +
        `    };\n` +
        `    return swallow;\n` +
        `  }\n` +
        `}`,
    )).toEqual(['src/__synthetic__.ts swallow() catch → []']);
  });

  it('catches the five more spellings review of #153 got through', () => {
    // Each of these was CONSTRUCTED against this scan, PASSED, and is closed here.
    // All five are second spellings of an emptiness the scan already knew, which is
    // the exact family #149's review (`[] as T`) and #154's (`void 0`,
    // `new Array()`) found — a ratchet is only as good as its spelling coverage.

    // ONE and TWO — a LOGICAL assignment. `??=` is how the ticket's own
    // `catch { cards = [] }` gets written once `cards` is optional, and the header
    // already claimed "returns or ASSIGNS" while the code tested `=` alone.
    expect(scan(inFn(
      'lz1',
      'let xs: string[] | undefined; try { xs = await read(); } catch { xs ??= []; } return xs ?? [];',
    ))).toEqual(['src/__synthetic__.ts lz1() catch → []']);
    expect(scan(inFn(
      'lz2',
      'let xs: string[] | undefined; try { xs = await read(); } catch { xs ||= []; } return xs ?? [];',
    ))).toEqual(['src/__synthetic__.ts lz2() catch → []']);

    // THREE — `Array()` without the `new`. #154 closed `new Array()` and left the
    // shorter spelling of the same function open.
    expect(scan(inFn('lz3', 'try { return await read(); } catch { return Array<string>(); }')))
      .toEqual(['src/__synthetic__.ts lz3() catch → []']);

    // FOUR — the non-null assertion, the fourth type-only wrapper beside `as`,
    // `<T>` and `satisfies`, all three of which were already recursed through.
    expect(scan(inFn('lz4', 'try { return await read(); } catch { return undefined!; }')))
      .toEqual(['src/__synthetic__.ts lz4() catch → undefined']);

    // FIVE — an empty TEMPLATE literal for `''`, which is what `wirePath` and
    // `boardOfTaskList` both answer with today.
    expect(scan(
      'declare function rs(): Promise<string>;\n' +
        'export async function lz5(): Promise<string> { try { return await rs(); } catch { return ``; } }',
    )).toEqual(["src/__synthetic__.ts lz5() catch → ''"]);

    // SIX — the clause-side twin of the seed-one bypass above: a binding that
    // destructures nothing.
    expect(scan(inFn('lz6', 'try { return await read(); } catch ({}) { return []; }')))
      .toEqual(['src/__synthetic__.ts lz6() catch → []']);
  });

  it('and none of those five widened the predicate past emptiness', () => {
    // The polarity for every arm above, one at a time. Without these, five arms
    // that answer "empty" for anything at all would look identical to five that
    // work — and one of them (`Array`) already has an argument form that MUST be
    // read as a length the handler chose.
    expect(scan(inFn('nz1', 'try { return await read(); } catch { return Array<string>(5); }')))
      .toEqual([]);
    expect(scan(inFn(
      'nz2',
      "let xs: string[] | undefined; try { xs = await read(); } catch { xs ??= ['fallback']; } return xs ?? [];",
    ))).toEqual([]);
    expect(scan(inFn(
      'nz3',
      "let xs: string[] = []; try { xs = await read(); } catch { xs = ['fallback']; } return xs;",
    ))).toEqual([]);
    expect(scan(
      'declare function rs2(): Promise<string>;\n' +
        'export async function nz4(): Promise<string> { try { return await rs2(); } catch { return `nope`; } }',
    )).toEqual([]);
    // A pattern that destructures SOMETHING is still a decision about content.
    expect(scan(inFn('nz5', 'try { return await read(); } catch ({ message }) { return []; }')))
      .toEqual([]);
    // A non-null assertion around a NON-empty value is not emptiness either.
    expect(scan(inFn('nz6', "try { return await read(); } catch { return ['x']!; }"))).toEqual([]);
  });

  it('two clauses in one function get distinct keys', () => {
    // The `#n` ordinal. Without it `skill-store.ts`'s two collapse onto one key
    // and one hides inside the other's exemption — the same collapse the
    // exactly-once arm exists to prevent for seed one. It held `cards-api.ts`'s
    // four the same way until they were discharged.
    expect(scan(inFn(
      'twice',
      'try { return await read(); } catch { return []; } finally { }',
    ) + `\nexport async function twice2(): Promise<string[]> { try { return await read(); } catch { return []; } }`))
      .toEqual([
        'src/__synthetic__.ts twice() catch → []',
        'src/__synthetic__.ts twice2() catch → []',
      ]);
    expect(scan(inFn(
      'twin',
      'try { return await read(); } catch { return []; }\n  try { return await read(); } catch { return []; }',
    ))).toEqual([
      'src/__synthetic__.ts twin() catch → []',
      'src/__synthetic__.ts twin() catch → [] #2',
    ]);
  });
});
