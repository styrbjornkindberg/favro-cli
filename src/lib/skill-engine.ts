/**
 * Skill Engine — YAML Skill Parsing, Variable Interpolation, and Step Execution
 *
 * Executes skill definitions step-by-step.
 *
 * A step is one of the read commands below, or — for anything else — a WRITE
 * INTENT, looked up in the shared dispatch table (`./dispatch`) at call time.
 * The engine therefore holds no list of intents: an intent a later ticket
 * registers is callable from a skill with no change here, and every write a
 * skill makes passes the same scope lock a commander action does.
 *
 * The run is ONE transaction: the engine opens exactly one `CompensationLog`
 * and threads it through every dispatch, so a failure in step 3 unwinds steps 1
 * and 2 as well. It holds no rollback logic of its own — the log unwinds itself,
 * inside the table; the engine only decides when the run is over.
 *
 * Read commands in skill steps:
 *   context, query, standup, sprint-plan
 */
import FavroHttpClient from '../lib/http-client';
import { createFavroClient } from './client-factory';
import { confirmAction } from './safety';
import { readConfig, FavroConfig } from './config';
import { dispatch, getIntent, intentNames, isRetryable, DispatchResult } from './dispatch';
import { CompensationLog, Orphan, TxOutcome } from './tx-cards';
import { parseLimit } from './read-shape';
import ContextAPI from '../api/context';
import { StandupAPI } from '../api/standup';
import { SprintPlanAPI } from '../api/sprint-plan';
import { SkillDefinition, SkillStep, SkillVariable } from './skill-store';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StepResult {
  step: number;
  command: string;
  status: 'success' | 'skipped' | 'failed';
  output?: string;
  error?: string;
}

export interface SkillRunResult {
  skill: string;
  steps: StepResult[];
  status: 'completed' | 'partial' | 'failed';
  /**
   * Present only when the run's one transaction had to be unwound.
   *
   * `retryable` is the table's own derivation (`isRetryable`), carried rather
   * than re-derived: `outcome === 'rolled-back'` is not the same question, and
   * asking it here instead was one of the three drifted sites in #66.
   */
  rollback?: { outcome: TxOutcome; retryable: boolean; orphans: Orphan[] };
}

export interface SkillRunOptions {
  dryRun?: boolean;
  yes?: boolean;
  /** Bypass the scope lock on every write step, with a warning. */
  force?: boolean;
  variables?: Record<string, string>;
  /** Injectable so a caller — or a wire test — can drive a specific Favro. */
  client?: FavroHttpClient;
  /** Carries `scopeCollectionId`. Read from disk when omitted. */
  config?: FavroConfig;
  /** Called before each step — return false to skip */
  onBeforeStep?: (step: SkillStep, index: number) => Promise<boolean>;
  /** Called after each step with its result */
  onStepComplete?: (result: StepResult) => void;
}

/** What a step produced: the line(s) to show, and the object `as:` captures. */
interface StepOutcome {
  output: string;
  value?: unknown;
}

/**
 * A write step whose intent failed. Carries the table's own result — including
 * what the unwind left behind — so `runSkill` reports it without re-deriving it.
 */
class StepDispatchFailure extends Error {
  constructor(readonly result: DispatchResult<unknown>) {
    super(result.error ?? `intent "${result.intent}" failed`);
    this.name = 'StepDispatchFailure';
  }
}

// ─── Variable Interpolation ───────────────────────────────────────────────────

/**
 * Walk a captured step result down `path`. Every miss THROWS.
 *
 * A chain reference that silently degrades into the literal `{{c.cardId}}` is
 * exactly the silent-wrong-answer this build exists to kill: the literal would
 * go to the wire as a card reference and come back as somebody else's refusal,
 * several turns later. A capture that does not carry the field says so here.
 */
function readCapture(captured: unknown, name: string, path: string[]): unknown {
  let cursor = captured;
  const walked: string[] = [];
  for (const field of path) {
    if (cursor === null || typeof cursor !== 'object') {
      throw new Error(
        `{{${[name, ...path].join('.')}}} — step captured as "${name}" has no "${field}" ` +
          `under ${[name, ...walked].join('.')}: that is a ${cursor === null ? 'null' : typeof cursor}, not an object.`,
      );
    }
    cursor = (cursor as Record<string, unknown>)[field];
    walked.push(field);
    if (cursor === undefined) {
      throw new Error(
        `{{${[name, ...path].join('.')}}} — step captured as "${name}" carries no ${walked.join('.')}.`,
      );
    }
  }
  return cursor;
}

