/**
 * The one command runner (ADR-0002, #113).
 *
 * A commander action becomes `.action(run(handler))`. The handler receives a
 * `Ctx` and **returns**; this module owns everything around it — credential
 * resolution, the config read, the api namespace, the output shape, the error
 * boundary and the exit code. A command module is then its flag declarations
 * plus the work, which is the whole point: the same twenty lines were re-typed
 * across 128 actions, and the repetition was the cheapest of its costs.
 *
 * Three rules this file exists to hold in one place:
 *
 * 1. **JSON is the default; `--human` opts out.** Not TTY-sniffed — a shape that
 *    varies with the invocation environment makes the agent's output and the
 *    human's output differ for an identical command.
 * 2. **`process.exitCode`, never a hard `process.exit`.** A hard exit terminates
 *    before a pending async write flushes, and stdout is a pipe under MCP. The
 *    runner sets the code and returns; the literal call appears nowhere in this
 *    file, and `run.test.ts` asserts it never does.
 * 3. **An error in JSON mode is an envelope on stdout.** MCP hands an agent
 *    stdout first and stderr as an appended blob, so a failure written only to
 *    stderr reads as `(no output)`.
 */
import type { Command } from 'commander';
import FavroHttpClient from './http-client';
import { createFavroClient } from './client-factory';
import { readConfig, FavroConfig } from './config';
import { capRows, noteTruncation, writeEnvelope } from './read-shape';
import { reportDispatch } from './report-dispatch';
import { DispatchResult, isRetryable } from './dispatch';
import { isVerbose, logError } from './error-handler';
import { classifyThrownError } from './favro-error';

import { CardsAPI } from './cards-api';
import { BoardsAPI } from './boards-api';
import { CollectionsAPI } from './collections-api';
import { ColumnsAPI } from './columns-api';
// The comments client lives under `api/`, not `lib/` — #89 deleted the `lib/`
// twin, which did not resolve `cardCommonId`. This one does.
import { CommentsApiClient } from '../api/comments';
import { TagsAPI } from './tags-api';
import { TasksAPI } from './tasks-api';
import { TaskListsAPI } from './tasklists-api';
import { UsersAPI } from './users-api';
import { WidgetsAPI } from './widgets-api';
import { AttachmentsAPI } from './attachments-api';
import { CustomFieldsAPI } from './custom-fields-api';
import { ActivityApiClient } from '../api/activity';
import { AggregateAPI } from '../api/aggregate';
import { ContextAPI } from '../api/context';
// `members` is `FavroApiClient` — the class predates the naming the rest of the
// directory settled on. Renaming it is not this ticket's business (#116).
import { FavroApiClient as MembersApiClient } from '../api/members';
import { QueryAPI } from '../api/query';
import { SprintPlanAPI } from '../api/sprint-plan';
import { StandupAPI } from '../api/standup';
import { FavroWebhooksAPI } from '../api/webhooks';

// ─── the api namespace ───────────────────────────────────────────────────────

/**
 * Every API class, behind a lazy memoised getter.
 *
 * On `ctx` rather than imported per command because that removes 113
 * `new XxxAPI(client)` sites — and, the actual point, because a test stubs
 * `ctx.api.cards` instead of mocking `http-client`.
 *
 * Lazy is load-bearing, not tidiness: a command wanting `CardsAPI` must not pay
 * for the other nineteen. Written as twenty explicit getters rather than a
 * table so that each `new` is greppable and the type falls out of the code.
 * `activity` and `members` joined in #116, which is when the first command
 * needing them migrated; twenty is now every API class in the codebase, which
 * `run.test.ts` pins.
 *
 * ponytail: lazy about `new`, NOT about `require`. The twenty imports above
 * are eager, so requiring this module pulls ~99 modules that `cards-api` alone
 * does not — 98 when #113 measured it (44 → 142), 97 before #116 and 99 after,
 * re-measured through `require.cache`. The two getters #116 added cost two
 * modules rather than a whole subtree, because `api/members` was already
 * reached through `api/context`. Nothing today pays for it — `cli.ts` already
 * imports most of the graph — but #119 must not claim a startup win without
 * measuring `dist/` first. Making it lazy means `await import()` in the
 * getters, which makes every `ctx.api.x` a promise; that is the price.
 */
