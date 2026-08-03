/**
 * What a write may CLAIM, against a real server.
 *
 * Three sites used to report a field they never observed, by substituting the
 * caller's own argument when the PUT response did not carry it back:
 *
 *   1. `widgets-api.ts` — `updated.widgetCommonId ?? boardId`, which laundered a
 *      silent response into `✓ Widget added to board`. This is #82's endpoint and
 *      #82's exact bug: the success line printed for a write that never landed.
 *   2. `custom-fields-api.ts` — a read-back that FAILED OPEN, degrading
 *      `displayValue` to the value the caller passed in.
 *   3. `cards-link.ts` — `✓ Card … moved to board ${options.toBoard}`, a pure
 *      argument echo with no observation behind it at all.
 *
 * None of the three grew a read-back, and deliberately. A read-back is only
 * legitimate against a **measured write-response echo**. The one this repo has is
 * `archived`, from #75's live probe (recorded on `UpdateCardRequest.archive`), and
 * it is what earns `TxCards.setArchived` its throw. `widgetCommonId`, `columnId`
 * and `customFields` are measured on **GET rows**
 * (`docs/research/tracker-contract-favro-carriers.md` §1.3/§3) — a read-side row
 * is not a write-side echo, and inferring one from the other is the step ADR-0003
 * refuses and the reason #101 was declined.
 *
 * ── Why a real server, and why the OMIT arm is the only one that matters ──
 *
 * A queued mock hands back the next canned response whatever was asked for, so it
 * cannot express "the response omitted this field" as distinct from "the response
 * carried it". But a hand-rolled HTTP stand is the same trap in a costume: if the
 * stand answers every PUT with a body WE wrote to contain the field, then a
 * read-back tested against it verifies our own assumption against itself and can
 * never fail. #101's triage caught precisely that in `dispatch-tx-wire.test.ts`.
 *
 * So the stand's PUT echo is a test PARAMETER, and every site is driven through
 * all three settings:
 *
 *   `full`      — the response carries the field. The confirmed path.
 *   `omit`      — the response carries no such field. **The arm with teeth**: it
 *                 is the one that fails if the argument is substituted back in.
 *   `different` — the response carries a field with a value we did NOT request.
 *                 Pins that what is reported is the OBSERVATION, not the request;
 *                 `omit` alone cannot catch a fix that echoes the argument
 *                 whenever the server happens to send something.
 */
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import WidgetsAPI from '../lib/widgets-api';
import CardsAPI from '../lib/cards-api';
import CustomFieldsAPI from '../lib/custom-fields-api';

const ORG = 'org-1';

const BOARD_ID = 'w-target-0001';
const OTHER_BOARD_ID = 'w-elsewhere-9999';
const CARD_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const CARD_COMMON_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const FIELD_ID = 'cf-text-0001';

/** How the stand answers a `PUT /cards/:cardId`. */
type Echo = 'full' | 'omit' | 'different';

interface Received {
  method: string;
  url: string;
  body: string;
}

/** Every server this file started, so a failed assertion cannot leak one. */
const running: http.Server[] = [];

/**
 * A Favro stand-in whose PUT response shape is chosen by the test.
 *
 * The GET paths always answer fully — they are the measured side, and a test
 * about write echoes must not accidentally be a test about a broken read.
 */
