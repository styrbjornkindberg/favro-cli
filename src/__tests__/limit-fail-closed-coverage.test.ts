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
 * Then the fetch path went away entirely. Reviewing #143 measured six
 * `cardLimit` parameters with zero reads between them, so every one of those
 * fourteen commands computed a correct number and handed it to a signature that
 * dropped it. The number is not the bug once nothing reads it; the FLAG is. It
 * is deleted — see arm three for why a real cap is not honestly reachable here.
 *
 * THE ARMS
 *
 *   - THE TABLE drives `parseLimit` and `capRows` over every malformed spelling
 *     the two tickets name, plus the values that must still work.
 *   - THE LIVE PRINT CAP drives `buildProgram()` — the program `bin/favro`
 *     builds — against a real HTTP server. It asserts the refusal exits 1, puts
 *     nothing on stdout that could be read as a result, and never pages the
 *     board: the whole point of parsing before the fetch.
 *   - THE REMOVED FETCH CAPS assert the fourteen declare no `--limit` on the
 *     real commander tree and that supplying one now DECLINES by name rather
 *     than being silently ignored, with both negative controls.
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

import { CommanderError, type Command } from 'commander';

import { capRows, parseLimit } from '../lib/read-shape';
import { RefusalError } from '../lib/refusal';
import FavroHttpClient from '../lib/http-client';
import * as clientFactory from '../lib/client-factory';
import { buildProgram } from '../cli';

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
  const before = process.exitCode;
  process.exitCode = undefined;
  const exit = jest.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit must not be called under run()');
  }) as never);
  const out = jest.spyOn(console, 'log').mockImplementation(() => {});
  const err = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await buildProgram().parseAsync(['node', 'favro', ...argv]);
  } catch (error) {
    if ((error as Error).message !== 'process.exit') throw error;
  }
  const code = process.exitCode;
  process.exitCode = before;
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
      'cards', 'list', BOARD, '--limit', '1_000', '--human',
    ]);

    expect(code).toBe(1);
    expect(stderr).toContain('1_000');
    // Nothing on stdout that a caller could parse as a RESULT. The old
    // behaviour printed a full, well-formed envelope of every card. Driven
    // `--human` since #119 put `cards list` on `run()`: unflagged, the refusal
    // is an error ENVELOPE on stdout, which the arm below is about.
    expect(stdout).toBe('');
    // And it costs no board read: the parse runs before the fetch, so a typo'd
    // cap does not page a whole board only to throw it away.
    expect(served.filter((s) => s.path.endsWith('/cards'))).toEqual([]);
  });

  it('a --limit that parses still caps the output and marks it', async () => {
    const { client } = await startServer(5);
    jest.spyOn(clientFactory, 'createFavroClient').mockResolvedValue(client);

    const { code, stdout } = await drive(['cards', 'list', BOARD, '--limit', '2']);

    expect(code).toBeUndefined();
    const envelope = JSON.parse(stdout);
    expect(envelope.rows).toHaveLength(2);
    expect(envelope.truncated).toBe(true);
  });

  it('the refusal is an ENVELOPE on stdout under the machine default (#119)', async () => {
    // The other half of the arm above, and the one `cards list` could not have
    // until it moved onto `run()`: a caller who parses stdout gets the reason
    // rather than nothing at all.
    const { client, served } = await startServer(5);
    jest.spyOn(clientFactory, 'createFavroClient').mockResolvedValue(client);

    const { code, stdout, stderr } = await drive(['cards', 'list', BOARD, '--limit', '1_000']);

    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toEqual({
      error: { message: expect.stringContaining('1_000'), retryable: false },
    });
    expect(stderr).toBe('');
    expect(served.filter((s) => s.path.endsWith('/cards'))).toEqual([]);
  });
});

// ─── arm three: the fetch caps are GONE, and say so out loud ─────────────────

