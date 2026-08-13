/**
 * The `--filter` fail-closed ratchet (#83).
 *
 * WHAT IT GUARDS
 * `--filter` is one grammar with an eight-step protocol behind it, and #46 made
 * exactly ONE command run all of it. The steps that matter here are two:
 *
 *   1. `parseQuery`          — fails closed on field NAMES, offline.
 *   2. `validateQueryValues` — fails closed on the VALUES of the fields whose
 *                              vocabulary Favro owns (`tag:`, `label:`,
 *                              `status:`, `assignee:`), which costs a read.
 *
 * Step 2 is skippable, and `cards export` skipped it. So `cards list --filter
 * "tag:typoo"` refused and printed the org's real tags, while `cards export
 * --filter "tag:typoo"` wrote an empty file — same grammar, opposite
 * guarantees, decided by which command you typed. An empty export that looks
 * like an answer is precisely the plausible-wrong-answer #32, #44 and #46 exist
 * to abolish, and #77 restated: absent or unresolvable data is UNCHECKABLE, not
 * exempt.
 *
 * THE ARMS
 *
 *   - PARITY drives both commands' filter paths over one stub org with the same
 *     four bad inputs — an unknown field, an unknown bare token, an unknown tag
 *     value, an unknown status value — and asserts the refusals are the same
 *     object shape with the same words. It fails the moment either side starts
 *     answering instead of refusing.
 *   - THE RATCHET reads the source. `resolveQuery` composes the two steps into
 *     one call precisely so a third consumer cannot pick up a partial subset of
 *     it; this arm asserts nothing outside `query-values.ts` reaches for
 *     `parseQuery` on its own. Parity over two commands proves two commands. A
 *     ratchet over the real surface is what stops the third.
 *   - THE LIVE COMMAND drives `buildProgram()`, because the two arms above call
 *     library functions and neither reaches the command a user types.
 *   - LIVE PARITY (#138) drives every command that takes `--filter` and compares
 *     the printed refusals to each other. Two of them used to be WRITE
 *     commands — `batch move` and `batch assign` — which carried a third grammar
 *     of their own until #138 deleted it; #110 then deleted the commands, so the
 *     live set is `cards list` and `cards export`. Same words, same exit code;
 *     two commands refusing two ways is the next version of this bug, and only a
 *     comparison catches that.
 *   - EXACT MEMBERSHIP reads the source again, for anyone deciding tag or
 *     assignee membership by substring — the flag-shaped spelling of the same
 *     bug (#84).
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { ParseError } from '../lib/query-parser';
import { resolveQuery } from '../lib/query-values';
import { applyFilters } from '../lib/cards-export';
import CardsAPI, { Card } from '../lib/cards-api';
import * as clientFactory from '../lib/client-factory';
import { buildProgram } from '../cli';

jest.mock('../lib/cards-api');
jest.mock('../lib/client-factory');

const BOARD = 'board-1';

const WIDGETS = [
  {
    widgetCommonId: BOARD,
    name: 'Dev',
    type: 'board',
    columns: [
      { columnId: 'col-1', name: 'To Do' },
      { columnId: 'col-2', name: 'Doing' },
    ],
  },
];

const TAGS = [
  { tagId: 'tag-1', name: 'bug' },
  { tagId: 'tag-2', name: 'backend' },
];

const CARDS: Card[] = [
  { cardId: 'c1', name: 'Fix login', tags: ['bug'], status: 'Doing' } as Card,
  { cardId: 'c2', name: 'Write docs', tags: ['backend'], status: 'To Do' } as Card,
];

/** Minimal FavroHttpClient stand-in — only the reads these paths make. */
function makeClient() {
  const get = jest.fn(async (url: string) => {
    if (url === '/widgets') return { entities: WIDGETS };
    if (url === '/tags') return { entities: TAGS };
    // One real user, so `batch assign --to alice` gets past its own resolution
    // and the FILTER is what the parity arm below is comparing.
    if (url === '/users') return { entities: [{ userId: 'u-alice', name: 'alice', email: 'alice@example.com' }] };
    // `favro query` settles the board before the filter, the same order
    // `cards list` uses (#82) — so its arm needs the single-board read too.
    if (url === `/widgets/${BOARD}`) return WIDGETS[0];
    throw new Error(`unexpected GET ${url}`);
  });
  return { get, organizationId: 'org-a' } as any;
}

