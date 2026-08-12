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
 *      argument echo, while the same PUT's echo went unread because `moveCard`
 *      returned its body raw and `Card.boardId` is `normalizeCard`'s derivation
 *      from `widgetCommonId`.
 *
 * None of the three grew a THROW, and deliberately. A throw against a write
 * RESPONSE is only legitimate against a **measured write-response echo**. The one
 * this repo has is `archived`, from #75's live probe (recorded on
 * `UpdateCardRequest.archive`), and it is what earns `TxCards.setArchived` its
 * throw. `widgetCommonId`, `columnId` and `customFields` are measured on **GET
 * rows** (`docs/research/tracker-contract-favro-carriers.md` §1.3/§3) — a
 * read-side row is not a write-side echo, and inferring one from the other is the
 * step ADR-0003 refuses.
 *
 * That is a rule about the echo, not a ban on confirming a write. #101 closed by
 * READING THE CARD BACK: `TxCards.moveColumn` throws on a mismatch, and the value
 * it compares comes from a fresh `GET /cards/{cardId}` — the measured surface —
 * never from the PUT. The three sites here could each buy a throw the same way,
 * at one extra GET; none does, because reporting the hole is enough for them and
 * an unread echo is not a hazard the way an unverified column move was.
 *
 * What all three DO is report the echo when it is there and report a hole when it
 * is not. Sites 1 and 3 are the same call on the same field, so they read the
 * same echo; nothing about that requires a new measurement, only that an absent
 * echo never becomes a ✓ and never exits 0.
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
 *   `blank`     — the response carries the field with `null` / `''`. Present but
 *                 empty is neither `full` nor `omit`, and it must not launder
 *                 into a confirmation.
 *   `foreign`   — the response carries a `customFields` entry for a DIFFERENT
 *                 field id, alongside ours. Without this arm the `customFieldId`
 *                 match is untested: a one-element array containing exactly the
 *                 field under test passes whether the code filters on the id or
 *                 just takes `[0]`, which would confirm this write with another
 *                 field's value.
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
const OTHER_FIELD_ID = 'cf-text-9999';

