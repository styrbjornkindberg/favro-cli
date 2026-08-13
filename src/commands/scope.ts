import { Command } from 'commander';
import { writeConfig } from '../lib/config';
import { Collection } from '../lib/collections-api';
import { AnonymousCtx, Ctx, run } from '../lib/run';

export function registerScopeCommand(program: Command): void {
  const scopeCmd = program.command('scope')
    .description('Manage collection write scope to prevent accidental mutations');

  scopeCmd
    .command('set <collectionId>')
    .description('Lock write commands to a specific collection')
    .action(run(async (ctx: Ctx, collectionId: string) => {
      // On stderr: it prints while the command is still working, and stdout
      // carries the result.
      process.stderr.write(`Verifying collection ${collectionId}...\n`);
      const collection: Collection = await ctx.api.collections.getCollection(collectionId);

      await writeConfig({
        ...ctx.config,
        scopeCollectionId: collectionId,
        scopeCollectionName: collection.name,
      });

      return {
        item: { scopeCollectionId: collectionId, scopeCollectionName: collection.name },
        human: () =>
          `✓ Scope locked to collection: "${collection.name}" (${collectionId})\n` +
          `  Write commands to boards outside this collection will now be blocked.`,
      };
    }));

  scopeCmd
    .command('show')
    .description('Show current write scope')
    // `anonymous`: the lock is read from the config file, and asking a user with
    // no credentials what their scope is should not refuse.
    .action(run({ anonymous: true }, (ctx: AnonymousCtx) => ({
      item: {
        scopeCollectionId: ctx.config.scopeCollectionId,
        scopeCollectionName: ctx.config.scopeCollectionName,
      },
      human: () =>
        ctx.config.scopeCollectionId
          ? `🔒 Current scope: "${ctx.config.scopeCollectionName ?? ctx.config.scopeCollectionId}" (${ctx.config.scopeCollectionId})`
          : '⚠ No scope set — all write commands are unrestricted',
    })));

  scopeCmd
    .command('clear')
    .description('Remove write scope lock')
    .action(run({ anonymous: true }, async (ctx: AnonymousCtx) => {
      if (!ctx.config.scopeCollectionId) {
        return { item: { cleared: false }, human: () => 'No scope lock currently set.' };
      }

      const config = { ...ctx.config };
      delete config.scopeCollectionId;
      delete config.scopeCollectionName;
      await writeConfig(config);

      return {
        item: { cleared: true },
        human: () => '✓ Scope lock cleared. All write commands are now unrestricted.',
      };
    }));
}
