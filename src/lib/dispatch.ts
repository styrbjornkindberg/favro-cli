/**
 * The shared dispatch table (#51).
 *
 * The CLI's card-write actions and the skill engine call ONE table — structured
 * args-in / result-out — so they cannot drift apart on guardrails.
 *
 * **WHAT ROUTES HERE, AND WHAT DOES NOT.** This module claimed its guardrails
 * held "on every path — including the skill engine's and the MCP passthrough's"
 * (at the `assertScope` call below) until #111, and a `git grep` falsifies that
 * twice: 26 guard call sites live outside this table, and the MCP passthrough has
 * no path into this table at all. What is measured on HEAD:
 *
 * - **Every write to the CARD ENTITY routes.** Seven methods issue one, and none
 *   has a production caller outside `tx-cards.ts`: `CardsAPI`'s `createCard`,
 *   `updateCard`, `deleteCard`, `moveCard`, `linkCard`, `unlinkCard`, plus
 *   `WidgetsAPI.addWidgetToBoard`, which is the `PUT /cards/{id}` behind
 *   `add-board-instance`. A `TxCards` is constructed in exactly one production
 *   place — `dispatch()` below — and handed to nothing but an intent's own
 *   `board()` and `run`, the first of which sees only its `ReadTx` face (#107).
 *   So no card write outside the table exists today — but `CardsAPI`'s writes
 *   stay REACHABLE: `run.ts:93` puts a live one on `ctx.api.cards` for every
 *   `run()`-wrapped command, so this is a measured fact held by review, not a
 *   structural impossibility. (`write-echo-wire.test.ts` discharges that class by
 *   DELETING the method; these seven cannot go, because `TxCards` needs them.)
 *   There is no pending exception to name either: `favro execute` was the eighth
 *   unrouted write path, and ADR-0004 (#96) had it DELETED rather than routed, so
 *   #112 closed without work; #124 did the deleting at `0a963a6`.
 * - **The callers are `cli.ts`, eight modules under `src/commands/`, and
 *   `skill-engine.ts`.** Neither MCP server is one of them: neither WRITES except
 *   by shelling `favro …` (`mcp-server.ts`, `execFile`), so MCP re-enters through
 *   the CLI path it names and inherits exactly what that path does — it has no
 *   route of its own into this table to be guarded separately. (`mcp-http-server`
 *   does build a client of its own, for one read: `GET /organizations`, to settle
 *   which org a request belongs to.)
 * - **Writes to a card's SUB-RESOURCES and to everything that is not a card do
 *   NOT route here** — comments, tasks, tasklists, attachments, boards, columns,
 *   members, collections. They take a guard at their own call sites, and the
 *   census is 26 to this table's 1 (all counts `git grep`-able, production only,
 *   `safety.ts` itself excluded): `checkScope` ×6, `checkResolvedScope` ×12 —
 *   which is `checkScope` behind a thunk, so 18 reach the same `assertScope` —
 *   `checkCollectionScope` ×5, which compares against local config and resolves
 *   no board, so it is NOT the same function underneath, and `assertOrgScope` ×3.
 *   Org-wide writes — tags, user groups, webhooks, `collections create` — land on
 *   no board for a collection lock to resolve at all; the three irreversible ones
 *   take `assertOrgScope`, four of the other six rest on `confirmAction` alone,
 *   and `webhooks create` / `collections create` carry no prompt either — both
 *   additive. `scope-lock-coverage.test.ts` holds that partition, and its debt
 *   list is empty, so nothing is unguarded by oversight.
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
import { classifyThrownError, failureMessage, isTransientStatus, isWireFailure } from './favro-error';
import { foldName } from './fold-name';
import { CompensationLog, Orphan, ReadTx, TxCards, TxOutcome } from './tx-cards';
import { CommittedWidget } from './widgets-api';
import { CATEGORY_TAGS, STATE_TAGS, VerifiedTracker } from './tracker-config';
import { RefusalError, TransientError } from './refusal';
import { capRows, ListEnvelope, parseLimit } from './read-shape';

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
   * is what let three sites drift apart in #66. It is `retryAdvice` — the gate
   * and the derivation in one expression, shared verbatim with `run.ts`'s error
   * boundary and the skill engine's end-of-run unwind, so the three cannot drift
   * again (ADR-0002, "Two populations").
   *
   * Nothing in this codebase LOOPS on it: every reader prints advice or emits it
   * in the machine envelope. The reader that acts on it is the agent, which the
   * help topic tells to obey the field — which is why a wrong `true` is the
   * expensive direction.
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
 * Everything an intent declares that does not depend on whether it writes.
 * Not exported: `Intent` below is the type callers name.
 */
