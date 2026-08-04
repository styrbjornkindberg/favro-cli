/**
 * `favro query` runs the ONE grammar, and fails closed (#95).
 *
 * WHAT THIS REPLACED
 * This file used to be ~120 tests of `parseQueryFilter` / `matchCard` /
 * `explainNoResults` — the second, regex-based parser. Every one of them passed,
 * and the thing they pinned was the defect: `parseQueryFilter('statuz:done')`
 * returned `{ text: 'statuz:done' }`, a title search, and `favro query <board>
 * "statuz:done"` answered a confident zero rows with a paragraph explaining why.
 * A test that pins a plausible wrong answer is worse than no test, so they are
 * gone with the parser and what is pinned here is the refusal.
 *
 * NOTHING IS MOCKED BUT THE WIRE
 * One fake `get` serves the routes these paths make, and throws on anything
 * else. `BoardsAPI`, `CardsAPI`, `ColumnDirectory`, `cachedTags` and
 * `resolveAssignee` are all the real thing, so the value-settling this file's
 * headline depends on is actually running. A class mock in its place would let
 * `resolveQuery` be skipped entirely and every arm below would still be green.
 *
 * THE CARD STAND DISCRIMINATES ON EACH CONJUNCT SEPARATELY
 * `status:done AND tag:bug` is run against a board holding a card that satisfies
 * BOTH, one that satisfies only the status, one that satisfies only the tag, and
 * one that satisfies neither and carries neither field at all. Deleting either
 * conjunct from the query admits a different, named card — which is what makes
 * the assertion sensitive to each half rather than to the pair.
 */
import { ParseError, knownFields } from '../../lib/query-parser';
import { QueryAPI, buildSummary } from '../../api/query';
import type { Card } from '../../lib/cards-api';
import type { ContextCard } from '../../api/context';
import {
  STUB_BOARD,
  STUB_TAGS,
  STUB_USER_IDS,
  stubVocabularyClient,
  useTempConfigDir,
} from '../../test-support/filter-vocabulary';

useTempConfigDir();

// ─── the board ───────────────────────────────────────────────────────────────

/**
 * Four cards, chosen so that no single predicate in `status:done AND tag:bug`
 * can carry the answer on its own.
 *
 * `tags` and `status` are set directly while `tagIds`/`columnId` are absent on
 * purpose: `CardsAPI.listCards` hydrates those two fields from the column and
 * tag directories when the ids are present, and a stand that went through the
 * hydration would be asserting the hydration rather than the filter.
 */
const card = (fields: Partial<Card> & Pick<Card, 'cardId' | 'name'>): Card =>
  ({ createdAt: '2026-01-01T00:00:00Z', ...fields }) as Card;

const CARDS: Card[] = [
  card({ cardId: 'c-both', name: 'Fix login', status: 'done', tags: ['bug'], assignees: ['alice@example.com'] }),
  card({ cardId: 'c-status-only', name: 'Ship docs', status: 'done', tags: ['docs'], assignees: ['bob@example.com'] }),
  card({ cardId: 'c-tag-only', name: 'Triage crash', status: 'todo', tags: ['bug'], assignees: [] }),
  // Carries NEITHER field — the omit arm. An absent value must fail a predicate,
  // never pass it.
  card({ cardId: 'c-bare', name: 'Nothing set' }),
];

/**
 * The wire. A handful of routes and a throw, so an arm cannot pass because the
 * stand answered a call it was never meant to receive.
 *
 * `served` records the paths, which is how the "a refusal costs no card read"
 * arm is checked — and that arm carries a POSITIVE control, because
 * `not.toContain` alone would pass against a probe that records nothing at all.
 */
function makeWire(opts: { opaqueIds?: boolean; cardsFail?: string } = {}) {
  const vocabulary = stubVocabularyClient({ opaqueIds: opts.opaqueIds });
  const served: string[] = [];
  const get = async (url: string, config?: any) => {
    served.push(url);
    if (url === `/widgets/${STUB_BOARD}`) {
      return { widgetCommonId: STUB_BOARD, name: 'Stub', type: 'board' };
    }
    if (url === '/cards') {
      if (opts.cardsFail) throw new Error(opts.cardsFail);
      return { entities: CARDS };
    }
    return vocabulary.get(url, config);
  };
  return { client: { get, organizationId: 'org-stub' } as any, served };
}

