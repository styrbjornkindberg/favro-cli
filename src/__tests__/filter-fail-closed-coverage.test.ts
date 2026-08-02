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
import { applyFilters } from '../commands/cards-export';
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
    if (url === '/users') return { entities: [] };
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
      detail: (e as ParseError).detail,
    };
  }
}

/**
 * Every shape of bad input the two commands must agree about, with the token
 * the refusal has to name — "Error" is not a refusal.
 */
const BAD_INPUTS: Array<[label: string, filter: string, unresolvable: string, kind: string]> = [
  ['an unknown field', 'bogusfield:x', 'bogusfield', 'unknown-field'],
  ['an unknown bare token', 'typoo', 'typoo', 'unknown-token'],
  ['an unknown tag value', 'tag:typoo', 'typoo', 'unknown-value'],
  ['an unknown status value', 'status:Shipped', 'Shipped', 'unknown-value'],
];

describe('cards list and cards export refuse the same filter identically', () => {
  test.each(BAD_INPUTS)('%s', async (_label, filter, unresolvable, kind) => {
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

    // A refusal names the token it could not resolve. `status:` is settled by
    // ColumnDirectory, which raises its own class, so the KIND is only asserted
    // where the parse protocol owns the refusal.
    expect(list.message).toContain(unresolvable);
    if (list.name === 'ParseError') expect(list.detail?.kind).toBe(kind);
  });

  test('a filter the vocabulary accepts still exports its rows', async () => {
    const rows = await applyFilters(CARDS, ['tag:bug'], {
      client: makeClient(),
      boardId: BOARD,
    });
    expect(rows.map((c) => c.cardId)).toEqual(['c1']);
  });

  test('a refusal names candidates, so the user can act on it', async () => {
    const refusal = await refusalFrom(() =>
      applyFilters(CARDS, ['tag:typoo'], { client: makeClient(), boardId: BOARD })
    );
    expect(refusal.refused).toBe(true);
    if (!refusal.refused) return;
    expect(refusal.detail?.candidates).toEqual(['backend', 'bug']);
    expect(refusal.message).toContain('bug');
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
    expect(sources).toContain(path.join('commands', 'cards-export.ts'));
    expect(sources).toContain('cli.ts');
    expect(sources.some((f) => f.includes('__tests__'))).toBe(false);
  });
});

// ─── arm three: the command a user actually types ────────────────────────────

/**
 * Arms one and two never reach a command. `commands/cards-export.ts` exports a
 * `registerCardsExportCommand` that nothing but its own tests registers — the
 * live `cards export` is inline in `cli.ts` — so the export suite can be fully
 * green while the live path answers a plausible zero rows. This arm drives
 * `buildProgram()`, the program `bin/favro` builds.
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
    let code: number | undefined;
    const exit = jest.spyOn(process, 'exit').mockImplementation(((c?: number) => {
      code = c;
      throw new Error('process.exit');
    }) as never);
    const said = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      buildProgram().parseAsync([
        'node', 'favro', 'cards', 'export', BOARD,
        '--filter', 'tag:typoo',
        '--out', out,
      ])
    ).rejects.toThrow('process.exit');

    const printed = said.mock.calls.map((c) => String(c[0])).join('\n');
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
  [path.join('api', 'query.ts')]:
    '#95 — the second, regex-based grammar behind `favro query`; re-pointed or deleted there',
  [path.join('commands', 'batch.ts')]:
    '#138 — `parseFilterExpression`, a third `--filter` grammar on a WRITE command. ' +
    'Its worst caller is not the one #138 names: `cards update --board <b> --label bug ' +
    '--status done` (cli.ts, `filterExprs.push(`tag:${options.label}`)`) routes through ' +
    'the same `buildFilterFn`, so in an org holding both `bug` and `debug` that command ' +
    'WRITES to the `debug` cards too. Batch move/assign is the same grammar, lower stakes.',
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
