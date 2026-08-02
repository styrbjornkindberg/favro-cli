/**
 * Collections Get Command
 * CLA-1783 FAVRO-021: Implement Collections Endpoints
 *
 * favro collections get <id> [--include boards,stats]
 */
import { Command } from 'commander';
import { Collection } from '../lib/collections-api';
import { run } from '../lib/run';

const VALID_INCLUDES = ['boards', 'stats'];

function formatCollectionDetails(collection: Collection): void {
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

export function registerCollectionsGetCommand(collectionsParent: Command): void {
  collectionsParent
    .command('get <collection>')
    .description('Get a collection by id or exact name (trimmed, case-insensitive)')
    .option(
      '--include <options>',
      'Comma-separated list of related data to include: boards, stats',
    )
    // No bare "not found" arm: CollectionsAPI already classified the failure and
    // resolution refusals carry their own candidate list.
    .action(run(async (ctx, id: string, options: { include?: string }) => {
      const include = options.include
        ? options.include.split(',').map((s: string) => s.trim()).filter(Boolean)
        : undefined;

      if (include && include.length > 0) {
        const invalidValues = include.filter((v: string) => !VALID_INCLUDES.includes(v));
        if (invalidValues.length > 0) {
          throw new Error(
            `Invalid --include values: ${invalidValues.join(', ')}. Valid options: ${VALID_INCLUDES.join(', ')}`,
          );
        }
      }

      return {
        item: await ctx.api.collections.getCollection(id, include),
        human: formatCollectionDetails,
      };
    }));
}

export default registerCollectionsGetCommand;