/** A captured value is only usable as an argument if it renders as a scalar. */
function renderCapture(reference: string, value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new Error(
    `{{${reference}}} resolves to ${Array.isArray(value) ? 'an array' : 'an object'}, not a value. ` +
      `Reference a scalar field of it instead.`,
  );
}

/**
 * Replace {{variable}} placeholders in a string with resolved values.
 *
 * A plain `{{name}}` — and a flat key that happens to hold a dot, such as the
 * `{{scope.board}}` a skill template writes — is a variable. Anything else with
 * a dot whose HEAD names a step captured with `as:` is a chain reference, read
 * out of that step's structured result.
 */
export function interpolate(
  template: string,
  vars: Record<string, string>,
  captures: Record<string, unknown> = {},
): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, key: string) => {
    if (vars[key] !== undefined) return vars[key];
    const [name, ...path] = key.split('.');
    // `hasOwnProperty`, not `in`: `in` walks `Object.prototype`, so
    // `{{constructor.name}}` and `{{toString.x}}` would be read as chain
    // references and throw, where an unknown head must stay literal.
    if (path.length > 0 && Object.prototype.hasOwnProperty.call(captures, name)) {
      return renderCapture(key, readCapture(captures[name], name, path));
    }
    return `{{${key}}}`;
  });
}

/**
 * Recursively interpolate all string values in an args object.
 */
function interpolateArgs(
  args: Record<string, string> | undefined,
  vars: Record<string, string>,
  captures: Record<string, unknown> = {},
): Record<string, string> {
  if (!args) return {};
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(args)) {
    result[key] = typeof val === 'string' ? interpolate(val, vars, captures) : val;
  }
  return result;
}

// ─── Resolve Variables ────────────────────────────────────────────────────────

/**
 * Resolve all skill variables — use provided values, then defaults.
 * Returns a flat key→value map for interpolation.
 */
export function resolveVariables(
  variableDefs: Record<string, SkillVariable> | undefined,
  provided: Record<string, string>,
): Record<string, string> {
  const resolved: Record<string, string> = { ...provided };

  if (variableDefs) {
    for (const [key, def] of Object.entries(variableDefs)) {
      if (!resolved[key] && def.default) {
        resolved[key] = def.default;
      }
    }
  }

  return resolved;
}

// ─── Step Dispatcher ──────────────────────────────────────────────────────────

/**
 * Execute a single skill step by dispatching to the appropriate API.
 *
 * Returns BOTH the display string and the step's structured result. `as:`
 * captures the latter: a chain reads `{{name.cardId}}` off the object the API
 * actually returned, never off a re-parse of what we printed.
 */
