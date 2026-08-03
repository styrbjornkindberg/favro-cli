/**
 * `--limit` fails closed, on the print path and the fetch path (#142/#143).
 *
 * WHAT IT GUARDS
 * `--limit` had two parsers and both invented a number from garbage.
 *
 *   - THE PRINT PATH (`capRows`, #142). #99 stopped `parseInt` reading `1e9` as
 *     1, but a rejected value came back `undefined` and `undefined` is what
 *     every caller reads as "the flag said nothing" — so `--limit banana` meant
 *     NO cap. The caller asked to be capped, was not, and got a well-formed
 *     response with nothing anywhere saying the flag was ignored.
 *   - THE FETCH PATH (`parseInt(options.limit, 10)`, #143). Sixteen commands
 *     re-typed the prefix parse, so `--limit 5,000` was 5 and `--limit 2abc`
 *     was 2, and `|| 1000` then turned every unparseable value into the
 *     command's own default.
 *
 * Both are the same defect: a plausible answer built out of input we could not
 * read. `parseLimit` now REFUSES instead, so absent and unreadable stop being
 * the same value, and one guard covers every caller.
 *
 * THE ARMS
 *
 *   - THE TABLE drives `parseLimit` and `capRows` over every malformed spelling
 *     the two tickets name, plus the values that must still work.
 *   - THE LIVE PRINT CAP drives `buildProgram()` — the program `bin/favro`
 *     builds — against a real HTTP server. It asserts the refusal exits 1, puts
 *     nothing on stdout that could be read as a result, and never pages the
 *     board: the whole point of parsing before the fetch.
 *   - THE FETCH CAPS drive three of the sixteen handlers against a recording
 *     `Ctx` and assert what reaches the API: the parsed number for a good
 *     value, the declared default when absent, and NO CALL AT ALL for garbage.
 *   - THE RATCHET walks the real compiled surface for a `--limit` still going
 *     through a numeric conversion of its own, with the usual four arms.
 */
import http from 'http';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import * as ts from 'typescript';

import { capRows, parseLimit } from '../lib/read-shape';
import { RefusalError } from '../lib/refusal';
import FavroHttpClient from '../lib/http-client';
import * as clientFactory from '../lib/client-factory';
import { buildProgram } from '../cli';
import { contextHandler } from '../commands/context';
import { standupHandler } from '../commands/standup';
import { healthHandler } from '../commands/health';
import type { Ctx } from '../lib/run';

// ─── arm one: the table ──────────────────────────────────────────────────────

/**
 * Every spelling #142 lists, and why each one used to answer.
 *
 * `0` is here by decision, not by accident: it is the one value where
 * "malformed" is a judgement. `capRows` read it as no cap, so `--limit 0` — the
 * narrowest cap anyone could type — returned EVERYTHING. See `parseLimit`.
 */
const MALFORMED = ['banana', '1e9', '2abc', '2.7', '5,000', '1_000', '-1', '', '0', '  ', '1 2'];

describe('a supplied --limit that does not parse is a refusal', () => {
  it.each(MALFORMED)('parseLimit refuses %p, and names it', (limit) => {
    let thrown: unknown;
    try {
      parseLimit(limit);
    } catch (error) {
      thrown = error;
    }
    // A refusal, not a bare Error: the same call declines identically, so the
    // boundary must not report it retryable (`refusal.ts`).
    expect(thrown).toBeInstanceOf(RefusalError);
    // The value is quoted back, so the user can see what we read. An empty or
    // whitespace value has nothing to quote and still has to say what is taken.
    expect((thrown as Error).message).toContain(`"${limit}"`);
    expect((thrown as Error).message).toContain('whole number of 1 or more');
  });

  it.each(MALFORMED)('capRows refuses %p rather than silently not capping', (limit) => {
    // This is the #142 regression in one line: each of these used to return
    // `{rows:[1,2,3]}` — every row, no marker, no complaint.
    expect(() => capRows([1, 2, 3], limit)).toThrow(RefusalError);
  });

  it('an ABSENT --limit still means uncapped, and is not a refusal', () => {
    expect(parseLimit(undefined)).toBeUndefined();
    expect(capRows([1, 2, 3])).toEqual({ rows: [1, 2, 3] });
    expect(capRows([1, 2, 3], undefined)).toEqual({ rows: [1, 2, 3] });
  });

  it('a value that parses is still a cap, and surrounding space is still fine', () => {
    expect(parseLimit('1')).toBe(1);
    expect(parseLimit('25')).toBe(25);
    expect(parseLimit(' 7 ')).toBe(7);
    expect(parseLimit('1000000000')).toBe(1000000000);
    expect(capRows([1, 2, 3], '2')).toEqual({ rows: [1, 2], truncated: true });
    // A cap wider than the data leaves no marker — nothing was cut.
    expect(capRows([1, 2, 3], '1000000000')).toEqual({ rows: [1, 2, 3] });
  });

  it('a NUMBER handed in by a non-commander caller is still guarded', () => {
    // `capRows` takes `number | string`, and only the string arm is parsed. A
    // `NaN` from a numeric caller must not reach `slice(0, NaN)`, which returned
    // zero rows marked `truncated` before #99.
    expect(capRows([1, 2, 3], NaN)).toEqual({ rows: [1, 2, 3] });
    expect(capRows([1, 2, 3], 0)).toEqual({ rows: [1, 2, 3] });
  });
});

