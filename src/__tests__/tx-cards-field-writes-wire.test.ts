/**
 * `setText` / `setDueDate` / `setFieldValue` against a `node:http` Favro
 * stand-in — #106, step 1 of the sequence in #92.
 *
 * WHAT THIS FILE IS, AND WHAT IT IS NOT.
 *
 * It is NOT the measurement. The measurement is
 * `docs/research/card-write-field-semantics.md`, taken live against the #105
 * scratch board; a stand cannot substitute for it, because a stand that answers
 * a PUT with a row WE wrote verifies our own assumption against itself (#101's
 * triage caught exactly that). This file is where the measured behaviour gets
 * PINNED, so a later edit that quietly re-derives one of the four wire quirks
 * from taste fails here.
 *
 * The stand therefore models the four quirks as MEASURED, not as convenient:
 *
 *   1. `name` — stored and echoed byte-for-byte. No trimming, no parsing.
 *   2. `detailedDescription` — CANONICALISED on the way in. The stand applies a
 *      one-rule stand-in for it (`-` list markers become `*`); the live wire does
 *      four things, and any one of them is enough to break a strict read-back.
 *      `''` stores `"\n"`.
 *   3. `dueDate` — `"YYYY-MM-DD"` normalises to `…T00:00:00.000Z`, an ISO string
 *      is stored verbatim, `null` clears, and `""` is a **silent no-op**.
 *   4. `customFields` — a select's `[optionId]` is honoured and echoed; an empty
 *      array, an unknown field id and a bare string each answer **202 with a
 *      `message` and no card row**, which axios reads as success.
 *
 * THE ARMS WITH TEETH are the ones about the compensation RECORD rather than the
 * write. `compareBeforeRestore` tests `live === record.wrote`, so recording the
 * ARGUMENT instead of what the wire STORED makes every canonicalised or
 * normalised field decline its own restore and report a `compensation-skipped`
 * orphan for a card nobody else touched — a correct `rolled-back` reported as
 * `rollback-incomplete`. Two tests below fail on exactly that mutation, and a
 * happy-path write assertion cannot see it.
 */
import * as http from 'http';
import { AddressInfo } from 'net';
import FavroHttpClient from '../lib/http-client';
import CardsAPI from '../lib/cards-api';
import { CompensationLog, TxCards } from '../lib/tx-cards';
import { RefusalError, TransientError } from '../lib/refusal';
import { tempConfigDir } from '../test-support/config-dir';

// Set before anything reads it: the stand carries an organizationId, so a
// cache-backed lookup on any of these paths would otherwise write to the real
// `~/.favro`.
tempConfigDir('favro-tx-fields-');

const ORG = 'org-1';
const CARD = '00000000000000000000cc01';
/** The one enabled custom field on the #105 scratch board: `Status`, Single select. */
const FIELD = 'zxMLxD4zx4tSwJr75';
const TODO_OPTION = 'YLanLiuXKA8JpvEsX';
const DOING_OPTION = '07ef4afba3a3d76994f5dd74';