const originalConfigDir = process.env.FAVRO_CONFIG_DIR;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'favro-filter-ratchet-'));
  process.env.FAVRO_CONFIG_DIR = tmpDir;
});

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.FAVRO_CONFIG_DIR;
  else process.env.FAVRO_CONFIG_DIR = originalConfigDir;
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ─── arm one: the two commands refuse the same input identically ─────────────

/** What a refusal is, reduced to the parts a caller can act on. */
async function refusalFrom(run: () => Promise<unknown>) {
  try {
    const answered = await run();
    return { refused: false as const, answered };
  } catch (err) {
    const e = err as ParseError;
    return {
      refused: true as const,
      name: e.constructor.name,
      message: e.message,
    };
  }
}

/**
 * Every shape of bad input the two commands must agree about, with the token
 * the refusal has to name — "Error" is not a refusal.
 *
 * `reason` is the WORDING each arm must produce, and it is what discriminates
 * the arms from each other. It replaces a `detail.kind` assertion deleted with
 * the discriminants in #140 — and it discriminates strictly better, because
 * `kind` was `unknown-value` for BOTH the tag and the status arm, so a refusal
 * that fired the wrong one of those two satisfied it. The prose is the contract;
 * a refusal that changes which sentence it produces has changed behaviour.
 */
const BAD_INPUTS: Array<
  [label: string, filter: string, unresolvable: string, reason: RegExp]
> = [
  ['an unknown field', 'bogusfield:x', 'bogusfield', /^Unknown filter field 'bogusfield' at position 0 —/],
  ['an unknown bare token', 'typoo', 'typoo', /^Unrecognised filter token 'typoo' at position 0 —/],
  ['an unknown tag value', 'tag:typoo', 'typoo', /^No tag matching "typoo" —/],
  ['an unknown status value', 'status:Shipped', 'Shipped', /^No column named "Shipped" on board board-1 —/],
];

describe('cards list and cards export refuse the same filter identically', () => {
  test.each(BAD_INPUTS)('%s', async (_label, filter, unresolvable, reason) => {
    const ctx = { client: makeClient(), boardId: BOARD };

    // `cards list` — the command #46 made fail closed.
    const list = await refusalFrom(() => resolveQuery(filter, ctx));

    // `cards export` — the command that used to answer a plausible zero rows.
    const exported = await refusalFrom(() =>
      applyFilters(CARDS, [filter], { client: makeClient(), boardId: BOARD })
    );

    expect(list.refused).toBe(true);
    expect(exported.refused).toBe(true);
    expect(exported).toEqual(list);

    // A refusal names the token it could not resolve, AND says the one thing
    // this arm is about — so an arm that starts firing another arm's refusal
    // fails here instead of passing on "it threw".
    expect(list.message).toContain(unresolvable);
    expect(list.message).toMatch(reason);
    // `status:` is settled by ColumnDirectory, which raises its own class; every
    // other arm is the parse protocol's own.
    expect(list.name).toBe(filter.startsWith('status:') ? 'ColumnResolutionError' : 'ParseError');
  });

  test('a filter the vocabulary accepts still exports its rows', async () => {
    const rows = await applyFilters(CARDS, ['tag:bug'], {
      client: makeClient(),
      boardId: BOARD,
    });
    expect(rows.map((c) => c.cardId)).toEqual(['c1']);
  });

  test('repeated --filter flags AND as written, not by operator precedence', async () => {
    // AND binds tighter than OR, so a bare `join(' AND ')` turns these two
    // flags into `tag:bug OR (tag:backend AND status:"To Do")` — which matches
    // `c1` as well, a strictly WIDER set than was asked for. On `cards export`
    // that was extra rows in a file; between #138 and #110 `batch move`/`batch
    // assign` reached this same call, and would have WRITTEN to them.
    const rows = await applyFilters(CARDS, ['tag:bug OR tag:backend', 'status:"To Do"'], {
      client: makeClient(),
      boardId: BOARD,
    });
    expect(rows.map((c) => c.cardId)).toEqual(['c2']);
  });

  test('a refusal names candidates, so the user can act on it', async () => {
    const refusal = await refusalFrom(() =>
      applyFilters(CARDS, ['tag:typoo'], { client: makeClient(), boardId: BOARD })
    );
    expect(refusal.refused).toBe(true);
    if (!refusal.refused) return;
    // The whole org vocabulary, sorted, in the message — this is where the
    // candidate list has always had to be, since nothing ever read the
    // `detail.candidates` copy of it (#140).
    expect(refusal.message).toBe(
      `No tag matching "typoo" — it is missing or not visible to your key. ` +
        `Run 'favro tags list' to see them. The org's tags:\n  backend\n  bug`
    );
  });
});