/** How the stand answers a `PUT /cards/:cardId`. */
type Echo = 'full' | 'omit' | 'different' | 'blank' | 'foreign';

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
        if (echo === 'blank') {
          // Present, and empty. `null` for the board, `null` for the value: the
          // server said the field exists and holds nothing, which is not the
          // same statement as "the card is on the board you asked for".
          send({
            ...base,
            widgetCommonId: null,
            customFields: [{ customFieldId: FIELD_ID, value: null }],
          });
          return;
        }
        if (echo === 'foreign') {
          // A real card's `customFields` carries EVERY field on the card. Ours is
          // absent from this response; another one is not.
          send({
            ...base,
            widgetCommonId: BOARD_ID,
            customFields: [{ customFieldId: OTHER_FIELD_ID, value: 'someone-elses-value' }],
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
    ['blank', true],
    ['foreign', true],
  ] as Array<[Echo, boolean]>)('PUT under echo=%s carries widgetCommonId: %s', async (echo, present) => {
    const { client } = await startServer(echo);
    const put = await client.put<Record<string, unknown>>(`/cards/${CARD_ID}`, {});
    expect('widgetCommonId' in put).toBe(present);
    expect('customFields' in put).toBe(present);
  });

  /** `blank` and `foreign` are PRESENT-but-useless, which is the point of them. */
  it('blank carries the keys with empty values', async () => {
    const { client } = await startServer('blank');
    const put = await client.put<any>(`/cards/${CARD_ID}`, {});
    expect(put.widgetCommonId).toBeNull();
    expect(put.customFields[0].value).toBeNull();
  });

  it('foreign carries a customFields entry for a different field', async () => {
    const { client } = await startServer('foreign');
    const put = await client.put<any>(`/cards/${CARD_ID}`, {});
    expect(put.customFields.map((f: any) => f.customFieldId)).not.toContain(FIELD_ID);
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

  /** A `null` echo is not an observation, and must not become the ✓ either. */
  it('a blank echo is falsy, so the caller cannot spend a ✓ on it', async () => {
    const { client } = await startServer('blank');
    const committed = await new WidgetsAPI(client).addWidgetToBoard(BOARD_ID, CARD_COMMON_ID);
    expect(committed.widgetCommonId).toBeFalsy();
    expect(committed.widgetCommonId).not.toBe(BOARD_ID);
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
   * The arm that pins the `customFieldId` match. A real `customFields` array
   * carries every field on the card, so "the response contained a value" and
   * "the response contained OUR field's value" are different claims. Without
   * this, dropping the id filter and taking `[0]` passes the whole suite — and
   * confirms this write with another field's value.
   */
  it('a foreign field echoed → unconfirmed, never that field\'s value', async () => {
    const { client } = await startServer('foreign');
    const result = await new CustomFieldsAPI(client).setFieldValue(CARD_ID, FIELD_ID, 'sent-value');
    expect(result.confirmed).toBe(false);
    expect(result.value).toBeNull();
    expect(result.displayValue).toBeUndefined();
  });

  /**
   * Present-but-`null` is reported unconfirmed. It errs toward the safe side —
   * the write may well have landed as a cleared value — but nothing here measured
   * whether Favro spells a cleared field `null`, an empty string, or an omission,
   * so it stays a hole rather than becoming a confirmation.
   */
  it('a blank echo is a hole, not a confirmation', async () => {
    const { client } = await startServer('blank');
    const result = await new CustomFieldsAPI(client).setFieldValue(CARD_ID, FIELD_ID, 'sent-value');
    expect(result.confirmed).toBe(false);
    expect(result.value).toBeNull();
  });

  /**
   * It must NOT throw. Throwing on an unmeasured ECHO is the shape #101's triage
   * declined: it takes out a working command to defend a hazard with no observed
   * instance. `setArchived` may throw because #75 measured that echo, and
   * `moveColumn` may throw because it re-reads the card instead of trusting one;
   * nothing measured this echo, and this site reads no card back.
   */
  it('an omitted echo is reported, not thrown — the echo is unmeasured', async () => {
    const { client } = await startServer('omit');
    await expect(
      new CustomFieldsAPI(client).setFieldValue(CARD_ID, FIELD_ID, 'sent-value'),
    ).resolves.toMatchObject({ confirmed: false });
  });
});

// ── Site 3: cards move ──────────────────────────────────────────────────────

describe('moveCard reports the board it OBSERVED', () => {
  /**
   * Same endpoint and same field as Site 1 — `PUT /cards/:cardId
   * {widgetCommonId}` — so the same echo is available, and the two commands must
   * not disagree about whether it counts as an observation.
   *
   * `boardId` is the field a `Card` consumer reads, and it only carries the echo
   * because the PUT body now goes through `normalizeCard`. Returned raw, as it
   * was, `boardId` was `undefined` on the arm where the server DID echo the
   * board: an echo and a silence were indistinguishable, and the command had
   * nothing to spend a ✓ on.
   */
  it('an echoed board reaches boardId, not just widgetCommonId', async () => {
    const { client } = await startServer('full');
    const moved = await new CardsAPI(client).moveCard(CARD_ID, { toBoardId: BOARD_ID });
    expect(moved.widgetCommonId).toBe(BOARD_ID);
    expect(moved.boardId).toBe(BOARD_ID);
  });

  /** THE arm with teeth: nothing echoed, nothing claimed, argument nowhere. */
  it('omitted → boardId is absent, never backfilled from the argument', async () => {
    const { client } = await startServer('omit');
    const moved = await new CardsAPI(client).moveCard(CARD_ID, { toBoardId: BOARD_ID });
    expect(moved.widgetCommonId).toBeUndefined();
    expect(moved.boardId).toBeUndefined();
  });

  it('a different board echoed → the SERVER wins, not the request', async () => {
    const { client } = await startServer('different');
    const moved = await new CardsAPI(client).moveCard(CARD_ID, { toBoardId: BOARD_ID });
    expect(moved.boardId).toBe(OTHER_BOARD_ID);
  });

  it('a blank echo is falsy, so the caller cannot spend a ✓ on it', async () => {
    const { client } = await startServer('blank');
    const moved = await new CardsAPI(client).moveCard(CARD_ID, { toBoardId: BOARD_ID });
    expect(moved.boardId).toBeFalsy();
    expect(moved.boardId).not.toBe(BOARD_ID);
  });

  /** The write still goes out correctly — the honesty fix changed no request. */
  it('sends the RESOLVED board on the wire', async () => {
    const { client, received } = await startServer('omit');
    await new CardsAPI(client).moveCard(CARD_ID, { toBoardId: BOARD_ID });
    const put = received.find((r) => r.method === 'PUT');
    expect(JSON.parse(put?.body ?? '{}')).toMatchObject({ widgetCommonId: BOARD_ID });
  });
});