// ─── arm two: the live print cap, over a real wire ───────────────────────────

const BOARD = 'Sprint 42';
const BOARD_ID = 'board-1';

const running: http.Server[] = [];

interface Served {
  path: string;
  query: string;
}

/** A Favro stand-in serving one board and `cards` cards, recording every GET. */
function startServer(cards: number): Promise<{ client: FavroHttpClient; served: Served[] }> {
  const served: Served[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://x');
    served.push({ path: url.pathname, query: url.search });

    const entities = url.pathname.endsWith('/widgets')
      ? [{ widgetCommonId: BOARD_ID, name: BOARD, type: 'board', columns: [] }]
      : Array.from({ length: cards }, (_, i) => ({
          cardId: `c${i}`,
          cardCommonId: `cc${i}`,
          name: `Card ${i}`,
          sequentialId: i + 1,
          widgetCommonId: BOARD_ID,
        }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ entities, requestId: 'req-1', pages: 1, page: 0 }));
  });
  running.push(server);

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        client: new FavroHttpClient({
          baseURL: `http://127.0.0.1:${port}/api/v1`,
          auth: { organizationId: 'org-1' },
        }),
        served,
      });
    });
  });
}

const originalConfigDir = process.env.FAVRO_CONFIG_DIR;
let tmpDir: string;

beforeEach(async () => {
  // The name cache is a real file — give each test its own so a run never reads
  // or clobbers the developer's own ~/.favro cache.
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'favro-limit-test-'));
  process.env.FAVRO_CONFIG_DIR = tmpDir;
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => new Promise((done) => s.close(() => done(null)))));
  if (originalConfigDir === undefined) delete process.env.FAVRO_CONFIG_DIR;
  else process.env.FAVRO_CONFIG_DIR = originalConfigDir;
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

/** Run one argv through the real program and hand back what the user saw. */
async function drive(argv: string[]) {
  let code: number | undefined;
  const exit = jest.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    code = c;
    throw new Error('process.exit');
  }) as never);
  const out = jest.spyOn(console, 'log').mockImplementation(() => {});
  const err = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await buildProgram().parseAsync(['node', 'favro', ...argv]);
  } catch (error) {
    if ((error as Error).message !== 'process.exit') throw error;
  }
  const stdout = out.mock.calls.map((c) => String(c[0])).join('\n');
  const stderr = err.mock.calls.map((c) => String(c[0])).join('\n');
  out.mockRestore();
  err.mockRestore();
  exit.mockRestore();
  return { code, stdout, stderr };
}

describe('the live cards list refuses a --limit it cannot read', () => {
  it('exits 1, names the value, writes no result — and never pages the board', async () => {
    const { client, served } = await startServer(5);
    jest.spyOn(clientFactory, 'createFavroClient').mockResolvedValue(client);

    const { code, stdout, stderr } = await drive([
      'cards', 'list', BOARD, '--limit', '1_000', '--json',
    ]);

    expect(code).toBe(1);
    expect(stderr).toContain('1_000');
    // Nothing on stdout that a caller could parse as a result. The old
    // behaviour printed a full, well-formed envelope of every card.
    expect(stdout).toBe('');
    // And it costs no board read: the parse runs before the fetch, so a typo'd
    // cap does not page a whole board only to throw it away.
    expect(served.filter((s) => s.path.endsWith('/cards'))).toEqual([]);
  });

  it('a --limit that parses still caps the output and marks it', async () => {
    const { client } = await startServer(5);
    jest.spyOn(clientFactory, 'createFavroClient').mockResolvedValue(client);

    const { code, stdout } = await drive(['cards', 'list', BOARD, '--limit', '2', '--json']);

    expect(code).toBeUndefined();
    const envelope = JSON.parse(stdout);
    expect(envelope.rows).toHaveLength(2);
    expect(envelope.truncated).toBe(true);
  });
});