async function executeStep(
  step: SkillStep,
  vars: Record<string, string>,
  captures: Record<string, unknown>,
  client: FavroHttpClient,
  options: SkillRunOptions,
  tx: { config: FavroConfig; log: CompensationLog },
): Promise<StepOutcome> {
  const args = interpolateArgs(step.args, vars, captures);

  switch (step.command) {
    case 'context': {
      const board = args.board ?? vars.board;
      if (!board) throw new Error('Step requires "board" argument');
      const contextApi = new ContextAPI(client);
      const snapshot = await contextApi.getSnapshot(board, parseLimit(args.limit) ?? 1000);
      return { output: JSON.stringify(snapshot, null, 2), value: snapshot };
    }

    case 'standup': {
      const board = args.board ?? vars.board;
      if (!board) throw new Error('Step requires "board" argument');
      const standupApi = new StandupAPI(client);
      const result = await standupApi.getStandup(board);
      const lines: string[] = [`Standup for ${result.board.name}:`];
      if (result.blocked.length) lines.push(`🔴 Blocked (${result.blocked.length}): ${result.blocked.map(c => c.title).join(', ')}`);
      if (result.inProgress.length) lines.push(`⏳ In Progress (${result.inProgress.length}): ${result.inProgress.map(c => c.title).join(', ')}`);
      if (result.dueSoon.length) lines.push(`📅 Due Soon (${result.dueSoon.length}): ${result.dueSoon.map(c => c.title).join(', ')}`);
      if (result.completed.length) lines.push(`✅ Completed (${result.completed.length}): ${result.completed.map(c => c.title).join(', ')}`);
      return { output: lines.join('\n'), value: result };
    }

    case 'sprint-plan': {
      const board = args.board ?? vars.board;
      if (!board) throw new Error('Step requires "board" argument');
      const sprintApi = new SprintPlanAPI(client);
      // `parseLimit`, not `parseInt`: the prefix parse made `budget: "1e9"` a
      // ONE-POINT sprint here, which is the same defect #142 closed on the CLI's
      // `--budget` — the two spellings of the same step must not disagree.
      // Missed by #143, which counted `limit` sites only. Found in review.
      const budget = parseLimit(args.budget, '--budget');
      const result = await sprintApi.getSuggestions(board, budget);
      const output = `Sprint plan for ${result.board.name} (budget: ${result.budget}):\n` +
        result.suggestions.map((c: any) => `  [${c.priority}] ${c.title} (effort: ${c.effort})`).join('\n');
      return { output, value: result };
    }

    case 'query': {
      const board = args.board ?? vars.board;
      const q = args.query;
      if (!board || !q) throw new Error('Step requires "board" and "query" arguments');
      const { QueryAPI } = await import('../api/query');
      const queryApi = new QueryAPI(client);
      const result = await queryApi.execute(board, q);
      const output = `Found ${result.matches.length} cards:\n` +
        result.matches.map((m: any) => `  - [${m.card.id}] ${m.card.title} (${m.card.status ?? 'no status'})`).join('\n');
      return { output, value: result };
    }

    default: {
      // Anything that is not a read command is a write intent. Looked up in the
      // shared table at CALL time, never against a list baked in here, so an
      // intent registered by a later ticket is callable from a skill at once.
      if (!getIntent(step.command)) {
        const known = intentNames();
        throw new Error(
          `Unknown skill command: "${step.command}".\n` +
            `  Read commands: context, standup, sprint-plan, query\n` +
            `  Write intents: ${known.length ? known.join(', ') : '(none registered)'}`,
        );
      }
      // The run's ONE log goes in, so this step's write joins the same
      // transaction as every step before it. The table does the unwinding.
      const result = await dispatch(step.command, args, {
        client,
        config: tx.config,
        force: options.force,
        dryRun: options.dryRun,
        log: tx.log,
      });
      // A preview wrote nothing, so it has no structured result to capture: a
      // later `{{name.field}}` stays literal under --dry-run rather than
      // inventing an id the run never obtained.
      if (result.preview) return { output: result.preview.map((line) => `[dry-run] ${line}`).join('\n') };
      if (result.outcome !== 'ok') throw new StepDispatchFailure(result);
      return { output: JSON.stringify(result.value ?? {}, null, 2), value: result.value };
    }
  }
}

// ─── Skill Runner ─────────────────────────────────────────────────────────────

/**
 * Execute a skill definition step-by-step.
 */