function startServer(echo: Echo): Promise<{ client: FavroHttpClient; received: Received[] }> {
  const received: Received[] = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const url = req.url ?? '';
      const method = req.method ?? '';
      received.push({ method, url, body });

      const send = (payload: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      // ── The write under test ──────────────────────────────────────────────
      if (method === 'PUT' && url.startsWith('/api/v1/cards/')) {
        // Always a 200 and always a card-shaped body: the hazard being tested is
        // a MISSING FIELD on an accepted write, not an HTTP error. An error would
        // be caught by any of the paths already covered elsewhere.
        const base: Record<string, unknown> = {
          cardId: CARD_ID,
          cardCommonId: CARD_COMMON_ID,
          name: 'A card',
        };
        if (echo === 'full') {
          send({
            ...base,
            widgetCommonId: BOARD_ID,
            customFields: [{ customFieldId: FIELD_ID, value: 'observed-value' }],
          });
          return;
        }
        if (echo === 'different') {
          // The server reports a board and a value we never asked for. Favro
          // doing this would be a genuine surprise; the point is that whatever it
          // says is what gets reported, and the argument never overwrites it.
          send({
            ...base,
            widgetCommonId: OTHER_BOARD_ID,
            customFields: [{ customFieldId: FIELD_ID, value: 'something-else' }],
          });
          return;
        }
        // `omit`: accepted, card-shaped, and silent about both fields.
        send(base);
        return;
      }

      // ── Reads, all fully populated ────────────────────────────────────────
      if (url.startsWith(`/api/v1/customfields/${FIELD_ID}`)) {
        send({ customFieldId: FIELD_ID, name: 'Notes', type: 'Text', enabled: true });
        return;
      }
      if (url.startsWith('/api/v1/widgets')) {
        send({ entities: [{ widgetCommonId: BOARD_ID, name: 'Target Board', columns: [] }] });
        return;
      }
      if (url.startsWith('/api/v1/cards/')) {
        send({ cardId: CARD_ID, cardCommonId: CARD_COMMON_ID, name: 'A card', widgetCommonId: BOARD_ID });
        return;
      }
      if (url.startsWith('/api/v1/cards')) {
        send({
          entities: [
            { cardId: CARD_ID, cardCommonId: CARD_COMMON_ID, name: 'A card', widgetCommonId: BOARD_ID },
          ],
        });
        return;
      }
      send({ entities: [] });
    });
  });
  running.push(server);

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        client: new FavroHttpClient({
          baseURL: `http://127.0.0.1:${port}/api/v1`,
          auth: { organizationId: ORG },
        }),
        received,
      });
    });
  });
}

const originalConfigDir = process.env.FAVRO_CONFIG_DIR;
let tmpDir: string;

beforeEach(async () => {
  // The name cache is a real file — give each test its own, so a run never reads
  // or clobbers the developer's own ~/.favro cache.
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'favro-write-echo-test-'));
  process.env.FAVRO_CONFIG_DIR = tmpDir;
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => new Promise((done) => s.close(() => done(null)))));
  if (originalConfigDir === undefined) delete process.env.FAVRO_CONFIG_DIR;
  else process.env.FAVRO_CONFIG_DIR = originalConfigDir;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Proof the stand is actually varying, so the `omit` arms are not vacuous. */
describe('the stand itself', () => {
  it.each([
    ['full', true],
    ['omit', false],
    ['different', true],
  ] as Array<[Echo, boolean]>)('PUT under echo=%s carries widgetCommonId: %s', async (echo, present) => {
    const { client } = await startServer(echo);
    const put = await client.put<Record<string, unknown>>(`/cards/${CARD_ID}`, {});
    expect('widgetCommonId' in put).toBe(present);
    expect('customFields' in put).toBe(present);
  });
});

// ── Site 1: widgets add ─────────────────────────────────────────────────────

describe('addWidgetToBoard reports the board it OBSERVED (#82)', () => {
  it('echoed → the observed widgetCommonId comes back', async () => {
    const { client } = await startServer('full');
    const committed = await new WidgetsAPI(client).addWidgetToBoard(BOARD_ID, CARD_COMMON_ID);
    expect(committed.widgetCommonId).toBe(BOARD_ID);
  });

  /**
   * THE test. `?? boardId` made this arm indistinguishable from the one above:
   * the response said nothing, and the caller was handed the board it had asked
   * for, which then printed as `✓ Widget added to board (w-target-0001)`.
   */
  it('omitted → the field is ABSENT, never backfilled from the argument', async () => {
    const { client } = await startServer('omit');
    const committed = await new WidgetsAPI(client).addWidgetToBoard(BOARD_ID, CARD_COMMON_ID);
    expect(committed.widgetCommonId).toBeUndefined();
    // Named explicitly: the requested board must not reappear as an observation.
    expect(committed.widgetCommonId).not.toBe(BOARD_ID);
  });

  it('a different board echoed → the SERVER wins, not the request', async () => {
    const { client } = await startServer('different');
    const committed = await new WidgetsAPI(client).addWidgetToBoard(BOARD_ID, CARD_COMMON_ID);
    expect(committed.widgetCommonId).toBe(OTHER_BOARD_ID);
  });

  /**
   * The fields that legitimately DO fall back, so the fix is not over-read as
   * "never substitute anything". These degrade to values read from the preceding
   * `GET /cards`, which is an observation; `boardId` is an argument, and that is
   * the whole difference.
   */
  it('name and cardId still fall back to the GET row, which is observed', async () => {
    const { client } = await startServer('omit');
    const committed = await new WidgetsAPI(client).addWidgetToBoard(BOARD_ID, CARD_COMMON_ID);
    expect(committed.cardId).toBe(CARD_ID);
    expect(committed.name).toBe('A card');
  });
});