// ─── arm three: the fetch caps ───────────────────────────────────────────────

/**
 * Three of the sixteen fetch caps #143 names, each with a different declared
 * default, driven against a `Ctx` that records the cap it was handed.
 *
 * The assertion is on the ARGUMENT, not on rows, and that is deliberate: the
 * cap these commands pass is threaded down to `ContextAPI.getSnapshot` /
 * `AggregateAPI.getMultiBoardSnapshot`, which — measured, not assumed — accept
 * `cardLimit` and never read it. So "`--limit 1e9` fetches one card" was never
 * observable in the fetched ROWS for this family; what is observable, and what
 * was wrong, is the number the command computed. Raised on #143.
 */
function recordingCtx(recorder: jest.Mock): Ctx {
  return {
    client: {} as never,
    config: {},
    verbose: false,
    api: {
      context: { getSnapshot: recorder },
      standup: { getStandup: recorder },
      aggregate: { getMultiBoardSnapshot: recorder, getCollectionSnapshot: recorder },
    },
  } as unknown as Ctx;
}

/** label → [declared default, a call with the given `--limit` value]. */
const FETCH_CAPS: Array<[string, number, (ctx: Ctx, limit?: string) => Promise<unknown>]> = [
  ['context', 1000, (ctx, limit) => contextHandler(ctx, BOARD, { limit })],
  ['standup', 500, (ctx, limit) => standupHandler(ctx, { board: BOARD, limit })],
  ['health', 1000, (ctx, limit) => healthHandler(ctx, { limit: limit as string })],
];

describe('a fetch cap is parsed, defaulted or refused — never invented', () => {
  it.each(FETCH_CAPS)('%s: --limit 1e9 refuses instead of fetching one item', async (_l, _d, call) => {
    const recorder = jest.fn(async () => ({ allCards: [], cards: [], board: { name: BOARD } }));
    // `parseInt('1e9', 10)` is 1. Every one of these fetched a single card and
    // reported it as the answer to "give me effectively everything".
    await expect(call(recordingCtx(recorder), '1e9')).rejects.toThrow(RefusalError);
    // A refusal spends nothing: the API is never reached at all.
    expect(recorder).not.toHaveBeenCalled();
  });

  it.each(FETCH_CAPS)('%s: a large --limit reaches the API whole', async (_l, _d, call) => {
    const recorder = jest.fn(async () => ({ allCards: [], cards: [], board: { name: BOARD } }));
    await call(recordingCtx(recorder), '1000000');
    expect(recorder.mock.calls[0]).toContain(1000000);
  });

  it.each(FETCH_CAPS)('%s: an absent --limit is the declared default', async (_l, dflt, call) => {
    const recorder = jest.fn(async () => ({ allCards: [], cards: [], board: { name: BOARD } }));
    await call(recordingCtx(recorder), undefined);
    // Absent must NOT refuse, and must NOT become an uncapped org-wide sweep:
    // for a fetch, "no cap" is a much larger cost than for a print (#143).
    expect(recorder.mock.calls[0]).toContain(dflt);
  });

  it.each(FETCH_CAPS)('%s: a comma-grouped --limit refuses rather than reading 5', async (_l, _d, call) => {
    const recorder = jest.fn(async () => ({ allCards: [], cards: [], board: { name: BOARD } }));
    await expect(call(recordingCtx(recorder), '5,000')).rejects.toThrow(RefusalError);
    expect(recorder).not.toHaveBeenCalled();
  });
});

// ─── arm four: the ratchet ───────────────────────────────────────────────────

