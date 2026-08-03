/**
 * The shared dispatch table (#51).
 *
 * The CLI commander actions and the skill engine call ONE table — structured
 * args-in / result-out — so they cannot drift apart on guardrails. Safety lives
 * in one place.
 *
 * The real guardrails are the **mandatory scope lock**, **boundedness** and
 * **resolver structured-refusal**. `--dry-run` is demoted from safety wall to
 * convenience preview, and previews the whole chain when used: safety must not
 * rest on a flag anyone can omit.
 *
 * The transaction boundary is ONE dispatch invocation, over a compensation log
 * the table owns. A caller may hand its own log in — that is how the skill engine
 * makes a whole RUN one transaction — but the unwinding always happens here. The
 * skill engine gets no rollback of its own.
 *
 * A pre-write refusal (unknown intent, scope violation, an unresolvable
 * identifier) THROWS. It is not a fourth outcome: nothing was written, so there
 * is nothing for the three-outcome contract to describe.
 */
import FavroHttpClient from './http-client';
import { FavroConfig } from './config';
import CardsAPI, { Card } from './cards-api';
import { assertScope } from './safety';
import { classifyThrownError } from './favro-error';
import { foldName } from './fold-name';
import { CompensationLog, Orphan, TxCards, TxOutcome } from './tx-cards';
import { CATEGORY_TAGS, STATE_TAGS, VerifiedTracker } from './tracker-config';
import { RefusalError } from './refusal';
import { capRows, ListEnvelope } from './read-shape';

// ─── contract ────────────────────────────────────────────────────────────────

export interface DispatchContext {
  client: FavroHttpClient;
  /** Carries `scopeCollectionId` — the mandatory lock. `{}` when nothing is locked. */
  config: FavroConfig;
  /** Bypass the scope lock, with a warning. The lock's only escape hatch. */
  force?: boolean;
  /** Preview only. A convenience, never a safety wall. */
  dryRun?: boolean;
  /**
   * A caller-owned compensation log, so several dispatch invocations form one
   * transaction. The skill engine opens exactly one per run and threads it
   * through every step; it never unwinds one itself.
   */
  log?: CompensationLog;
}

export interface DispatchResult<T = unknown> {
  intent: string;
  outcome: TxOutcome;
  /**
   * Is the same black-box call worth making again?
   *
   * Two things have to hold, and the outcome is only one of them: the unwind
   * must have left nothing behind (`rolled-back`), AND the failure must not be
   * one that will recur identically. `rollback-incomplete` fails the first;
   * a deterministic refusal — ours or the wire's — fails the second.
   *
   * It is NOT "the world is unchanged" — `outcome` answers that, and the two
   * came apart the moment a fully-undone run met a failure that can never
   * succeed (#151).
   *
   * This is the ONE derivation. `reportDispatch`, the skill engine and
   * `skill run` all read it rather than re-deriving it from the outcome, which
   * is what let three sites drift apart in #66. A reader holding a WIDER
   * population than this table's asks `isWireFailure` first and only then this
   * — `run.ts` since #134, the skill engine's end-of-run unwind since #151 —
   * which narrows the answer without re-deriving it (ADR-0002, "Two
   * populations").
   */
  retryable: boolean;
  value?: T;
  /** Why the intent failed. Absent on `ok`. */
  error?: string;
  /** What the unwind left behind, with the cause and per-field detail. */
  orphans?: Orphan[];
  /** Present only under `dryRun`. The whole chain this invocation would run. */
  preview?: string[];
}

/**
 * One named intent. Declared once, registered against the one table.
 *
 * `run` receives `TxCards` and nothing else — no client, no config, no
 * `CardsAPI` — so an un-instrumented write from an intent is unconstructible.
 */
export interface Intent<A = any, R = unknown> {
  name: string;
  /** One line, for `--help` and for the drift test. */
  summary: string;
  /** What this invocation would do, for `--dry-run`. */
  preview(args: A): string[];
  /**
   * The board this write lands on, for the mandatory scope lock. `undefined`
   * when the intent touches no board (the lock then has nothing to check).
   *
   * A `widgetCommonId` under its internal alias `boardId` (#120 item 4). The
   * two names are one keyspace, deliberately: `cards-api.ts` normalises
   * Favro's wire `widgetCommonId` to `boardId` on every card, and `assertScope`
   * spends it straight back on the wire as `GET /widgets/${boardId}`. The alias
   * is what makes `board()` returning `undefined` MEAN something — a card with
   * no `widgetCommonId` is an assignment fork, which is a real card the lock
   * cannot see, not an absent field.
   *
   * An array when one invocation writes to several boards — a multi-create with
   * per-entry boards. EVERY board is checked; taking the first would let one
   * in-scope entry smuggle the rest of the batch past the lock.
   */
  board(args: A, tx: TxCards): Promise<string | string[] | undefined>;
  /**
   * This intent writes NOTHING, so the scope lock has nothing to guard and no
   * board is required. Declared per intent, never inferred: an intent that
   * yields no board is otherwise unlockable, and defaulting to "unlocked" is
   * how a fork card slipped a write past the lock.
   *
   * Absent means "this writes", which is the fail-closed default a new intent
   * inherits with nothing to remember.
   */
  readOnly?: true;
  /**
   * This intent makes a write with NO inverse, so it cannot be composed into a
   * larger transaction.
   *
   * The three-outcome contract can describe a transaction that unwound cleanly
   * (`rolled-back`) or left orphans (`rollback-incomplete`). It cannot describe
   * "the unwind succeeded and a deleted card is still gone" — and inventing a
   * fourth outcome to say so would break every reader of `TxOutcome`. So the
   * composition is REFUSED before anything is written instead: a pre-write
   * refusal throws, which the contract already covers.
   *
   * Bites on a CALLER-THREADED log, full stop — its depth is not consulted. A
   * terminal intent logs nothing, so writes made after it see a log that still
   * reads "nothing written yet"; asking about depth only saw the writes that
   * came BEFORE. A terminal intent dispatched with no log of the caller's opens
   * a fresh one and runs normally, which is the whole point of
   * `favro cards delete` — and is the only way to reach one.
   */
  terminal?: true;
  run(args: A, tx: TxCards): Promise<R>;
}