export function apiNamespace(client: FavroHttpClient) {
  const built = new Map<string, unknown>();
  const once = <T>(key: string, make: () => T): T => {
    if (!built.has(key)) built.set(key, make());
    return built.get(key) as T;
  };
  return {
    get cards() { return once('cards', () => new CardsAPI(client)); },
    get boards() { return once('boards', () => new BoardsAPI(client)); },
    get collections() { return once('collections', () => new CollectionsAPI(client)); },
    get columns() { return once('columns', () => new ColumnsAPI(client)); },
    get comments() { return once('comments', () => new CommentsApiClient(client)); },
    get tags() { return once('tags', () => new TagsAPI(client)); },
    get tasks() { return once('tasks', () => new TasksAPI(client)); },
    get tasklists() { return once('tasklists', () => new TaskListsAPI(client)); },
    get users() { return once('users', () => new UsersAPI(client)); },
    get widgets() { return once('widgets', () => new WidgetsAPI(client)); },
    get attachments() { return once('attachments', () => new AttachmentsAPI(client)); },
    get customFields() { return once('customFields', () => new CustomFieldsAPI(client)); },
    get activity() { return once('activity', () => new ActivityApiClient(client)); },
    get aggregate() { return once('aggregate', () => new AggregateAPI(client)); },
    get context() { return once('context', () => new ContextAPI(client)); },
    get members() { return once('members', () => new MembersApiClient(client)); },
    get query() { return once('query', () => new QueryAPI(client)); },
    get sprintPlan() { return once('sprintPlan', () => new SprintPlanAPI(client)); },
    get standup() { return once('standup', () => new StandupAPI(client)); },
    get webhooks() { return once('webhooks', () => new FavroWebhooksAPI(client)); },
  };
}

export type ApiNamespace = ReturnType<typeof apiNamespace>;

// ─── the context ─────────────────────────────────────────────────────────────

/**
 * What every handler gets. Deliberately four members: `assertScope` and
 * `confirmAction` stay free functions taking `ctx.client`, because widening
 * `Ctx` is how a seam becomes a god object (ADR-0002, "Revisit when").
 */
export interface Ctx {
  client: FavroHttpClient;
  /** Read once, before the handler runs. Carries `scopeCollectionId`. */
  config: FavroConfig;
  /** Resolved from the ROOT program, one spelling. This is #85's grave. */
  verbose: boolean;
  api: ApiNamespace;
}

/**
 * What `run({ anonymous: true }, …)` gets: no client, and therefore no `api`.
 * Both are absent from the TYPE, so `auth`, `issue-tracker-help`, `shell` and
 * `skill` cannot reach for a client the runner never built.
 */
export type AnonymousCtx = Omit<Ctx, 'client' | 'api'>;

// ─── what a handler returns ──────────────────────────────────────────────────

/** Carried by the answer-code commands — `health`, `release-check`, `diff`. */
interface WithExitCode {
  /** Where a non-zero code is the FINDING, not a failure. */
  exitCode?: number;
}

/**
 * The three arms are mutually exclusive, and the `?: never` members are what
 * make that true. TypeScript's excess-property check against a union admits any
 * key present in ANY member, so without these `{ dispatch, item }` compiles and
 * the runner silently drops one of them.
 */
interface NotRows {
  rows?: never;
}
interface NotItem {
  item?: never;
}
interface NotDispatch {
  dispatch?: never;
}

/** A list read. Always an envelope, whether or not its author considered it. */
export interface RowsResult<T> extends WithExitCode, NotItem, NotDispatch {
  rows: T[];
  /**
   * `--limit`. Caps what is PRINTED; the fetch already ran to completion.
   * A string because that is how commander hands a flag over — `capRows` owns
   * the parse, so a handler passes `options.limit` through untouched.
   */
  limit?: number | string;
  /** Returning `void` is legal, and is what accommodates `console.table`. */
  human?: (rows: T[]) => string | void;
}

/** A single read. Stays bare — rule 1 of `read-shape.ts`. */
export interface ItemResult<T> extends WithExitCode, NotRows, NotDispatch {
  item: T;
  human?: (item: T) => string | void;
}

/**
 * A write that went through the shared dispatch table.
 *
 * It carries the VALUE, and that is not decoration: `reportDispatch` writes
 * nothing at all on `ok`, so every call site today follows it with its own
 * `✓ Created …` print. An arm that only reported failure would make a
 * successful write print nothing — the silent-no-output failure ADR-0002 exists
 * to kill, moved to the success path.
 */
export interface DispatchArm<T> extends WithExitCode, NotRows, NotItem {
  dispatch: DispatchResult<T>;
  /** Renders `dispatch.value` in human mode. The `✓ …` line lives here. */
  human?: (value: T) => string | void;
}

