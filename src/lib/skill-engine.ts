/**
 * Skill Engine — YAML Skill Parsing, Variable Interpolation, and Step Execution
 *
 * Executes skill definitions step-by-step. Each step maps to a CLI command
 * that is dispatched to the underlying API layer.
 *
 * Supported commands in skill steps:
 *   context, query, standup, sprint-plan, audit
 */
import FavroHttpClient from '../lib/http-client';
import { createFavroClient } from './client-factory';
import { confirmAction } from './safety';
import ContextAPI from '../api/context';
import { StandupAPI } from '../api/standup';
import { SprintPlanAPI } from '../api/sprint-plan';
import { SkillDefinition, SkillStep, SkillVariable } from './skill-store';
import { parseSince } from './audit-api';

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
}

export interface SkillRunOptions {
  dryRun?: boolean;
  yes?: boolean;
  variables?: Record<string, string>;
  /** Called before each step — return false to skip */
  onBeforeStep?: (step: SkillStep, index: number) => Promise<boolean>;
  /** Called after each step with its result */
  onStepComplete?: (result: StepResult) => void;
}

// ─── Variable Interpolation ───────────────────────────────────────────────────

/**
 * Replace {{variable}} placeholders in a string with resolved values.
 */
export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, key) => {
    return vars[key] ?? `{{${key}}}`;
  });
}

/**
 * Recursively interpolate all string values in an args object.
 */
function interpolateArgs(args: Record<string, string> | undefined, vars: Record<string, string>): Record<string, string> {
  if (!args) return {};
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(args)) {
    result[key] = typeof val === 'string' ? interpolate(val, vars) : val;
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
 * Returns the output as a string for display/chaining.
 */
async function executeStep(
  step: SkillStep,
  vars: Record<string, string>,
  client: FavroHttpClient,
  options: SkillRunOptions,
): Promise<string> {
  const args = interpolateArgs(step.args, vars);

  switch (step.command) {
    case 'context': {
      const board = args.board ?? vars.board;
      if (!board) throw new Error('Step requires "board" argument');
      const contextApi = new ContextAPI(client);
      const snapshot = await contextApi.getSnapshot(board, parseInt(args.limit ?? '1000', 10));
      return JSON.stringify(snapshot, null, 2);
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
      return lines.join('\n');
    }

    case 'sprint-plan': {
      const board = args.board ?? vars.board;
      if (!board) throw new Error('Step requires "board" argument');
      const sprintApi = new SprintPlanAPI(client);
      const budget = args.budget ? parseInt(args.budget, 10) : undefined;
      const result = await sprintApi.getSuggestions(board, budget);
      return `Sprint plan for ${result.board.name} (budget: ${result.budget}):\n` +
        result.suggestions.map((c: any) => `  [${c.priority}] ${c.title} (effort: ${c.effort})`).join('\n');
    }

    case 'query': {
      const board = args.board ?? vars.board;
      const q = args.query;
      if (!board || !q) throw new Error('Step requires "board" and "query" arguments');
      const { QueryAPI } = await import('../api/query');
      const queryApi = new QueryAPI(client);
      const result = await queryApi.execute(board, q);
      return `Found ${result.matches.length} cards:\n` +
        result.matches.map((m: any) => `  - [${m.card.id}] ${m.card.title} (${m.card.status ?? 'no status'})`).join('\n');
    }

    case 'audit': {
      const board = args.board ?? vars.board;
      if (!board) throw new Error('Step requires "board" argument');
      const AuditAPI = (await import('./audit-api')).default;
      const auditApi = new AuditAPI(client);
      const since = args.since ?? '1d';
      const sinceDate = parseSince(since);
      const results = await auditApi.getBoardAuditLog(board, sinceDate, parseInt(args.limit ?? '50', 10));
      return `Audit for ${board} (since ${since}):\n` +
        results.map(a => `  - ${a.changeType}: ${a.cardName} (${a.author ?? 'unknown'})`).join('\n');
    }

    default:
      throw new Error(`Unknown skill command: "${step.command}". Supported: context, standup, sprint-plan, query, audit`);
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
  const client = await createFavroClient();

  const results: StepResult[] = [];
  let hasFailure = false;

  for (let i = 0; i < skill.steps.length; i++) {
    const step = skill.steps[i];
    const stepNum = i + 1;

    // Confirmation check
    if (step.confirm && !options.dryRun) {
      const interpolatedCmd = `${step.command} ${Object.entries(interpolateArgs(step.args, vars)).map(([k, v]) => `${k}="${v}"`).join(' ')}`;
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

    try {
      const output = await executeStep(step, vars, client, options);
      const result: StepResult = { step: stepNum, command: step.command, status: 'success', output };
      results.push(result);
      options.onStepComplete?.(result);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const result: StepResult = { step: stepNum, command: step.command, status: 'failed', error: errMsg };
      results.push(result);
      options.onStepComplete?.(result);
      hasFailure = true;

      if (!step.continueOnError) {
        break;
      }
    }
  }

  const allCompleted = results.length === skill.steps.length;
  const allSucceeded = results.every(r => r.status === 'success' || r.status === 'skipped');

  return {
    skill: skill.name,
    steps: results,
    status: allSucceeded && allCompleted ? 'completed' : hasFailure ? (allCompleted ? 'partial' : 'failed') : 'completed',
  };
}
