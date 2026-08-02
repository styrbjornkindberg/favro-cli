/**
 * Collections List Command
 * CLA-1783 FAVRO-021: Implement Collections Endpoints
 *
 * favro collections list [--human]
 */
import { Command } from 'commander';
import { Collection } from '../lib/collections-api';
import { omitBulk } from '../lib/read-shape';
import { run } from '../lib/run';

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
    // `--format table|json` is gone (ADR-0002): it was a third spelling of
    // `--human`/`--json`, and the runner owns the axis now.
    .action(run(async (ctx) => {
      const collections = await ctx.api.collections.listCollections(100);

      // The two bulk fields are dropped before the rows leave the handler —
      // `sharedToUsers` alone was 47% of this payload. Omission is rendering
      // only, and neither field reaches the table, so both modes agree.
      return {
        rows: omitBulk('collection', collections),
        human: (rows: Collection[]) => {
          console.log(`Found ${rows.length} collection(s):`);
          formatCollectionsTable(rows);
        },
      };
    }));
}

export default registerCollectionsListCommand;