// ── Site 2: custom-fields set ───────────────────────────────────────────────

describe('setFieldValue does not fail open onto its own argument', () => {
  it('echoed → the observed value, marked confirmed', async () => {
    const { client } = await startServer('full');
    const result = await new CustomFieldsAPI(client).setFieldValue(CARD_ID, FIELD_ID, 'sent-value');
    expect(result.confirmed).toBe(true);
    expect(result.value).toBe('observed-value');
  });

  /**
   * THE test. The old code returned `{ value: 'sent-value', displayValue:
   * 'sent-value' }` here — byte-identical in shape to a confirmed write, and the
   * command printed `✓ Custom field updated successfully. Value: sent-value`.
   */
  it('omitted → confirmed:false and NO value, not the argument echoed back', async () => {
    const { client } = await startServer('omit');
    const result = await new CustomFieldsAPI(client).setFieldValue(CARD_ID, FIELD_ID, 'sent-value');
    expect(result.confirmed).toBe(false);
    expect(result.value).toBeNull();
    expect(result.displayValue).toBeUndefined();
    // The specific regression: the argument must not come back as an observation.
    expect(result.value).not.toBe('sent-value');
    expect(result.displayValue).not.toBe('sent-value');
  });

  it('a different value echoed → reported as stored, not as sent', async () => {
    const { client } = await startServer('different');
    const result = await new CustomFieldsAPI(client).setFieldValue(CARD_ID, FIELD_ID, 'sent-value');
    expect(result.confirmed).toBe(true);
    expect(result.value).toBe('something-else');
  });

  /**
   * It must NOT throw. Throwing on an unmeasured echo is #101's regression: it
   * takes out a working command to defend a hazard with no observed instance.
   * `setArchived` may throw because #75 measured that echo; nothing measured this
   * one.
   */
  it('an omitted echo is reported, not thrown — the echo is unmeasured', async () => {
    const { client } = await startServer('omit');
    await expect(
      new CustomFieldsAPI(client).setFieldValue(CARD_ID, FIELD_ID, 'sent-value'),
    ).resolves.toMatchObject({ confirmed: false });
  });
});

// ── Site 3: cards move ──────────────────────────────────────────────────────

describe('moveCard has no observation to report, and does not invent one', () => {
  /**
   * Documents why the Site 3 fix is to the MESSAGE and not to a read-back, with
   * the reason a guard here would be doubly wrong: `moveCard` returns the PUT
   * body RAW, with no `normalizeCard`, and `Card.boardId` is `normalizeCard`'s
   * derivation from `widgetCommonId`. So `moved.boardId` is `undefined` even on
   * the arm where the server DID echo the board — a guard written against it
   * would throw on every move while looking like it had caught something.
   */
  it('boardId is undefined even when the server echoes widgetCommonId', async () => {
    const { client } = await startServer('full');
    const moved = await new CardsAPI(client).moveCard(CARD_ID, { toBoardId: BOARD_ID });
    expect(moved.widgetCommonId).toBe(BOARD_ID);
    expect(moved.boardId).toBeUndefined();
  });

  it('and undefined when it echoes nothing — the two are indistinguishable here', async () => {
    const { client } = await startServer('omit');
    const moved = await new CardsAPI(client).moveCard(CARD_ID, { toBoardId: BOARD_ID });
    expect(moved.widgetCommonId).toBeUndefined();
    expect(moved.boardId).toBeUndefined();
  });

  /** The write still goes out correctly — the honesty fix changed no request. */
  it('sends the RESOLVED board on the wire', async () => {
    const { client, received } = await startServer('omit');
    await new CardsAPI(client).moveCard(CARD_ID, { toBoardId: BOARD_ID });
    const put = received.find((r) => r.method === 'PUT');
    expect(JSON.parse(put?.body ?? '{}')).toMatchObject({ widgetCommonId: BOARD_ID });
  });
});
