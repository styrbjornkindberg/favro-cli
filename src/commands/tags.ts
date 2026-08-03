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
import { assertOrgScope, confirmAction, dryRunLog } from '../lib/safety';
import { capRows, noteTruncation, writeEnvelope } from '../lib/read-shape';
import { invalidateCache } from '../lib/name-cache';

export function registerTagsCommands(program: Command): void {
  const tagsCommand = program.command('tags').description('Manage global workspace tags');

  tagsCommand
    .command('list')
    .description('List all tags in the workspace')
    .option('--limit <n>', 'Cap how many rows are printed; sets "truncated"')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const verbose = tagsCommand.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();
        const api = new TagsAPI(client);
        const tags = await api.listTags();
        // The fetch already ran to completion; `--limit` cuts the PRINT (#99).
        // Enveloped since #44, but with no cap it could never say `truncated`.
        const envelope = capRows(tags, options.limit);

        if (options.json) {
          // A list read: envelope, compact. A tag row has no bulk field — the
          // 27 KB is 249 rows, which `favro tags get` answers for a single tag.
          writeEnvelope(envelope, Boolean(program.opts()?.pretty));
        } else {
          console.log(`Found ${envelope.rows.length} tag(s):`);
          const rows = envelope.rows.map(t => ({
            ID: t.tagId,
            Name: t.name,
            Color: t.color || 'none',
          }));
          console.table(rows);
          noteTruncation(envelope, tags.length);
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  tagsCommand
    .command('get <tag>')
    .description('Get one tag by name or tagId (~200 bytes, not the whole tag list)')
    .option('--json', 'Output as JSON')
    .action(async (tag: string, options) => {
      const verbose = tagsCommand.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();
        const api = new TagsAPI(client);
        const found = await api.getTag(tag);

        if (options.json) {
          console.log(JSON.stringify(found, null, 2));
        } else {
          console.log(`Tag: ${found.name}`);
          console.log(`ID: ${found.tagId}`);
          console.log(`Color: ${found.color || 'none'}`);
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  // The three tag writes below (#104) do not consult the scope lock, and that is
  // decided, not forgotten. The lock is a COLLECTION lock: `assertScope` resolves
  // the board a write lands on and asks whether that board sits in the locked
  // collection. A tag is a workspace-level entity — it lands on no board, so there
  // is nothing for the lock to resolve. Guarding here could only produce a check
  // that always passes (a lie) or one that always refuses (tag management broken
  // outright for every locked user). Neither is the lock doing its job. If these
  // need a guardrail it is an ORG-level guard, not this one in a costume.
  //
  // #125 built that separate guard, and it covers exactly one of the three:
  // `assertOrgScope` on `tags delete`, because `tags delete` strips the tag from
  // every card in the organization and cannot be undone — a wider blast radius
  // than anything the collection lock guards. `create` is additive and a stray
  // one is undone by a delete; `update` renames org-wide but another rename puts
  // it back. Irreversibility is the line. On those two the guard remains
  // `confirmAction`, which `-y` waives.
  //
  // Not the reason, though #125's own body offers it: "an unknown tag name is
  // already refused client-side". `createTag` refuses nothing — it posts the name
  // it is given, which is the whole point of a create. The refusal is
  // `TagLookupError` in `getTag`, and what it closes is the ACCIDENTAL-creation
  // path on a CARD write (`cards update --tags "typo"` refuses instead of
  // inventing a tag). That is true and it matters; it says nothing about this
  // command, so it is not what exempts it.
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
        // Or the 15-minute TTL keeps the new tag invisible to every resolver that
        // refuses on an unknown name — including `cards create --tag`, whose
        // refusal message tells you to run this command.
        await invalidateCache(client.organizationId, 'tags');

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
    .description('Delete a tag — organization-wide; refused while a scope lock is set')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Allow this org-wide delete despite the scope lock')
    .action(async (tagId: string, options) => {
      const verbose = tagsCommand.opts()?.verbose ?? false;
      try {
        // #125 closes the gap the comment above names. The collection lock still
        // cannot govern this write — but `assertOrgScope` can, and does: a
        // configured lock refuses an org-wide delete unless --force. Before the
        // dry-run, matching `cards create`, so a preview is not a way around it.
        await assertOrgScope(`Deleting tag ${tagId}`, options.force);

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
