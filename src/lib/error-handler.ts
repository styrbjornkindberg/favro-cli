/**
 * Unified Error Handler
 * CLA-1771 FAVRO-011: Error Handling & User Feedback
 *
 * Provides consistent error formatting, helpful suggestions, and verbose mode.
 */
import { c } from './theme';

/**
 * Format an error for display.
 * - Normal mode: "Error: [message]" (no stack trace)
 * - Verbose mode: Full stack trace
 */
export function logError(error: unknown, verbose = false): void {
  if (error instanceof Error) {
    console.error(`${c.fail} ${c.error('Error:')} ${error.message}`);
    if (verbose && error.stack) {
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
