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
import CardsAPI from '../lib/cards-api';
import { linkTypeToIsBefore } from '../lib/dependency-direction';
import { createFavroClient } from '../lib/client-factory';
import { logError } from '../lib/error-handler';
import { confirmAction } from '../lib/safety';
import { AddedEdge, dispatch, EdgeArgs, RemovedEdges } from '../lib/dispatch';
import { previewOnly, reportDispatch } from '../lib/report-dispatch';
import { capRows, noteTruncation, writeEnvelope } from '../lib/read-shape';
import { readConfig } from '../lib/config';

export function registerDependenciesCommands(program: Command): void {
  const depsCommand = program.command('dependencies').description('Manage card dependencies (blockers/related)');

  depsCommand
    .command('list <card>')
    .description('List dependencies for a card')
    .option('--limit <n>', 'Cap how many rows are printed; sets "truncated"')
    .option('--json', 'Output as JSON')
    .action(async (cardId: string, options) => {
      const verbose = depsCommand.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();
        const api = new CardsAPI(client);
        const links = await api.getCardLinks(cardId);
        // The fetch already ran to completion; `--limit` cuts the PRINT (#99).
        const envelope = capRows(links, options.limit);

        if (options.json) {
          writeEnvelope(envelope, Boolean(program.opts()?.pretty));
        } else {
          console.log(`Found ${envelope.rows.length} dependencies for card ${cardId}:`);
          const rows = envelope.rows.map(lnk => ({
            Direction: lnk.isBefore ? 'before (blocks this card)' : 'after (blocked by this card)',
            Target: lnk.cardId,
            Name: lnk.cardName || '—',
          }));
          console.table(rows);
          noteTruncation(envelope, links.length);
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  depsCommand
    .command('add <sourceId> <targetId>')
    .description('Add a dependency link between two cards')
    .requiredOption('--type <type>', 'Link type: depends-on, blocks')
    .option('--json', 'Output as JSON')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass bounds checking')
    .addHelpText('after', '\nIntent contract: run `favro help issue-tracker`.')
    .action(async (sourceId: string, targetId: string, options) => {
      const verbose = depsCommand.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();

        if (
          !options.dryRun &&
          !(await confirmAction(`Link ${sourceId} -> ${targetId} (${options.type})?`, { yes: options.yes }))
        ) {
          process.exit(0);
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
        const args: EdgeArgs = linkTypeToIsBefore(options.type)
          ? { card: sourceId, blockedBy: targetId }
          : { card: targetId, blockedBy: sourceId };

        const result = await dispatch<AddedEdge>('add-blocking-edge', { ...args }, {
          client,
          config: (await readConfig()) ?? {},
          force: options.force,
          dryRun: options.dryRun,
        });
        if (reportDispatch(result, options.json)) process.exit(1);
        if (result.outcome !== 'ok' || result.value === undefined) return;

        if (options.json) {
          console.log(JSON.stringify(result.value, null, 2));
        } else {
          // "Created" and "already there" stay distinguishable, as the intent
          // keeps them. The old line here was built entirely from ARGUMENTS and
          // printed a ✓ whether or not the response carried an edge; the intent
          // answers what it observed.
          console.log(
            result.value.created
              ? `✓ Dependency added: ${sourceId} -> ${targetId} (${options.type})`
              : `✓ Already linked: ${sourceId} -> ${targetId} (${options.type}) — nothing written`,
          );
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  depsCommand
    .command('delete <card> <targetId>')
    .description('Remove a single dependency link between two cards')
    .option('--json', 'Output as JSON')
    .option('--dry-run', 'Preview the removal. Reads the card first to check the scope lock')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass bounds checking')
    .addHelpText('after', '\nIntent contract: run `favro help issue-tracker`.')
    .action(async (cardId: string, targetId: string, options) => {
      const verbose = depsCommand.opts()?.verbose ?? false;
      try {
        const config = (await readConfig()) ?? {};
        const args = { card: cardId, blockedBy: targetId } as EdgeArgs;

        // A dry run with NO lock configured previews from the intent's own pure
        // `preview()` and touches no wire — see `previewOnly`. #155 pinned this
        // command's dry run at zero requests and no credential, and routing it
        // must not take that away.
        if (options.dryRun && !config.scopeCollectionId) {
          previewOnly('remove-blocking-edge', { ...args }, config);
          return;
        }

        const client = await createFavroClient();

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
        const result = await dispatch<{ removed: boolean; isBefore?: boolean }>(
          'remove-blocking-edge',
          { ...args },
          { client, config, force: options.force, dryRun: options.dryRun },
        );
        if (reportDispatch(result, options.json)) process.exit(1);
        if (result.outcome !== 'ok' || result.value === undefined) return;

        if (options.json) {
          console.log(JSON.stringify(result.value, null, 2));
        } else {
          console.log(
            result.value.removed
              ? `✓ Dependency removed: ${cardId} -> ${targetId}`
              : `✓ No edge between ${cardId} and ${targetId} — nothing written`,
          );
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  depsCommand
    .command('delete-all <card>')
    .description('Remove all dependencies from a card (at most 20 — more refuses)')
    .option('--json', 'Output as JSON')
    .option('--dry-run', 'Preview the removal. Reads the card first to check the scope lock')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass bounds checking')
    .addHelpText('after', '\nIntent contract: run `favro help issue-tracker`.')
    .action(async (cardId: string, options) => {
      const verbose = depsCommand.opts()?.verbose ?? false;
      try {
        const config = (await readConfig()) ?? {};

        // As on `delete` above: an unlocked dry run stays free. It therefore
        // cannot say whether this card is over the cap — that takes the read this
        // branch exists to avoid — so the preview says what the bound IS and the
        // real run is where an over-cap card refuses.
        if (options.dryRun && !config.scopeCollectionId) {
          previewOnly('clear-blocking-edges', { card: cardId }, config);
          return;
        }

        const client = await createFavroClient();

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
        const result = await dispatch<RemovedEdges>(
          'clear-blocking-edges',
          { card: cardId },
          { client, config, force: options.force, dryRun: options.dryRun },
        );
        if (reportDispatch(result, options.json)) process.exit(1);
        if (result.outcome !== 'ok' || result.value === undefined) return;

        if (options.json) {
          console.log(JSON.stringify(result.value, null, 2));
        } else {
          // The COUNT is an observation — how many edges `removeBlockingEdge`
          // actually found and deleted — not the length of the list we read.
          console.log(
            result.value.removed.length > 0
              ? `✓ Removed ${result.value.removed.length} dependencies from card ${cardId}`
              : `✓ Card ${cardId} had no dependencies — nothing written`,
          );
        }
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });
}