/**
 * There is no fetch cap left to test, and that is the assertion.
 *
 * This arm used to drive three of the fetch commands against a recording `Ctx`
 * and check the NUMBER each one computed — deliberately not the rows, because
 * `ContextAPI.getSnapshot` and `AggregateAPI.getMultiBoardSnapshot` accepted
 * `cardLimit` and never read it, so the cap was unobservable in the fetch. Six
 * such parameters, zero reads, measured through the checker. The close comment
 * on #143 took the decision: absent means no cap, an explicit value means a real
 * cap — and a real cap here is not reachable honestly. `getMultiBoardSnapshot`
 * sweeps collections through `mapConcurrent(…, 3, …)` and each worker appends as
 * its call lands, so a global cut point is decided by wire arrival order; and
 * `buildStats` turns whatever survives into the `by_status` / `by_owner`
 * proportions that `health`, `workload`, `team` and `overview` print as
 * measured. A subsampled ratio is a plausible answer built from data we chose
 * not to read, which is the one conversion this codebase does not make — and
 * "results are partial" does not repair a wrong percentage. So the parameter is
 * deleted and the flag with it.
 *
 * WHAT THIS ARM GUARDS: the flag went away LOUDLY. Commander answers an
 * unrecognised option with `commander.unknownOption` and exit 1, so
 * `favro workload --limit 50` now declines and names the flag instead of
 * accepting it and quietly ignoring it — which is what it did for its whole
 * life. Two independent signals, because either alone can pass for the wrong
 * reason:
 *
 *   - THE SURFACE: the real commander tree has no `--limit` on any of the
 *     fourteen. A missing command name fails too, so a rename cannot empty this
 *     list quietly.
 *   - THE PARSE: the real program, given `--limit 50`, raises
 *     `commander.unknownOption` naming `--limit`, asks for exit 1, and never
 *     reaches the action — so it costs no wire call. That is precisely what the
 *     user gets: `.exitOverride()` (ADR-0002) turns commander's own exit into a
 *     `CommanderError`, and `cli.ts`'s `.catch` sets `process.exitCode` from it
 *     after commander has already written the message.
 *
 * The NEGATIVE controls are both real and both necessary. `cards list` still
 * carries a `--limit` (a print cap, `capRows`), so the surface probe must SEE
 * one somewhere or "no `--limit` on the fourteen" is just a broken probe. And
 * `--nonesuch` must be reported as `--nonesuch` and NOT as `--limit`, or the
 * fourteen rows above would pass on any unknown flag at all rather than on the
 * one that was removed. Arm two covers the third direction end to end:
 * `cards list --limit 2` still parses, fetches and caps.
 *
 * If a future ticket wires a cap that DISCLOSES — a `capped` field on the
 * snapshot that every one of these commands renders on the human path and in
 * `--json` — this arm is the one to rewrite, and rewriting it is the point: the
 * disclosure arms have to be written down before the flag comes back.
 */
const LIMIT_REMOVED: Array<[string, string[]]> = [
  ['context', ['context', BOARD]],
  ['standup', ['standup', '--board', BOARD]],
  ['sprint-plan', ['sprint-plan', '--board', BOARD]],
  ['query', ['query', BOARD, 'status:done']],
  ['board', ['board', BOARD]],
  ['diff', ['diff', BOARD, '--since', '1d']],
  ['health', ['health']],
  ['my-cards', ['my-cards']],
  ['my-standup', ['my-standup']],
  ['next', ['next']],
  ['overview', ['overview']],
  ['stale', ['stale']],
  ['team', ['team']],
  ['workload', ['workload']],
];

/**
 * The `--limit` options of one command in the real tree, addressed by the same
 * name path the user types (`['cards', 'list']`).
 *
 * Not `?.` on the lookup — a renamed or unregistered command must FAIL here, not
 * report "no --limit" because it found nothing to look at.
 */
function limitOptionsOf(...namePath: string[]): string[] {
  let node: Command = buildProgram();
  for (const name of namePath) {
    const child = node.commands.find((c) => c.name() === name);
    if (!child) throw new Error(`no such command: ${namePath.join(' ')}`);
    node = child;
  }
  return node.options.map((o) => o.long ?? o.short ?? '').filter((l) => l === '--limit');
}

/**
 * Parse one argv through the real program and hand back the `CommanderError` it
 * declined with — plus whatever reached stdout, which must be nothing.
 *
 * A parse error never enters an action, so this needs no server and no client:
 * `createFavroClient` is never called, which is also the claim that a typo'd
 * flag costs no wire call.
 */
async function parseError(argv: string[]) {
  const out = jest.spyOn(console, 'log').mockImplementation(() => {});
  const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  let thrown: unknown;
  try {
    await buildProgram().parseAsync(['node', 'favro', ...argv]);
  } catch (error) {
    thrown = error;
  }
  const stdout = out.mock.calls.map((c) => String(c[0])).join('\n');
  out.mockRestore();
  write.mockRestore();
  return { thrown, stdout };
}