// ─── arm two: nothing may run half the protocol ──────────────────────────────

/**
 * `parseQuery` is half of `--filter`. Composing it with the value check is what
 * `resolveQuery` is for, so these are the only two files allowed to name it:
 * the one that declares it, and the one that completes it.
 *
 * The scan below matches the NAME in the source text, not resolved call sites —
 * so even a comment naming `parseQuery` trips it. That bluntness is the point:
 * a call-graph version needs the type checker, and would still miss a dynamic
 * `require` or a re-export, which is exactly how the half-protocol would come
 * back. If you trip this, route the caller through `resolveQuery`, or add the
 * file to the set above with a reason. Do not loosen the regex.
 */
const MAY_NAME_PARSE_QUERY = new Set([
  path.join('lib', 'query-parser.ts'),
  path.join('lib', 'query-values.ts'),
]);

const SRC = path.resolve(__dirname, '..');
const NOT_PRODUCTION = /(^|\/)(__tests__|__integration__|test-support)(\/|$)/;

/** Every production `.ts` under `src`, relative to `src`. */
function productionSources(dir: string = SRC): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    const rel = path.relative(SRC, full);
    if (NOT_PRODUCTION.test(rel.split(path.sep).join('/'))) return [];
    if (entry.isDirectory()) return productionSources(full);
    return entry.name.endsWith('.ts') ? [rel] : [];
  });
}

describe('the parse-then-validate protocol is one call', () => {
  test('no production module reaches for parseQuery on its own', () => {
    const offenders = productionSources().filter(
      (rel) =>
        !MAY_NAME_PARSE_QUERY.has(rel) &&
        /\bparseQuery\b/.test(fs.readFileSync(path.join(SRC, rel), 'utf8'))
    );
    expect(offenders).toEqual([]);
  });

  test('the scan looks at the files it claims to', () => {
    const sources = productionSources();
    expect(sources).toContain(path.join('lib', 'cards-export.ts'));
    expect(sources).toContain('cli.ts');
    expect(sources.some((f) => f.includes('__tests__'))).toBe(false);
  });
});

// ─── arm three: the command a user actually types ────────────────────────────

/**
 * Arms one and two never reach a command: they call `applyFilters` directly.
 * `lib/cards-export.ts` used to carry a `registerCardsExportCommand` twin that
 * nothing but its own tests registered — the live `cards export` is inline in
 * `cli.ts` — so the export suite could be fully green while the live path
 * answered a plausible zero rows. The twin is gone (#139); this arm is what
 * replaced it, and it drives `buildProgram()`, the program `bin/favro` builds.
 */
