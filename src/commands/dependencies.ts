/**
 * Dependencies Commands
 * CLA-1804 FAVRO-XXX: Dependencies Endpoints
 *
 * favro dependencies list <card>
 * favro dependencies add <sourceId> <targetId> --type blocks
 */
import { Command } from 'commander';
import CardsAPI from '../lib/cards-api';
import { linkTypeToIsBefore } from '../lib/dependency-direction';
import { createFavroClient } from '../lib/client-factory';
import { logError } from '../lib/error-handler';
import { checkScope, confirmAction, dryRunLog } from '../lib/safety';
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
    .action(async (sourceId: string, targetId: string, options) => {
      const verbose = depsCommand.opts()?.verbose ?? false;
      try {
        const config = await readConfig();
        const client = await createFavroClient();
        
        // Safety bound: check scope for source card
        const api = new CardsAPI(client);
        const sourceCard = await api.getCard(sourceId);
        await checkScope(sourceCard?.boardId ?? '', client, config, options.force);

        if (options.dryRun) {
          dryRunLog('adding', 'dependency', `${sourceId} -> ${targetId} (${options.type})`);
          process.exit(0);
        }

        if (!(await confirmAction(`Link ${sourceId} -> ${targetId} (${options.type})?`, { yes: options.yes }))) {
          process.exit(0);
        }

        const link = await api.linkCard(sourceId, { toCardId: targetId, isBefore: linkTypeToIsBefore(options.type) });

        // The fourth site of the same family as `widgets add` / `custom-fields
        // set` / `cards move`: this printed `✓ Dependency added: src -> target
        // (type)` built entirely from ARGUMENTS, while `linkCard` returns the
        // server's own `dependencies` array — the observation — and it was thrown
        // away. `linkCard` also does `res.dependencies ?? []`, so an omitted key
        // arrived as "no edges" and the ✓ printed anyway.
        //
        // The edge set is only compared for EMPTINESS, not for the target's id:
        // the command holds `targetId` as the caller typed it (a ref), while the
        // response speaks resolved `cardId`s, so a strict comparison here would be
        // between two different vocabularies. Non-empty is what is honestly
        // available — and it is the whole difference between an observation and an
        // argument.
        //
        // ponytail: emptiness only; upgrade to a per-edge id comparison if the
        // command ever resolves `targetId` for another reason.
        if (options.json) {
          console.log(JSON.stringify(link, null, 2));
        } else if (link.length > 0) {
          console.log(`✓ Dependency added: ${sourceId} -> ${targetId} (${options.type})`);
        } else {
          console.log(
            `Dependency ${sourceId} -> ${targetId} (${options.type}) was accepted (200) but is UNCONFIRMED: ` +
            `the response carried no dependencies, so nothing here observed the edge.\n` +
            `Whether this POST echoes the edge set is unmeasured — the documented example does\n` +
            `(docs/research/dependencies-and-parent-child-semantics.md §1.4), but documented is not probed,\n` +
            `so an absent echo is not by itself a failure.\n` +
            `Verify with: favro dependencies list ${sourceId}`
          );
        }
        // A hole forbids a clean exit code (#148). Same rule as the other three.
        if (link.length === 0) process.exit(1);
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  depsCommand
    .command('delete <card> <targetId>')
    .description('Remove a single dependency link between two cards')
    .option('--dry-run', 'Preview the removal. Reads the card first to check the scope lock')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass bounds checking')
    .action(async (cardId: string, targetId: string, options) => {
      const verbose = depsCommand.opts()?.verbose ?? false;
      try {
        const config = await readConfig();

        // The lock runs BEFORE the preview (#155). It ran after, so a card on a
        // board outside the locked collection previewed at exit 0 — measured, 55
        // bytes and zero requests — while the real run refused. A preview that
        // promises an action the guardrail will not allow is worse than no
        // preview; `--dry-run` is the flag a careful caller reaches for first.
        // #152 settled this order for the four MIGRATED writes and CONTEXT.md
        // named these as the gap; this is that gap.
        //
        // GATED ON A CONFIGURED LOCK, and the gate is load-bearing rather than
        // tidy. Everything the check needs is eager: `createFavroClient()`
        // resolves credentials and rejects without them, and the card read is a
        // request — neither can be deferred behind `checkScope`'s own "no lock,
        // no-op" return, and `checkResolvedScope` cannot absorb it either
        // because its `client` parameter is eager too. Ungated, a `--dry-run`
        // for a user with NO lock would be charged a credential and a GET for a
        // verdict there is no lock to produce, which is exactly what #102/#104
        // ("no behaviour change when no lock is configured, and no extra
        // requests on that path") and #135's pricing rule forbid.
        //
        // The gate also removes the card read from the REAL run when nothing is
        // locked, where it only ever fed a check that returns immediately —
        // `checkResolvedScope`'s docstring calls that out as billing an unlocked
        // user "a GET for an answer nobody was going to read".
        if (config?.scopeCollectionId) {
          const client = await createFavroClient();
          const card = await new CardsAPI(client).getCard(cardId);
          await checkScope(card?.boardId ?? '', client, config, options.force);
        }

        if (options.dryRun) {
          dryRunLog('remove', 'dependency', `${cardId} -> ${targetId}`);
          return;
        }

        const client = await createFavroClient();
        const api = new CardsAPI(client);

        if (!(await confirmAction(`Remove dependency ${cardId} -> ${targetId}?`, { yes: options.yes }))) {
          return;
        }

        await api.unlinkCard(cardId, targetId);

        console.log(`✓ Dependency removed: ${cardId} -> ${targetId}`);
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });

  depsCommand
    .command('delete-all <card>')
    .description('Remove all dependencies from a card')
    .option('--dry-run', 'Preview the removal. Reads the card first to check the scope lock')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass bounds checking')
    .action(async (cardId: string, options) => {
      const verbose = depsCommand.opts()?.verbose ?? false;
      try {
        const config = await readConfig();

        // Before the preview and gated on the lock, for the reasons spelled out
        // on `delete` above (#155). Its twin, so it moves with it: fixing one of
        // a pair rebuilds the half-locked family #103/#104 exist to stop.
        if (config?.scopeCollectionId) {
          const client = await createFavroClient();
          const card = await new CardsAPI(client).getCard(cardId);
          await checkScope(card?.boardId ?? '', client, config, options.force);
        }

        if (options.dryRun) {
          dryRunLog('remove all dependencies from', 'card', cardId);
          return;
        }

        const client = await createFavroClient();
        const api = new CardsAPI(client);

        if (!(await confirmAction(`Remove ALL dependencies from card ${cardId}? This cannot be undone.`, { yes: options.yes }))) {
          return;
        }

        await api.deleteAllDependencies(cardId);

        console.log(`✓ All dependencies removed from card ${cardId}`);
      } catch (error: any) {
        logError(error, verbose);
        process.exit(1);
      }
    });
}
