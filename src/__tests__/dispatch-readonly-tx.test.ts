/**
 * `readOnly` is a COMPILE-TIME guarantee, and this file is what makes that claim
 * falsifiable (#107).
 *
 * `Intent.readOnly` is load-bearing: it is what skips the boardless-write refusal
 * in `dispatch`, so an intent that declared it falsely took the exemption from
 * the scope lock AND made the write it promised not to. Until #107 the promise
 * was documentation. Now a `readOnly` intent's `run` receives `ReadTx`, on which
 * no write exists.
 *
 * ## Why the arms are shaped the way they are
 *
 * A type test is the easiest thing in this repo to write unfalsifiably, in two
 * specific ways, and both are answered below rather than hoped about:
 *
 *  1. **`@ts-expect-error` passes on ANY error on that line**, including one the
 *     test did not mean. So each expect-error arm sits on a line whose only
 *     possible complaint is the one named, the surrounding lines are deliberately
 *     well-formed, and each was verified by TEMPORARILY widening the type and
 *     watching `npm run typecheck` fail with `Unused '@ts-expect-error'`. An
 *     expect-error arm that stops being needed is an error, which is the whole
 *     reason it is spelled this way and not as a comment.
 *  2. **A `never`-extraction can be empty for the wrong reason.** `NO_WRITES`
 *     below asserts that not one write name is a key of the read-only tx; on its
 *     own it would pass just as happily if `Writes` listed eight names nothing
 *     has. `EVERY_WRITE` is the same expression at the opposite polarity, over
 *     the WRITING arm, so a misspelled or stale `Writes` fails there.
 *
 * `[X] extends [never]` and never `X extends never`: the bare form distributes
 * over a naked type parameter and answers `never` for an empty union, which is
 * neither `true` nor `false` and would make the assertion unsatisfiable rather
 * than false. The tuple wrapper turns it off.
 *
 * These arms are checked by `npm run typecheck` (which includes test files —
 * the root `tsconfig.json` excludes them, so `npx tsc --noEmit` alone does NOT
 * check this file) and by `ts-jest` when the suite runs. The runtime `it` blocks
 * are what keep the file from being an empty suite, and they pin the two facts a
 * type cannot: which intent actually carries the flag, and that the whole-org
 * sweep refuses at runtime rather than only at the type level.
 */
import CardsAPI, { Card } from '../lib/cards-api';
import FavroHttpClient from '../lib/http-client';
import { getIntent, intentNames, isRetryable, Intent, RefusalError } from '../lib/dispatch';
import { CompensationLog, ReadTx, TxCards } from '../lib/tx-cards';

// ─── the type-level arms ─────────────────────────────────────────────────────

/** The tx a `readOnly` intent's `run` is handed — extracted through `Intent`, so
 *  this pins the WIRING and not merely `ReadTx` in isolation. */
type ReadOnlyTx = Parameters<Extract<Intent<unknown, unknown>, { readOnly: true }>['run']>[1];

/** And the tx a writing intent is handed. */
type WritingTx = Parameters<Extract<Intent<unknown, unknown>, { readOnly?: undefined }>['run']>[1];

/**
 * Every write on the facade, by name. A ninth reversible op has to be added here
 * or `EVERY_WRITE` below stops holding — which is the point: the list cannot go
 * stale quietly.
 */
type Writes =
  | 'create'
  | 'deleteCard'
  | 'moveColumn'
  | 'setTags'
  | 'setAssignees'
  | 'addBlockingEdge'
  | 'removeBlockingEdge'
  | 'setArchived';

type WritesOn<T> = Extract<keyof T, Writes>;

/** NOT ONE write is reachable on a `readOnly` intent's tx. */
const NO_WRITES: [WritesOn<ReadOnlyTx>] extends [never] ? true : false = true;

/**
 * The opposite polarity, same expression: a WRITING intent's tx has all eight.
 * Without this, `NO_WRITES` would pass vacuously against a `Writes` union of
 * names nothing has — and would also pass against a `ReadOnlyTx` of `any`
 * (`keyof any` includes every string, so `NO_WRITES` catches that one too).
 */
const EVERY_WRITE: [Exclude<Writes, WritesOn<WritingTx>>] extends [never] ? true : false = true;

/** And the reads ARE reachable, or `ReadTx` would be trivially write-free. */
const READS_REACHABLE: [Exclude<'getCard' | 'listCards' | 'tracker', keyof ReadOnlyTx>] extends [never]
  ? true
  : false = true;

/**
 * Declared, never registered: the compiler is the only thing that has to look at
 * these. Registering them would put two fictional names in `intentNames()`, which
 * `help-topic-drift.test.ts` reads.
 */
const readOnlyIntentThatWrites: Intent<{ card: string }, void> = {
  name: 'scratch-readonly-writes',
  summary: 'declared so the compiler can refuse it',
  preview: () => [],
  readOnly: true,
  board: async () => undefined,
  run: async (a, tx) => {
    // A read, on the same `tx`, unannotated and well-formed — so the line below
    // cannot be failing because `tx` is broken or untyped.
    await tx.getCard(a.card);
    // @ts-expect-error — `create` is a write, and a `readOnly` intent's tx is `ReadTx`.
    await tx.create({ name: 'a card' });
  },
};

type ReadOnlyRun = Extract<Intent<{ card: string }, void>, { readOnly: true }>['run'];
type WritingRun = Extract<Intent<{ card: string }, void>, { readOnly?: undefined }>['run'];

