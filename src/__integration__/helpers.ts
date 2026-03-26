/**
 * Integration test helpers
 *
 * Setup:
 *   export FAVRO_API_TOKEN=<your Favro API bearer token>
 *   export FAVRO_TEST_BOARD_ID=<board ID to run tests against>
 *
 * Create a dedicated "CLI Test Board" in Favro for these tests.
 * Cards created during tests are tracked and cleaned up after each suite.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

export const execFileAsync = promisify(execFile);

/** Path to the compiled CLI entry point */
export const CLI_PATH = path.resolve(__dirname, '../../dist/cli.js');

/** Run CLI via ts-node for integration tests (no build required) */
const TS_NODE = path.resolve(__dirname, '../../node_modules/.bin/ts-node');
const CLI_SRC = path.resolve(__dirname, '../cli.ts');

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run the CLI with given args. Returns stdout, stderr, and exit code.
 * Uses ts-node so no build step needed.
 */
export async function runCLI(args: string[], env?: Record<string, string>): Promise<RunResult> {
  const mergedEnv = {
    ...process.env,
    FAVRO_API_TOKEN: process.env.FAVRO_API_TOKEN || '',
    ...env,
  };

  try {
    const { stdout, stderr } = await execFileAsync(
      TS_NODE,
      ['--project', path.resolve(__dirname, '../../tsconfig.json'), CLI_SRC, ...args],
      { env: mergedEnv, timeout: 60000 }
    );
    return { stdout, stderr, exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.code || 1,
    };
  }
}

/**
 * Check if integration test env vars are present.
 * Call this at the top of each describe block to skip when not configured.
 */
export function integrationGuard(): boolean {
  return !!(process.env.FAVRO_API_TOKEN && process.env.FAVRO_TEST_BOARD_ID);
}

export const TEST_BOARD_ID = process.env.FAVRO_TEST_BOARD_ID || '';
export const API_TOKEN = process.env.FAVRO_API_TOKEN || '';

/** Small delay helper */
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