/**
 * No `--limit` (or `--budget`) may be turned into a number by anything but
 * `parseLimit`.
 *
 * The eighteen sites #143 counted were eighteen copies of one parse, and a
 * nineteenth is one `parseInt` away. This walks the REAL compiled surface —
 * `ts.createProgram(...).getSourceFiles()`, so a file added to `tsconfig.json`
 * tomorrow is scanned with nothing to remember here, and a file NOT in the
 * program cannot be silently skipped by a directory crawl the way a `readdir`
 * walk would.
 *
 * WHAT COUNTS: an expression reading a property named `limit` or `budget`
 * (`options.limit`, `args.budget`, `opts['limit']`) passed to a conversion that is not
 * `parseLimit` — `parseInt`, `parseFloat`, `Number(…)`, their `Number.parseInt`
 * spellings, or a unary `+`. The alternatives are in because they are the
 * obvious next spellings of the same bug, and a ratchet that only knows the
 * spelling it was born from is a ratchet you get to write twice.
 *
 * The value is FOLLOWED, not just matched where it stands: an identifier is
 * resolved with `checker.getSymbolAtLocation` and its declaration re-tested, so
 * `const l = options.limit; parseInt(l, 10)` and `const { limit } = options;`
 * both fire. The first draft matched the argument expression only, and all three
 * launderings — a local, a destructure, and `Number.parseInt` — were confirmed
 * by construction to slip past it with the suite green. Found in review.
 *
 * ponytail: one hop through a DECLARATION, not full dataflow. A value carried
 * into another function's parameter — `readLimit(a.limit)`, then `Number(v)`
 * inside — still evades; that shape existed in `dispatch.ts` and was deleted
 * rather than allowlisted. Upgrade path if it comes back: resolve the enclosing
 * function's call sites through the checker and test each argument.
 */
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const NOT_PRODUCTION = /(^|\/)(__tests__|__integration__|test-support)(\/|$)/;

const limitConfigPath = ts.findConfigFile(REPO_ROOT, ts.sys.fileExists, 'tsconfig.json')!;
const limitConfig = ts.parseJsonConfigFileContent(
  ts.readConfigFile(limitConfigPath, ts.sys.readFile).config,
  ts.sys,
  REPO_ROOT,
);
const limitProgram = ts.createProgram(limitConfig.fileNames, {
  ...limitConfig.options,
  noEmit: true,
});

/**
 * The one file allowed to convert a `--limit` into a number, because it is the
 * parser everything else is funnelled into. `parseLimit`'s own `Number(trimmed)`
 * is a true positive under the rule above and the only one in `src` — exempting
 * the file rather than the two expressions keeps the rule one line, and the
 * self-check below fails if the file ever stops being part of the program, so a
 * rename cannot silently widen this into "some file I do not scan".
 */
const THE_PARSER = path.join('lib', 'read-shape.ts');

/** Every production source the compiler itself says is part of `src`. */
const scannableFiles = limitProgram
  .getSourceFiles()
  .filter((sf) => !sf.isDeclarationFile)
  .filter((sf) => sf.fileName.startsWith(path.join(REPO_ROOT, 'src') + path.sep))
  .filter((sf) => !NOT_PRODUCTION.test(path.relative(path.join(REPO_ROOT, 'src'), sf.fileName)));

const productionFiles = scannableFiles.filter(
  (sf) => path.relative(path.join(REPO_ROOT, 'src'), sf.fileName) !== THE_PARSER,
);

const NUMERIC_CONVERSIONS = new Set(['parseInt', 'parseFloat', 'Number']);

/**
 * The flags that share `parseLimit`'s grammar, so they must share its parser.
 *
 * `budget` is here because #143 counted `limit` sites only, and the `sprint-plan`
 * SKILL step kept its `parseInt(args.budget, 10)` — `budget: "1e9"` planned a
 * one-point sprint, the same defect the CLI's `--budget` had already fixed, in
 * the same file the ticket edited twenty lines above. Found in review.
 */
const CAP_FLAGS = new Set(['limit', 'budget']);

/**
 * The value a numeric conversion is being handed, or `undefined` if this node is
 * not one. `Number.parseInt(x, 10)` counts: same function, different spelling,
 * and the callee is a property access rather than a bare identifier — which is
 * precisely how it slipped past the first draft.
 */
