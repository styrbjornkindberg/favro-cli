import { Command } from 'commander';
import { readConfig, writeConfig } from '../lib/config';
import { createFavroClient } from '../lib/client-factory';
import CollectionsAPI from '../lib/collections-api';
import { logError } from '../lib/error-handler';

export function registerScopeCommand(program: Command): void {
  const scopeCmd = program.command('scope')
    .description('Manage collection write scope to prevent accidental mutations');

  scopeCmd
    .command('set <collectionId>')
    .description('Lock write commands to a specific collection')
    .action(async (collectionId: string) => {
      try {
        const client = await createFavroClient();
        const api = new CollectionsAPI(client);
        
        console.log(`Verifying collection ${collectionId}...`);
        const collection = await api.getCollection(collectionId);
        
        const config = await readConfig();
        config.scopeCollectionId = collectionId;
        config.scopeCollectionName = collection.name;
        await writeConfig(config);
        
        console.log(`✓ Scope locked to collection: "${collection.name}" (${collectionId})`);
        console.log(`  Write commands to boards outside this collection will now be blocked.`);
      } catch (error: any) {
        logError(error, program.opts().verbose);
        process.exit(1);
      }
    });

  scopeCmd
    .command('show')
    .description('Show current write scope')
    .action(async () => {
      try {
        const config = await readConfig();
        if (config.scopeCollectionId) {
          console.log(`🔒 Current scope: "${config.scopeCollectionName ?? config.scopeCollectionId}" (${config.scopeCollectionId})`);
        } else {
          console.log('⚠ No scope set — all write commands are unrestricted');
        }
      } catch (error: any) {
        logError(error, false);
      }
    });

  scopeCmd
    .command('clear')
    .description('Remove write scope lock')
    .action(async () => {
      try {
        const config = await readConfig();
        if (!config.scopeCollectionId) {
          console.log('No scope lock currently set.');
          return;
        }
        
        delete config.scopeCollectionId;
        delete config.scopeCollectionName;
        await writeConfig(config);
        
        console.log('✓ Scope lock cleared. All write commands are now unrestricted.');
      } catch (error: any) {
        logError(error, false);
      }
    });
}
