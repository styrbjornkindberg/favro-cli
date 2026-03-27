/**
 * Collections Get Command
 * CLA-1783 FAVRO-021: Implement Collections Endpoints
 *
 * favro collections get <id> [--include boards,stats]
 */
import { Command } from 'commander';
import CollectionsAPI from '../lib/collections-api';
import FavroHttpClient from '../lib/http-client';
import { resolveApiKey } from '../lib/config';
import { logError, missingApiKeyError } from '../lib/error-handler';

export function registerCollectionsGetCommand(collectionsParent: Command): void {
  collectionsParent
    .command('get <id>')
    .description('Get a collection by ID')
    .option(
      '--include <options>',
      'Comma-separated list of related data to include: boards, stats',
    )
    .option('--json', 'Output as JSON')
    .action(async (id: string, options) => {
      const verbose = collectionsParent.parent?.opts()?.verbose ?? false;
      try {
        const token = await resolveApiKey();
        if (!token) {
          console.error(`Error: ${missingApiKeyError()}`);
          process.exit(1);
        }

        const VALID_INCLUDES = ['boards', 'stats'];
        const include = options.include
          ? options.include.split(',').map((s: string) => s.trim()).filter(Boolean)
          : undefined;

        if (include && include.length > 0) {
          const invalidValues = include.filter((v: string) => !VALID_INCLUDES.includes(v));
          if (invalidValues.length > 0) {
            console.error(`Error: Invalid --include values: ${invalidValues.join(', ')}. Valid options: ${VALID_INCLUDES.join(', ')}`);
            process.exit(1);
          }
        }

        const client = new FavroHttpClient({ auth: { token } });
        const api = new CollectionsAPI(client);

        const collection = await api.getCollection(id, include);

        if (options.json) {
          console.log(JSON.stringify(collection, null, 2));
        } else {
          console.log(`Collection: ${collection.name} (${collection.collectionId})`);
          if (collection.description) {
            console.log(`Description: ${collection.description}`);
          }
          if (collection.boardCount !== undefined) {
            console.log(`Boards: ${collection.boardCount}`);
          }
          if (collection.memberCount !== undefined) {
            console.log(`Members: ${collection.memberCount}`);
          }
          console.log(`Created: ${collection.createdAt?.slice(0, 10) ?? '—'}`);
          console.log(`Updated: ${collection.updatedAt?.slice(0, 10) ?? '—'}`);

          if (collection.boards && collection.boards.length > 0) {
            console.log('\nBoards:');
            const rows = collection.boards.map(b => ({
              ID: b.boardId,
              Name: b.name,
              Cards: b.cardCount ?? '—',
            }));
            console.table(rows);
          }
        }
      } catch (error: any) {
        // Surface 404 with clear message
        if (error?.response?.status === 404) {
          console.error(`✗ Collection not found: ${id}. Use 'favro collections list' to see available collections.`);
          process.exit(1);
        }
        logError(error, verbose);
        process.exit(1);
      }
    });
}

export default registerCollectionsGetCommand;
