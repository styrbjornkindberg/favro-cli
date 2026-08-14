/**
 * `customField:` filters, end to end: `GET /cards` → `normalizeCard` →
 * `filterCards` — issue #167 item 3.
 *
 * No client mock, and the fixture is the LIVE page: board
 * `5dd75f0d5116020817ebe70a` on 2026-08-14, whose cards each carry
 * `customFields: [{customFieldId: "zxMLxD4zx4tSwJr75", value: ["YLanLiuXKA8JpvEsX"]}]`
 * — the board's `Status` field, holding the option whose LABEL is `Todo`. That
 * page is the whole argument: there is no `name` key on the entry to match
 * `customField:Status=…` by, and the stored value is the option's id, not its
 * label.
 *
 * The old arms for this predicate fed `filterCards` a hand-written
 * `[{name: 'Priority', value: 'High'}]`, a shape Favro has never sent, and were
 * green while the live command answered `matches: []` for three cards that all
 * matched. That is the same failure `blocked-by:` had (#162): the test encoded
 * the CLI's wrong model of the payload, so only a real request could separate
 * them.
 *
 * Polarity is paired: the refusal arms are only meaningful next to a filter that
 * DOES match this same card and one that genuinely does not — otherwise they
 * would pass just as happily against a fixture nothing can read.
 */
import * as http from 'http';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import CardsAPI from '../lib/cards-api';
import { filterCards, parseQuery, ParseError } from '../lib/query-parser';

const BOARD = '5dd75f0d5116020817ebe70a';
const STATUS_FIELD = 'zxMLxD4zx4tSwJr75';
const TODO_OPTION = 'YLanLiuXKA8JpvEsX';

/** The live page, two cards, both holding `Status` = the `Todo` option id. */
const FIXTURE_PAGE = [
  {
    cardId: '19b306ba979af84019ba1819',
    cardCommonId: 'b9e653db17ed594a4456a2f7',
    name: 'probe: #58 dependency 404',
    widgetCommonId: BOARD,
    columnId: 'b2cddf969e31126a57d1568e',
    customFields: [{ customFieldId: STATUS_FIELD, value: [TODO_OPTION] }],
  },
  {
    cardId: 'efa36fa10e57e2e3e6f40641',
    cardCommonId: '2840638aa2124fd4b4f4a6c1',
    name: 'probe: blocker',
    widgetCommonId: BOARD,
    columnId: 'b2cddf969e31126a57d1568e',
    customFields: [{ customFieldId: STATUS_FIELD, value: [TODO_OPTION] }],
  },
];

function startServer(): Promise<{ api: CardsAPI; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(
      (req.url ?? '').startsWith('/api/v1/widgets')
        ? { entities: [{ widgetCommonId: BOARD, name: 'Kanban' }] }
        : { entities: FIXTURE_PAGE },
    ));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const client = new FavroHttpClient({ baseURL: `http://127.0.0.1:${port}/api/v1` });
      resolve({
        api: new CardsAPI(client),
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** Fetch the fixture board the way `cards list` does, then filter it. */
async function listAndFilter(filter: string): Promise<string[]> {
  const { api, close } = await startServer();
  try {
    const cards = await api.listCards({ boardId: BOARD });
    return filterCards(parseQuery(filter), cards).map((c) => c.name ?? '');
  } finally {
    await close();
  }
}

describe('customField: over cards that came through normalizeCard (#167)', () => {
  test('the normalised card carries the wire\'s own custom field shape — no name, an option id', async () => {
    const { api, close } = await startServer();
    try {
      const [first] = await api.listCards({ boardId: BOARD });

      expect(first.customFields).toEqual([{ customFieldId: STATUS_FIELD, value: [TODO_OPTION] }]);
      // The two keys the old predicate needed, and neither is here.
      expect(first.customFields?.[0]).not.toHaveProperty('name');
      expect(first.customFields?.[0].value).not.toContain('Todo');
    } finally {
      await close();
    }
  });

  // The polarity the refusal arms are measured against: this page IS filterable,
  // and an unrelated filter over it IS empty. Without these two, "customField:
  // does not return rows" would be indistinguishable from a broken fixture.
  test('a filter this payload can answer matches both cards', async () => {
    expect((await listAndFilter('name~probe')).sort()).toEqual([
      'probe: #58 dependency 404', 'probe: blocker',
    ]);
  });

  test('a genuinely unrelated filter over the same page is empty', async () => {
    expect(await listAndFilter('name~nothing-by-this-name')).toEqual([]);
  });

  test.each([
    // The live invocation from the issue: three cards all set to Todo, zero matches.
    'customField:Status=Todo',
    // The id spellings do not sneak past either — the refusal is the field, not the value.
    `customField:Status=${TODO_OPTION}`,
    `customField:${STATUS_FIELD}=${TODO_OPTION}`,
    'customField:Score>50',
    'name~probe AND customField:Status=Todo',
  ])('%s is refused, not answered with an empty result', async (filter) => {
    await expect(listAndFilter(filter)).rejects.toThrow(ParseError);
    await expect(listAndFilter(filter)).rejects.toThrow(/'customField' filters are refused/);
  });
});