describe('the live cards export refuses a filter it cannot settle', () => {
  const listCards = jest.fn(async () => CARDS);
  let outDir: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    // The out-path guard rejects anything outside cwd, so the file this test
    // proves is NOT written has to be somewhere it legitimately could be.
    outDir = await fsp.mkdtemp(path.join(process.cwd(), '.favro-export-refusal-'));
    (clientFactory.createFavroClient as jest.Mock).mockImplementation(async () => makeClient());
    (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(
      () => ({ listCards } as any)
    );
  });

  afterEach(async () => {
    await fsp.rm(outDir, { recursive: true, force: true });
  });

  test('an unknown tag exits 1, writes no file, and never fetches the board', async () => {
    const out = path.join(outDir, 'refused.json');
    // `--human`, so the refusal renders on stderr where this arm reads it. #119
    // put `cards export` on `run()`: unflagged it emits the error ENVELOPE on
    // stdout instead, and sets `process.exitCode` rather than exiting hard.
    const before = process.exitCode;
    process.exitCode = undefined;
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit must not be called under run()');
    }) as never);
    const said = jest.spyOn(console, 'error').mockImplementation(() => {});

    await buildProgram().parseAsync([
      'node', 'favro', '--human', 'cards', 'export', BOARD,
      '--filter', 'tag:typoo',
      '--out', out,
    ]);

    const printed = said.mock.calls.map((c) => String(c[0])).join('\n');
    const code = process.exitCode;
    process.exitCode = before;
    said.mockRestore();
    exit.mockRestore();

    expect(code).toBe(1);
    expect(fs.existsSync(out)).toBe(false);
    // A refusal names the token it could not resolve, and the candidates.
    expect(printed).toContain('typoo');
    expect(printed).toContain('bug');
    // And it needs no board data to say so. Paging a whole board only to throw
    // it away is the most expensive read this CLI makes; `cards list` spends
    // zero of them on the same refusal.
    expect(listCards).not.toHaveBeenCalled();
  });

  test('a filter the vocabulary accepts still writes the export', async () => {
    const out = path.join(outDir, 'exported.json');
    const said = jest.spyOn(console, 'error').mockImplementation(() => {});

    await buildProgram().parseAsync([
      'node', 'favro', 'cards', 'export', BOARD,
      '--filter', 'tag:bug',
      '--out', out,
    ]);

    said.mockRestore();
    expect(listCards).toHaveBeenCalledWith(BOARD);
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).map((c: any) => c.id)).toEqual(['c1']);
  });
});

// ─── arm four-and-a-half: the live `favro query` speaks the same grammar ─────

/**
 * `favro query <board> "<filter>"` was the FOURTH surface filtering cards, and
 * until #95 it ran a second, regex-based parser of its own: it scraped what it
 * recognised, swept the remainder into a title search, and answered a confident
 * zero rows with a paragraph explaining why. So `favro query <board>
 * "statuz:done"` ANSWERED where `cards list --filter "statuz:done"` refused.
 *
 * This arm drives the real program and compares the refusal a user reads to the
 * one `cards export` prints for the same input. It is a separate arm from the
 * live-parity one above, and it has to be, for a reason worth writing down:
 *
 *   `favro query` is migrated to the ADR-0002 runner and the three `--filter`
 *   commands are NOT (#119 owns that). So query writes
 *   `{"error":{"message,retryable"}}` to **stdout** while the other three write
 *   `✗ Error: …` to **stderr**. A byte comparison of the two channels would
 *   fail on the envelope rather than on the grammar, and weakening the
 *   comparison to make it pass is how a parity arm stops proving parity.
 *   The MESSAGE is what has to be identical, and that is what is compared.
 */
