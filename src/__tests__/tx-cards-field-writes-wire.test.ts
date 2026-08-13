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
  /** Echo this instead of what was written to `name`. */
  nameEcho?: string;
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
        const value = put.dueDate;
        // MEASURED: `""` is a silent no-op, `null` clears, a bare date normalises.
        if (value === null) delete row.dueDate;
        else if (value === '') void 0;
        else if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) row.dueDate = `${value}T00:00:00.000Z`;
        else row.dueDate = value;
      }
      if ('customFields' in put) {
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
            { customFieldId: entry.customFieldId, value: entry.value },
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

  it('a name write the wire echoes DIFFERENTLY throws, and logs nothing to undo', async () => {
    const stand = await startServer({ nameEcho: 'something else' });
    const { tx, log } = txOn(stand);

    await expect(tx.setText(CARD, 'name', 'renamed')).rejects.toThrow(TransientError);
    await expect(tx.setText(CARD, 'name', 'renamed')).rejects.toThrow(/answered 200 but did not take/);
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
    expect(log.depth).toBe(0);
    expect(stand.row.dueDate).toBeUndefined();
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