describe('the inert fetch cap is gone, and its flag refuses out loud', () => {
  it.each(LIMIT_REMOVED)('%s declares no --limit in the real commander tree', (name) => {
    expect(limitOptionsOf(name)).toEqual([]);
  });

  it.each(LIMIT_REMOVED)('%s declines --limit 50 by name, and writes no result', async (_n, argv) => {
    const { thrown, stdout } = await parseError([...argv, '--limit', '50']);

    expect((thrown as CommanderError)?.code).toBe('commander.unknownOption');
    expect((thrown as Error)?.message).toContain("unknown option '--limit'");
    // `cli.ts` reads this straight into `process.exitCode`.
    expect((thrown as CommanderError)?.exitCode).toBe(1);
    // Accepting it and quietly ignoring it is exactly what this change deletes,
    // so an exit 0 with a well-formed report is the regression.
    expect(stdout).toBe('');
  });

  it('the surface probe can still SEE a --limit where one really exists', () => {
    // `cards list` keeps a real one — a print cap. If this ever came back empty
    // the fourteen rows above would be proving nothing.
    expect(limitOptionsOf('cards', 'list')).toEqual(['--limit']);
  });

  it('the surface probe THROWS on a name it cannot find, at either depth', () => {
    // Pins the `if (!child) throw`. Softening it to `return []` left all 61 tests
    // green — a renamed or unregistered command would then have reported "no
    // --limit" because there was nothing to look at. Found by mutation.
    expect(() => limitOptionsOf('no-such-command')).toThrow('no such command');
    expect(() => limitOptionsOf('cards', 'no-such-leaf')).toThrow('no such command');
  });

  it('an unknown flag is named as ITSELF, not as --limit', async () => {
    // The discriminator. Without it, the fourteen rows above would pass on any
    // unknown option whatsoever rather than on the one that was removed.
    const { thrown } = await parseError(['health', '--nonesuch', '50']);
    expect((thrown as CommanderError)?.code).toBe('commander.unknownOption');
    expect((thrown as Error)?.message).toContain("'--nonesuch'");
    expect((thrown as Error)?.message).not.toContain('--limit');
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
afterAll(() => fs.rmSync(probeDir, { recursive: true, force: true }));
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
    // 125 production files and 34 conversions, re-measured by instrumenting
    // these two expressions. It said 127 until #110 deleted `commands/batch.ts`,
    // `commands/batch-smart.ts` and `lib/bulk.ts` and added `commands/removed.ts`
    // — net −2. The floor never moved, so nothing went red and the number went
    // stale silently.
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

// ─── arm five: no snapshot read grows a cap parameter again ──────────────────

/**
 * `ContextAPI.getSnapshot` and `AggregateAPI.getMultiBoardSnapshot` take a board
 * or a scope and NOTHING ELSE.
 *
 * This is the ratchet the original defect needed and did not have. A dead
 * `cardLimit: number = 1000` sat on both of these long enough to grow four
 * pass-throughs feeding it (`QueryAPI.execute`, `SprintPlanAPI.getSuggestions`,
 * `StandupAPI.getStandup`, `getCollectionSnapshot`) and fourteen commands
 * computing a number for it. Every one of those was correct code written around
 * a parameter with zero reads.
 *
 * Re-adding the parameter ALONE was confirmed to leave all 3051 tests green —
 * nothing passes it, so nothing observes it. Found by mutation. It is inert on
 * the day it lands and load-bearing six commits later, which is exactly the
 * shape a ratchet is for.
 *
 * Parameters are counted through the checker rather than `Function.length`,
 * because `length` stops at the first default — `cardLimit: number = 1000` is
 * invisible to it, which is part of how this went unnoticed.
 *
 * ponytail: three methods by name, not "every method returning a snapshot".
 * These are the ones the six parameters hung off. Widen it when a fourth appears.
 */
const UNCAPPED_READS: Array<[string, string, string[]]> = [
  // file (relative to src), method, the exact parameter list allowed
  [path.join('api', 'context.ts'), 'getSnapshot', ['boardRef']],
  [path.join('api', 'aggregate.ts'), 'getMultiBoardSnapshot', ['scope']],
  [path.join('api', 'aggregate.ts'), 'getCollectionSnapshot', ['collectionRef']],
  [path.join('api', 'query.ts'), 'execute', ['boardRef', 'query']],
  [path.join('api', 'sprint-plan.ts'), 'getSuggestions', ['boardRef', 'budget']],
  [path.join('api', 'standup.ts'), 'getStandup', ['boardRef', 'dueSoonDays']],
];

/** Parameter names of one method declaration, found through the real program. */
function parametersOf(relFile: string, method: string): string[] {
  const sf = scannableFiles.find(
    (f) => path.relative(path.join(REPO_ROOT, 'src'), f.fileName) === relFile,
  );
  // Not a soft return — a moved file must fail here rather than report "no
  // parameters" because it found no file to look in.
  if (!sf) throw new Error(`not in the program: ${relFile}`);

  const found: string[][] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === method) {
      found.push(node.parameters.map((p) => sf.text.slice(p.name.pos, p.name.end).trim()));
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);

  if (found.length !== 1) {
    throw new Error(`${found.length} declarations of ${method} in ${relFile}`);
  }
  return found[0];
}

describe('the snapshot reads take no cap parameter', () => {
  it.each(UNCAPPED_READS)('%s %s takes exactly (%s)', (file, method, params) => {
    // The whole list, not a count: a second parameter under any name is a
    // review conversation, and `cardLimit` back by that name is this ticket
    // reopening. Re-adding it is invisible to every other test in the repo.
    expect(parametersOf(file, method)).toEqual(params);
  });

  it('the parameter probe fails loudly on a method or a file it cannot find', () => {
    // Without this, the rows above could pass on a probe that always answered
    // with whatever it was asked for — the too-thin-stand shape that once let
    // `() => true` pass 2934 tests in this repo.
    expect(() => parametersOf(path.join('api', 'context.ts'), 'noSuchMethod')).toThrow(
      '0 declarations',
    );
    expect(() => parametersOf(path.join('api', 'no-such-file.ts'), 'getSnapshot')).toThrow(
      'not in the program',
    );
  });
});
