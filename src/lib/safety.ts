import * as readline from 'readline';
import { FavroConfig } from './config';
import FavroHttpClient from './http-client';
import { logError } from './error-handler';

/**
 * Ask the user for confirmation via stdin.
 * @param message The prompt message
 * @param yes If true, skip prompt and return true
 */
export async function confirmAction(message: string, options: { yes?: boolean } = {}): Promise<boolean> {
  if (options.yes) {
    return true;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

/**
 * Checks if the board belongs to the currently locked scope collection.
 * If scope checking is not enabled, or the board belongs to the collection, returns true.
 * Otherwise, logs an error and exits the process (unless force is true).
 */
export async function checkScope(
  boardId: string,
  client: FavroHttpClient,
  config: FavroConfig,
  force: boolean = false
): Promise<void> {
  if (!config.scopeCollectionId) {
    return;
  }

  try {
    const raw = await client.get<any>(`/widgets/${boardId}`);
    const collectionIds = raw.collectionIds ?? [];

    if (!collectionIds.includes(config.scopeCollectionId)) {
      if (force) {
        console.warn(`[!] Warning: Board ${boardId} is outside your locked scope (${config.scopeCollectionName ?? config.scopeCollectionId}), but proceeding because --force was used.`);
        return;
      }

      console.error(`✗ Scope violation: board "${raw.name ?? boardId}" is not in locked collection "${config.scopeCollectionName ?? config.scopeCollectionId}".`);
      console.error(`  Run 'favro scope show' to see your current lock.`);
      console.error(`  Run 'favro scope set <collectionId>' to change it, or pass --force to override.`);
      process.exit(1);
    }
  } catch (error: any) {
    if (error?.response?.status === 404) {
      console.error(`✗ Scope check failed: Board ${boardId} not found.`);
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
  if (!config.scopeCollectionId) {
    return;
  }

  if (collectionId !== config.scopeCollectionId) {
    if (force) {
      console.warn(`[!] Warning: Target collection ${collectionId} is outside your locked scope (${config.scopeCollectionName ?? config.scopeCollectionId}), but proceeding because --force was used.`);
      return;
    }

    console.error(`✗ Scope violation: target collection "${collectionId}" is not the locked collection "${config.scopeCollectionName ?? config.scopeCollectionId}".`);
    console.error(`  Run 'favro scope show' to see your current lock.`);
    console.error(`  Run 'favro scope set <collectionId>' to change it, or pass --force to override.`);
    process.exit(1);
  }
}

/**
 * Generates a standard dry-run preview message.
 */
export function dryRunLog(verb: string, targetType: string, targetName: string, payload?: any): void {
  console.log(`[dry-run] Would ${verb} ${targetType} "${targetName}"${payload ? ' with:' : ''}`);
  if (payload) {
    console.log(JSON.stringify(payload, null, 2));
  }
}
