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
 * TWO ARMS
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
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { ParseError } from '../lib/query-parser';
import { resolveQuery } from '../lib/query-values';
import { applyFilters } from '../commands/cards-export';
import { Card } from '../lib/cards-api';

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

// ─── arm three: nobody substring-matches a card's tags or assignees ──────────

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
 * ponytail: line-based. A match split across lines would slip past. It has
 * never been written that way here; move to the TypeScript AST, as
 * `scope-lock-coverage.test.ts` does, if one ever is.
 */
const SUBSTRING_OVER_VOCABULARY =
  /\b(?:tags|assignees)\b[^\n]*\.(?:some|find|filter|every)\([^\n]*\.includes\(\s*(?!['"`])/;

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
    '#138 — `parseFilterExpression`, a third `--filter` grammar on a WRITE command',
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
});