/**
 * A refusal: the intent declined to write, and the same call will decline again.
 *
 * A refusal is not an outcome. The table rethrows one, on the same footing as
 * the scope lock, as long as THIS invocation has not written anything yet.
 * Thrown after a write, it unwinds like any other failure — an orphan is an
 * orphan whatever raised it.
 *
 * Declared in `./refusal` (a leaf module, so every refusal in the codebase can
 * extend it without an import cycle) and re-exported here, where the rule that
 * reads it lives. `AssigneeError`, `CardResolutionError`, `TrackerConfigError`
 * and the `TxCards` guards are all subclasses, so the whole class is covered
 * rather than four remembered special cases.
 */
export { RefusalError };

/**
 * Is this failure worth retrying, given how the unwind went? **The one
 * derivation of retry advice** (#66) — nothing else may compute it.
 *
 * A clean unwind says the world is unchanged. That is NOT the same as saying
 * the call is worth making again, and conflating the two is the loop #51 closed
 * for client-side refusals: create, be refused, unwind, repeat. The wire raises
 * exactly the same class of refusal — `403 "Invalid column"` is a bad-input
 * rejection, so the identical request is rejected identically — and until now
 * only the client-side half was recognised.
 *
 * Narrow on purpose. `retryable: false` is claimed only for a `RefusalError`,
 * or where `./favro-error` classifies the response as a deterministic refusal:
 * its closed, probed message sets (`not-found`, `conflict`, `invalid`), a 401,
 * or a 403 — which that module defaults to a permission denial whether or not
 * the message is one it recognises, the fail-closed arm. A failure it cannot
 * classify — a 5xx, a timeout, a bug of our own — keeps the
 * rolled-back-is-retryable reading: the world is genuinely back where it
 * started, and the next attempt may well behave differently.
 *
 * That last reading is only sound for THIS population — errors raised inside a
 * write this table instrumented, where unclassifiable means a wire hiccup. Every
 * caller holding a wider one gates this call behind `isWireFailure` for exactly
 * that reason: the CLI's error boundary since #134, the skill engine's
 * end-of-run unwind since #151 (ADR-0002 "Two populations").
 */
export function isRetryable(outcome: TxOutcome, error: unknown): boolean {
  if (outcome !== 'rolled-back') return false;
  if (error instanceof RefusalError) return false;
  const kind = classifyThrownError(error)?.kind;
  // `undefined` is "no HTTP response to classify"; `unknown` is "a response we
  // cannot name". Both are the transient family. `none` cannot reach here.
  return kind === undefined || kind === 'unknown' || kind === 'none';
}

/** An intent nobody registered. Names the table so the refusal is reachable. */
export class UnknownIntentError extends Error {
  constructor(readonly requested: string, readonly known: string[]) {
    super(
      `No such intent "${requested}". The dispatch table holds: ${known.join(', ')}.\n` +
        `Run 'favro help issue-tracker' for the intent contract.`,
    );
    this.name = 'UnknownIntentError';
  }
}

// ─── the table ───────────────────────────────────────────────────────────────

const table = new Map<string, Intent<any, any>>();

/**
 * Add an intent to the one table. Later tickets register theirs here; nothing
 * else may hold a second table, which is the whole point.
 */
export function registerIntent<A, R>(intent: Intent<A, R>): void {
  table.set(intent.name, intent as Intent<any, any>);
}

/** Every registered intent name. The drift test reads this. */
export function intentNames(): string[] {
  return [...table.keys()].sort();
}

/** One intent, or undefined. For help text and the drift test. */
export function getIntent(name: string): Intent<any, any> | undefined {
  return table.get(name);
}

/**
 * Run one intent as one transaction.
 *
 * @throws `UnknownIntentError` / `ScopeError` / a resolver refusal — before any
 *   write. Those are refusals, not outcomes.
 */