const idsOf = (matches: ContextCard[]) => matches.map((c) => c.id).sort();

/** Run something that must refuse, and hand back the refusal. */
async function refusalFrom(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a refusal, got an answer');
}

// ─────────────────────────────────────────────────────────────────────────────

describe('favro query refuses what the deleted parser used to answer', () => {
  /**
   * The inputs the old parser INVENTED a meaning for. Each one answered a
   * plausible zero rows; each one now names the token it refused.
   *
   * `knownFields()` builds the candidate list rather than a pasted literal:
   * pasting it would pin today's field set, and the set is DERIVED on purpose
   * (#46) — a legitimately added field would fail this arm and the cheapest fix
   * for that red is to edit the literal, which teaches that these strings are
   * decoration. The PROSE either side of it is asserted verbatim.
   */
  const KNOWN = [...knownFields()].sort().join(', ');
  const unknownField = (field: string, pos: number) =>
    `Unknown filter field '${field}' at position ${pos} — refusing to run a query that cannot mean what you asked. ` +
    `Known fields: ${KNOWN}.`;

  const INVENTED: Array<[input: string, message: string]> = [
    // The ticket's headline: a typo'd field name.
    ['statuz:done', unknownField('statuz', 0)],
    // `priority:` was never a Favro field — the old parser read a custom field
    // called Priority or Urgency and called it a grammar keyword.
    ['priority:high', unknownField('priority', 0)],
    // `due:` is not the date field. `due_date:` is.
    ['due:overdue', unknownField('due', 0)],
    // `assigned:`/`owner:` were aliases the old parser minted for `assignee:`.
    ['assigned:@alice', unknownField('assigned', 0)],
    ['owner:bob', unknownField('owner', 0)],
  ];

  it.each(INVENTED)('%s refuses instead of answering zero rows', async (input, message) => {
    const { client } = makeWire();
    const error = await refusalFrom(() => new QueryAPI(client).execute(STUB_BOARD, input));

    // `instanceof` AND `.name`: `toThrow(ParseError)` matches by constructor name
    // up the chain, so a renamed bare `Error` satisfies it.
    expect(error).toBeInstanceOf(ParseError);
    expect(error.name).toBe('ParseError');
    expect(error.message).toBe(message);
  });

  it('free text is title~"…" and nothing else — a bare word refuses and says so', async () => {
    const { client } = makeWire();
    const error = await refusalFrom(() =>
      new QueryAPI(client).execute(STUB_BOARD, 'authentication refactor'),
    );

    expect(error).toBeInstanceOf(ParseError);
    expect(error.name).toBe('ParseError');
    expect(error.message).toBe(
      `Unrecognised filter token 'authentication' at position 0 — it names no field and carries no operator. ` +
        `Filters are field:value (see 'favro cards list --help'). For free text, say it: title~"authentication".`,
    );
  });

  it('a tag outside the org refuses with the org’s real tags', async () => {
    const { client } = makeWire();
    const error = await refusalFrom(() => new QueryAPI(client).execute(STUB_BOARD, 'tag:typoo'));

    expect(error).toBeInstanceOf(ParseError);
    expect(error.name).toBe('ParseError');
    expect(error.message).toBe(
      `No tag matching "typoo" — it is missing or not visible to your key. ` +
        `Run 'favro tags list' to see them. The org's tags:\n` +
        [...STUB_TAGS].sort().map((n) => `  ${n}`).join('\n'),
    );
  });

  it('a column the board does not have refuses with that board’s columns', async () => {
    const { client } = makeWire();
    const error = await refusalFrom(() => new QueryAPI(client).execute(STUB_BOARD, 'status:nonesuch'));

    expect(error.name).toBe('ColumnResolutionError');
    expect(error.message).toBe(
      `No column named "nonesuch" on board ${STUB_BOARD} — it is missing or not visible to your key. ` +
        `That board's columns:\n  col-0  todo\n  col-1  in-progress\n  col-2  done`,
    );
  });

  it('an empty query refuses rather than widening to the whole board', async () => {
    const { client, served } = makeWire();
    const error = await refusalFrom(() => new QueryAPI(client).execute(STUB_BOARD, '   '));

    expect(error).toBeInstanceOf(ParseError);
    expect(error.name).toBe('ParseError');
    expect(error.message).toBe(
      `The query is empty — it narrows nothing, and ignoring it would answer the whole board. ` +
        `Pass a filter expression, or ask for the board: favro cards list <board>.`,
    );
    // Nothing at all was read: an empty query cannot be made to mean something
    // by anything on the wire.
    expect(served).toEqual([]);
  });

  it('unblocked is refused here and names the command that answers it', async () => {
    const { client } = makeWire();
    const error = await refusalFrom(() => new QueryAPI(client).execute(STUB_BOARD, 'unblocked'));

    expect(error).toBeInstanceOf(ParseError);
    expect(error.name).toBe('ParseError');
    expect(error.message).toBe(
      `"unblocked" is not available here: it has to judge each blocker, which takes ` +
        `reads this command does not make and cannot report on. ` +
        `Ask the frontier where it is answered: favro cards list ${STUB_BOARD} --filter "unblocked"`,
    );
  });

  it('the unblocked remedy quotes a board NAME, so it can be pasted back', async () => {
    // #126's class: a refusal whose remedy cannot be run. `favro cards list
    // Sprint 42 --filter …` reads as two positionals and answers about a board
    // nobody asked for. `board-stub` above is id-shaped and needs no quotes,
    // which is why the unquoted case cannot prove this one.
    const board = { widgetCommonId: STUB_BOARD, name: 'Sprint 42', type: 'board' };
    const named = {
      organizationId: 'org-stub',
      get: async (url: string) => {
        // A name carries a space, so `getBoard` resolves it off the LIST first
        // and then reads the board by id.
        if (url === '/widgets') return { entities: [board] };
        if (url === `/widgets/${STUB_BOARD}`) return board;
        throw new Error(`unexpected GET ${url}`);
      },
    } as any;

    const error = await refusalFrom(() => new QueryAPI(named).execute('Sprint 42', 'unblocked'));
    expect(error.message).toContain('favro cards list "Sprint 42" --filter "unblocked"');
  });

  it('a refusal never pages the board — and the positive control proves the probe', async () => {
    const refused = makeWire();
    await refusalFrom(() => new QueryAPI(refused.client).execute(STUB_BOARD, 'statuz:done'));
    expect(refused.served).not.toContain('/cards');

    const answered = makeWire();
    await new QueryAPI(answered.client).execute(STUB_BOARD, 'status:done');
    expect(answered.served).toContain('/cards');
  });
});

