import { Command } from 'commander';
import { scopeOverride, writeConfig } from '../lib/config';
import { Collection } from '../lib/collections-api';
import { RefusalError } from '../lib/refusal';
import { AnonymousCtx, Ctx, run } from '../lib/run';

/**
 * `set` and `clear` manage the FILE lock, and under `FAVRO_SCOPE_COLLECTION_ID`
 * nothing in this shell will ever read it (#174). Writing it and reporting
 * success would be a lie about the guardrail every write rests on, so both
 * refuse instead — a `RefusalError`, because it is deterministic and unsetting
 * the variable is the only thing that changes the answer.
 */
function refuseIfOverridden(verb: string, remedy: string): void {
  const env = scopeOverride();
  if (env === undefined) return;
  throw new RefusalError(
    `FAVRO_SCOPE_COLLECTION_ID is set ("${env}"), so it — not the config file — is the\n` +
      `  effective lock in this shell. '${verb}' writes the file lock, which nothing here reads,\n` +
      `  so it is refused rather than written.\n` +
      `  ${remedy}\n` +
      `  Run 'favro scope show' to see the effective lock and its source.`,
  );
}

export function registerScopeCommand(program: Command): void {
  const scopeCmd = program.command('scope')
    .description('Manage collection write scope to prevent accidental mutations');

  scopeCmd
    .command('set <collectionId>')
    .description('Lock write commands to a specific collection')
    .action(run(async (ctx: Ctx, collectionId: string) => {
      // Before the verifying GET: an override makes the write pointless, so
      // there is nothing to verify.
      refuseIfOverridden(
        'scope set',
        'To retarget this shell: export FAVRO_SCOPE_COLLECTION_ID=<collectionId>. ' +
          'To manage the file\n  lock instead: unset FAVRO_SCOPE_COLLECTION_ID.',
      );
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
    .action(run({ anonymous: true }, (ctx: AnonymousCtx) => {
      // The SOURCE, not just the value (#174). `ctx.config` already carries the
      // effective lock, so without this line the file and the env disagree and no
      // output explains why.
      const source = scopeOverride() !== undefined ? 'env' : 'file';
      return {
        item: {
          scopeCollectionId: ctx.config.scopeCollectionId,
          scopeCollectionName: ctx.config.scopeCollectionName,
          source,
        },
        human: () =>
          ctx.config.scopeCollectionId
            ? `🔒 Current scope: "${ctx.config.scopeCollectionName ?? ctx.config.scopeCollectionId}" (${ctx.config.scopeCollectionId})\n` +
              (source === 'env'
                ? '  Source: FAVRO_SCOPE_COLLECTION_ID — this shell only, and it overrides the config file.'
                : '  Source: config file — shared by every shell on this machine.')
            : '⚠ No scope set — all write commands are unrestricted',
      };
    }));

  scopeCmd
    .command('clear')
    .description('Remove write scope lock')
    .action(run({ anonymous: true }, async (ctx: AnonymousCtx) => {
      refuseIfOverridden(
        'scope clear',
        'To unlock this shell: unset FAVRO_SCOPE_COLLECTION_ID.',
      );
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
