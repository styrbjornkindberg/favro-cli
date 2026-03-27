/**
 * Collections List Command
 * CLA-1783 FAVRO-021: Implement Collections Endpoints
 *
 * favro collections list [--format table|json]
 */
import { Command } from 'commander';
import CollectionsAPI, { Collection } from '../lib/collections-api';
import FavroHttpClient from '../lib/http-client';
import { resolveApiKey } from '../lib/config';
import { logError, missingApiKeyError } from '../lib/error-handler';

export function formatCollectionsTable(collections: Collection[]): void {
  if (collections.length === 0) {
    console.log('No collections found.');
    return;
  }

  const rows = collections.map(c => ({
    ID: c.collectionId,
    Name: (c.name ?? '—').length > 40 ? (c.name ?? '—').slice(0, 37) + '...' : (c.name ?? '—'),
    Description: c.description
      ? c.description.length > 35 ? c.description.slice(0, 32) + '...' : c.description
      : '—',
    Boards: c.boardCount ?? '—',
    Members: c.memberCount ?? '—',
    Updated: c.updatedAt ? c.updatedAt.slice(0, 10) : '—',
  }));

  console.table(rows);
}

export function registerCollectionsListCommand(collectionsParent: Command): void {
  collectionsParent
    .command('list')
    .description('List all collections')
    .option('--format <format>', 'Output format: table or json', 'table')
    .option('--json', 'Output as JSON (alias for --format json)')
    .action(async (options) => {
      const verbose = collectionsParent.parent?.opts()?.verbose ?? false;
      try {
        const token = await resolveApiKey();
        if (!token) {
          console.error(`Error: ${missingApiKeyError()}`);
          process.exit(1);
        }

        // --json flag is an alias for --format json
        const format = options.json ? 'json' : (options.format ?? 'table').toLowerCase();
        if (format !== 'table' && format !== 'json') {
          console.error(`Error: Invalid format "${options.format}". Use --format table or --format json`);
          process.exit(1);
        }

        const client = new FavroHttpClient({ auth: { token } });
        const api = new CollectionsAPI(client);
        const collections = await api.listCollections(100);

        if (format === 'json') {
          console.log(JSON.stringify(collections, null, 2));
        } else {
          console.log(`Found ${collections.length} collection(s):`);
          formatCollectionsTable(collections);
        }
      } catch (error) {
        logError(error, verbose);
        process.exit(1);
      }
    });
}

export default registerCollectionsListCommand;