describe('favro query answers the grammar it accepts', () => {
  it('AND is sensitive to each conjunct on its own', async () => {
    const { client } = makeWire();
    const api = new QueryAPI(client);

    // Both conjuncts: only the card satisfying both survives.
    expect(idsOf((await api.execute(STUB_BOARD, 'status:done AND tag:bug')).matches)).toEqual(['c-both']);

    // Drop `tag:bug` — the status-only card is admitted. Drop `status:done` —
    // the tag-only card is. Neither is reachable by the pair, so the assertion
    // above cannot pass on half the query.
    expect(idsOf((await api.execute(STUB_BOARD, 'status:done')).matches)).toEqual(['c-both', 'c-status-only']);
    expect(idsOf((await api.execute(STUB_BOARD, 'tag:bug')).matches)).toEqual(['c-both', 'c-tag-only']);
  });

  it('OR widens to the union, and never to everything', async () => {
    const { client } = makeWire();
    const matches = (await new QueryAPI(client).execute(STUB_BOARD, 'status:done OR tag:bug')).matches;

    expect(idsOf(matches)).toEqual(['c-both', 'c-status-only', 'c-tag-only']);
    // The omit arm: a card carrying neither field is not swept in by a union.
    expect(idsOf(matches)).not.toContain('c-bare');
  });

  it('a card missing the field fails the predicate — absence is not a match', async () => {
    const { client } = makeWire();
    // `c-bare` has no `status` and no `tags` at all.
    expect(idsOf((await new QueryAPI(client).execute(STUB_BOARD, 'status:todo')).matches)).toEqual(['c-tag-only']);
  });

  it('title~"…" is the one spelling of free text, and it works', async () => {
    const { client } = makeWire();
    expect(idsOf((await new QueryAPI(client).execute(STUB_BOARD, 'title~"login"')).matches)).toEqual(['c-both']);
  });

  it('the applied filter carries values SETTLED against Favro, not as typed', async () => {
    // Opaque ids share no substring with the typed name, so this arm is only
    // green if `resolveAssignee` actually ran — with `userId === email` a raw
    // substring match would answer identically and prove nothing (#84).
    const { client } = makeWire({ opaqueIds: true });
    const result = await new QueryAPI(client).execute(STUB_BOARD, 'assignee:alice');

    expect(result.filter.raw).toBe('assignee:alice');
    expect(result.filter.ast).toEqual({
      kind: 'field',
      field: 'assignee',
      operator: '=',
      value: STUB_USER_IDS.alice,
    });
    // …and the cards, which carry emails, therefore match nothing. An answer
    // here would mean the typed name had ridden through unresolved.
    expect(result.matches).toEqual([]);
  });

  it('matches are ContextCards — no `card` wrapper, no per-row matchReason', async () => {
    const { client } = makeWire();
    const [card] = (await new QueryAPI(client).execute(STUB_BOARD, 'title~"login"')).matches;

    expect(card.id).toBe('c-both');
    expect(card.title).toBe('Fix login');
    expect(card.status).toBe('done');
    // The two fields `QueryMatch` used to add. Their absence is the shape change.
    expect(Object.keys(card)).not.toContain('card');
    expect(Object.keys(card)).not.toContain('matchReason');
  });

  it('total counts every card searched, not the matches', async () => {
    const { client } = makeWire();
    const result = await new QueryAPI(client).execute(STUB_BOARD, 'title~"login"');

    expect(result.matches).toHaveLength(1);
    expect(result.total).toBe(CARDS.length);
  });

  it('a board that reads clean carries NO unreachable key at all', async () => {
    const { client } = makeWire();
    const result = await new QueryAPI(client).execute(STUB_BOARD, 'status:done');

    // `unreachable: []` would read as a hole to any truthiness check (#86).
    expect('unreachable' in result).toBe(false);
    expect(JSON.stringify(result)).not.toContain('unreachable');
  });

  it('a dead card read is a HOLE, never an empty board', async () => {
    const { client } = makeWire({ cardsFail: 'Request timed out' });
    const result = await new QueryAPI(client).execute(STUB_BOARD, 'status:done');

    expect(result.matches).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.unreachable).toEqual([{ id: 'cards', reason: 'Request timed out' }]);
    // ADR-0002: a successful command never prints nothing.
    expect(result.summary).not.toBe('');
  });
});

describe('buildSummary', () => {
  const cards = (n: number): ContextCard[] =>
    Array.from({ length: n }, (_, i) => ({ id: `c-${i}`, title: `Card ${i + 1}` }));

  it('says the empty answer is empty, and how much was searched', () => {
    expect(buildSummary([], 'Sprint 42', 'status:done', 12)).toBe(
      `No cards on board "Sprint 42" match 'status:done' — searched 12 card(s).`,
    );
  });

  it('a single match is a card, not cards', () => {
    expect(buildSummary(cards(1), 'Sprint 42', 'x', 3)).toBe('Found 1 matching card: "Card 1"');
  });

  it('five or fewer lists every title', () => {
    expect(buildSummary(cards(5), 'Sprint 42', 'x', 9)).toBe(
      'Found 5 matching cards: "Card 1", "Card 2", "Card 3", "Card 4", "Card 5"',
    );
  });

  it('more than five lists three and counts the rest', () => {
    expect(buildSummary(cards(6), 'Sprint 42', 'x', 9)).toBe(
      'Found 6 matching cards: "Card 1", "Card 2", "Card 3", … and 3 more',
    );
  });
});