/**
 * `void` is the streaming arm and is load-bearing, not a hedge: the TUIs,
 * `auth login` and anything driving `ProgressBar` own their stdout and say so
 * in the type.
 */
export type Result<T> = RowsResult<T> | ItemResult<T> | DispatchArm<T> | void;

/**
 * The constraint `run` puts on a handler's return.
 *
 * `any`, deliberately and with a named cost: one type parameter shared by the
 * whole handler cannot describe a handler that branches — `opts.count ? { item:
 * Count } : { rows: Board[] }` is a real shape in a dozen of #114's files, and
 * under `Result<T>` it does not compile. `unknown` cannot replace `any` here:
 * `(rows: Board[]) => string` is not assignable to `(rows: unknown[]) => string`
 * under `strictFunctionTypes`, so it would break every `human` formatter.
 *
 * What this gives up: `{ rows: Board[], human: (rows: Count[]) => … }` no longer
 * fails to compile. The arms stay exclusive (above), and `emit` reads only keys
 * every arm agrees on, so the loss is confined to a formatter disagreeing with
 * its own rows.
 */
export type AnyResult = RowsResult<any> | ItemResult<any> | DispatchArm<any> | void;

// ─── format resolution ───────────────────────────────────────────────────────

export interface Format {
  /** JSON is the default. `--human` is the only way out. */
  json: boolean;
  /** `--pretty`, a root flag owned by the runner. */
  pretty: boolean;
}

/**
 * The one format resolution, for all 128 actions.
 *
 * `--human` is read with globals merged, so it works declared at the root or on
 * the leaf. `--verbose` deliberately is NOT: reading it from the root alone is
 * what collapses the fifteen spellings of #85 to one, and what stops a leaf
 * `--verbose` meaning something different from the root's.
 */
export function resolveFormat(command?: Command): Format {
  const opts = mergedOpts(command);
  return { json: !opts.human, pretty: Boolean(opts.pretty) };
}

function mergedOpts(command?: Command): Record<string, unknown> {
  if (!command) return {};
  return typeof command.optsWithGlobals === 'function'
    ? command.optsWithGlobals()
    : command.opts();
}

/**
 * Commander appends the `Command` to the action arguments. Detected by shape
 * rather than by position, because the number of declared arguments varies per
 * command and an off-by-one here would silently resolve every flag to nothing.
 */
function commandFrom(args: readonly unknown[]): Command | undefined {
  const last = args[args.length - 1] as Command | undefined;
  return last && typeof last.opts === 'function' ? last : undefined;
}

// ─── the runner ──────────────────────────────────────────────────────────────

export interface RunOptions {
  /** Build no client, and drop it from the handler's type. */
  anonymous: true;
}

type Action<A extends unknown[]> = (...args: A) => Promise<void>;

export function run<R extends AnyResult, A extends unknown[]>(
  handler: (ctx: Ctx, ...args: A) => R | Promise<R>,
): Action<A>;
export function run<R extends AnyResult, A extends unknown[]>(
  options: RunOptions,
  handler: (ctx: AnonymousCtx, ...args: A) => R | Promise<R>,
): Action<A>;
export function run(
  optionsOrHandler: RunOptions | ((ctx: never, ...args: never[]) => unknown),
  maybeHandler?: (ctx: never, ...args: never[]) => unknown,
): Action<unknown[]> {
  const anonymous = typeof optionsOrHandler !== 'function';
  const handler = (anonymous ? maybeHandler! : optionsOrHandler) as (
    ctx: Ctx | AnonymousCtx,
    ...args: unknown[]
  ) => unknown;

  return async (...args: unknown[]): Promise<void> => {
    // Resolved before the try: the catch has to know which stream the error
    // goes to, and reading commander state cannot itself fail.
    const command = commandFrom(args);
    const format = resolveFormat(command);

    try {
      const config = await readConfig();
      // `isVerbose()` is #85's latch, set by the root `preAction` hook. Reading
      // it rather than re-deriving from `command` keeps ONE mechanism for the
      // flag that #85 just collapsed from fifteen.
      const base = { config, verbose: isVerbose() };
      const ctx: Ctx | AnonymousCtx = anonymous
        ? base
        : await withClient(base, mergedOpts(command));

      emit((await handler(ctx, ...args)) as AnyResult, format);
    } catch (error) {
      if (format.json) {
        const envelope = { message: messageOf(error), retryable: retryableFrom(error) };
        console.log(JSON.stringify({ error: envelope }));
      } else {
        // No second argument: `logError` reads the same latch.
        logError(error);
      }
      process.exitCode = 1;
    }
  };
}

