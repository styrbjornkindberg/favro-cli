/**
 * Unified Error Handler
 * CLA-1771 FAVRO-011: Error Handling & User Feedback
 *
 * Provides consistent error formatting, helpful suggestions, and verbose mode.
 */
import type { Command } from 'commander';
import { c } from './theme';
import { classifyThrownError } from './favro-error';

/**
 * Whether the run asked for stack traces. Latched once per action by
 * `latchVerbose`, and the default every `logError` falls back to.
 */
let verboseRun = false;

/**
 * Make `--verbose` reach every command, by resolving it in ONE place (#85).
 *
 * `--verbose` is declared once, on the root program. Commander's `.opts()`
 * returns a command's OWN options only, so `root.opts().verbose` is `true`
 * while `tags.opts().verbose` is `undefined` — every action that read an
 * intermediate parent's opts got `false` and the flag was dead on that command,
 * across 28 sites. Twenty-five more passed no flag at all.
 *
 * A `preAction` hook on the root program is inherited by every descendant, so
 * this fires exactly once before whichever action is about to run, whatever its
 * depth. `optsWithGlobals()` merges the action command's own options with every
 * ancestor's, which is the resolution the broken sites were each trying and
 * failing to hand-roll — and it also picks up a subcommand that declares its
 * own `--verbose` (`batch update`), so those stay verbose too.
 *
 * Commands do not need to read the flag any more: `logError(error)` is now
 * correct everywhere. The reads still dotted through `src/commands` are
 * redundant rather than wrong — a stale `false` is OR'd with this — and #80
 * candidate 02 removes the template that produced them.
 */
export function latchVerbose(program: Command): void {
  program.hook('preAction', (_thisCommand, actionCommand) => {
    verboseRun = actionCommand.optsWithGlobals().verbose === true;
  });
}

/** Did this run ask for stack traces? */
export function isVerbose(): boolean {
  return verboseRun;
}

/**
 * Format an error for display.
 * - Normal mode: "Error: [message]" (no stack trace)
 * - Verbose mode: Full stack trace
 *
 * `verbose` is an override, never a veto: a caller that passes `false` (or
 * nothing) still gets the stack when the run was started with `--verbose`.
 * That is what makes the seam above a single fix rather than 53 of them.
 *
 * When the error came off the wire, Favro's own `response.data.message` is what
 * the user needs to see — axios' `Request failed with status code 403` says
 * nothing. The classifier turns the pair (status, message) into the line.
 */
export function logError(error: unknown, verbose = false): void {
  if (error instanceof Error) {
    const classified = classifyThrownError(error);
    const message = classified?.isFailure ? classified.message : error.message;
    console.error(`${c.fail} ${c.error('Error:')} ${message}`);
    if ((verbose || verboseRun) && error.stack) {
      console.error(c.muted('\nStack trace:'));
      console.error(c.muted(error.stack));
    }
  } else {
    console.error(`${c.fail} ${c.error('Error:')} ${String(error)}`);
  }
}

/**
 * Suggest closest board name when the target board is not found.
 * Returns a helpful message like:
 *   "Board 'Q2-Dev' not found. Available: Q2-Marketing, Q2-Eng, Q1-Archive"
 */
export function suggestBoard(boardName: string, availableBoards: string[]): string {
  const list = availableBoards.join(', ');
  const msg = `Board '${boardName}' not found.`;
  return list ? `${msg} Available: ${list}` : `${msg} No boards available.`;
}

/**
 * Format a "not found" error with suggestions.
 * Suitable for boards, collections, and other named resources.
 */
export function notFoundError(resourceType: string, name: string, available: string[]): string {
  const list = available.join(', ');
  const msg = `${resourceType} '${name}' not found.`;
  return list ? `${msg} Available: ${list}` : `${msg}`;
}

/**
 * Format an invalid date error.
 */
export function invalidDateError(_value?: string): string {
  return `Invalid date format. Use YYYY-MM-DD`;
}

/**
 * Format a rate limit message.
 */
export function rateLimitMessage(retrySeconds?: number): string {
  if (retrySeconds !== undefined) {
    return `${c.warn('⏳')} Rate limited. Retrying in ${c.bold(String(retrySeconds))} seconds...`;
  }
  return `${c.warn('⏳')} Rate limited. Please wait before retrying.`;
}

/**
 * Format a missing API key error.
 */
export function missingApiKeyError(): string {
  return `${c.fail} API key not found. Run ${c.info("'favro auth login'")} first`;
}

/**
 * ErrorFormatter class for consistent error output across all commands.
 */
export class ErrorFormatter {
  private verbose: boolean;

  constructor(verbose = false) {
    this.verbose = verbose;
  }

  /**
   * Log an error to stderr with consistent formatting.
   */
  log(error: unknown): void {
    logError(error, this.verbose);
  }

  /**
   * Log an error and exit with code 1.
   */
  fatal(error: unknown): never {
    this.log(error);
    process.exit(1);
  }

  /**
   * Create a helpful "not found" message.
   */
  notFound(resourceType: string, name: string, available: string[]): string {
    return notFoundError(resourceType, name, available);
  }
}

export default ErrorFormatter;