export async function dispatch<T = unknown>(
  name: string,
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<DispatchResult<T>> {
  const intent = table.get(name);
  if (!intent) throw new UnknownIntentError(name, intentNames());

  const log = ctx.log ?? new CompensationLog();

  // An irreversible intent cannot join a transaction AT ALL — a threaded log is
  // the refusal, not the log's depth.
  //
  // Depth was the wrong question in both directions. A terminal intent pushes NO
  // compensation entry, so it leaves the depth exactly where it found it: every
  // write made AFTER it sees a log that still says "nothing written yet", and a
  // later failure unwinds those, reports `rolled-back / retryable` and says
  // nothing about the card this step destroyed. Nothing inside this invocation
  // can know whether a later write is coming, so the composition is refused
  // whether or not the transaction has written anything yet.
  //
  // Refused before the scope lock because it is free — no network, no
  // resolution — and a refusal is a refusal either way.
  if (intent.terminal && ctx.log) {
    throw new RefusalError(
      `Refusing to run "${name}" as part of a transaction: it is IRREVERSIBLE and has no compensating write.\n` +
        `Any step of that transaction that failed — before this one or after it — would unwind the ` +
        `reversible writes and report "rolled-back", while what this step destroyed stayed destroyed. That ` +
        `report would be a lie, and there is no fourth outcome to tell the truth with.\n` +
        `This is why "${name}" cannot be a skill step: a skill run is ONE transaction, start to finish. ` +
        `Run 'favro cards delete <card>' directly instead — that path opens no transaction of its own, and ` +
        `prompts before it writes.`,
    );
  }

  const tx = new TxCards(new CardsAPI(ctx.client), log, ctx.client);

  // The mandatory guardrail, inside the table, on every path — including the
  // skill engine's and the MCP passthrough's.
  const board = await intent.board(args as never, tx);
  const boards = typeof board === 'string' ? [board] : board ?? [];
  // A write that names no board is UNCHECKABLE, not exempt. The loop below
  // simply does not run for an empty list, so without this the lock would fail
  // OPEN — which is exactly what an assignment fork produces: `getCard(...)
  // .boardId` is `widgetCommonId`, and a fork has none, so `cards link`,
  // `cards unlink` and `cards retag` all boarded off `undefined`.
  //
  // `--force` deliberately does NOT rescue this. Force is "I know this board is
  // outside the lock"; here there is no board to know anything about, so there
  // is nothing for the escape hatch to escape.
  if (boards.length === 0 && !intent.readOnly && ctx.config?.scopeCollectionId) {
    throw new RefusalError(
      `Refusing to run "${name}": it writes, but it resolved no board, so the scope lock ` +
        `(${ctx.config.scopeCollectionName ?? ctx.config.scopeCollectionId}) cannot be checked.\n` +
        `A card with no board instance (no widgetCommonId) is what an assignment fork looks like, and ` +
        `a write to one is a write the lock cannot see.\n` +
        `Pass the reference of the board-resident instance instead — 'favro cards get <cardCommonId>' ` +
        `names the instances.`,
    );
  }
  // Every distinct board, not just the first: a batch that straddles the lock
  // must refuse as a whole, before anything is written.
  for (const one of new Set(boards)) {
    await assertScope(one, ctx.client, ctx.config, ctx.force);
  }

  if (ctx.dryRun) {
    // A preview, and only a preview: nothing is written, and whatever this
    // transaction already holds is shown too, so a chain previews as a chain.
    return {
      intent: name,
      outcome: 'ok',
      retryable: false,
      preview: [...intent.preview(args as never), ...log.describe()],
    };
  }

  // The log's depth counts what the whole TRANSACTION has written, which under a
  // caller-threaded log includes earlier steps. Only the depth THIS invocation
  // added says whether the refusal below arrived before or after our own write.
  const depthAtEntry = log.depth;

  try {
    const value = (await intent.run(args as never, tx)) as T;
    return { intent: name, outcome: 'ok', retryable: false, value };
  } catch (error) {
    // A refusal raised before THIS invocation wrote anything is a refusal, not
    // an outcome — reporting it as retryable `rolled-back` would send an agent
    // round the same loop forever: re-create, refuse identically, unwind.
    // Earlier steps of a threaded transaction are still unwound, by the caller
    // that owns the log (see `runSkill`'s end-of-run unwind).
    if (error instanceof RefusalError && log.depth === depthAtEntry) throw error;
    // Unwind the WHOLE log, not just this invocation's entries: when a caller
    // threads one log through several dispatches, a late failure has to undo the
    // early writes too, or "rolled-back" would be a lie about the run.
    const { outcome, orphans } = await log.unwind();
    return {
      intent: name,
      outcome,
      retryable: isRetryable(outcome, error),
      error: error instanceof Error ? error.message : String(error),
      ...(orphans.length > 0 ? { orphans } : {}),
    };
  }
}

// ─── registered intents ──────────────────────────────────────────────────────

/**
 * `create` — one atomic validated `POST /cards` carrying every composite.
 *
 * Nothing here is composition: `parentCardId`, both dependency directions,
 * `columnId`, `tags` and `assignmentIds` are all honoured and validated by the
 * same call, and any bad value 403s the whole create with no card created. The
 * card still gets an undo handle, so a later step in the same transaction can
 * roll it back.
 */
export interface CreateArgs {
  name: string;
  board?: string;
  status?: string;
  description?: string;
  /** A bare string is one item, never a string to iterate. See `oneOrMany`. */
  tags?: string[] | string;
  assignees?: string[] | string;
  parent?: string;
  blockedBy?: string[] | string;
  blocks?: string[] | string;
}

/** `CreateArgs` after `createEntries` has settled every list-shaped field. */
type NormalCreateArgs = Omit<CreateArgs, 'tags' | 'assignees' | 'blockedBy' | 'blocks'> & {
  tags?: string[];
  assignees?: string[];
  blockedBy?: string[];
  blocks?: string[];
};

/**
 * A string in a list-shaped field is ONE item, not a sequence of characters.
 *
 * The skill engine passes `Record<string, string>` straight into
 * `dispatch('create', …)`, so `blockedBy: "CLA-1804"` arrives as a string. It
 * passes the `.length` check in `createRequest` and `cards-api` then spreads it —
 * `...("bug")` is `'b','u','g'`, three `toCardId` calls, a silent wrong answer.
 * (`tags` was only luckier, not safer: `validateTagNames` calls `.some()` and
 * TypeErrors.)
 *
 * Wrapped rather than comma-split ON PURPOSE. The CLI already comma-splits
 * before it gets here, and splitting again at the chokepoint would corrupt any
 * value that legitimately contains a comma; a wrapped `"a,b"` instead refuses
 * loudly downstream as an unknown tag or an unresolvable card.
 */
const oneOrMany = (v: string[] | string | undefined): string[] | undefined =>
  typeof v === 'string' ? (v === '' ? undefined : [v]) : v;

/**
 * The multi form: an ENUMERATED list, never a derived one.
 *
 * The fan-out ban is reframed as derived N vs enumerated N. A caller that
 * already holds the N cards it wants may create them in one transaction; a
 * caller that would *compute* N from a read may not.
 */
export interface MultiCreateArgs {
  cards: CreateArgs[];
}

/**
 * How many cards one multi-create may make. Over the cap the intent REFUSES —
 * it never creates the first 20 and drops the rest, because a partial create
 * that reports success is exactly the silent-wrong-answer class this build
 * exists to close.
 */
export const MULTI_CREATE_CAP = 20;

const isMulti = (a: CreateArgs | MultiCreateArgs): a is MultiCreateArgs =>
  Array.isArray((a as MultiCreateArgs).cards);

/** Every list-shaped field settled to an array. Returns a new object. */
const normalize = (c: CreateArgs): NormalCreateArgs => ({
  ...c,
  tags: oneOrMany(c.tags),
  assignees: oneOrMany(c.assignees),
  blockedBy: oneOrMany(c.blockedBy),
  blocks: oneOrMany(c.blocks),
});

/**
 * The entries this invocation will create, bounded and normalised, or a refusal.
 *
 * `preview`, `board` and `run` all route through here, so the normalisation
 * cannot be reached around — which is why it lives here and not in the CLI.
 */
function createEntries(a: CreateArgs | MultiCreateArgs): NormalCreateArgs[] {
  if (!isMulti(a)) return [normalize(a)];
  if (a.cards.length === 0) {
    throw new RefusalError('Nothing to create: the enumerated card list is empty.');
  }
  if (a.cards.length > MULTI_CREATE_CAP) {
    throw new RefusalError(
      `Refusing to create ${a.cards.length} cards in one call — a multi-create is capped at ` +
        `${MULTI_CREATE_CAP}.\n` +
        `The cap is not a page size: the whole batch is one transaction, so creating the first ` +
        `${MULTI_CREATE_CAP} and dropping the rest would report success for cards that do not exist. ` +
        `Split the list into batches of ${MULTI_CREATE_CAP} or fewer and run them one at a time.`,
    );
  }
  return a.cards.map(normalize);
}

const createRequest = (a: NormalCreateArgs) => ({
  name: a.name,
  description: a.description,
  status: a.status,
  boardId: a.board,
  tags: a.tags?.length ? a.tags : undefined,
  assignees: a.assignees?.length ? a.assignees : undefined,
  parentCardId: a.parent,
  blockedBy: a.blockedBy?.length ? a.blockedBy : undefined,
  blocks: a.blocks?.length ? a.blocks : undefined,
});

/**
 * `create` — one card, or an enumerated batch of at most `MULTI_CREATE_CAP`.
 *
 * There is no bulk route to reach for: `POST /cards/bulk` does not exist (it
 * falls through to Favro's web app and answers 200 with an HTML page, so the old
 * `response.cards` read silently created nothing), and a half-successful bulk
 * gives no per-card undo handle. So the batch is a LOOP over `txCards.create`,
 * which is what gives every created card its own compensation entry — a failure
 * on card 4 of 6 unwinds cards 1–3 as well, LIFO, and the whole thing reports
 * `rolled-back`.
 *
 * Returns the WHOLE card (or cards): the JSON a caller pipes out of
 * `cards create --json` carries `cardCommonId`, `columnId` and `sequentialId`,
 * and narrowing it here would break every reader of those. The CLI projects what
 * it prints.
 */
registerIntent<CreateArgs | MultiCreateArgs, Card | Card[]>({
  name: 'create',
  summary: 'Create a card, or an enumerated batch of at most 20, in one transaction',
  preview: (a) =>
    createEntries(a).flatMap((c) => [
      `create card "${c.name}"${c.board ? ` on board ${c.board}` : ''}${c.status ? ` in column "${c.status}"` : ''}`,
      ...(c.tags?.length ? [`  tags: ${c.tags.join(', ')}`] : []),
      ...(c.assignees?.length ? [`  assignees: ${c.assignees.join(', ')}`] : []),
      ...(c.parent ? [`  parent: ${c.parent}`] : []),
      ...(c.blockedBy?.length ? [`  blocked by: ${c.blockedBy.join(', ')}`] : []),
      ...(c.blocks?.length ? [`  blocks: ${c.blocks.join(', ')}`] : []),
    ]),
  board: async (a) =>
    createEntries(a)
      .map((c) => c.board)
      .filter((b): b is string => Boolean(b)),
  run: async (a, tx) => {
    const entries = createEntries(a);
    if (!isMulti(a)) return tx.create(createRequest(entries[0]));
    const made: Card[] = [];
    // Sequential on purpose. No added concurrency: the cap is what bounds this,
    // and a parallel batch would make "which cards exist now" a race with the
    // compensation log.
    for (const entry of entries) made.push(await tx.create(createRequest(entry)));
    return made;
  },
});

export interface DeleteArgs {
  card: string;
}

export interface DeleteResult {
  /** The instance actually deleted, not the reference we were handed. */
  cardId: string;
  /** The board it was on. Absent only when no scope lock forced us to have one. */
  boardId?: string;
}

/**
 * `delete` — remove ONE board instance of a card. Irreversible, and terminal.
 *
 * **Instance, not card.** Favro keys `DELETE /cards/{cardId}` on the instance id
 * and removes every instance only under `?everywhere=true`, which `CardsAPI
 * .deleteCard` does not send (`docs/research/card-identifier-semantics.md` §2.1;
 * the probe wave in `tracker-contract-favro-carriers.md` had to pass it
 * explicitly to make throwaway cards vanish org-wide). Claiming FORKS a card, so
 * "the card" routinely has more than one instance, and deleting the one named
 * leaves the rest — along with the comments, tasks and tasklists, which hang off
 * `cardCommonId` and survive as long as any instance does.
 *
 * `board()` is the whole guardrail. A fork has no `widgetCommonId`, so it boards
 * off `undefined` and the table's boardless-write rule refuses it under a lock —
 * `--force` deliberately does not rescue that, because there is no board for the
 * escape hatch to escape.
 *
 * `terminal: true` and NO compensation entry: see `TxCards.deleteCard`. The
 * delete is the last statement in `run` for the `depthAtEntry` reason documented
 * there — nothing after it may refuse.
 */
registerIntent<DeleteArgs, DeleteResult>({
  name: 'delete',
  summary: 'Delete one board instance of a card — irreversible, with no compensating write',
  terminal: true,
  preview: (a) => [
    `delete card ${a.card}`,
    `  ONE board instance: other instances of the same cardCommonId are left alone`,
    `  IRREVERSIBLE — no compensating write, so no later failure can roll this back`,
  ],
  board: async (a, tx) => (await tx.getCard(a.card)).boardId,
  run: async (a, tx) => {
    const card = await tx.getCard(a.card);
    // Last statement, deliberately. Nothing may throw a RefusalError after this:
    // the delete logs nothing, so `log.depth` still equals `depthAtEntry` and the
    // table would rethrow such a refusal as a PRE-write one. See TxCards.deleteCard.
    const cardId = await tx.deleteCard(card.cardId);
    return { cardId, boardId: card.boardId };
  },
});

/**
 * `read` — one card, and optionally its children.
 *
 * List-children is FOLDED IN here rather than being an intent of its own, and
 * frontier-listing was cut entirely: `--filter` subsumes it, and a second read
 * intent would be a second place for the read shape to drift.
 *
 * The children listing is a client-side pass over ONE board read. There is no
 * proven `parentCardId` filter on `GET /cards` — an unproven parameter is
 * ignored without complaint by this API, which would answer "every card on the
 * board" as if it were "the children" — and hierarchy is same-board only
 * (`parentCardId` is never cross-board), so the board read is complete by
 * construction **provided the card has a board instance at all**. That
 * precondition is not decoration: `listCards(undefined)` omits `widgetCommonId`
 * from the query and paginates the whole ORGANISATION to completion, which is
 * exactly the unbounded sweep this build refuses. A card with no
 * `widgetCommonId` — a fork — therefore refuses before the list.
 *
 * Skill args are STRINGS, and `read` is reachable as a skill step, so `children`
 * and `limit` are coerced rather than trusted: `children: "false"` is truthy in
 * JS and would have listed children anyway — a silent wrong answer — and `limit`
 * only ever worked by accident, via coercion inside `capRows`.
 *
 * The card comes back BARE and the children come back in the envelope: singles
 * are bare, list reads are always an envelope. `children` is present exactly
 * when it was asked for, so the shape follows the REQUEST and never the data.
 */
export interface ReadArgs {
  card: string;
  /** Also list the cards whose `parentCardId` is this card. */
  children?: boolean | string;
  /** Output cap on the children rows only. Never truncates the fetch. */
  limit?: number | string;
}

/**
 * A skill step spells every arg as a string, so `"false"`, `"0"` and `""` must
 * all mean false — in JS they are all truthy as strings. Anything else that is
 * present means true, which is what a bare CLI flag already means.
 *
 * `read`'s two call sites ONLY, and the leniency is why. A flag that only ever
 * gates extra output can safely read anything-present as true; a DIRECTION
 * argument for a mutation cannot, because the same leniency turns an
 * unrecognised spelling into the opposite write. `archive` used to share this
 * and does not any more — see `archiveDirection`.
 */
const truthyArg = (v: boolean | string | undefined): boolean =>
  typeof v === 'string' ? !['', 'false', '0', 'no'].includes(v.trim().toLowerCase()) : v === true;

/** `"2"` is a limit of 2. Anything that is not a positive integer is no cap. */
function readLimit(v: number | string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) {
    throw new RefusalError(
      `--limit must be a positive whole number; got "${v}". ` +
        `It caps the printed rows, never the fetch — omit it to print every row.`,
    );
  }
  return n;
}