interface Received {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

interface Stand {
  client: FavroHttpClient;
  received: Received[];
  /** The stand's stored card row, as the wire would hold it. */
  row: Record<string, unknown>;
  writes(): Received[];
}

const running: http.Server[] = [];

/**
 * Favro's markdown canonicalisation, reduced to its cheapest observable rule.
 * The live wire also inserts blank lines between list items, drops a fence's
 * info string and injects U+200B after `[`; one rule is enough to make the
 * round trip lossy, which is the property under test.
 */
const canonicalise = (md: string): string => (md === '' ? '\n' : md.replace(/^- /gm, '* '));

interface StandOptions {
  /** Seed values on the stored row. */
  row?: Record<string, unknown>;
  /** Drop a field's write on the floor, answering 200 with the untouched row. */
  ignore?: string;
  /** Echo this instead of what was written to `name` / `dueDate`. */
  nameEcho?: string;
  dueDateEcho?: string;
  /**
   * Store a custom field's value under this key instead of `value` — what a
   * `Members` / `Link` / `Number` field does, per the four payload keys
   * `custom-fields-api.ts` builds. Unmeasured on the live wire, and that is the
   * point: reading `value` alone would report such a write as one that did not
   * take.
   */
  fieldEchoKey?: 'members' | 'link' | 'total';
}

async function startServer(options: StandOptions = {}): Promise<Stand> {
  const received: Received[] = [];
  const row: Record<string, unknown> = {
    cardId: CARD,
    cardCommonId: 'common-1',
    name: 'probe card',
    widgetCommonId: 'board-1',
    columnId: 'col-todo',
    archived: false,
    tags: [],
    assignments: [],
    customFields: [{ customFieldId: FIELD, value: [TODO_OPTION] }],
    ...options.row,
  };

  const server = http.createServer((req, res) => {
    const pathOnly = (req.url ?? '').split('?')[0].replace(/^\/api\/v1/, '');
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      received.push({ method: req.method ?? '', path: pathOnly, body });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (pathOnly !== `/cards/${CARD}`) return send(200, { entities: [] });
      if (req.method === 'GET') return send(200, row);
      if (req.method !== 'PUT') return send(200, row);

      const put = (body ?? {}) as Record<string, unknown>;

      if ('name' in put && options.ignore !== 'name') {
        row.name = options.nameEcho ?? put.name;
      }
      if ('detailedDescription' in put && options.ignore !== 'description') {
        row.detailedDescription = canonicalise(String(put.detailedDescription));
      }
      if ('dueDate' in put && options.ignore !== 'dueDate') {
        const value = options.dueDateEcho ?? put.dueDate;
        // MEASURED: `""` is a silent no-op, `null` clears, a bare date normalises.
        if (value === null) delete row.dueDate;
        else if (value === '') void 0;
        else if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) row.dueDate = `${value}T00:00:00.000Z`;
        else row.dueDate = value;
      }
      if ('customFields' in put && options.ignore !== 'customFields') {
        const entries = (put.customFields ?? []) as Array<Record<string, unknown>>;
        for (const entry of entries) {
          // MEASURED: each of these three answers 202 with a message and NO card
          // row, and writes nothing. 202 is a success to axios.
          if (entry.customFieldId !== FIELD) return send(202, { message: 'Custom field is not valid' });
          if (!Array.isArray(entry.value)) return send(202, { message: 'Match failed' });
          if (entry.value.length === 0) return send(202, { message: 'Invalid status value' });
          const stored = (row.customFields ?? []) as Array<Record<string, unknown>>;
          row.customFields = [
            ...stored.filter((f) => f.customFieldId !== entry.customFieldId),
            { customFieldId: entry.customFieldId, [options.fieldEchoKey ?? 'value']: entry.value },
          ];
        }
      }
      // MEASURED: the PUT answers with the whole card row, key-for-key identical
      // to what a GET on the same card returns.
      return send(200, row);
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
        row,
        writes: () => received.filter((r) => r.method !== 'GET'),
      });
    });
  });
}

function txOn(stand: Stand): { tx: TxCards; log: CompensationLog } {
  const log = new CompensationLog();
  return { tx: new TxCards(new CardsAPI(stand.client), log, stand.client), log };
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((s) => new Promise((done) => s.close(() => done(null)))));
});

