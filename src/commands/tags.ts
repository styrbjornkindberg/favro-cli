/**
 * Tags Commands
 * CLA-1802 FAVRO-XXX: Tags Endpoints
 *
 * favro tags list
 * favro tags create --name "Bug" --color red
 */
import { Command } from 'commander';
import TagsAPI from '../lib/tags-api';
import { createFavroClient } from '../lib/client-factory';
import { logError } from '../lib/error-handler';
import { confirmAction, dryRunLog } from '../lib/safety';

export function registerTagsCommands(program: Command): void {
  const tagsCommand = program.command('tags').description('Manage global workspace tags');

  tagsCommand
    .command('list')
    .description('List all tags in the workspace')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const verbose = tagsCommand.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();
        const api = new TagsAPI(client);
        const tags = await api.listTags();

        if (options.json) {
          console.log(JSON.stringify(tags, null, 2));
        } else {
          console.log(`Found ${tags.length} tag(s):`);
          const rows = tags.map(t => ({
            ID: t.tagId,
            Name: t.name,
            Color: t.color || 'none',
          }));
          console.table(rows);
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  tagsCommand
    .command('create')
    .description('Create a new global tag')
    .requiredOption('--name <name>', 'Tag name')
    .option('--color <color>', 'Tag color (e.g. red, blue)')
    .option('--json', 'Output as JSON')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (options) => {
      const verbose = tagsCommand.opts()?.verbose ?? false;
      try {
        if (options.dryRun) {
          dryRunLog('creating', 'tag', options.name);
          process.exit(0);
        }

        if (!(await confirmAction(`Create tag "${options.name}"${options.color ? ` (color: ${options.color})` : ''}?`, { yes: options.yes }))) {
          process.exit(0);
        }

        const client = await createFavroClient();
        const api = new TagsAPI(client);
        const tag = await api.createTag(options.name, options.color);

        if (options.json) {
          console.log(JSON.stringify(tag, null, 2));
        } else {
          console.log(`✓ Tag created: ${tag.tagId} (${tag.name})`);
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });
}