function convertedValue(node: ts.Node): ts.Expression | undefined {
  if (ts.isCallExpression(node)) {
    if (ts.isIdentifier(node.expression) && NUMERIC_CONVERSIONS.has(node.expression.text)) {
      return node.arguments[0];
    }
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Number' &&
      NUMERIC_CONVERSIONS.has(node.expression.name.text)
    ) {
      return node.arguments[0];
    }
    return undefined;
  }
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.PlusToken) {
    return node.operand;
  }
  return undefined;
}

/**
 * Reads a `limit` anywhere under `node`, FOLLOWING identifiers one hop through
 * their declaration — a local (`const l = options.limit`), a destructured
 * binding (`const { limit } = options`, `const { limit: cap } = options`), or a
 * parameter actually named `limit`.
 *
 * `seen` is per call, not module-level: it breaks a declaration cycle without
 * making the predicate remember an answer between calls.
 */
function makeReadsALimit(checker: ts.TypeChecker): (node: ts.Node) => boolean {
  return (root: ts.Node): boolean => {
    const seen = new Set<ts.Symbol>();

    const declares = (decl: ts.Declaration): boolean => {
      if (ts.isBindingElement(decl)) {
        const named = decl.propertyName ?? decl.name;
        return ts.isIdentifier(named) && CAP_FLAGS.has(named.text);
      }
      if (ts.isVariableDeclaration(decl)) {
        return decl.initializer !== undefined && walk(decl.initializer);
      }
      if (ts.isParameter(decl)) {
        return ts.isIdentifier(decl.name) && CAP_FLAGS.has(decl.name.text);
      }
      return false;
    };

    const walk = (node: ts.Node): boolean => {
      if (ts.isPropertyAccessExpression(node) && CAP_FLAGS.has(node.name.text)) return true;
      if (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        CAP_FLAGS.has(node.argumentExpression.text)
      ) {
        return true;
      }
      if (ts.isIdentifier(node)) {
        const symbol = checker.getSymbolAtLocation(node);
        if (symbol && !seen.has(symbol)) {
          seen.add(symbol);
          if ((symbol.declarations ?? []).some(declares)) return true;
        }
      }
      return ts.forEachChild(node, walk) === true;
    };

    return walk(root);
  };
}

const readsALimit = makeReadsALimit(limitProgram.getTypeChecker());

/** Probe sources for the positive control live on disk so they get a program. */
const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'favro-limit-probe-'));
let probeSeq = 0;

interface Offence {
  file: string;
  text: string;
}

/** Every numeric conversion of a `--limit`, and every conversion seen at all. */
function scan(
  files: readonly ts.SourceFile[],
  reads: (node: ts.Node) => boolean,
): { offences: Offence[]; conversionsSeen: number } {
  const offences: Offence[] = [];
  let conversionsSeen = 0;

  const visit = (sf: ts.SourceFile, node: ts.Node): void => {
    const converted = convertedValue(node);
    if (converted) conversionsSeen += 1;

    if (converted && reads(converted)) {
      offences.push({
        file: path.relative(path.join(REPO_ROOT, 'src'), sf.fileName),
        // `sf.text.slice`, not `node.getText()`: a node off a `createProgram`
        // source file has no `parent` set, so `getText()` throws — and a ratchet
        // that CRASHES instead of naming the offender is a ratchet whose red
        // build tells you nothing. Found by mutating one site back to `parseInt`.
        text: sf.text.slice(node.pos, node.end).trim().replace(/\s+/g, ' ').slice(0, 80),
      });
    }
    ts.forEachChild(node, (child) => visit(sf, child));
  };

  for (const sf of files) ts.forEachChild(sf, (child) => visit(sf, child));
  return { offences, conversionsSeen };
}

/**
 * DEBT: `--limit` values still parsed by hand, keyed by file, valued with the
 * issue that will delete the entry.
 *
 * Empty. #143 converted all sixteen. Do NOT add to this list to make a red build
 * green — an entry is a command that can invent a cap out of garbage, and the
 * only correct response is to route it through `parseLimit`.
 */
const HAND_PARSED: Record<string, string> = {};

/**
 * Run the REAL scan over one probe source, through a real one-file program so
 * the checker — and therefore the follow-the-identifier arm — is the same one
 * production is scanned with. Hand-rolling a checkerless copy of the predicate
 * here is how a positive control ends up proving something the scan does not do.
 */