export interface ReadResult {
  card: Card;
  children?: ListEnvelope<Card>;
}

registerIntent<ReadArgs, ReadResult>({
  name: 'read',
  summary: 'Read one card, optionally with its children',
  preview: (a) => [`read ${a.card}${truthyArg(a.children) ? ' and list its children' : ''}`],
  // A read lands no write, so the scope lock has nothing to check. The lock
  // guards mutation; making it guard reads would break `read` on any card
  // outside the locked collection, which is the opposite of honest failure.
  // Declared, not inferred — a boardless WRITE is refused under a lock, and
  // this is the one intent that has earned the exemption.
  readOnly: true,
  board: async () => undefined,
  run: async (a, tx) => {
    const limit = readLimit(a.limit);
    const card = await tx.getCard(a.card);
    if (!truthyArg(a.children)) return { card };
    if (!card.boardId) {
      // `boardId` is our alias for `widgetCommonId`, and a fork has none. Listing
      // without it is not "the board" — it is every card in the organisation,
      // paginated to completion, then filtered client-side. Refuse instead, and
      // lose nothing: a card with no board instance has no children by
      // construction, because `parentCardId` is same-board only.
      throw new RefusalError(
        `Cannot list the children of ${a.card}: it has no board instance (no widgetCommonId), ` +
          `which is what an assignment fork looks like.\n` +
          `Hierarchy is same-board only, so a card off every board has no children to list. ` +
          `Read the board-resident instance of this card instead — 'favro cards get <cardCommonId>' ` +
          `names the instances — or drop --children.`,
      );
    }
    // A single-call read THROWS on failure rather than answering empty, so an
    // empty `rows` here unambiguously means the card has no children.
    const onBoard = await tx.listCards(card.boardId);
    const children = onBoard.filter((c) => c.parentCardId === card.cardId);
    return { card, children: capRows(children, limit) };
  },
});

