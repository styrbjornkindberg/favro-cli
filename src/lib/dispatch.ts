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
import CardsAPI from './cards-api';
import { assertScope } from './safety';
import { CompensationLog, Orphan, TxCards, TxOutcome } from './tx-cards';

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
   * `rolled-back` is retryable — the world is back where it started, so the same
   * black-box call is safe to repeat. `rollback-incomplete` is not: something is
   * left behind and a retry would compound it.
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
   */
  board(args: A, tx: TxCards): Promise<string | undefined>;
  run(args: A, tx: TxCards): Promise<R>;
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
  const tx = new TxCards(new CardsAPI(ctx.client), log);

  // The mandatory guardrail, inside the table, on every path — including the
  // skill engine's and the MCP passthrough's.
  const board = await intent.board(args as never, tx);
  if (board) await assertScope(board, ctx.client, ctx.config, ctx.force);

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

  try {
    const value = (await intent.run(args as never, tx)) as T;
    return { intent: name, outcome: 'ok', retryable: false, value };
  } catch (error) {
    // Unwind the WHOLE log, not just this invocation's entries: when a caller
    // threads one log through several dispatches, a late failure has to undo the
    // early writes too, or "rolled-back" would be a lie about the run.
    const { outcome, orphans } = await log.unwind();
    return {
      intent: name,
      outcome,
      retryable: outcome === 'rolled-back',
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
  tags?: string[];
  assignees?: string[];
  parent?: string;
  blockedBy?: string[];
  blocks?: string[];
}

registerIntent<CreateArgs, { cardId: string; name: string }>({
  name: 'create',
  summary: 'Create a card, with tag / parent / blocking / assignee / column on the one call',
  preview: (a) => [
    `create card "${a.name}"${a.board ? ` on board ${a.board}` : ''}${a.status ? ` in column "${a.status}"` : ''}`,
    ...(a.tags?.length ? [`  tags: ${a.tags.join(', ')}`] : []),
    ...(a.assignees?.length ? [`  assignees: ${a.assignees.join(', ')}`] : []),
    ...(a.parent ? [`  parent: ${a.parent}`] : []),
    ...(a.blockedBy?.length ? [`  blocked by: ${a.blockedBy.join(', ')}`] : []),
    ...(a.blocks?.length ? [`  blocks: ${a.blocks.join(', ')}`] : []),
  ],
  board: async (a) => a.board,
  run: async (a, tx) => {
    const card = await tx.create({
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
    return { cardId: card.cardId, name: card.name };
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