interface IntentCore<A> {
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
   *
   * `ReadTx` on BOTH arms, `readOnly` or not (#107). `board()` runs BEFORE
   * `assertScope`, so a write made from here would never be checked against the
   * lock at all — it would be the one write in the table that the mandatory
   * guardrail structurally cannot see. No intent writes in `board()` today; now
   * none can.
   */
  board: (args: A, tx: ReadTx) => Promise<string | string[] | undefined>;
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
}

/**
 * One named intent. Declared once, registered against the one table.
 *
 * `run` receives a tx facade and nothing else — no client, no config, no
 * `CardsAPI` — so an un-instrumented write from an intent is unconstructible.
 *
 * **WHICH facade follows `readOnly`, and that is why this is a UNION** rather
 * than one interface with an optional flag (#107). `readOnly: true` gets
 * `ReadTx`, on which no write exists, so the declaration is a compile-time
 * guarantee instead of a promise. It was load-bearing while it was still only a
 * promise: `readOnly` is what skips the boardless-write refusal below, so an
 * intent that declared it falsely took the exemption from the scope lock AND
 * made the write it promised not to.
 *
 * `board` and `run` are function-typed PROPERTIES, not methods, and that is
 * load-bearing too. Method-syntax parameters stay bivariant even under
 * `strictFunctionTypes`, so a `readOnly` arm declaring `run(a, tx: ReadTx)`
 * would still accept an implementation annotated `(a, tx: TxCards)` — the whole
 * write surface back, for the price of one type annotation. A property is
 * contravariant in its parameters, which refuses that.
 *
 * `readOnly?: undefined` on the write arm rather than an omitted field: it is
 * what makes `readOnly` a discriminant, so an object literal declaring
 * `readOnly: true` cannot fall through to the arm whose `run` takes `TxCards`.
 * Absent still means "this writes", which stays the fail-closed default a new
 * intent inherits with nothing to remember.
 */
export type Intent<A = any, R = unknown> =
  | (IntentCore<A> & {
      /**
       * This intent writes NOTHING, so the scope lock has nothing to guard and
       * no board is required. Declared per intent, never inferred: an intent
       * that yields no board is otherwise unlockable, and defaulting to
       * "unlocked" is how a fork card slipped a write past the lock.
       */
      readOnly: true;
      run: (args: A, tx: ReadTx) => Promise<R>;
    })
  | (IntentCore<A> & {
      readOnly?: undefined;
      run: (args: A, tx: TxCards) => Promise<R>;
    });

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
 * the message is one it recognises, the fail-closed arm.
 *
 * A response whose message it cannot name is decided by STATUS, through
 * `isTransientStatus` — the same expression `HttpClient` retries on, so what we
 * retry and what we advertise as retryable are one set (#162). A timeout or a
 * bug of our own reaches no status at all and keeps the
 * rolled-back-is-retryable reading: the world is genuinely back where it
 * started, and the next attempt may well behave differently.
 *
 * That last reading is only sound for a failure that came off the WIRE, where
 * unclassifiable means a wire hiccup. Nothing calls this function raw for that
 * reason — every caller goes through `retryAdvice` below, which owns the gate.
 */
export function isRetryable(outcome: TxOutcome, error: unknown): boolean {
  if (outcome !== 'rolled-back') return false;
  if (error instanceof RefusalError) return false;
  const kind = classifyThrownError(error)?.kind;
  // `undefined` is "no HTTP response to classify" — the transient family.
  // `none` cannot reach here. `unknown` is "a response we cannot name from its
  // message", and it used to be read as transient too: that is what put
  // `"retryable": true` on `400 "Card can't have more than 1024 characters."`,
  // measured live and identical on both runs (#162). The status decides it now.
  if (kind === undefined || kind === 'none') return true;
  if (kind !== 'unknown') return false;
  return isTransientStatus((error as { response?: { status?: number } } | null | undefined)?.response?.status);
}

/**
 * **The retry advice.** One expression, every caller — the gate and the
 * derivation behind it (#134, #151, and #151's carried-forward half).
 *
 * The rule: *the wire is the gate, the table runs behind it*, and the ONE
 * exemption is a failure whose site measured it transient and said so with a
 * `TransientError`. Unknown therefore means deterministic-until-proven-
 * otherwise, everywhere — a wrong `false` costs one honest failure, a wrong
 * `true` costs an agent looping on a call that can never succeed.
 *
 * This used to be three expressions for one rule, and the third was the odd one
 * out: `dispatch` asked `isRetryable` RAW, on the theory that its population is
 * narrow enough for unclassifiable to mean "wire hiccup". Narrow is not the same
 * as clean — `intent.run` is our code, so a `TypeError` of ours raised in there
 * came back `retryable: true`, which is #134's `--include bogus` bug wearing the
 * table's clothes. The reason it survived #151 was the fear that inverting the
 * default would break the in-process failures that ARE transient; the
 * enumeration says that population is two throw sites, both read-backs in
 * `TxCards` (`setArchived` and `moveColumn`, see `TransientError`), so the
 * marker costs one line each and the default gets to be fail-closed.
 *
 * `isWireFailure` FIRST is not decoration: it is what keeps a deterministic
 * error of ours out of `isRetryable`'s unclassifiable-is-transient arm at all.
 * `isRetryable` still decides which HTTP failures are deterministic, so the
 * question the three sites genuinely share stays shared and #66 stays closed.
 */
export const retryAdvice = (outcome: TxOutcome, error: unknown): boolean =>
  (isWireFailure(error) || error instanceof TransientError) && isRetryable(outcome, error);

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

  // The mandatory guardrail. `assertScope` has exactly ONE production caller
  // outside `safety.ts`, and this line is it — so every intent takes the
  // identical check whether the CLI dispatched it or a skill step did. It is not
  // every write PATH in the CLI, and the header says which ones it is not.
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
    //
    // `isWireFailure` is what keeps a 2xx denial OUT of that fast path (#165).
    // `RefusalError` carries two claims — deterministic, and nothing was written —
    // and this line reads the second. A `WireRefusalError` only satisfies the
    // first: measured 2026-08-14, `PUT {name, columnId:<bogus>}` answers
    // `202 {"message":"Invalid column"}` and the name changes anyway, so a 202 means
    // "at least one field was refused", never "nothing happened". Taking the fast
    // path on one would propagate a partial write with the transaction's earlier
    // steps left standing, which is this ticket's own defect class wearing the
    // repair's clothes. Unwinding cannot recover the applied half either — it was
    // never logged — and `WireRefusalError`'s message says so; what it does recover
    // is everything the transaction wrote before the denial.
    if (error instanceof RefusalError && !isWireFailure(error) && log.depth === depthAtEntry) {
      throw error;
    }
    // Unwind the WHOLE log, not just this invocation's entries: when a caller
    // threads one log through several dispatches, a late failure has to undo the
    // early writes too, or "rolled-back" would be a lie about the run.
    const { outcome, orphans } = await log.unwind();
    return {
      intent: name,
      outcome,
      retryable: retryAdvice(outcome, error),
      // `failureMessage`, not `error.message`: the raw axios sentence names a
      // status code and nothing else, and it is what `widgets add` leaked as
      // `"error":"Request failed with status code 403"` while every read command
      // said `Favro said "Access denied" …` for the same response (#162 item 8).
      error: failureMessage(error),
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
 * How many cards one enumerated multi-WRITE may touch. Over the cap the intent
 * REFUSES — it never writes the first 20 and drops the rest, because a partial
 * batch that reports success is exactly the silent-wrong-answer class this build
 * exists to close.
 *
 * ONE declaration, deliberately: a second constant for the next batched write
 * would be a second number to keep in step with this one's refusal wording. The
 * argument is transaction integrity, which is a property of the batch and not of
 * the verb, so the name is the verb-neutral one (#107) — and `boundEntries` below
 * makes the WORDING verb-neutral too, now that `create` is not the only reader
 * (#108).
 */
export const MULTI_WRITE_CAP = 20;

/**
 * The enumerated list a multi-write will touch, bounded, or a refusal.
 *
 * One helper for every batched intent, because the cap and its justification are
 * one rule. `create` carried the only copy while it was the only reader; `update`
 * arriving with a second copy is how the number and — worse — the REASON drift
 * apart, and the reason is the load-bearing half: an agent that reads the cap as a
 * page size will split the batch and retry, which is correct, while one that reads
 * it as a truncation point will believe the first 20 succeeded.
 *
 * @param verb the intent's own verb, for the wording. The rule is the same for
 *   all of them; only the sentence naming what was refused differs.
 * @param noun what the entries ARE. `create` and `update` batch cards;
 *   `clear-blocking-edges` batches edges on one card (#109), and calling
 *   those "cards" would name the wrong thing in the one sentence a caller acts
 *   on. The REASON below is what must not be re-typed per intent, so only the
 *   noun moves.
 */
function boundEntries<T>(verb: string, entries: readonly T[], noun = 'cards'): readonly T[] {
  if (entries.length === 0) {
    throw new RefusalError(`Nothing to ${verb}: the enumerated ${noun.replace(/s$/, '')} list is empty.`);
  }
  if (entries.length > MULTI_WRITE_CAP) {
    throw new RefusalError(
      `Refusing to ${verb} ${entries.length} ${noun} in one call — a multi-${verb} is capped at ` +
        `${MULTI_WRITE_CAP}.\n` +
        `The cap is not a page size: the whole batch is one transaction, so writing only the first ` +
        `${MULTI_WRITE_CAP} and dropping the rest would report success for ${noun} that were never ` +
        `touched. Bring the batch to ${MULTI_WRITE_CAP} or fewer — split an enumerated list, or act ` +
        `on a derived one entry at a time — and run them separately.`,
    );
  }
  return entries;
}

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
  return boundEntries('create', a.cards).map(normalize);
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
 * `create` — one card, or an enumerated batch of at most `MULTI_WRITE_CAP`.
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
  // SETTLED, not passed through (#109). `--board` takes a NAME or an id, and
  // `assertScope` GETs `/widgets/<id>`: handed a name it 404s into "Board … not
  // found", a refusal naming the wrong problem (#82).
  //
  // UNCONDITIONAL, and `looksLikeName` is deliberately not used as a gate: it is
  // weak by design — a one-word board name ("Backlog") is shape-identical to an
  // id — so skipping the settle on it would reopen #82 for exactly the names most
  // likely to be typed.
  //
  // What it costs, measured on a socket in `git-sync-intent-wire.test.ts` and not
  // inferred: on a REAL create, nothing. `createCard`'s own `boardIdOf` settles
  // the same value through the same 15-minute name cache, so the two settlings
  // are one `/widgets` list even from cold. On a `--dry-run` with no lock it is
  // one list where there were none, because `board()` runs before the preview
  // returns — an exception to the #102/#104 pricing rule, taken because the
  // alternative is leaving #82 open on `cards create`.
  board: async (a, tx) =>
    Promise.all(
      createEntries(a)
        .map((c) => c.board)
        .filter((b): b is string => Boolean(b))
        .map((b) => tx.resolveBoardId(b)),
    ),
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
 * precondition is not decoration: a board-less list omits `widgetCommonId` from
 * the query and paginates the whole ORGANISATION to completion, which is exactly
 * the unbounded sweep this build refuses. A card with no `widgetCommonId` — a
 * fork — therefore refuses before the list.
 *
 * The precondition STAYS, and is no longer the only thing holding the sweep back
 * (#107). `TxCards.listCards` now takes a required non-empty board and refuses an
 * empty one, so the sweep is unreachable from the facade rather than merely
 * unreached. The refusal here is kept because it answers a different question and
 * says so: a fork has no children by construction, so this is an honest empty
 * answer's refusal, not a boundedness one, and it names the instance to read
 * instead.
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

/**
 * `"2"` is a limit of 2. An absent or empty `limit` is no cap; anything else
 * that is not a positive whole number is a refusal.
 *
 * The STRING arm is `parseLimit`'s, not a second grammar. This used to be
 * `Number(v)` guarded by `Number.isInteger`, which is a *different* dialect of
 * `--limit` from the one every CLI site speaks: it read `"1e9"` as 1000000000,
 * `"0x10"` as 16 and `"5.0"` as 5, all of which `parseLimit` declines. So the
 * dispatch surface — MCP and skill steps — accepted spellings the flag refuses,
 * which is exactly the "one parser, three outcomes, no fourth" claim
 * `CONTEXT.md` makes, unmade. Found in review of #142/#143.
 *
 * A NUMBER cannot come off a flag; it only arrives from a JSON tool call, so it
 * is checked here rather than in `parseLimit`. `0` refuses on both arms —
 * `capRows` would read it as EVERYTHING (#142).
 */
function readLimit(v: number | string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  if (typeof v === 'string') return parseLimit(v);
  if (!Number.isInteger(v) || v < 1) {
    throw new RefusalError(
      `--limit takes a whole number of 1 or more — got "${v}". ` +
        `It caps the printed rows, never the fetch — omit it to print every row.`,
    );
  }
  return v;
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
  // this is the one intent that has earned the exemption. Declaring it also
  // narrows `tx` below to `ReadTx`, so the exemption and the promise behind it
  // are now the same fact rather than two that could disagree (#107).
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
    // `moved` is the card RE-READ after the write, not the PUT response, so the
    // column printed here is an observation of the card. `moveColumn` owns that
    // and threw already if the card did not land there (#101).
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
    // The re-read column, as in `claim` above — never the PUT echo.
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
    // Refused on the ROLE LIST, in CLI code, before anything is looked up: this
    // axis is a closed vocabulary and `retag` writes nothing outside it. It is
    // NOT a claim that the name is unknown to the org — that check belongs to
    // `TxCards.setTags` (via `CardsAPI.tagReplacement`), which resolves names
    // and refuses the ones the workspace does not carry. Saying otherwise sent a
    // live run to the wrong diagnosis on `wayfinder:map`, a tag that resolves
    // (#164).
    const known = inVocabulary(vocabulary, requested);
    if (!known) {
      throw new RefusalError(
        `"${requested}" is not a ${axis} role. The tracker's ${axis} vocabulary is closed: ${vocabulary.join(', ')}.\n` +
          `Refused on that list alone — nothing was looked up, so this says nothing about whether the tag exists. ` +
          `A tag outside the two axes goes on with 'cards update <card> --tags <the card's whole tag list>', ` +
          `which writes a workspace tag by name and refuses one the workspace does not carry.`,
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

/**
 * The fields `update` writes, each through the `TxCards` primitive that owns its
 * wire shape. Every one is optional; at least one has to be there.
 *
 * `status` is the column, because on a write Favro's "status" IS the column and
 * `PUT {status}` 200s and changes nothing — `moveColumn` owns that. `dueDate` is
 * deliberately absent: see the seam note on the intent below.
 */
export interface UpdateArgs {
  card: string;
  name?: string;
  description?: string;
  /** Column name or `columnId`, resolved against the card's own board. */
  status?: string;
  /** A bare string is one item, never a string to iterate. See `oneOrMany`. */
  tags?: string[] | string;
  /** A name, an email, a `userId` or `@me` — resolved here, not by the caller. */
  assignees?: string[] | string;
  /**
   * ONE custom field, by `customFieldId`, and the value to put in it — an option
   * NAME for a select, a URL for a link, a numeric string for a number.
   *
   * The value is resolved against the field's own DEFINITION inside the intent
   * (`TxCards.customFieldWrite`), never by the caller: an option name has to
   * become `[optionId]` before it reaches the wire, and which payload key the
   * value goes under is a property of the field's type.
   *
   * One, not a list, because one is what `custom-fields set` writes and a list is
   * not needed yet. A second field on the same card is a second `update`.
   */
  customField?: { field: string; value: string };
  /**
   * `YYYY-MM-DD` or a full ISO timestamp; `null` clears it. `""` is REFUSED by
   * `TxCards.setDueDate` — a measured silent no-op (#106) — rather than
   * forwarded, so an empty CSV cell has to be dropped by its caller, not passed
   * through as "clear this".
   */
  dueDate?: string | null;
}

/** The multi form: an ENUMERATED list, never a derived one — as `create`'s is. */
export interface MultiUpdateArgs {
  cards: UpdateArgs[];
}

export interface UpdateResult {
  cardId: string;
  /** The fields this entry actually wrote, in the order they went out. */
  wrote: string[];
}

const isMultiUpdate = (a: UpdateArgs | MultiUpdateArgs): a is MultiUpdateArgs =>
  Array.isArray((a as MultiUpdateArgs).cards);

/** Which of the writable fields this entry names, in the order `run` applies them. */
function fieldsOf(a: UpdateArgs): string[] {
  return [
    ...(a.name !== undefined ? ['name'] : []),
    ...(a.description !== undefined ? ['description'] : []),
    ...(a.dueDate !== undefined ? ['dueDate'] : []),
    ...(oneOrMany(a.tags)?.length ? ['tags'] : []),
    ...(oneOrMany(a.assignees)?.length ? ['assignees'] : []),
    ...(a.customField ? [`customField:${a.customField.field}`] : []),
    ...(a.status !== undefined && a.status !== '' ? ['status'] : []),
  ];
}

/**
 * The entries this invocation will update, bounded, or a refusal.
 *
 * `preview`, `board` and `run` all route through here, so an entry naming no field
 * cannot be reached around — which is why the check lives here and not in the CLI.
 *
 * An entry with no field REFUSES rather than being skipped. A skipped entry inside
 * a batch is the silent-wrong-answer shape: the run would report `ok` over a card
 * it never touched, and the caller's own list is the only record of what it meant
 * to write. The CLI's old single-card path printed "Nothing to update." for this,
 * which is honest for one card and unrepresentable for twenty.
 */
function updateEntries(a: UpdateArgs | MultiUpdateArgs): readonly UpdateArgs[] {
  const entries = isMultiUpdate(a) ? boundEntries('update', a.cards) : [a];
  for (const entry of entries) {
    if (fieldsOf(entry).length === 0) {
      throw new RefusalError(
        `Nothing to update on ${entry.card}: no field was given.\n` +
          `Pass at least one of name, description, status, tags, assignees or a custom field. An entry naming no ` +
          `field is refused rather than skipped: in a batch, skipping it would report success for a ` +
          `card that was never written.`,
      );
    }
  }
  return entries;
}

/**
 * `update` — write named fields on one card, or on an enumerated batch of at most
 * `MULTI_WRITE_CAP` (#108, step 3 of #92).
 *
 * The point of registering it is everything it stops having to remember. It
 * inherits the mandatory scope lock, the boardless-write refusal, the
 * board-straddle refusal, the cap, and one compensation log — the four guardrails
 * `cards update`'s hand-rolled `api.updateCard` call had none of.
 *
 * **`board()` returns EVERY entry's board, not the first.** That is what makes a
 * batch straddling the lock refuse as a whole, before anything is written; taking
 * the first would let one in-scope entry smuggle the rest past the lock. It costs
 * one `GET /cards/{ref}` per entry, which `run` pays for again — the reads are not
 * shared because `board()` runs before `assertScope` and may not cache a decision
 * the lock has not yet approved.
 *
 * **A field per primitive, so a field per undo handle.** A failure on the third
 * field unwinds the first two, LIFO, and the invocation reports `rolled-back`. That
 * is the whole difference from the PUT it replaces: one `api.updateCard` carrying
 * five keys either lands whole or fails whole, and Favro does not say which — so a
 * partial write had no record and no inverse.
 *
 * `status` goes LAST, deliberately. It is the only field whose primitive confirms
 * its own write with a re-read (`moveColumn`, #101), so it is the one most likely
 * to raise — and raising last means the field writes before it are already logged
 * and get unwound, rather than a failed move stranding them un-recorded.
 *
 * **THE SEAM: custom fields arrived with #109, `dueDate` with #110.** `name`
 * and `description` route through `TxCards.setText`, which is #106's two methods
 * fused into one because the measurement did not split them (see its own note).
 *
 * `customField` arrived with #109 because `custom-fields set` routes here: that
 * command resolved the value and made the PUT in one un-instrumented
 * `CustomFieldsAPI.setFieldValue` call, so it had no lock, no log and no undo
 * handle. It now spends `TxCards.customFieldWrite` (the resolution, a read) and
 * `TxCards.setFieldValue` (the write, logged). Only `Single select` is measured on
 * that path (#106) and nothing here widens that — see `CustomFieldKey`.
 *
 * `dueDate` was left out of #108 because its round trip was a normalisation nobody
 * had observed: the write shape was `YYYY-MM-DD`, a card reads back a full ISO
 * timestamp (#132, 853 cards, zero date-only), and whether the WRITE side accepted
 * an ISO string was unmeasured — so a captured pre-state could not be shown to be
 * restorable. **#106 measured it and the answer is yes**: an ISO timestamp is
 * honoured and echoed verbatim, `null` clears, `""` is a silent no-op, and
 * `TxCards.setDueDate` carries a real compensation entry. It was then held back
 * from these args until a command passed one, because an arg nothing passes is a
 * surface with no caller to keep it honest. #110 is that command: `cards update
 * --from-csv` has a `due_date` column, and routing the CSV onto this intent is
 * what retires `BulkTransaction`.
 */
registerIntent<UpdateArgs | MultiUpdateArgs, UpdateResult | UpdateResult[]>({
  name: 'update',
  summary: 'Update fields on a card, or on an enumerated batch of at most 20, in one transaction',
  preview: (a) =>
    updateEntries(a).flatMap((c) => [
      `update card ${c.card}`,
      ...(c.name !== undefined ? [`  name: "${c.name}"`] : []),
      ...(c.description !== undefined ? [`  description: ${c.description.length} characters`] : []),
      ...(c.dueDate !== undefined
        ? [`  dueDate: ${c.dueDate === null ? '(cleared)' : c.dueDate}`]
        : []),
      ...(oneOrMany(c.tags)?.length ? [`  tags: ${oneOrMany(c.tags)!.join(', ')}`] : []),
      ...(oneOrMany(c.assignees)?.length ? [`  assignees: ${oneOrMany(c.assignees)!.join(', ')}`] : []),
      ...(c.customField ? [`  custom field ${c.customField.field}: "${c.customField.value}"`] : []),
      ...(c.status !== undefined && c.status !== '' ? [`  column: "${c.status}"`] : []),
      `  reversible: each field carries its own compensating write`,
    ]),
  // Every distinct board the invocation touches. `boards` is de-duplicated by the
  // table, so a batch of twenty cards on one board costs one scope check.
  board: async (a, tx) =>
    Promise.all(updateEntries(a).map(async (c) => (await tx.getCard(c.card)).boardId)).then((all) =>
      all.filter((b): b is string => Boolean(b)),
    ),
  run: async (a, tx) => {
    const entries = updateEntries(a);
    const results: UpdateResult[] = [];
    // Sequential on purpose, exactly as `create`'s batch is: the cap is what bounds
    // this, and a parallel batch would make "which fields are written now" a race
    // with the compensation log.
    for (const entry of entries) {
      // Resolved once per entry, so every primitive below writes to the same
      // instance. `setText` and the rest each re-read the card for their own
      // capture; what they must not do is re-RESOLVE a reference that could settle
      // on a different instance between two writes of one entry.
      const cardId = (await tx.getCard(entry.card)).cardId;
      const wrote: string[] = [];

      if (entry.name !== undefined) {
        await tx.setText(cardId, 'name', entry.name);
        wrote.push('name');
      }
      if (entry.description !== undefined) {
        await tx.setText(cardId, 'description', entry.description);
        wrote.push('description');
      }
      if (entry.dueDate !== undefined) {
        await tx.setDueDate(cardId, entry.dueDate);
        wrote.push('dueDate');
      }
      const tags = oneOrMany(entry.tags);
      if (tags?.length) {
        // `setTags` owns the diff, the name/id keyspace and the unknown-name
        // refusal. Whole-array semantics, as `--tags` has always had: the list
        // given is the list the card ends with.
        await tx.setTags(cardId, tags);
        wrote.push('tags');
      }
      const assignees = oneOrMany(entry.assignees);
      if (assignees?.length) {
        // Names become userIds HERE rather than in the CLI, so the skill engine and
        // the MCP passthrough get the same resolution the flag does. `setAssignees`
        // refuses a non-userId, and a name diffed raw would read as "unassign
        // everyone, add a string Favro has never seen".
        const ids = [];
        for (const one of assignees) ids.push(await tx.resolveAssignee(one));
        await tx.setAssignees(cardId, ids);
        wrote.push('assignees');
      }
      if (entry.customField) {
        // Two steps, both inside the transaction: resolve the value against the
        // field's definition (a read), then write it (instrumented). The old
        // `custom-fields set` did both inside one un-instrumented
        // `CustomFieldsAPI.setFieldValue`, which is what put this write outside
        // the seam. `key` travels with the value because the payload key follows
        // the field's TYPE — see `CustomFieldKey`.
        const { field } = entry.customField;
        const { key, value } = await tx.customFieldWrite(field, entry.customField.value);
        await tx.setFieldValue(cardId, field, value, key);
        wrote.push(`customField:${field}`);
      }
      if (entry.status !== undefined && entry.status !== '') {
        await tx.moveColumn(cardId, entry.status);
        wrote.push('status');
      }

      results.push({ cardId, wrote });
    }
    return isMultiUpdate(a) ? results : results[0];
  },
});

// ─── the board-instance intents ──────────────────────────────────────────────

export interface MoveBoardArgs {
  card: string;
  /** The destination board, by NAME or `widgetCommonId`. Settled in `board()`. */
  toBoard: string;
}

/**
 * `move-board` — take one card OFF the board it is on and put it on another.
 * The CLI surface of `cards move` (#109).
 *
 * **Two boards, both checked, both inside the intent.** `board()` returns the
 * origin AND the settled destination, and the table checks every distinct one
 * before anything is written — so a move OUT of the locked collection and a move
 * INTO it refuse alike. The destination is settled here rather than passed
 * through raw because `assertScope` GETs `/widgets/{id}`: handed a board NAME it
 * 404s into "Board … not found", a refusal naming the wrong problem (#82).
 *
 * The origin is deliberately spelled `?? ''` rather than filtered away. A card
 * with no `widgetCommonId` is an assignment fork, and `''` is what makes the lock
 * REFUSE it — filtering it out would leave the destination as the only board
 * checked, and the fork would ride in on it. `--force` does not rescue that, for
 * the reason `assertScope` gives: there is no board for the escape hatch to
 * escape.
 *
 * **`terminal: true`, and the write logs nothing** — see `TxCards.moveToBoard`.
 * The move-back is spellable but is not an inverse: the card's column on the
 * origin board is neither captured nor restorable, so `rolled-back` would be a
 * lie about where the card ended up. The move is the last statement in `run` for
 * `delete`'s `depthAtEntry` reason.
 */
registerIntent<MoveBoardArgs, Card>({
  name: 'move-board',
  summary: 'Move a card to a different board — irreversible, with no compensating write',
  terminal: true,
  preview: (a) => [
    `move card ${a.card} to board ${a.toBoard}`,
    `  it LEAVES the board it is on: this is a move, not a second instance — 'widgets add' is that`,
    `  IRREVERSIBLE here — the column it held on the old board is not captured, so no later failure can put it back`,
  ],
  board: async (a, tx) => [
    (await tx.getCard(a.card)).boardId ?? '',
    await tx.resolveBoardId(a.toBoard),
  ],
  // Last statement, deliberately: `moveToBoard` logs nothing, so `log.depth` is
  // unchanged and a RefusalError raised after it would be rethrown as pre-write.
  run: (a, tx) => tx.moveToBoard(a.card, a.toBoard),
});

export interface AddBoardInstanceArgs {
  /** The board to put the card on, by NAME or `widgetCommonId`. */
  board: string;
  /** The `cardCommonId` whose instance set gains a member. */
  card: string;
  /** Optional column on the destination board, by `columnId`. */
  column?: string;
}

/**
 * `add-board-instance` — give a card a board instance it did not have. The CLI
 * surface of `widgets add` (#109).
 *
 * **This is the fork factory, and that is why it is in the table.** A card's
 * `boardId` is its `widgetCommonId`; the boardless card `dispatch` refuses writes
 * to is a card with no instance at all. This is the one write that manufactures
 * one, so it is the one thing allowed to — outside the table it was a write that
 * created the very shape the table exists to refuse.
 *
 * **The DESTINATION board is the only one checked**, which is what the command
 * did before and is not an oversight: `dragMode: 'commit'` adds an instance and
 * leaves every existing one alone, so no other board's contents change. The card
 * argument is a `cardCommonId` and has no single board to name.
 *
 * **`terminal: true`, and the write logs nothing** — see `TxCards.commitToBoard`.
 * The inverse would be deleting the instance this created, and the new instance's
 * `cardId` is not something the response has been measured to carry.
 */
registerIntent<AddBoardInstanceArgs, CommittedWidget>({
  name: 'add-board-instance',
  summary: 'Put an existing card on another board as a new instance — irreversible',
  terminal: true,
  preview: (a) => [
    `add card ${a.card} to board ${a.board}${a.column ? ` in column ${a.column}` : ''}`,
    `  a NEW board instance: every existing instance is left where it is`,
    `  IRREVERSIBLE — the new instance's own id is not measured on this response, so nothing can name it to undo it`,
  ],
  board: async (a, tx) => tx.resolveBoardId(a.board),
  // Last statement, for `move-board`'s reason.
  //
  // The card SETTLES to a `cardCommonId` first (#162 item 8). `commitToBoard`'s
  // first step is `GET /cards?cardCommonId=<x>`, and Favro answers that with
  // `403 Access denied` for a `cardId` — so `widgets add <board> <cardId>`, with
  // the id `cards list` prints as a card's own identity, failed at an honest exit
  // code and a message about neither the card nor the identifier. `tx` already
  // owns the translation the comments, tasks and tasklists paths take; asking for
  // it here costs one card read and also makes a `CLA-1804` reference reach this
  // intent, which no spelling of the argument could before.
  run: async (a, tx) => tx.commitToBoard(a.board, await tx.resolveCardCommonId(a.card), a.column),
});

export interface RemoveAllEdgesArgs {
  card: string;
}

export interface RemovedEdges {
  cardId: string;
  /** The far card of every edge actually removed. Empty means there were none. */
  removed: string[];
}

/**
 * `clear-blocking-edges` — clear every blocking edge on one card, bounded.
 * The CLI surface of `dependencies delete-all` (#109).
 *
 * **A DERIVED list, capped, and that is the whole point of registering it.** The
 * multi-write rule elsewhere is "enumerated N, never derived N", and this is the
 * deliberate exception: the caller cannot enumerate what it is asking to destroy,
 * because "all of them" is the request. So the list is derived from ONE bounded
 * read and then held to the same `MULTI_WRITE_CAP` — over the cap it REFUSES
 * rather than wiping, because `DELETE /cards/{id}/dependencies` is a single
 * unbounded call whose blast radius nobody sees until afterwards.
 *
 * An EMPTY edge set is not a refusal. `boundEntries`' empty arm is about an
 * enumerated list the caller typed and got wrong; here it means the card has no
 * dependencies, which is an honest `ok` with nothing written — the same answer
 * `remove-blocking-edge` gives for an absent edge, so a retry after a failed run
 * can still reach a clean result.
 *
 * Reversible, unlike the two above: each edge goes through
 * `TxCards.removeBlockingEdge`, which captures the direction before the delete
 * and pushes a real compensating write. A failure on edge 4 of 6 re-adds edges
 * 1–3, LIFO, and the invocation reports `rolled-back`. That is the whole
 * difference from the one-shot `DELETE .../dependencies` it replaces, which had
 * no per-edge record and no inverse.
 */
registerIntent<RemoveAllEdgesArgs, RemovedEdges>({
  name: 'clear-blocking-edges',
  summary: 'Remove every blocking edge on a card, at most 20, in one transaction',
  // A pure function of the args, like every other preview: it makes no read, so
  // it cannot say how many edges there are. It says what bounds the write instead.
  preview: (a) => [
    `remove every blocking edge on ${a.card}`,
    `  bounded: a card holding more than ${MULTI_WRITE_CAP} edges refuses rather than wiping`,
    `  reversible: each edge removed carries its own compensating write`,
  ],
  board: async (a, tx) => (await tx.getCard(a.card)).boardId,
  run: async (a, tx) => {
    const cardId = await tx.resolveCardId(a.card);
    const edges = await tx.getCardLinks(cardId);
    if (edges.length === 0) return { cardId, removed: [] };
    boundEntries('remove', edges, 'dependency edges');

    const removed: string[] = [];
    // Sequential, as every batched intent here is: the cap bounds it, and a
    // parallel wipe would make "which edges exist now" a race with the log.
    for (const edge of edges) {
      // An inlined edge carries `cardCommonId`; one read from `/dependencies`
      // carries `cardId`. `liveEdge` matches either, so take whichever is there
      // rather than resolving a second time.
      const far = edge.cardId ?? edge.cardCommonId;
      if (!far) continue;
      const outcome = await tx.removeBlockingEdge(cardId, far);
      if (outcome.removed) removed.push(far);
    }
    return { cardId, removed };
  },
});