describe('the live favro query refuses a filter in the same words cards export does', () => {
  const listCards = jest.fn(async () => CARDS);

  beforeEach(() => {
    jest.clearAllMocks();
    (clientFactory.createFavroClient as jest.Mock).mockImplementation(async () => makeClient());
    (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => ({ listCards } as any));
  });

  /** Drive one command and collect BOTH channels — the point is which is used. */
  async function driven(argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const said = jest.spyOn(console, 'log').mockImplementation((...a) => { out.push(String(a[0])); });
    const alsoSaid = jest.spyOn(console, 'error').mockImplementation((...a) => { err.push(String(a[0])); });
    const exit = jest.spyOn(process, 'exit').mockImplementation(((c?: number) => {
      throw new Error(`process.exit:${c}`);
    }) as never);
    const before = process.exitCode;
    process.exitCode = undefined;
    try {
      await buildProgram().parseAsync(['node', 'favro', ...argv]);
    } catch (error) {
      if (!/^process\.exit:/.test((error as Error).message)) throw error;
      err.push((error as Error).message);
    }
    const code = process.exitCode;
    process.exitCode = before;
    said.mockRestore();
    alsoSaid.mockRestore();
    exit.mockRestore();
    return { stdout: out.join('\n'), stderr: err.join('\n'), code };
  }

  test.each(BAD_INPUTS)('%s refuses on query with export’s wording', async (_label, filter, unresolvable) => {
    const query = await driven(['query', BOARD, filter]);
    const exported = await driven(['cards', 'export', BOARD, '--filter', filter, '--out', 'unused.json']);

    // The machine-readable refusal is on STDOUT (ADR-0002).
    const envelope = JSON.parse(query.stdout);
    expect(envelope.error.message).toContain(unresolvable);
    expect(query.code).toBe(1);

    // …and it is the SAME sentence, whole rather than a substring, which is what
    // makes a second grammar reappearing here fail rather than pass on "it also
    // said typoo". `cards export` put it on STDERR with stdout empty until #119
    // moved it onto `run()`; both boundaries are the runner's now, so the
    // comparison is envelope against envelope.
    expect(JSON.parse(exported.stdout).error.message).toBe(envelope.error.message);
    expect(exported.code).toBe(1);
  });

  test('a refusal never pages the board, and a filter it accepts does', async () => {
    await driven(['query', BOARD, 'tag:typoo']);
    expect(listCards).not.toHaveBeenCalled();

    // The positive control. Without it, `not.toHaveBeenCalled` above would pass
    // against a command that never reached the fetch for any reason at all.
    const answered = await driven(['query', BOARD, 'tag:bug']);
    expect(listCards).toHaveBeenCalled();
    expect(JSON.parse(answered.stdout).matches.map((c: any) => c.id)).toEqual(['c1']);
  });

  test('free text is refused and pointed at title~"…" — the #95 headline', async () => {
    const { stdout, code } = await driven(['query', BOARD, 'authentication', 'refactor']);

    expect(code).toBe(1);
    // The old parser answered this: `{ text: 'authentication refactor' }`, a
    // title search over a board, and zero rows read as "no such card".
    expect(JSON.parse(stdout).error.message).toBe(
      `Unrecognised filter token 'authentication' at position 0 — it names no field and carries no operator. ` +
        `Filters are field:value (see 'favro cards list --help'). For free text, say it: title~"authentication".`,
    );
  });
});

// ─── arm five: every live --filter command refuses in the SAME words ─────────

/**
 * `batch move` and `batch assign` carried a THIRD `--filter` grammar until #138
 * — `parseFilterExpression`, which read an unknown field as `() => false` and
 * substring-matched tags. On a WRITE command that meant a bulk operation
 * reporting success having done nothing, with a typo indistinguishable from an
 * empty result.
 *
 * **Both commands were deleted by #110, and with them the last `--filter` on a
 * WRITE.** So this arm no longer compares a write against a read, and the sibling
 * assertion that a refusal attempts no write went with them — there is nothing
 * left that could write. What it still does is the part that generalises: drive
 * EVERY live `--filter` surface through `buildProgram()` and assert the refusals
 * are byte-for-byte the same text at the same exit code. That is `cards list` and
 * `cards export` here, plus `favro query` in the arm below, which is separate
 * because it is migrated to the runner and answers on a different STREAM.
 *
 * "Two commands refusing two ways" is the next version of this bug, and only a
 * comparison catches it — each command's own test would happily pin its own
 * wording.
 */
