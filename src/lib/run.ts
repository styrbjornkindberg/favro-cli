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
import { capRows, writeEnvelope } from './read-shape';
import { reportDispatch } from './report-dispatch';
import { DispatchResult, isRetryable } from './dispatch';
import { logError } from './error-handler';
import { classifyThrownError } from './favro-error';

import { CardsAPI } from './cards-api';
import { BoardsAPI } from './boards-api';
import { CollectionsAPI } from './collections-api';
import { ColumnsAPI } from './columns-api';
import { CommentsAPI } from './comments-api';
import { TagsAPI } from './tags-api';
import { TasksAPI } from './tasks-api';
import { TaskListsAPI } from './tasklists-api';
import { UsersAPI } from './users-api';
import { WidgetsAPI } from './widgets-api';
import { AttachmentsAPI } from './attachments-api';
import { CustomFieldsAPI } from './custom-fields-api';
import { AggregateAPI } from '../api/aggregate';
import { ContextAPI } from '../api/context';
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
 * for the other seventeen. Written as eighteen explicit getters rather than a
 * table so that each `new` is greppable and the type falls out of the code.
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
    get comments() { return once('comments', () => new CommentsAPI(client)); },
    get tags() { return once('tags', () => new TagsAPI(client)); },
    get tasks() { return once('tasks', () => new TasksAPI(client)); },
    get tasklists() { return once('tasklists', () => new TaskListsAPI(client)); },
    get users() { return once('users', () => new UsersAPI(client)); },
    get widgets() { return once('widgets', () => new WidgetsAPI(client)); },
    get attachments() { return once('attachments', () => new AttachmentsAPI(client)); },
    get customFields() { return once('customFields', () => new CustomFieldsAPI(client)); },
    get aggregate() { return once('aggregate', () => new AggregateAPI(client)); },
    get context() { return once('context', () => new ContextAPI(client)); },
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

/** A list read. Always an envelope, whether or not its author considered it. */
export interface RowsResult<T> extends WithExitCode {
  rows: T[];
  /** `--limit`. Caps what is PRINTED; the fetch already ran to completion. */
  limit?: number;
  /** Returning `void` is legal, and is what accommodates `console.table`. */
  human?: (rows: T[]) => string | void;
}

/** A single read. Stays bare — rule 1 of `read-shape.ts`. */
export interface ItemResult<T> extends WithExitCode {
  item: T;
  human?: (item: T) => string | void;
}

/** A write that went through the shared dispatch table. */
export interface DispatchArm {
  dispatch: DispatchResult;
}

/**
 * `void` is the streaming arm and is load-bearing, not a hedge: the TUIs,
 * `auth login` and anything driving `ProgressBar` own their stdout and say so
 * in the type.
 */
export type Result<T> = RowsResult<T> | ItemResult<T> | DispatchArm | void;

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

function rootOf(command: Command): Command {
  let node = command;
  while (node.parent) node = node.parent;
  return node;
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

export function run<T, A extends unknown[]>(
  handler: (ctx: Ctx, ...args: A) => Result<T> | Promise<Result<T>>,
): Action<A>;
export function run<T, A extends unknown[]>(
  options: RunOptions,
  handler: (ctx: AnonymousCtx, ...args: A) => Result<T> | Promise<Result<T>>,
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
    const verbose = command ? Boolean(rootOf(command).opts().verbose) : false;

    try {
      const config = await readConfig();
      const base = { config, verbose };
      const ctx: Ctx | AnonymousCtx = anonymous
        ? base
        : await withClient(base, mergedOpts(command));

      emit((await handler(ctx, ...args)) as Result<unknown>, format);
    } catch (error) {
      if (format.json) {
        const envelope = { message: messageOf(error), retryable: retryableFrom(error) };
        console.log(JSON.stringify({ error: envelope }));
      } else {
        logError(error, verbose);
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

function emit(result: Result<unknown>, format: Format): void {
  if (!result) return;

  if ('dispatch' in result) {
    // `reportDispatch`'s returned boolean is the exit code, and the one place
    // the retry advice is worded.
    if (reportDispatch(result.dispatch, format.json)) process.exitCode = 1;
    return;
  }

  if ('rows' in result) {
    const envelope = capRows(result.rows, result.limit);
    if (format.json) writeEnvelope(envelope, format.pretty);
    else writeHuman(envelope.rows, result.human);
  } else {
    if (format.json) console.log(stringify(result.item, format.pretty));
    else writeHuman(result.item, result.human);
  }

  if (result.exitCode !== undefined) process.exitCode = result.exitCode;
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
 */
const retryableFrom = (error: unknown): boolean => isRetryable('rolled-back', error);

export default run;