describe('setText — name is confirmed against the echo, description cannot be', () => {
  it('a name write that the wire echoes back verbatim is logged and unwinds clean', async () => {
    const stand = await startServer();
    const { tx, log } = txOn(stand);

    await tx.setText(CARD, 'name', 'renamed');
    expect(stand.row.name).toBe('renamed');

    const result = await log.unwind();
    expect(result).toEqual({ outcome: 'rolled-back', orphans: [] });
    expect(stand.row.name).toBe('probe card');
  });

  it('a name write the wire silently drops says nothing was written', async () => {
    const stand = await startServer({ ignore: 'name' });
    const { tx, log } = txOn(stand);

    await expect(tx.setText(CARD, 'name', 'renamed')).rejects.toThrow(TransientError);
    await expect(tx.setText(CARD, 'name', 'renamed')).rejects.toThrow(/nothing was written/);
    expect(log.depth).toBe(0);
  });

  it('a name write echoed as a THIRD value says so, instead of claiming nothing happened', async () => {
    const stand = await startServer({ nameEcho: 'something else' });
    const { tx, log } = txOn(stand);

    // `setArchived` may say "nothing was written" on a mismatch because `archived`
    // is two-valued. `name` is not: an echo that is neither what we sent nor what
    // was there means something DID get written, and this throw leaves it unlogged.
    //
    // ONE call, and the stand is why: it stores the echo, so a second attempt finds
    // the card already holding it and takes the other branch honestly.
    const error = await tx.setText(CARD, 'name', 'renamed').catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(TransientError);
    expect(error.message).toMatch(/THIRD value/);
    expect(error.message).toMatch(/cannot unwind/);
    expect(log.depth).toBe(0);
  });

  it('a CANONICALISED description does not throw — the read-back that name gets is impossible here', async () => {
    const stand = await startServer();
    const { tx } = txOn(stand);

    await tx.setText(CARD, 'description', '- one\n- two');

    // What the wire stored is not what we sent, and the write still stands.
    expect(stand.row.detailedDescription).toBe('* one\n* two');
  });

  it('the description entry records what the wire STORED, so the unwind does not orphan', async () => {
    const stand = await startServer();
    const { tx, log } = txOn(stand);

    await tx.setText(CARD, 'description', '- one\n- two');
    const result = await log.unwind();

    // THE ARM WITH TEETH. Recording the argument (`- one\n- two`) instead of the
    // stored value (`* one\n* two`) compares our markdown against Favro's copy,
    // declines the restore and reports a skipped orphan on a card nobody else
    // touched — `rollback-incomplete` for a rollback that was available.
    expect(result).toEqual({ outcome: 'rolled-back', orphans: [] });
    // An absent prior description restores as `''`, which the wire stores as
    // `"\n"` — measured, and the reason the record cannot hold the argument here
    // either.
    expect(stand.row.detailedDescription).toBe('\n');
  });
});