async function withClient(
  base: AnonymousCtx,
  opts: Record<string, unknown>,
): Promise<Ctx> {
  const client = await createFavroClient({
    apiKey: opts.apiKey as string | undefined,
    email: opts.email as string | undefined,
    organizationId: opts.organizationId as string | undefined,
  });
  return { ...base, client, api: apiNamespace(client) };
}

// ─── output ──────────────────────────────────────────────────────────────────

function emit(result: AnyResult, format: Format): void {
  if (!result) return;

  if (result.dispatch) {
    // `reportDispatch`'s returned boolean is the exit code, and the one place
    // the retry advice is worded.
    //
    // ponytail: in JSON mode it also puts its OWN shape on stdout for a
    // failure — `{intent, outcome, error, …}`, not the boundary's
    // `{error:{message, retryable}}`. Two machine shapes for one question.
    // Left alone here because collapsing them means changing `reportDispatch`
    // for its five existing callers, which is a call for #113 to make, not a
    // side effect of adding the runner. Raised on the issue.
    if (reportDispatch(result.dispatch, format.json)) {
      process.exitCode = 1;
      return;
    }
    // The success path. `reportDispatch` returns without printing on `ok`, so
    // the value is written here or not at all. A dry run and a value-less
    // intent both leave `value` undefined and have nothing to show.
    if (result.dispatch.value !== undefined) {
      writeValue(result.dispatch.value, result.human, format);
    }
  } else if (result.rows) {
    const envelope = capRows(result.rows, result.limit);
    if (format.json) {
      writeEnvelope(envelope, format.pretty);
    } else {
      writeHuman(envelope.rows, result.human);
      // A `human` formatter is handed ROWS, not the envelope, so it cannot say
      // a cut happened and every one of them would have to be told to. The
      // runner says it instead — once, for every migrated list read (#99).
      noteTruncation(envelope, result.rows.length);
    }
  } else {
    writeValue(result.item, result.human, format);
  }

  if (result.exitCode !== undefined) process.exitCode = result.exitCode;
}

/** A bare value: the machine shape in JSON mode, the formatter's in human. */
function writeValue<T>(value: T, human: ((value: T) => string | void) | undefined, format: Format): void {
  if (format.json) console.log(stringify(value, format.pretty));
  else writeHuman(value, human);
}

/**
 * The human path. A formatter returning `void` printed for itself — appending
 * anything under it would be the runner talking over the command.
 *
 * No formatter at all falls back to indented JSON: a reader who asked for
 * `--human` and got silence has been told nothing.
 */
function writeHuman<T>(value: T, human?: (value: T) => string | void): void {
  if (!human) {
    console.log(stringify(value, true));
    return;
  }
  const text = human(value);
  if (typeof text === 'string') console.log(text);
}

const stringify = (value: unknown, pretty: boolean): string =>
  JSON.stringify(value, null, pretty ? 2 : undefined);

// ─── errors ──────────────────────────────────────────────────────────────────

/** The same wording `logError` puts on stderr — one message, both modes. */
function messageOf(error: unknown): string {
  const classified = classifyThrownError(error);
  if (classified?.isFailure) return classified.message;
  return error instanceof Error ? error.message : String(error);
}

/**
 * "Should I try again?", from the ONE derivation.
 *
 * `isRetryable` gates on the transaction outcome first; the error boundary has
 * no transaction, so `'rolled-back'` is the arm that asks the only question
 * left — is this failure deterministic. Reusing it rather than restating
 * `RefusalError` + `classifyThrownError` here is what stops the CLI and the
 * dispatch table drifting apart on the same question, which is #66 all over.
 *
 * ponytail: the ceiling. `isRetryable` reads an UNCLASSIFIABLE error as
 * retryable, because in the dispatch table an unclassifiable error is a wire
 * hiccup after a clean unwind. This boundary also catches errors that never
 * touched the wire — an `ENOENT` from `--out /nope/x.csv`, a `TypeError` of our
 * own — and calls them retryable too, which is advice an agent should not act
 * on. Narrowing it to `classifyThrownError(error) ? … : false` contradicts the
 * derivation ADR-0002 states, so it is raised on #113 rather than changed here.
 */
const retryableFrom = (error: unknown): boolean => isRetryable('rolled-back', error);

export default run;
