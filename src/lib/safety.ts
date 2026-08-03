import * as readline from 'readline';
import { FavroConfig } from './config';
import FavroHttpClient from './http-client';
import { logError } from './error-handler';
import { RefusalError } from './refusal';
import { c } from './theme';

/**
 * Ask the user for confirmation via stdin.
 * @param message The prompt message
 * @param yes If true, skip prompt and return true
 */
export async function confirmAction(message: string, flags?: { yes?: boolean }): Promise<boolean> {
  if (flags?.yes || process.env.NODE_ENV === 'test') {
    return true;
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      'Non-interactive environment detected (no TTY). Pass -y / --yes to confirm without a prompt.'
    );
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${c.warn('?')} ${message} ${c.muted('[y/N]')} `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

/**
 * A scope-lock refusal, thrown rather than printed.
 *
 * The lock is the real write guardrail (`--dry-run` is only a preview), so it has
 * to hold for every caller — the CLI, the shared dispatch table, the skill engine
 * and the MCP passthrough alike. A `process.exit(1)` cannot: it turns one
 * guardrail into a CLI-only one and kills a skill run mid-transaction with the
 * compensation log unread. So the check throws, and the CLI is the only place
 * that turns the throw into an exit code.
 *
 * A `RefusalError` (#120), because a scope violation is the definition of a
 * deterministic decline: the lock is configuration, so the identical call
 * refuses identically until someone runs `favro scope set`. It was a bare
 * `Error` until now, and that was not cosmetic — `isRetryable` claims
 * `retryable: false` only for a `RefusalError` or a classifiable HTTP response,
 * and a `ScopeError` is neither, so it fell through to the transient arm and
 * came back TRUE — advice to retry a refusal only `favro scope set` can change.
 *
 * `dispatch` calls `assertScope` outside its own try, so the throw escapes the
 * table uninstrumented; the skill engine catches it as `abortCause` and, if an
 * earlier step already wrote, derives `rollback.retryable` from it at the
 * end-of-run unwind. That was measured when this type was introduced: a
 * two-step skill whose second step straddles the lock reported `retryable:
 * true` before and `false` after, with nothing else touched.
 *
 * NEITHER wide-population reader still rests on the type alone. The runner's
 * error boundary has gated on `isWireFailure` since #134, and the skill
 * engine's end-of-run unwind since #151 (ADR-0002, "Two populations"), so a
 * `ScopeError` answers `false` at both for a second, independent reason — it
 * never touched the wire — whether or not it extends `RefusalError`. What the
 * type still buys is the NAMING: `checkScope` below branches on it, and a
 * decline that says what it is beats one inferred from where it came from.
 */
export class ScopeError extends RefusalError {
  constructor(
    message: string,
    readonly boardId: string,
    readonly scopeCollectionId: string,
  ) {
    super(message);
    this.name = 'ScopeError';
  }
}

/**
 * The board a card sits on, for the scope check — or `''` when it cannot be read.
 *
 * One helper rather than the six near-identical copies the #102/#103/#104 pass
 * first grew across `src/commands/`, because all three of its properties are
 * policy and policy repeated six times is policy that will drift on the seventh:
 *
 *   - It WRAPS the resolving GET. An unwrapped one turns a stale reference into
 *     a dead command instead of a clean refusal (the #78 regression).
 *   - It resolves to `''`, never to a skipped check. A board that cannot be read
 *     is UNCHECKABLE, not exempt — `assertScope` refuses `''` under a lock and
 *     ignores it without one, so `?? ''` is the fail-CLOSED answer.
 *   - It REPORTS the cause. `assertScope`'s own refusal tells the user the
 *     underlying error "is reported separately"; six silent `catch { return '' }`
 *     blocks made that a promise nothing kept, leaving a typo'd id looking
 *     identical to a card with no board.
 *
 * Callers needing the whole card (a rollback snapshot, say) still fetch it
 * themselves and take `card?.boardId ?? ''` — this is for the callers that want
 * only the board.
 */
export async function boardOfCard(client: FavroHttpClient, cardRef: string): Promise<string> {
  if (!cardRef) return '';
  const { default: CardsAPI } = await import('./cards-api');
  try {
    return (await new CardsAPI(client).getCard(cardRef))?.boardId ?? '';
  } catch (error: any) {
    console.error(`${c.fail} Could not read card ${cardRef}: ${error?.message ?? String(error)}`);
    return '';
  }
}

/**
 * The board behind a write named only by a `commentId` — comment → card → board.
 *
 * The second hop is `boardOfCard`, which owns the wrap/report/fail-closed
 * policy; this wraps the first for the same reason. Shared rather than copied
 * into `comments.ts` and `attachments.ts` because an unwrapped copy is not a
 * cosmetic difference: it rejects instead of resolving `''`, and a rejecting
 * resolver never reaches the lock at all.
 */
export async function boardOfComment(client: FavroHttpClient, commentId: string): Promise<string> {
  const { CommentsApiClient } = await import('../api/comments');
  let cardRef = '';
  try {
    // The normaliser puts cardCommonId on `cardId`.
    cardRef = (await new CommentsApiClient(client).getComment(commentId))?.cardId ?? '';
  } catch (error: any) {
    console.error(`${c.fail} Could not read comment ${commentId}: ${error?.message ?? String(error)}`);
    return '';
  }
  return boardOfCard(client, cardRef);
}

/**
 * Take the scope lock on a board that has to be RESOLVED first, paying for the
 * resolution only when there is a lock to check it against.
 *
 * `checkScope` is already free when nothing is locked, but `checkScope(await
 * resolve(), …)` is not: the argument evaluates first, so every guarded command
 * billed an unlocked user a GET for an answer nobody was going to read. #102 and
 * #104 both make that a criterion — *"no behaviour change when no lock is
 * configured, and no extra requests on that path"* — and an eager resolve breaks
 * it at every site at once.
 *
 * Taking a THUNK rather than a board id is what makes the saving possible, and
 * it is why the two-hop resolvers (task list → card, comment → card) fit here
 * too: the caller says how to find the board, this decides whether to ask.
 *
 * Callers that must fetch the card anyway — a CSV row needs it for the rollback
 * snapshot — resolve eagerly and call `checkScope` directly; there is no second
 * request for them to save.
 */
export async function checkResolvedScope(
  client: FavroHttpClient,
  resolve: () => Promise<string>,
  force: boolean = false,
): Promise<void> {
  const { readConfig } = await import('./config');
  const config = await readConfig();
  if (!config?.scopeCollectionId) return;
  await checkScope(await resolve(), client, config, force);
}

/**
 * Assert the board is inside the locked scope collection. Throws `ScopeError`
 * when it is not. A no-op when no lock is configured, and a warning-only
 * pass-through under `force`.
 */
export async function assertScope(
  boardId: string,
  client: FavroHttpClient,
  config: FavroConfig,
  force: boolean = false
): Promise<void> {
  if (!config || !config.scopeCollectionId) {
    return;
  }

  const locked = config.scopeCollectionName ?? config.scopeCollectionId;

  // A write that names no board is UNCHECKABLE, not exempt. Callers reach here
  // with an empty board id two ways — the card has no board instance
  // (`boardId` is `widgetCommonId`, and an assignment fork has none), or the
  // card could not be read at all and the caller passed `?? ''` rather than
  // guessing. Both are boards the lock cannot see. Without this the lock fails
  // OPEN, or sends a `/widgets/` request that refuses by accident rather than
  // on purpose.
  //
  // `--force` deliberately does NOT rescue this. Force is "I know this board is
  // outside the lock"; here there is no board to know anything about, so there
  // is nothing for the escape hatch to escape.
  if (!boardId) {
    throw new ScopeError(
      `Scope violation: this write names no board, so the scope lock ("${locked}") cannot be checked.\n` +
        `  Either the card could not be read (wrong id, deleted card, or a failed request — the\n` +
        `  underlying error is reported separately), or it has no board instance: no widgetCommonId\n` +
        `  is what an assignment fork looks like, and a write to one is a write the lock cannot see.\n` +
        `  Check the id, then run 'favro cards get <cardCommonId>' to name the board-resident instance.`,
      boardId,
      config.scopeCollectionId,
    );
  }

  const raw = await client.get<any>(`/widgets/${boardId}`);
  const collectionIds = raw?.collectionIds ?? [];
  if (collectionIds.includes(config.scopeCollectionId)) return;

  if (force) {
    console.warn(`${c.warn('⚠')} ${c.warn('Warning:')} Board ${boardId} is outside your locked scope (${locked}), but proceeding because --force was used.`);
    return;
  }

  throw new ScopeError(
    `Scope violation: board "${raw?.name ?? boardId}" is not in locked collection "${locked}".\n` +
      `  Run 'favro scope show' to see your current lock.\n` +
      `  Run 'favro scope set <collectionId>' to change it, or pass --force to override.`,
    boardId,
    config.scopeCollectionId,
  );
}

/**
 * Checks if the board belongs to the currently locked scope collection.
 * If scope checking is not enabled, or the board belongs to the collection, returns true.
 * Otherwise, logs an error and exits the process (unless force is true).
 *
 * The CLI presentation of `assertScope` — one check, two presentations, so the
 * lock cannot say different things to different callers.
 */
export async function checkScope(
  boardId: string,
  client: FavroHttpClient,
  config: FavroConfig,
  force: boolean = false
): Promise<void> {
  try {
    await assertScope(boardId, client, config, force);
  } catch (error: any) {
    if (error instanceof ScopeError) {
      const [head, ...rest] = error.message.split('\n');
      console.error(`${c.fail} ${c.error('Scope violation:')}${head.replace('Scope violation:', '')}`);
      rest.forEach((line) => console.error(line));
      process.exit(1);
      return;
    }
    if (error?.response?.status === 404) {
      console.error(`${c.fail} Scope check failed: Board ${boardId} not found.`);
      process.exit(1);
    }
    logError(error, false);
    process.exit(1);
  }
}

/**
 * Refuse an ORG-WIDE destructive write while a collection lock is configured (#125).
 *
 * The gap #104 named and left open. Nine writes land on no board — tags, user
 * groups, webhooks, `collections create` — so `assertScope` has nothing to
 * resolve and is structurally the wrong guard for them; that decision stands.
 * But three of the nine are irreversible org-wide DELETES, and `tags delete`
 * strips the tag from every card in the organization: a wider blast radius than
 * anything the collection lock guards. Their only guard until now was
 * `confirmAction`, which `-y` waives and `NODE_ENV=test` skips outright.
 *
 * What this keys on is the LOCK, not the target — and that is the whole idea,
 * not a shortcut. A configured lock is the user stating "my writes stay inside
 * this collection". An org-wide delete provably does not stay inside it, and no
 * amount of resolution will make it, so the presence of a lock is sufficient
 * grounds to refuse. #125 weighed a `scopeOrganizationId` in config against
 * this and it loses: the CLI is already single-org per API key, so an org id
 * would compare a value to itself.
 *
 * Consequences, stated rather than discovered later:
 *   - NO LOCK, NO CHANGE. Returns before doing anything, and makes no request
 *     either way — the #102/#104 criterion ("no behaviour change when no lock is
 *     configured, and no extra requests on that path") holds by construction,
 *     since the only input is a local config read.
 *   - `--force` IS the escape hatch, spelled the same as everywhere else, and it
 *     warns rather than passing quietly. Unlike the empty-board arm of
 *     `assertScope`, force is meaningful here: the user knows exactly what
 *     org-wide means, which is why they are being asked.
 *   - It guards the DELETES only. `tags update` renames org-wide and is
 *     reversible with another rename; `create` is additive. Irreversibility is
 *     the line, and `scope-lock-coverage.test.ts` derives the set from which
 *     commands reach `client.delete` rather than from their names.
 *
 * A `ScopeError`, not a seventh refusal class: it is a scope refusal, it must be
 * `retryable: false` for the same reason (#120), and nothing reads `.boardId` —
 * so `''` here means "org-wide, no board to name", the same absence
 * `assertScope` already reports it with.
 */
export async function assertOrgScope(what: string, force: boolean = false): Promise<void> {
  const { readConfig } = await import('./config');
  const config = await readConfig();
  if (!config?.scopeCollectionId) return;

  const locked = config.scopeCollectionName ?? config.scopeCollectionId;

  if (force) {
    console.warn(
      `${c.warn('⚠')} ${c.warn('Warning:')} ${what} is organization-wide and reaches every board, ` +
        `including boards outside your locked scope (${locked}), but proceeding because --force was used.`
    );
    return;
  }

  throw new ScopeError(
    `Scope violation: ${what} is an ORGANIZATION-WIDE write — it reaches every board in the\n` +
      `  organization, including every board outside your locked collection ("${locked}").\n` +
      `  The collection lock cannot narrow this one: the write names no board, so there is nothing\n` +
      `  to resolve against the lock. It is refused rather than widened.\n` +
      `  Run 'favro scope show' to see your current lock.\n` +
      `  Run 'favro scope clear' to unlock, or pass --force to allow this single write.`,
    '',
    config.scopeCollectionId,
  );
}

/**
 * Checks if the collection matches the currently locked scope collection.
 */
export function checkCollectionScope(
  collectionId: string,
  config: FavroConfig,
  force: boolean = false
): void {
  if (!config || !config.scopeCollectionId) {
    return;
  }

  if (collectionId !== config.scopeCollectionId) {
    if (force) {
      console.warn(`${c.warn('⚠')} ${c.warn('Warning:')} Target collection ${collectionId} is outside your locked scope (${config.scopeCollectionName ?? config.scopeCollectionId}), but proceeding because --force was used.`);
      return;
    }

    console.error(`${c.fail} ${c.error('Scope violation:')} target collection "${collectionId}" is not the locked collection "${config.scopeCollectionName ?? config.scopeCollectionId}".`);
    console.error(`  Run ${c.info("'favro scope show'")} to see your current lock.`);
    console.error(`  Run ${c.info("'favro scope set <collectionId>'")} to change it, or pass ${c.bold('--force')} to override.`);
    process.exit(1);
  }
}

/**
 * Generates a standard dry-run preview message.
 */
export function dryRunLog(verb: string, targetType: string, targetName: string, payload?: any): void {
  console.log(`${c.dryRun('dry-run')} Would ${verb} ${targetType} "${c.bold(targetName)}"${payload ? ' with:' : ''}`);
  if (payload) {
    console.log(c.muted(JSON.stringify(payload, null, 2)));
  }
}
