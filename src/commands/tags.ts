/**
 * Tags Commands
 * CLA-1802 FAVRO-XXX: Tags Endpoints
 *
 * favro tags list
 * favro tags create --name "Bug" --color red
 */
import { Command } from 'commander';
import { Tag, TagLookupError } from '../lib/tags-api';
import { RefusalError } from '../lib/refusal';
import { assertOrgScope, confirmAction, dryRunLog } from '../lib/safety';
import { invalidateCache } from '../lib/name-cache';
import { Ctx, run } from '../lib/run';
import { c } from '../lib/theme';

/** The flag row the tag writes share. */
interface TagWriteFlags {
  name?: string;
  color?: string;
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
}

export function registerTagsCommands(program: Command): void {
  const tagsCommand = program.command('tags').description('Manage global workspace tags');

  tagsCommand
    .command('list')
    .description('List all tags in the workspace')
    .option('--limit <n>', 'Cap how many rows are printed; sets "truncated"')
    .action(run(async (ctx: Ctx, options: { limit?: string }) => ({
      // A list read: the envelope, compact. A tag row has no bulk field — the
      // 27 KB is 249 rows, which `favro tags get` answers for a single tag. The
      // fetch runs to completion; `--limit` cuts the PRINT (#99).
      rows: await ctx.api.tags.listTags(),
      limit: options.limit,
      human: (tags: Tag[]) => {
        console.log(`Found ${tags.length} tag(s):`);
        console.table(tags.map(t => ({
          ID: t.tagId,
          Name: t.name,
          Color: t.color || 'none',
        })));
      },
    })));

  tagsCommand
    .command('get <tag>')
    .description('Get one tag by name or tagId (~200 bytes, not the whole tag list)')
    .action(run(async (ctx: Ctx, tag: string) => ({
      item: await ctx.api.tags.getTag(tag),
      human: (found: Tag) =>
        [`Tag: ${found.name}`, `ID: ${found.tagId}`, `Color: ${found.color || 'none'}`].join('\n'),
    })));

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
  // than anything the collection lock guards. `create` is additive and `update`
  // renames org-wide but another rename puts it back. Irreversibility is the line.
  // On those two the guard remains `confirmAction`, which `-y` waives.
  //
  // What that argument does NOT establish is that the undo is REACHABLE. #125's
  // wording for `create` was "a stray one is undone by a delete" — but the delete
  // it points at is the one write `assertOrgScope` refuses, so under a configured
  // lock `create` is permitted and its stated undo needs `--force` (#163).
  // `update`'s undo is another `update`, which takes no org guard, so `create` is
  // the only one of the two whose remedy the lock withholds. Left as it is rather
  // than guarded: adding an org check to `create` is a behaviour change on a
  // command the lock was decided not to govern, and the argument above for why it
  // is additive still holds. What is fixed here is the claim, not the guard.
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
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(run(async (ctx: Ctx, options: TagWriteFlags) => {
      if (options.dryRun) {
        // The preview RESOLVES the name first (#163). It used to return here
        // before the client existed, so it could not ask, and `Would create` was
        // printed for `wayfinder:map` — a tag that exists with id
        // `ZLAszhmCsDpuNGG66`. A caller reads that as "this does not exist yet",
        // which is the one question a dry run is asked.
        //
        // Through `getTag`, the resolution `favro tags get` already makes, so the
        // two commands cannot disagree about whether a name is taken. It costs
        // the org tag list, cached — which is why this preview reaches for
        // `ctx.api` and so pays the credential check `run()` defers for the
        // argv-only previews (#135).
        //
        // Only an 'unknown' lookup means "would create". 'ambiguous' — the name
        // matches several tags — is left to propagate as the refusal `tags get`
        // raises: the tag plainly exists, and its message lists every colliding
        // id, which is more than this line could say.
        const existing = await ctx.api.tags.getTag(options.name!).catch((error: unknown) => {
          if (error instanceof TagLookupError && error.kind === 'unknown') return undefined;
          throw error;
        });
        if (existing) {
          console.log(
            `${c.dryRun('dry-run')} Tag "${c.bold(existing.name)}" already exists ` +
              `(${existing.tagId}) — nothing to create`,
          );
          return;
        }
        dryRunLog('creating', 'tag', options.name!);
        return;
      }

      if (!(await confirmAction(`Create tag "${options.name}"${options.color ? ` (color: ${options.color})` : ''}?`, { yes: options.yes }))) {
        return { item: { created: false, aborted: true }, human: () => 'Aborted.' };
      }

      const tag = await ctx.api.tags.createTag(options.name!, options.color);
      // Or the 15-minute TTL keeps the new tag invisible to every resolver that
      // refuses on an unknown name — including `cards create --tag`, whose
      // refusal message tells you to run this command.
      await invalidateCache(ctx.client.organizationId, 'tags');

      return { item: tag, human: (t: Tag) => `✓ Tag created: ${t.tagId} (${t.name})` };
    }));

  tagsCommand
    .command('update <tagId>')
    .description('Update a tag (rename or recolor)')
    .option('--name <name>', 'New tag name')
    .option('--color <color>', 'New tag color (e.g. red, blue)')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(run(async (ctx: Ctx, tagId: string, options: TagWriteFlags) => {
      if (!options.name && !options.color) {
        throw new RefusalError('Provide at least one field to update: --name or --color');
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

      return {
        item: await ctx.api.tags.updateTag(tagId, updateData),
        human: (tag: Tag) => `✓ Tag updated: ${tag.tagId} (${tag.name})`,
      };
    }));

  tagsCommand
    .command('delete <tagId>')
    .description('Delete a tag — organization-wide; refused while a scope lock is set')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Allow this org-wide delete despite the scope lock')
    .action(run(async (ctx: Ctx, tagId: string, options: TagWriteFlags) => {
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

      await ctx.api.tags.deleteTag(tagId);

      return { item: { deleted: true, tagId }, human: () => `✓ Tag deleted: ${tagId}` };
    }));
}