/**
 * `remove-blocking-edge` — the 7th intent, tx-instrumented over the verified
 * `unlinkCard`.
 *
 * Public and named rather than reachable-but-unnamed as `cards unlink` alone:
 * that would split tracker vocabulary from command vocabulary at exactly one
 * point, and the workaround for that gap is guessing. It is also the step the
 * `add-blocking-edge` reverse-edge refusal has to be able to name.
 */
export interface EdgeArgs {
  card: string;
  blockedBy: string;
}

registerIntent<EdgeArgs, { removed: boolean; isBefore?: boolean }>({
  name: 'remove-blocking-edge',
  summary: 'Remove the blocking edge between two cards',
  preview: (a) => [`remove the edge where ${a.blockedBy} blocks ${a.card}`],
  board: async (a, tx) => (await tx.getCard(a.card)).boardId,
  run: (a, tx) => tx.removeBlockingEdge(a.card, a.blockedBy),
});

/**
 * The pair already holds the edge the OTHER way round.
 *
 * Favro stores at most one edge per card pair — undirected identity, directed
 * semantics — so this pair can never accept the forward edge, and there is no
 * overwrite path. Reading the wire's `403 Dependency already exists` as success
 * here would claim `A blocks B` while the wire says `B blocks A`, which is why
 * the flipped write is REFUSED rather than applied.
 */