describe('every live --filter command refuses identically', () => {
  const listCards = jest.fn(async () => CARDS);
  const updateCard = jest.fn(async () => CARDS[0]);
  let outDir: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    outDir = await fsp.mkdtemp(path.join(process.cwd(), '.favro-parity-'));
    (clientFactory.createFavroClient as jest.Mock).mockImplementation(async () => makeClient());
    (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(
      () => ({ listCards, updateCard } as any)
    );
  });

  afterEach(async () => {
    await fsp.rm(outDir, { recursive: true, force: true });
  });

  /** Run one command to its refusal and return what the user saw. */
  async function refusal(argv: string[]) {
    const before = process.exitCode;
    process.exitCode = undefined;
    const exit = jest.spyOn(process, 'exit').mockImplementation(((c?: number) => {
      throw new Error(`process.exit:${c}`);
    }) as never);
    const said = jest.spyOn(console, 'error').mockImplementation(() => {});
    const alsoSaid = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // `--human`, for the reason above: the comparison is on the WORDING, and
      // both of these commands render it on stderr only under that flag.
      await buildProgram().parseAsync(['node', 'favro', '--human', ...argv]);
    } catch (err) {
      if (!/^process\.exit:/.test((err as Error).message)) throw err;
    }
    const printed = said.mock.calls.map((c) => String(c[0])).join('\n');
    const code = process.exitCode;
    process.exitCode = before;
    said.mockRestore();
    alsoSaid.mockRestore();
    exit.mockRestore();
    return { code, printed };
  }

  const COMMANDS: Array<[label: string, argv: (filter: string) => string[]]> = [
    ['cards export', (f) => ['cards', 'export', BOARD, '--filter', f, '--out', 'unused.json']],
    ['cards list', (f) => ['cards', 'list', '--board', BOARD, '--filter', f]],
  ];

  test.each(BAD_INPUTS)('%s reads the same on every command', async (_label, filter, unresolvable) => {
    const seen: Array<{ label: string; code?: number; printed: string }> = [];
    for (const [label, argv] of COMMANDS) {
      const built = argv(filter).map((a) => (a === 'unused.json' ? path.join(outDir, 'unused.json') : a));
      seen.push({ label, ...(await refusal(built)) });
    }

    for (const s of seen) {
      expect({ command: s.label, code: s.code }).toEqual({ command: s.label, code: 1 });
      expect(s.printed).toContain(unresolvable);
    }
    // The whole point of the arm: not merely that all three refused, but that
    // they refused with the same words.
    expect(seen.map((s) => s.printed)).toEqual(seen.map(() => seen[0].printed));
  });

  test('a refusal never pages the board, and never writes', async () => {
    // The write half is now vacuous by construction — #110 deleted the two
    // `--filter` write commands — and it is kept as the polarity that would
    // notice a `--filter` write coming back without the settle in front of it.
    for (const [, argv] of COMMANDS) await refusal(argv('tag:typoo'));
    expect(updateCard).not.toHaveBeenCalled();
    // …and the board is never even paged: a refusal needs no card data.
    expect(listCards).not.toHaveBeenCalled();
  });
});

// ─── arm four: nobody substring-matches a card's tags or assignees ───────────

/**
 * `--tag` and `--assignee` were the same bug wearing a flag instead of a filter
 * (#84): a raw lowercase `includes()` over the fetched cards, on the same flag
 * row as a `--filter` that settles `tag:` and `assignee:` against Favro's own
 * lists. `--tag typoo` answered zero rows; `--tag bug` also matched `debug`.
 *
 * A substring match that happens to hit exactly one tag is not "close enough" —
 * it is right by luck, and it turns wrong the day someone creates a second tag
 * containing it. Nothing here should be deciding tag or assignee membership on
 * its own, so this arm reads the source for anyone who still does.
 *
 * WHAT COUNTS
 * Element-wise string matching over a card's `tags`/`assignees` against a value
 * the caller supplied — `(card.tags ?? []).some(t => t…includes(value))`. Not
 * `array.includes(x)`, which is exact membership and correct. Not a hardcoded
 * literal (`tags.some(t => t.includes('blocked'))` in `risks.ts` and friends):
 * that is a convention scan over a name this repo chose, not a vocabulary it
 * has to look up.
 *
 * WHY THE SPAN IS `[^;]` AND NOT `[^\n]`
 * A line-based version of this arm shipped first, and it was vacuous against
 * the very code #84 deleted — Prettier had wrapped that filter at the arrow:
 *
 *   cardList = cardList.filter(c => (c.assignees ?? []).some(
 *     a => a.toLowerCase().includes(options.assignee.toLowerCase())
 *   ));
 *
 * `[^\n]*` cannot cross that break, so the one arm whose whole job is to stop
 * the THIRD occurrence did not see either of the first two. A statement span
 * does. `.toLowerCase()` is then required before `.includes(` to keep the wider
 * span off exact membership written across lines — `cards-api.ts`'s
 * `currentIds.includes(id)` is correct and must stay unflagged.
 *
 * WHY `foldName(…)` IS AN ALTERNATIVE TO `.toLowerCase()`
 * #141 replaced the lowercase-both-sides idiom with a shared Unicode fold at
 * every name seam, `api/query.ts` included. The debt did not move — that file
 * still substring-matches a card tag against a typed one — but the detector
 * stopped seeing it, because the case fold is now spelled as a call wrapping
 * the value rather than a method after it. A ratchet that a rename can blind
 * is not a ratchet, so it reads both spellings.
 *
 * ponytail: statement-based. The ceiling is a `;` INSIDE the expression — a
 * nested block body between the array and the `.includes(` would cut the span
 * short. Nothing here is written that way; move to the TypeScript AST, as
 * `scope-lock-coverage.test.ts` does, if one ever is.
 */