describe('setDueDate — three write shapes, and one that answers 200 and writes nothing', () => {
  it('refuses an empty string before any request leaves', async () => {
    const stand = await startServer({ row: { dueDate: '2026-09-01T00:00:00.000Z' } });
    const { tx } = txOn(stand);

    await expect(tx.setDueDate(CARD, '')).rejects.toThrow(RefusalError);
    await expect(tx.setDueDate(CARD, '')).rejects.toThrow(/measured silent no-op/);
    // Refused, not attempted: nothing at all reached the wire, not even a read.
    expect(stand.received).toEqual([]);
  });

  it('refuses a day that does not exist before any request leaves (#168)', async () => {
    // MEASURED live 2026-08-14: `PUT {dueDate: "2026-02-30"}` answers 200 with no
    // message and stores `2026-03-02T00:00:00.000Z`. The read-back below WOULD have
    // caught it — but as a `TransientError`, i.e. `retryable: true`, and the help
    // topic tells agents to obey that field, so an impossible date was retried
    // forever. A refusal is what the same-call-same-failure actually is.
    const stand = await startServer({ row: { dueDate: '2026-09-01T00:00:00.000Z' } });
    const { tx } = txOn(stand);

    await expect(tx.setDueDate(CARD, '2026-02-30')).rejects.toThrow(RefusalError);
    await expect(tx.setDueDate(CARD, '2026-02-30')).rejects.toThrow(/is not a date that exists/);
    await expect(tx.setDueDate(CARD, '2026-04-31')).rejects.toThrow(RefusalError);
    // Refused, not attempted — not even the read. A rolled-over date that reached
    // the wire would be stored, and nothing downstream could tell.
    expect(stand.received).toEqual([]);
  });

  it('a real end-of-month date is NOT refused — the guard is the rollover, not the 30th', async () => {
    // Polarity. A predicate that rejected every day above 28, or every February
    // date, would pass the arm above and break every legitimate month end.
    const stand = await startServer();
    const { tx } = txOn(stand);

    await tx.setDueDate(CARD, '2026-02-28');
    expect(stand.row.dueDate).toBe('2026-02-28T00:00:00.000Z');
    await tx.setDueDate(CARD, '2026-03-31');
    expect(stand.row.dueDate).toBe('2026-03-31T00:00:00.000Z');
    // A leap-year 29th is real; 2026 is not a leap year, so its 29th is not.
    await tx.setDueDate(CARD, '2024-02-29');
    expect(stand.row.dueDate).toBe('2024-02-29T00:00:00.000Z');
    await expect(tx.setDueDate(CARD, '2026-02-29')).rejects.toThrow(RefusalError);
  });

  it('a date-only write is confirmed on the DAY, not on the string it sent', async () => {
    const stand = await startServer();
    const { tx, log } = txOn(stand);

    await tx.setDueDate(CARD, '2026-09-01');

    // Strict equality against the argument would call this a write that did not
    // take, and throw on a card whose date is now set.
    expect(stand.row.dueDate).toBe('2026-09-01T00:00:00.000Z');
    expect(log.depth).toBe(1);
  });

  it('the entry records the NORMALISED value, so the unwind clears the date rather than orphaning', async () => {
    const stand = await startServer();
    const { tx, log } = txOn(stand);

    await tx.setDueDate(CARD, '2026-09-01');
    const result = await log.unwind();

    // THE ARM WITH TEETH, as for description: `wrote: '2026-09-01'` never equals
    // the live `2026-09-01T00:00:00.000Z`, so the compare would skip and orphan.
    expect(result).toEqual({ outcome: 'rolled-back', orphans: [] });
    expect(stand.row.dueDate).toBeUndefined();
  });

  it('null clears a date, and the inverse restores it by writing the ISO string back', async () => {
    const stand = await startServer({ row: { dueDate: '2026-10-15T07:00:00.000Z' } });
    const { tx, log } = txOn(stand);

    await tx.setDueDate(CARD, null);
    expect(stand.row.dueDate).toBeUndefined();

    const result = await log.unwind();
    expect(result).toEqual({ outcome: 'rolled-back', orphans: [] });
    // Only possible because an ISO timestamp is a legal WRITE shape — the
    // measurement that unblocked this primitive at all.
    expect(stand.row.dueDate).toBe('2026-10-15T07:00:00.000Z');
  });

  it('a due-date write the wire silently drops throws, and logs nothing to undo', async () => {
    const stand = await startServer({ ignore: 'dueDate' });
    const { tx, log } = txOn(stand);

    await expect(tx.setDueDate(CARD, '2026-09-01')).rejects.toThrow(TransientError);
    await expect(tx.setDueDate(CARD, '2026-09-01')).rejects.toThrow(/nothing was written/);
    expect(log.depth).toBe(0);
    expect(stand.row.dueDate).toBeUndefined();
  });

  it('a due-date echoed as a THIRD day says so, instead of claiming nothing happened', async () => {
    const stand = await startServer({
      row: { dueDate: '2026-01-01T00:00:00.000Z' },
      dueDateEcho: '2026-12-25T00:00:00.000Z',
    });
    const { tx, log } = txOn(stand);

    // Neither what we sent nor what was there — the unbounded-domain case
    // `archived` cannot have, and the one where "nothing was written" is a guess.
    // One call, for the reason the `name` arm above gives.
    const error = await tx.setDueDate(CARD, '2026-09-01').catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(TransientError);
    expect(error.message).toMatch(/THIRD value/);
    expect(error.message).toMatch(/cannot unwind/);
    expect(log.depth).toBe(0);
  });
});