export class ReverseEdgeError extends RefusalError {
  constructor(readonly card: string, readonly blockedBy: string) {
    super(
      `Refusing to record "${blockedBy} blocks ${card}": the pair already holds the REVERSE edge — ` +
        `${card} blocks ${blockedBy}.\n` +
        `Favro stores at most one edge per card pair (undirected identity, directed semantics), so this ` +
        `pair can never accept the forward edge and there is no overwrite path — reversing is ` +
        `delete-then-add.\n` +
        `To reverse it, run the 'remove-blocking-edge' intent on this pair first, then add this one.`,
    );
    this.name = 'ReverseEdgeError';
  }
}

export interface AddedEdge {
  /** False when the edge was already there. "Created" and "already there" stay distinguishable. */
  created: boolean;
  card: string;
  blockedBy: string;
}

/**
 * `add-blocking-edge` — idempotent by verification, so retrying after a failure
 * is safe.
 *
 * ONE bounded GET on ONE card settles it (Favro mirrors the edge set, and
 * `GET /cards` inlines it): the exact edge present means no write at all, the
 * reverse edge is a structured refusal, and only "neither" writes. That also
 * repairs the rollback contract rather than narrowing it — after a
 * `rollback-incomplete` orphan, the retry's pre-read finds its own edge and
 * answers `ok`.
 *
 * The race window — someone creates the pair between the pre-read and the write
 * — falls through to exactly ONE re-read, in the `conflict` catch below.
 */
registerIntent<EdgeArgs, AddedEdge>({
  name: 'add-blocking-edge',
  summary: 'Record that one card blocks another, idempotently, after a bounded pre-read',
  preview: (a) => [
    `add the edge where ${a.blockedBy} blocks ${a.card}`,
    `  (pre-read first: an existing edge is reported, not rewritten; the reverse edge refuses)`,
  ],
  board: async (a, tx) => (await tx.getCard(a.card)).boardId,
  run: async (a, tx) => {
    const cardId = await tx.resolveCardId(a.card);
    const farId = await tx.resolveCardId(a.blockedBy);
    const settled = (isBefore: boolean): AddedEdge => {
      // `isBefore` describes the FAR card relative to the card queried, so true
      // is "the far card comes before us", i.e. it blocks us.
      if (!isBefore) throw new ReverseEdgeError(cardId, farId);
      return { created: false, card: cardId, blockedBy: farId };
    };

    const existing = await tx.liveEdge(cardId, farId);
    if (existing) return settled(existing.isBefore);

    try {
      await tx.addBlockingEdge(cardId, farId);
      return { created: true, card: cardId, blockedBy: farId };
    } catch (error) {
      // `403 Dependency already exists` is the ONLY thing the race can look
      // like, and it is not success: it fires for an exact duplicate, for a
      // flipped write, and from the mirror end alike. So re-read once and let
      // the wire say which of those it was.
      if (classifyThrownError(error)?.kind !== 'conflict') throw error;
      const raced = await tx.liveEdge(cardId, farId);
      // A conflict with no edge to show for it is not an answer we can invent.
      if (!raced) throw error;
      return settled(raced.isBefore);
    }
  },
});

// ─── the tracker-board instance rule ─────────────────────────────────────────

/**
 * The instance of a card that lives on the tracker board, or a refusal.
 *
 * This is load-bearing rather than defensive: claiming FORKS the card —
 * `addAssignmentIds` produces a second to-do-list entity with no
 * `widgetCommonId` and no `columnId` — and a fork cannot be moved to a column it
 * does not have. The write path itself needs no ruling, because it acts on the
 * `cardId` handed to it.
 *
 * What enforces the rule is the `card.boardId === boardId` check BELOW, on the
 * card we read back — not the resolution. `resolveCardId` narrows by board only
 * for a sequential reference; a `cardId` or `cardCommonId` is returned unchanged
 * (`CardReferences.toCardId`). The board is therefore threaded into the read as
 * well, so a `cardCommonId` that exists on two boards settles on the tracker's
 * instance instead of escalating into an ambiguity refusal that tells the caller
 * to pass a `--board` flag these intents do not have.
 */