const CASE_FOLD = String.raw`(?:\.toLowerCase\(\)|foldName\([^();]*\))`;
const SUBSTRING_OVER_VOCABULARY = new RegExp(
  String.raw`\b(?:tags|assignees)\b[^;]*\.(?:some|find|filter|every)\([^;]*${CASE_FOLD}\.includes\(\s*(?!['"\`])`,
);

/**
 * DEBT: the filtering surfaces that still substring-match, keyed by file and
 * valued with the issue that will delete the line. Both are a SECOND grammar
 * rather than a missing guard, so both die by deletion, not by a patch here.
 *
 * Do NOT add to this list to make a red build green — a new entry is a new
 * surface answering the same question a different way, which is the defect.
 */
const SUBSTRING_DEBT: Record<string, string> = {
  // `api/query.ts` was here until #95. `parseQueryFilter` and `matchCard` are
  // deleted, not repaired: `favro query` runs `resolveQuery` + `filterCards`,
  // the same two calls `cards list --filter` makes, so `statuz:done` refuses
  // there exactly as it always did here. Its `foldName(tag).includes(typed)`
  // died with the matcher — the last surface deciding tag membership by
  // substring.
  // `commands/batch.ts` was here until #138. `parseFilterExpression` was
  // deleted, not repaired — `batch move` and `batch assign` were moved onto
  // `applyFilters` — and #110 then deleted the whole file. The
  // `cards update --board --label` path in `cli.ts` that shared its
  // `buildFilterFn` went with it: that spelling is a refusal now, pointing at
  // `--from-csv`, so the CLI holds no derived write set at all. It had closed
  // the worse half first — in an org holding both `bug` and `debug`,
  // `cards update --board <b> --label bug` used to WRITE to the `debug` cards.
};

/** Every production file whose source still matches element-wise. */
function substringMatchers(): string[] {
  return productionSources().filter((rel) =>
    SUBSTRING_OVER_VOCABULARY.test(fs.readFileSync(path.join(SRC, rel), 'utf8'))
  );
}

describe('tag and assignee membership is exact, everywhere', () => {
  test('no production module substring-matches a card tag or assignee', () => {
    const offenders = substringMatchers().filter((rel) => !(rel in SUBSTRING_DEBT));
    expect(offenders).toEqual([]);
  });

  test('every debt entry is still real, so a fixed one fails the build', () => {
    const stale = Object.keys(SUBSTRING_DEBT).filter(
      (rel) => !substringMatchers().includes(rel)
    );
    expect(stale).toEqual([]);
  });

  test('the flag row that #84 fixed is one of the files scanned, and is clean', () => {
    expect(productionSources()).toContain('cli.ts');
    expect(substringMatchers()).not.toContain('cli.ts');
  });

  test('the scan catches the deleted shape, wrapped the way Prettier wrapped it', () => {
    // Verbatim from `86dbeb7:src/cli.ts`. A line-based span missed this, which
    // is why the span is `[^;]` — re-narrow it and this test goes red.
    const deleted = [
      'cardList = cardList.filter(c => (c.assignees ?? []).some(',
      '  a => a.toLowerCase().includes(options.assignee.toLowerCase())',
      '));',
    ].join('\n');
    expect(SUBSTRING_OVER_VOCABULARY.test(deleted)).toBe(true);

    // …without flagging exact membership, which is correct and common.
    expect(
      SUBSTRING_OVER_VOCABULARY.test('const add = tags.filter(t => !currentIds.includes(t));')
    ).toBe(false);
  });
});