/**
 * The bivariance escape, closed. `run` is a function-typed PROPERTY on `Intent`,
 * not a method, so its parameter is contravariant and an annotation cannot widen
 * it back. Declared as a method it would be bivariant even under
 * `strictFunctionTypes`, and this arm would compile — handing the whole write
 * surface back for the price of one type annotation.
 *
 * Asserted on a bare assignment rather than inside an object literal on purpose:
 * a literal reports the mismatch on the `const` line, where an `@ts-expect-error`
 * would sit over every other error in the literal too.
 */
// @ts-expect-error — `(a, tx: TxCards)` is not assignable where `ReadTx` is asked for.
const annotatedReadOnlyRun: ReadOnlyRun = async (_a, _tx: TxCards) => {};

/** Positive polarity: the same body, unannotated, is fine. */
const inferredReadOnlyRun: ReadOnlyRun = async (_a, _tx) => {};

/**
 * The foreign arm: the identical `tx: TxCards` annotation is accepted on the
 * WRITING arm's `run`. So `annotatedReadOnlyRun` above is not failing because
 * annotating a parameter is refused generally — it fails because `TxCards` is
 * wider than what a `readOnly` intent is handed.
 */
const annotatedWritingRun: WritingRun = async (_a, _tx: TxCards) => {};

/** Positive polarity: a `readOnly` intent that only reads compiles, no escape hatch. */
const readOnlyIntentThatReads: Intent<{ card: string }, string | undefined> = {
  name: 'scratch-readonly-reads',
  summary: 'declared so the compiler can accept it',
  preview: () => [],
  readOnly: true,
  board: async () => undefined,
  run: async (a, tx) => (await tx.getCard(a.card)).boardId,
};

/** Positive polarity: omitting `readOnly` still gets the full facade. */
const writingIntent: Intent<{ name: string }, string> = {
  name: 'scratch-writing',
  summary: 'declared so the compiler can accept it',
  preview: () => [],
  board: async (a) => a.name,
  run: async (a, tx) => (await tx.create({ name: a.name })).cardId,
};

// ─── the runtime arms ────────────────────────────────────────────────────────

describe('readOnly narrows the tx an intent receives', () => {
  it('holds every type-level arm, and the four declarations they are read off', () => {
    // The `const`s carry the assertions; referencing them here is what keeps the
    // declarations from being dead code a future cleanup deletes.
    expect([NO_WRITES, EVERY_WRITE, READS_REACHABLE]).toEqual([true, true, true]);
    expect(readOnlyIntentThatWrites.readOnly).toBe(true);
    expect(readOnlyIntentThatReads.readOnly).toBe(true);
    expect(writingIntent.readOnly).toBeUndefined();
    expect([annotatedReadOnlyRun, inferredReadOnlyRun, annotatedWritingRun].map((f) => typeof f)).toEqual([
      'function',
      'function',
      'function',
    ]);
  });

  it('is carried by `read` alone, and by every other intent not at all', () => {
    // Exactly `true`, not merely truthy: the flag is read as a discriminant.
    expect(getIntent('read')?.readOnly).toBe(true);

    // The omit arm, over the whole registered table rather than one remembered
    // name: everything else must be ABSENT, not `false`, because absent is the
    // fail-closed default a new intent inherits.
    const others = intentNames().filter((n) => n !== 'read');
    expect(others.length).toBeGreaterThan(0);
    for (const name of others) {
      expect(getIntent(name)?.readOnly).toBeUndefined();
    }
  });
});

describe('TxCards.listCards refuses the whole-organisation sweep', () => {
  /**
   * One recorder, both polarities. Asserting "nothing was recorded" on its own is
   * unfalsifiable exactly in the case this test exists for, so the pass-through
   * arm runs FIRST and leaves a mark: the refusal arm then asserts the recorder
   * is unchanged, which fails if the guard lets `''` through.
   *
   * Measured against a real wire before it was written this way: `CardsAPI
   * .listCards()` and `.listCards('')` both go out as
   * `/cards?limit=100&archived=false&descriptionFormat=markdown` — no
   * `widgetCommonId` — which `getAllPages` then reads to completion across the
   * whole organisation. `''` is a `string`, so the required parameter alone does
   * not close that door.
   */
  it('passes a board through, and refuses an empty one without reaching the API', async () => {
    const listed: Array<string | undefined> = [];
    const api = {
      listCards: async (boardId?: string): Promise<Card[]> => {
        listed.push(boardId);
        return [];
      },
    } as unknown as CardsAPI;
    const tx = new TxCards(api, new CompensationLog(), {} as FavroHttpClient);

    await expect(tx.listCards('board-a')).resolves.toEqual([]);
    expect(listed).toEqual(['board-a']);

    const refusal = await tx.listCards('').then(
      () => undefined,
      (error: unknown) => error,
    );

    // The recorder is untouched by the refusal — no second call, and in
    // particular no call carrying `''` or `undefined`.
    expect(listed).toEqual(['board-a']);

    // `toThrow(RefusalError)` would match a renamed bare `Error` by constructor
    // name, so assert `instanceof` plus the property the readers actually key on:
    // `isRetryable` claims `retryable: false` for a `RefusalError` and would
    // answer TRUE for anything else raised here.
    expect(refusal).toBeInstanceOf(RefusalError);
    expect(refusal).toBeInstanceOf(Error);
    expect(isRetryable('rolled-back', refusal)).toBe(false);
    expect((refusal as Error).message).toContain('widgetCommonId');
    expect((refusal as Error).message).toContain('organisation');
  });
});