describe('setFieldValue — a 202 with a message is a failure, and axios calls it success', () => {
  it('a select write is confirmed from the echo and unwinds to the option that was there', async () => {
    const stand = await startServer();
    const { tx, log } = txOn(stand);

    await tx.setFieldValue(CARD, FIELD, [DOING_OPTION]);
    expect(stand.row.customFields).toEqual([{ customFieldId: FIELD, value: [DOING_OPTION] }]);

    const result = await log.unwind();
    // THE ARM WITH TEETH for the JSON compare: the stored value is an ARRAY, and
    // two structurally equal arrays are never `===`. An un-serialised record
    // declines every restore and orphans every rollback of a custom field.
    expect(result).toEqual({ outcome: 'rolled-back', orphans: [] });
    expect(stand.row.customFields).toEqual([{ customFieldId: FIELD, value: [TODO_OPTION] }]);
  });

  it('a clean 200 that wrote NOTHING is caught — the one read-back nothing pinned (#170)', async () => {
    // THE GAP THIS ARM CLOSES, measured: deleting `setFieldValue`'s read-back left
    // 151 tests in this file and `dispatch-tx-wire.test.ts` GREEN. Its four
    // siblings all redden when theirs is removed — `moveColumn` 4 arms,
    // `setArchived` 1, `setText` 2, `setDueDate` 2 — so this was the only member of
    // the five that a cleanup could have deleted silently, which is exactly the
    // reopening #170 warns about.
    //
    // The stand answers 200 with the untouched row and NO message, which is the
    // clean-200 shape (#170): no denial to key on, an ordinary success status, and
    // the requested change simply absent from the entity.
    const stand = await startServer({ ignore: 'customFields' });
    const { tx, log } = txOn(stand);

    await expect(tx.setFieldValue(CARD, FIELD, [DOING_OPTION])).rejects.toThrow(TransientError);
    await expect(tx.setFieldValue(CARD, FIELD, [DOING_OPTION]))
      .rejects.toThrow(/answered with a card row that does not carry what we sent/);
    // Nothing logged: the write landed nothing, so there is nothing to compensate.
    expect(log.depth).toBe(0);
    expect(stand.row.customFields).toEqual([{ customFieldId: FIELD, value: [TODO_OPTION] }]);
  });

  it('an empty array on a select refuses — 202, a message, and nothing written', async () => {
    const stand = await startServer();
    const { tx, log } = txOn(stand);

    await expect(tx.setFieldValue(CARD, FIELD, [])).rejects.toThrow(RefusalError);
    await expect(tx.setFieldValue(CARD, FIELD, [])).rejects.toThrow(/Invalid status value/);
    // Deterministic, so nothing to undo and nothing to retry.
    expect(log.depth).toBe(0);
    expect(stand.row.customFields).toEqual([{ customFieldId: FIELD, value: [TODO_OPTION] }]);
  });

  it('an unknown field id refuses on Favro’s own message rather than on the status', async () => {
    const stand = await startServer();
    const { tx } = txOn(stand);

    await expect(tx.setFieldValue(CARD, 'ZZZZZZZZZZZZZZZZZ', ['x'])).rejects.toThrow(
      /Custom field is not valid/,
    );
  });

  it('the 202 refusal lives at the seam, so a caller who never touches TxCards inherits it', async () => {
    const stand = await startServer();
    const api = new CardsAPI(stand.client);

    // `UpdateCardRequest.customFields` is a door #109's `cards update --field` will
    // come through. A guard only inside the primitive would leave that caller
    // holding a `{message}` body typed as a Card, every field undefined.
    await expect(
      api.updateCard(CARD, { customFields: [{ customFieldId: FIELD, value: [] }] }),
    ).rejects.toThrow(RefusalError);
    await expect(
      api.updateCard(CARD, { customFields: [{ customFieldId: FIELD, value: [] }] }),
    ).rejects.toThrow(/Invalid status value/);
  });

  it('a value echoed under members instead of value is a write that TOOK, not one that vanished', async () => {
    const stand = await startServer({ row: { customFields: [] }, fieldEchoKey: 'members' });
    const { tx, log } = txOn(stand);

    // THE ARM WITH TEETH for reading all four payload keys. `custom-fields-api.ts`
    // builds `members` / `link` / `total` for four field types, none of them probed
    // on this path. Reading `value` alone reports such a write as "did not take",
    // throws, and leaves a real mutation off the compensation log — the exact sign
    // flip of the silent-no-op class this facade exists to close.
    await expect(tx.setFieldValue(CARD, FIELD, ['u-1'])).resolves.toBeDefined();
    expect(log.depth).toBe(1);
  });

  /**
   * WRITTEN FRESH for #109, not moved. `write-echo-wire.test.ts` carried an arm
   * of this shape against `CustomFieldsAPI.putCardCustomField`, which had a
   * `customFieldId` filter of its own; that method is deleted, and the five other
   * arms beside it did have equivalents here. This one did not, and the gap was
   * real: every other stand in this file seeds ONE custom field, so `find(byId)`
   * and `[0]` are indistinguishable in all of them. Mutating
   * `cardFieldValue`'s filter to `entries[0]` left the whole suite green.
   *
   * A real `customFields` array carries every field on the card, so "the response
   * contained a value" and "the response contained OUR field's value" are
   * different claims. `OTHER` is seeded FIRST and the stand appends the written
   * entry, so it stays `entries[0]` across the write — which is what makes the
   * mutation fail here rather than pass by luck of ordering.
   */
  it('a foreign field in the echo is never read as ours', async () => {
    const stand = await startServer({
      row: {
        customFields: [
          { customFieldId: 'OTHER', value: ['x'] },
          { customFieldId: FIELD, value: [TODO_OPTION] },
        ],
      },
    });
    const { tx, log } = txOn(stand);

    // Reading `[0]` here confirms our write off the foreign field's value, sees a
    // mismatch, and throws a `TransientError` for a write that in fact landed.
    await expect(tx.setFieldValue(CARD, FIELD, [DOING_OPTION])).resolves.toBeDefined();
    expect(log.depth).toBe(1);

    // And the RECORD is ours too: the unwind restores our field and leaves the
    // foreign one exactly where it was.
    expect(await log.unwind()).toEqual({ outcome: 'rolled-back', orphans: [] });
    expect(stand.row.customFields).toContainEqual({ customFieldId: 'OTHER', value: ['x'] });
    expect(stand.row.customFields).toContainEqual({ customFieldId: FIELD, value: [TODO_OPTION] });
  });

  it('a field already holding the value writes nothing and logs nothing', async () => {
    const stand = await startServer();
    const { tx, log } = txOn(stand);

    await tx.setFieldValue(CARD, FIELD, [TODO_OPTION]);

    expect(stand.writes()).toEqual([]);
    expect(log.depth).toBe(0);
  });

  it('a field with no prior value orphans on the unwind, because a select has no measured clear', async () => {
    const stand = await startServer({ row: { customFields: [] } });
    const { tx, log } = txOn(stand);

    await tx.setFieldValue(CARD, FIELD, [DOING_OPTION]);
    const result = await log.unwind();

    expect(result.outcome).toBe('rollback-incomplete');
    expect(result.orphans).toHaveLength(1);
    expect(result.orphans[0]).toMatchObject({
      cause: 'compensation-failed',
      card: CARD,
      field: `customField:${FIELD}`,
    });
    expect(result.orphans[0].reason).toMatch(/no measured way to clear one/);
    // Reported, not faked: the value we set is still on the card.
    expect(stand.row.customFields).toEqual([{ customFieldId: FIELD, value: [DOING_OPTION] }]);
  });
});
