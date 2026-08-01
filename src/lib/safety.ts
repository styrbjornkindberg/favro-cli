import * as readline from 'readline';
import { FavroConfig } from './config';
import FavroHttpClient from './http-client';
import { logError } from './error-handler';
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
 */
export class ScopeError extends Error {
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
