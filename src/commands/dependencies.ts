/**
 * Dependencies Commands
 * CLA-1804 FAVRO-XXX: Dependencies Endpoints
 *
 * favro dependencies list <card>
 * favro dependencies add <sourceId> <targetId> --type blocks
 *
 * The three writes here go through the ONE dispatch table (#109) — the same
 * `add-blocking-edge` / `remove-blocking-edge` intents `cards link` / `cards
 * unlink` already use. This file was the seam's worst case: it guarded the lock
 * behind `if (sourceCard && sourceCard.boardId)`, so a fork slipped past it, and
 * `delete-all` wiped an unbounded edge set through one `DELETE` with no record of
 * what it removed.
 */
import { Command } from 'commander';
import { CardLink } from '../lib/cards-api';
import { linkTypeToIsBefore } from '../lib/dependency-direction';
import { confirmAction } from '../lib/safety';
import { AddedEdge, dispatch, EdgeArgs, RemovedEdges } from '../lib/dispatch';
import { previewOnly } from '../lib/report-dispatch';
import { Ctx, run } from '../lib/run';

/** The flag row the three writes share. */
interface EdgeFlags {
  type?: string;
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
}

export function registerDependenciesCommands(program: Command): void {
  const depsCommand = program.command('dependencies').description('Manage card dependencies (blockers/related)');

  depsCommand
    .command('list <card>')
    .description('List dependencies for a card')
    .option('--limit <n>', 'Cap how many rows are printed; sets "truncated"')
    .action(run(async (ctx: Ctx, cardId: string, options: { limit?: string }) => ({
      // The fetch runs to completion; `--limit` cuts the PRINT (#99).
      rows: await ctx.api.cards.getCardLinks(cardId),
      limit: options.limit,
      human: (links: CardLink[]) => {
        console.log(`Found ${links.length} dependencies for card ${cardId}:`);
        console.table(links.map(lnk => ({
          Direction: lnk.isBefore ? 'before (blocks this card)' : 'after (blocked by this card)',
          Target: lnk.cardId,
          Name: lnk.cardName || '—',
        })));
      },
    })));

  depsCommand
    .command('add <sourceId> <targetId>')
    .description('Add a dependency link between two cards')
    .requiredOption('--type <type>', 'Link type: depends-on, blocks')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass bounds checking')
    .addHelpText('after', '\nIntent contract: run `favro help issue-tracker`.')
    .action(run(async (ctx: Ctx, sourceId: string, targetId: string, options: EdgeFlags) => {
        if (
          !options.dryRun &&
          !(await confirmAction(`Link ${sourceId} -> ${targetId} (${options.type})?`, { yes: options.yes }))
        ) {
          return { item: { added: false, aborted: true }, human: () => 'Aborted.' };
        }

        // The `add-blocking-edge` intent, exactly as `cards link` uses it — one
        // edge write, one vocabulary. `depends-on` means the target comes BEFORE
        // this card, so the target is the blocker; `blocks` is the same edge read
        // from the other end, so the arguments swap.
        //
        // What the intent brings that the raw `api.linkCard` here did not: the
        // scope lock unconditionally (this file used to skip it whenever the
        // source card had no board — the exact case the lock exists for), a
        // bounded pre-read so an edge already present is REPORTED rather than
        // rewritten, a structured refusal when the pair holds the REVERSE edge,
        // and a compensating write.
        const args: EdgeArgs = linkTypeToIsBefore(options.type!)
          ? { card: sourceId, blockedBy: targetId }
          : { card: targetId, blockedBy: sourceId };

        return {
          dispatch: await dispatch<AddedEdge>('add-blocking-edge', { ...args }, {
            client: ctx.client,
            config: ctx.config,
            force: options.force,
            dryRun: options.dryRun,
          }),
          // "Created" and "already there" stay distinguishable, as the intent
          // keeps them. The old line here was built entirely from ARGUMENTS and
          // printed a ✓ whether or not the response carried an edge; the intent
          // answers what it observed.
          human: (value: AddedEdge) =>
            value.created
              ? `✓ Dependency added: ${sourceId} -> ${targetId} (${options.type})`
              : `✓ Already linked: ${sourceId} -> ${targetId} (${options.type}) — nothing written`,
        };
    }));

  depsCommand
    .command('delete <card> <targetId>')
    .description('Remove a single dependency link between two cards')
    .option('--dry-run', 'Preview the removal. Reads the card first to check the scope lock')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass bounds checking')
    .addHelpText('after', '\nIntent contract: run `favro help issue-tracker`.')
    .action(run(async (ctx: Ctx, cardId: string, targetId: string, options: EdgeFlags) => {
        const config = ctx.config;
        const args = { card: cardId, blockedBy: targetId } as EdgeArgs;

        // A dry run with NO lock configured previews from the intent's own pure
        // `preview()` and touches no wire — see `previewOnly`. #155 pinned this
        // command's dry run at zero requests and no credential, and routing it
        // must not take that away. `ctx.client` is untouched on this arm, which
        // is what keeps the credential deferred (#135).
        if (options.dryRun && !config.scopeCollectionId) {
          previewOnly('remove-blocking-edge', { ...args }, config);
          return;
        }

        if (
          !options.dryRun &&
          !(await confirmAction(`Remove dependency ${cardId} -> ${targetId}?`, { yes: options.yes }))
        ) {
          return;
        }

        // The `remove-blocking-edge` intent, exactly as `cards unlink` uses it.
        // The lock runs inside it and therefore BEFORE the `--dry-run` return
        // (#155's ordering, now structural rather than hand-rolled here), and the
        // removal captures the edge's DIRECTION before deleting it — which is the
        // only thing that makes re-adding it an inverse rather than a guess.
        return {
          dispatch: await dispatch<{ removed: boolean; isBefore?: boolean }>(
            'remove-blocking-edge',
            { ...args },
            { client: ctx.client, config, force: options.force, dryRun: options.dryRun },
          ),
          human: (value: { removed: boolean }) =>
            value.removed
              ? `✓ Dependency removed: ${cardId} -> ${targetId}`
              : `✓ No edge between ${cardId} and ${targetId} — nothing written`,
        };
    }));

  depsCommand
    .command('delete-all <card>')
    .description('Remove all dependencies from a card (at most 20 — more refuses)')
    .option('--dry-run', 'Preview the removal. Reads the card first to check the scope lock')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass bounds checking')
    .addHelpText('after', '\nIntent contract: run `favro help issue-tracker`.')
    .action(run(async (ctx: Ctx, cardId: string, options: EdgeFlags) => {
        const config = ctx.config;

        // As on `delete` above: an unlocked dry run stays free. It therefore
        // cannot say whether this card is over the cap — that takes the read this
        // branch exists to avoid — so the preview says what the bound IS and the
        // real run is where an over-cap card refuses.
        if (options.dryRun && !config.scopeCollectionId) {
          previewOnly('clear-blocking-edges', { card: cardId }, config);
          return;
        }

        if (
          !options.dryRun &&
          !(await confirmAction(`Remove ALL dependencies from card ${cardId}?`, { yes: options.yes }))
        ) {
          return;
        }

        // The `clear-blocking-edges` intent (#109). This was an UNBOUNDED
        // wipe: one `DELETE /cards/{id}/dependencies` that removed however many
        // edges the card held, with no record of which and no way back. The
        // intent enumerates them from one bounded read, refuses above
        // `MULTI_WRITE_CAP` rather than wiping, and removes each through
        // `TxCards.removeBlockingEdge` — so a failure part-way through re-adds
        // the ones already gone and the run reports `rolled-back`.
        //
        // The prompt no longer says "This cannot be undone", because it now can.
        return {
          dispatch: await dispatch<RemovedEdges>(
            'clear-blocking-edges',
            { card: cardId },
            { client: ctx.client, config, force: options.force, dryRun: options.dryRun },
          ),
          // The COUNT is an observation — how many edges `removeBlockingEdge`
          // actually found and deleted — not the length of the list we read.
          human: (value: RemovedEdges) =>
            value.removed.length > 0
              ? `✓ Removed ${value.removed.length} dependencies from card ${cardId}`
              : `✓ Card ${cardId} had no dependencies — nothing written`,
        };
    }));
}