async function trackerCard(tx: TxCards, ref: string, tracker: VerifiedTracker): Promise<Card> {
  const boardId = tracker.mapping.boardId;
  // A sequential reference settles against the tracker board directly, and
  // entities with no `widgetCommonId` (the forks) never take part.
  const cardId = await tx.resolveCardId(ref, { widgetCommonId: boardId });
  const card = await tx.getCard(cardId, { board: boardId });
  if (card.boardId === boardId) return card;
  throw new RefusalError(
    `Card ${cardId} is not on the tracker board (${boardId}) — it is ` +
      `${card.boardId ? `on board ${card.boardId}` : 'a fork: an assignment entity with no board and no column'}.\n` +
      `Refusing to claim or resolve it there: the tracker's active/done columns belong to ${boardId}, and a ` +
      `card that is not on that board has nowhere to be moved to.\n` +
      `Move the card to the tracker board first, or pass the reference of its tracker-board instance.`,
  );
}

export interface CardArgs {
  card: string;
  /** Whom to assign. Defaults to the caller. Accepts a name, an email or a userId. */
  assignee?: string;
}

/**
 * `claim` — assign the caller and move the card to the mapped `active` column,
 * in one call.
 *
 * The assignment goes out as `addAssignmentIds` and removes nobody: `assignees`
 * is a silent no-op on both verbs, and a whole-array replacement would unassign
 * everyone already on the card.
 */
registerIntent<CardArgs, { cardId: string; columnId?: string; assignee: string }>({
  name: 'claim',
  summary: 'Assign yourself to a card and move it to the tracker\'s active column',
  preview: (a) => [`claim ${a.card} for ${a.assignee ?? '@me'} and move it to the tracker's active column`],
  board: async (_a, tx) => (await tx.tracker()).mapping.boardId,
  run: async (a, tx) => {
    const tracker = await tx.tracker();
    const card = await trackerCard(tx, a.card, tracker);
    const userId = await tx.resolveAssignee(a.assignee ?? '@me');

    const current = card.assignees ?? [];
    if (!current.includes(userId)) await tx.setAssignees(card.cardId, [...current, userId]);
    const moved = await tx.moveColumn(card.cardId, tracker.mapping.columns.active);
    return { cardId: card.cardId, columnId: moved.columnId, assignee: userId };
  },
});

/** `resolve` — move the card to the mapped `done` column. Finishing is one turn. */
registerIntent<CardArgs, { cardId: string; columnId?: string }>({
  name: 'resolve',
  summary: 'Move a card to the tracker\'s done column',
  preview: (a) => [`move ${a.card} to the tracker's done column`],
  board: async (_a, tx) => (await tx.tracker()).mapping.boardId,
  run: async (a, tx) => {
    const tracker = await tx.tracker();
    const card = await trackerCard(tx, a.card, tracker);
    const moved = await tx.moveColumn(card.cardId, tracker.mapping.columns.done);
    return { cardId: card.cardId, columnId: moved.columnId };
  },
});

export interface RetagArgs {
  card: string;
  category?: string;
  state?: string;
}

// `foldName`: `tag` is either typed by the caller or read off the card, and the
// vocabulary is authored in the tracker config — three places one name can be
// spelled in two normalisation forms (#141).
const inVocabulary = (vocabulary: readonly string[], tag: string): string | undefined =>
  vocabulary.find((role) => foldName(role) === foldName(tag));

/** One axis: the role being written, or the one already on the card. */
function settleAxis(
  axis: 'category' | 'state',
  vocabulary: readonly string[],
  requested: string | undefined,
  onCard: string[],
  cardId: string,
): string {
  if (requested !== undefined) {
    // Refused in CLI code, never sent: on a write Favro reads an unknown name as
    // a tag CREATION, which either invents a tag or 403s on a key without that
    // permission. Neither is an answer an agent can act on.
    const known = inVocabulary(vocabulary, requested);
    if (!known) {
      throw new RefusalError(
        `"${requested}" is not a ${axis} role. The tracker's ${axis} vocabulary is: ${vocabulary.join(', ')}.\n` +
          `Refusing to write it: an unknown name on a tag write is a tag creation, not a match.`,
      );
    }
    return known;
  }
  if (onCard.length === 1) return onCard[0];
  throw new RefusalError(
    onCard.length === 0
      ? `Card ${cardId} carries no ${axis} tag, and none was given. The triage vocabulary requires exactly ` +
        `one ${axis} role and one of the other axis. Pass --${axis} <${vocabulary.join('|')}>.`
      : `Card ${cardId} carries ${onCard.length} ${axis} tags (${onCard.join(', ')}) — the triage vocabulary ` +
        `allows exactly one. Pass --${axis} <${vocabulary.join('|')}> to say which one stays.`,
  );
}

/**
 * `retag` — exactly one category role and exactly one state role.
 *
 * Nothing structural enforces one-of-each on a Favro tag, so the mutual
 * exclusion is enforced here or nowhere. Tags outside the two axes (a
 * `wayfinder:*` tag, anything a human added) are carried through untouched —
 * this writes a role swap, not a whole-array replacement of the card's tags.
 */
registerIntent<RetagArgs, { cardId: string; category: string; state: string; tags: string[] }>({
  name: 'retag',
  summary: 'Set the triage roles on a card — exactly one category, exactly one state',
  preview: (a) => [
    `retag ${a.card}${a.category ? ` category=${a.category}` : ''}${a.state ? ` state=${a.state}` : ''}`,
  ],
  board: async (a, tx) => (await tx.getCard(a.card)).boardId,
  run: async (a, tx) => {
    const card = await tx.getCard(a.card);
    const current = card.tags ?? [];

    const held = (vocabulary: readonly string[]) =>
      current.map((t) => inVocabulary(vocabulary, t)).filter((t): t is string => Boolean(t));
    const category = settleAxis('category', CATEGORY_TAGS, a.category, held(CATEGORY_TAGS), card.cardId);
    const state = settleAxis('state', STATE_TAGS, a.state, held(STATE_TAGS), card.cardId);

    const others = current.filter((t) => !inVocabulary(CATEGORY_TAGS, t) && !inVocabulary(STATE_TAGS, t));
    const tags = [...others, category, state];
    // `setTags` owns the diff, the name/id keyspace and the unknown-name refusal
    // (via `CardsAPI.tagReplacement`) — a second tag resolver here would be a defect.
    await tx.setTags(card.cardId, tags);
    return { cardId: card.cardId, category, state, tags };
  },
});