export async function runSkill(
  skill: SkillDefinition,
  options: SkillRunOptions = {},
): Promise<SkillRunResult> {
  const vars = resolveVariables(skill.variables, options.variables ?? {});
  const client = options.client ?? (await createFavroClient());
  const config = options.config ?? ((await readConfig()) ?? {});

  // ONE log for the whole run — this is the entire transaction mechanism the
  // engine owns. Every write step dispatches against it, so a late failure
  // unwinds the early writes too.
  const log = new CompensationLog();

  // What the steps so far captured with `as:`, keyed by capture name. Read by
  // `{{name.field}}` in every later step's args. Only a SUCCEEDING step
  // captures: a chain must never read a field off a step that did not run.
  const captures: Record<string, unknown> = {};

  // Checked before the first step, so a name no reference could ever match
  // costs nothing. `{{name.field}}` only matches word characters, so `as: my-cap`
  // would leave every reference to it standing as a literal and send THAT to the
  // wire — a silent wrong answer rather than a broken skill.
  for (const step of skill.steps) {
    if (step.as !== undefined && !/^\w+$/.test(step.as)) {
      throw new Error(
        `Invalid capture name "${step.as}" on step "${step.command}": ` +
          `an "as:" name must be letters, digits or underscores, so that {{${step.as}.field}} can reference it.`,
      );
    }
  }

  const results: StepResult[] = [];
  let hasFailure = false;
  // Whether a failure ENDED the run. The transaction is unwound if and only if
  // the run was aborted — a failure a step declared `continueOnError` for, and
  // that wrote nothing, is tolerated rather than fatal, so it must not drag the
  // writes that come after it into a rollback.
  let aborted = false;
  // What ended the run, kept so the end-of-run unwind can ask the table's one
  // question about it. A pre-write refusal is deterministic whichever step
  // raised it, so a run that unwinds around one is not retryable either (#66).
  let abortCause: unknown;
  let rollback: SkillRunResult['rollback'];

  for (let i = 0; i < skill.steps.length; i++) {
    const step = skill.steps[i];
    const stepNum = i + 1;

    // Inside the try from here on: interpolating a chain reference can itself
    // fail (a capture that carries no such field), and a throw that escaped the
    // loop would skip the end-of-run unwind and leave the run half-applied.
    try {
      // Confirmation check
      if (step.confirm && !options.dryRun) {
        const interpolatedCmd = `${step.command} ${Object.entries(interpolateArgs(step.args, vars, captures)).map(([k, v]) => `${k}="${v}"`).join(' ')}`;
        if (!(await confirmAction(`Execute step ${stepNum}: ${interpolatedCmd}?`, { yes: options.yes }))) {
          results.push({ step: stepNum, command: step.command, status: 'skipped' });
          options.onStepComplete?.({ step: stepNum, command: step.command, status: 'skipped' });
          continue;
        }
      }

      // Before-step callback
      if (options.onBeforeStep) {
        const proceed = await options.onBeforeStep(step, i);
        if (!proceed) {
          results.push({ step: stepNum, command: step.command, status: 'skipped' });
          options.onStepComplete?.({ step: stepNum, command: step.command, status: 'skipped' });
          continue;
        }
      }

      const { output, value } = await executeStep(step, vars, captures, client, options, { config, log });
      // The capture lands only now, after the step succeeded — and only if the
      // step actually produced structured data. A `--dry-run` step wrote
      // nothing and fetched nothing, so it captures nothing, and the references
      // to it stay literal in the preview instead of resolving to `undefined`.
      if (step.as && value !== undefined) captures[step.as] = value;
      const result: StepResult = { step: stepNum, command: step.command, status: 'success', output };
      results.push(result);
      options.onStepComplete?.(result);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const result: StepResult = { step: stepNum, command: step.command, status: 'failed', error: errMsg };
      results.push(result);
      options.onStepComplete?.(result);
      hasFailure = true;
      abortCause = error;

      if (error instanceof StepDispatchFailure) {
        // The table already unwound the whole run and emptied the log. There is
        // nothing left to build on, so `continueOnError` cannot apply: a later
        // step would be writing against a world that was just rolled back.
        rollback = {
          outcome: error.result.outcome,
          // The table already asked; asking again here is how the answers drift.
          retryable: error.result.retryable,
          orphans: error.result.orphans ?? [],
        };
        aborted = true;
        break;
      }
      // The run is ONE transaction, so `continueOnError` may only continue
      // across a failure that left the transaction empty — a read step, or a
      // refusal raised before anything was written. Once a write is pending,
      // continuing would run later steps against a world the end-of-run unwind
      // is about to revert: those writes would be visible to every other Favro
      // client and then taken back, buying nothing but wire traffic and a wider
      // window. So a failure after a write ends the run, exactly as a
      // `StepDispatchFailure` does.
      if (!step.continueOnError || log.depth > 0) {
        aborted = true;
        break;
      }
    }
  }

  // A pre-write refusal — the scope lock, a resolver, an unknown intent — throws
  // out of `dispatch` before its own unwind, so a run that already wrote would
  // otherwise end half-applied. The log still unwinds itself; the engine only
  // says when. A run that ended cleanly, one whose failure the table already
  // unwound, or one that merely tolerated a failure that wrote nothing, leaves
  // nothing here to do.
  if (aborted && log.depth > 0) {
    const unwound = await log.unwind();
    rollback = { ...unwound, retryable: isRetryable(unwound.outcome, abortCause) };
  }

  const allCompleted = results.length === skill.steps.length;
  const anySucceeded = results.some(r => r.status === 'success');

  // `partial` means some of the run stands and some of it did not. A run that
  // was rolled back has nothing standing, and a run whose only step failed has
  // nothing partial about it either — both are `failed`, so that `skill run`
  // exits non-zero on a refusal instead of reporting a partial success.
  const status: SkillRunResult['status'] =
    rollback ? 'failed'
      : !hasFailure ? 'completed'
        : anySucceeded && allCompleted ? 'partial'
          : 'failed';

  return {
    skill: skill.name,
    steps: results,
    status,
    ...(rollback ? { rollback } : {}),
  };
}