function fires(source: string): boolean {
  const file = path.join(probeDir, `probe-${probeSeq++}.ts`);
  fs.writeFileSync(file, source);
  const program = ts.createProgram([file], { ...limitConfig.options, noEmit: true });
  const sf = program.getSourceFile(file)!;
  return scan([sf], makeReadsALimit(program.getTypeChecker())).offences.length > 0;
}

describe('every --limit goes through parseLimit', () => {
  const { offences, conversionsSeen } = scan(productionFiles, readsALimit);

  it('no production module converts a --limit or --budget itself', () => {
    expect(offences.filter((o) => !(o.file in HAND_PARSED))).toEqual([]);
  });

  it('every debt entry is still real, so a fixed one fails the build', () => {
    const files = new Set(offences.map((o) => o.file));
    expect(Object.keys(HAND_PARSED).filter((f) => !files.has(f))).toEqual([]);
  });

  it('the scan actually enumerated the surface it claims to', () => {
    // Without this the two arms above pass vacuously the moment the walk breaks
    // — an empty offender list is indistinguishable from an empty scan. Three
    // independent floors: the files, a converted-value count, and the specific
    // files #142/#143 changed.
    // 127 production files at the time of writing.
    expect(productionFiles.length).toBeGreaterThan(110);
    expect(conversionsSeen).toBeGreaterThan(20);
    const names = productionFiles.map((sf) =>
      path.relative(path.join(REPO_ROOT, 'src'), sf.fileName),
    );
    expect(names).toContain('cli.ts');
    expect(names).toContain(path.join('commands', 'next.ts'));
    expect(names).toContain(path.join('lib', 'skill-engine.ts'));
    expect(names.some((n) => NOT_PRODUCTION.test(n))).toBe(false);
    // The one exemption is load-bearing, not a hole: the file is in the program
    // and it really does convert a limit, so a rename that quietly dropped it
    // out of the scan would fail here instead of widening the exemption.
    const parser = scannableFiles.filter(
      (sf) => path.relative(path.join(REPO_ROOT, 'src'), sf.fileName) === THE_PARSER,
    );
    expect(parser).toHaveLength(1);
    expect(scan(parser, readsALimit).offences.length).toBeGreaterThan(0);
    expect(names).not.toContain(THE_PARSER);
  });

  it('the detector recognises every shape #143 deleted, and no false friend', () => {
    // A positive control, because an offender list of zero proves nothing about
    // a detector nobody has seen fire. `fires` runs the real `scan`.
    // Verbatim shapes from the sixteen sites, plus the next spellings.
    expect(fires('const n = parseInt(options.limit, 10) || 1000;')).toBe(true);
    expect(fires("const n = parseInt(options.limit ?? '500', 10) || 500;")).toBe(true);
    expect(fires("const n = parseInt(args.limit ?? '1000', 10);")).toBe(true);
    expect(fires('const n = Number(options.limit);')).toBe(true);
    expect(fires('const n = +options.limit;')).toBe(true);
    expect(fires("const n = parseInt(opts['limit'], 10);")).toBe(true);

    // The three launderings that were CONFIRMED to evade the first draft — each
    // written into a real command, suite still green. Regression, not theory.
    expect(fires('const n = Number.parseInt(options.limit as string, 10);')).toBe(true);
    expect(fires('const l = options.limit; const n = parseInt(l as string, 10);')).toBe(true);
    expect(fires('const { limit } = options; const n = parseInt(limit as string, 10);')).toBe(true);
    expect(fires('const { limit: cap } = options; const n = parseInt(cap as string, 10);')).toBe(true);
    expect(fires('function f(limit: string) { return Number(limit); }')).toBe(true);
    // `--budget` shares the grammar, so it shares the ratchet — the skill step
    // #143 missed was exactly this line.
    expect(fires('const b = args.budget ? parseInt(args.budget, 10) : undefined;')).toBe(true);

    // …and leaves the correct call, and every unrelated `parseInt`, alone.
    expect(fires('const n = parseLimit(options.limit) ?? 1000;')).toBe(false);
    expect(fires('const n = parseInt(options.position, 10);')).toBe(false);
    expect(fires("const n = parseInt(process.env.FAVRO_MCP_PORT || '3000', 10);")).toBe(false);
    // A local that never touched a limit must not fire just for being a local.
    expect(fires('const d = options.days; const n = parseInt(d as string, 10);')).toBe(false);
  });
});