export interface ArchiveArgs {
  card: string;
  /**
   * `true` archives, `false` un-archives. REQUIRED, and strictly two-valued —
   * see `archiveDirection`. A skill step spells every arg as a string, so
   * `"true"` / `"false"` are accepted; nothing else is, in either type.
   */
  archived: boolean | string;
}

/**
 * Which side of the archive line this call is asking for. **Strictly
 * two-valued**, and everything else REFUSES.
 *
 * Absent refuses rather than defaulting. `false` is not a safe default here: it
 * is a write of its own, so an omitted arg on a skill step would silently
 * UN-archive a card nobody asked about. One intent with a direction still has to
 * be told the direction.
 *
 * `truthyArg` is deliberately NOT used, though it once was. It is a lenient
 * read-FLAG parser — "anything present means true, like a bare CLI flag" — which
 * is harmless on `read`'s `children` (no write either way) and inverts a write
 * here. Its non-string arm is `v === true`, so `archived: 1` — a JSON caller
 * spelling true the C way — parsed as FALSE and un-archived the card, as did
 * `null`; and its string arm let `"off"` and `"nope"` ARCHIVE one. A direction
 * argument for a mutation gets no leniency: an unrecognised spelling is a call to
 * repair, not a value to guess at.
 *
 * `"1"` / `"0"` are refused too, not accepted as a convenience. Accepting the
 * strings while the numbers refuse is exactly the kind of asymmetry that produced
 * the bug, and no caller spells it that way — the CLI passes real booleans and
 * every doc surface says `true` / `false`.
 */
function archiveDirection(v: unknown): boolean {
  if (v === true || v === false) return v;
  if (typeof v === 'string') {
    const spelled = v.trim().toLowerCase();
    if (spelled === 'true') return true;
    if (spelled === 'false') return false;
  }
  throw new RefusalError(
    `The "archive" intent needs 'archived: true' or 'archived: false'; got ${JSON.stringify(v)}.\n` +
      `Accepted, and nothing else: the booleans true / false, or the strings "true" / "false" ` +
      `(case and surrounding space are ignored, because a skill step spells every arg as a string).\n` +
      `It is ONE intent carrying a direction, not two — 'archive' and 'unarchive' are two CLI ` +
      `spellings of it, because Favro has ONE wire op here (PUT {archive: boolean}), unlike ` +
      `link/unlink which are a POST and a DELETE.\n` +
      `Nothing here is guessed at: defaulting an absent value to false would un-archive the card, ` +
      `and reading an unrecognised value as either side would write the direction you did not ask for.`,
  );
}

/**
 * `archive` — move ONE board instance of a card across the archive line, either
 * way.
 *
 * ONE intent taking a boolean, not two intents. `add-blocking-edge` /
 * `remove-blocking-edge` are two because they are two wire ops (POST and
 * DELETE); this is one wire op with a boolean argument — `PUT {archive: …}` —
 * and two names for one write would be two places for it to drift. The CLI still
 * spells it twice (`cards archive` / `cards unarchive`), the same way
 * `cards link` / `cards unlink` read better than a flag.
 *
 * **NOT `terminal`.** Unlike `delete` (#73), this is measured reversible in both
 * directions (#75), so it carries a real compensation entry and composes into a
 * larger transaction — including as a skill `command:` step.
 *
 * The write field is `archive` and the read-back field is `archived`; `PUT
 * {archived: …}` answers 200 and writes nothing. `TxCards.setArchived` owns that
 * asymmetry, and nothing here restates it.
 */
registerIntent<ArchiveArgs, { cardId: string; archived: boolean }>({
  name: 'archive',
  summary: 'Archive a card, or un-archive it — reversible, so it carries a compensating write',
  // Conditional wording, because `preview` is a pure function of its args by
  // design — no read, exactly as `delete`'s preview makes none — so it cannot
  // know which side of the line the card is already on. A card already archived
  // is left alone and logs nothing (`TxCards.setArchived`), so the flat
  // "archive card X / a later failure moves it back" this used to print asserted
  // two things it could not see: that a write would happen, and that a
  // compensation entry would exist to reverse. Both phrasings below stay true
  // whichever side the card is on. Adding a read to fix it was rejected:
  // read-free preview is the deliberate property.
  preview: (a) => {
    const wanted = archiveDirection(a.archived);
    const verb = wanted ? 'archive' : 'un-archive';
    return [
      `${verb} card ${a.card}, unless it is already ${wanted ? 'archived' : 'un-archived'}`,
      `  reversible: if it does write, a later failure in the same transaction moves it back`,
    ];
  },
  board: async (a, tx) => (await tx.getCard(a.card)).boardId,
  run: async (a, tx) => {
    const archived = archiveDirection(a.archived);
    const card = await tx.setArchived(a.card, archived);
    // The OBSERVED side, never the requested one. `setArchived` already threw if
    // the write did not take, so these agree — but reporting the argument back
    // would make the CLI's "✓ Card X is archived" a claim about the argument, in
    // the one feature whose whole premise is 200-and-nothing writes.
    return { cardId: card.cardId, archived: card.archived === true };
  },
});
