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

  tagsCommand
    .command('update <tagId>')
    .description('Update a tag (rename or recolor)')
    .option('--name <name>', 'New tag name')
    .option('--color <color>', 'New tag color (e.g. red, blue)')
    .option('--json', 'Output as JSON')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (tagId: string, options) => {
      const verbose = tagsCommand.opts()?.verbose ?? false;
      try {
        if (!options.name && !options.color) {
          console.error('Error: Provide at least one field to update: --name or --color');
          process.exit(1);
        }

        const updateData: { name?: string; color?: string } = {};
        if (options.name) updateData.name = options.name;
        if (options.color) updateData.color = options.color;

        if (options.dryRun) {
          dryRunLog('updating', 'tag', tagId, updateData);
          return;
        }

        if (!(await confirmAction(`Update tag ${tagId}?`, { yes: options.yes }))) {
          return;
        }

        const client = await createFavroClient();
        const api = new TagsAPI(client);
        const tag = await api.updateTag(tagId, updateData);

        if (options.json) {
          console.log(JSON.stringify(tag, null, 2));
        } else {
          console.log(`✓ Tag updated: ${tag.tagId} (${tag.name})`);
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  tagsCommand
    .command('delete <tagId>')
    .description('Delete a tag')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (tagId: string, options) => {
      const verbose = tagsCommand.opts()?.verbose ?? false;
      try {
        if (options.dryRun) {
          dryRunLog('deleting', 'tag', tagId);
          return;
        }

        if (!(await confirmAction(`Delete tag ${tagId}? This cannot be undone.`, { yes: options.yes }))) {
          return;
        }

        const client = await createFavroClient();
        const api = new TagsAPI(client);
        await api.deleteTag(tagId);

        console.log(`✓ Tag deleted: ${tagId}`);
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });
}
