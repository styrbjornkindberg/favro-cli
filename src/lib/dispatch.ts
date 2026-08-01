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
import { CompensationLog, Orphan, TxCards, TxOutcome } from './tx-cards';
import { CATEGORY_TAGS, STATE_TAGS, VerifiedTracker } from './tracker-config';
import { RefusalError } from './refusal';

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
  const tx = new TxCards(new CardsAPI(ctx.client), log, ctx.client);

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

// Returns the WHOLE card: the JSON a caller pipes out of `cards create --json`
// carries `cardCommonId`, `columnId` and `sequentialId`, and narrowing it here
// would break every reader of those. The CLI projects what it prints.
registerIntent<CreateArgs, Card>({
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
  run: async (a, tx) =>
    tx.create({
      name: a.name,
      description: a.description,
      status: a.status,
      boardId: a.board,
      tags: a.tags?.length ? a.tags : undefined,
      assignees: a.assignees?.length ? a.assignees : undefined,
      parentCardId: a.parent,
      blockedBy: a.blockedBy?.length ? a.blockedBy : undefined,
      blocks: a.blocks?.length ? a.blocks : undefined,
    }),
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

const inVocabulary = (vocabulary: readonly string[], tag: string): string | undefined =>
  vocabulary.find((role) => role.toLowerCase() === tag.trim().toLowerCase());

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
