/**
 * Widgets Commands
 * CLA-1801 FAVRO-XXX: Widgets Endpoints
 *
 * favro widgets list --card <card>
 * favro widgets add <board> <card>
 */
import { Command } from 'commander';
import { CardInstance } from '../lib/widgets-api';
import { confirmAction } from '../lib/safety';
import { dispatch } from '../lib/dispatch';
import { Ctx, run } from '../lib/run';

export function registerWidgetsCommands(program: Command): void {
  const widgetsCommand = program.command('widgets').description('Manage card widget instances directly');

  widgetsCommand
    .command('list')
    .description('List every board instance of a card — one row per board the card lives on')
    .requiredOption('--card <card>', 'Card to trace — sequentialId, cardId or cardCommonId')
    .option('--limit <n>', 'Cap how many rows are printed; sets "truncated"')
    .action(run(async (ctx: Ctx, options: { card: string; limit?: string }) => ({
      // The reference is SETTLED to a `cardCommonId` first. `/cards` takes it as
      // a query value, never a path segment, so a `cardId` in that slot is a
      // well-formed request for a card that does not exist — 200, zero rows,
      // which is this command's own defect under a second spelling
      // (`card-reference.ts:92`).
      //
      // The fetch runs to completion; `--limit` cuts the PRINT (#99). `capRows`
      // and the truncation note are the runner's now, so both modes read one
      // envelope and cannot disagree.
      rows: await ctx.api.widgets.listInstancesOfCard(
        await ctx.api.cards.resolveCardCommonId(options.card),
      ),
      limit: options.limit,
      human: (instances: CardInstance[]) => {
        console.log(`Found ${instances.length} board instance(s) of card ${options.card}:`);
        console.table(instances.map((i) => ({
          // A fork has no board, and `—` says so rather than borrowing an id
          // from somewhere else — the substitution that re-opened #82.
          BoardID: i.boardId ?? '—',
          CardID: i.cardId,
          Column: i.columnId ?? '—',
          Name: i.name,
        })));
      },
    })));

  widgetsCommand
    .command('add <board> <card>')
    .description('Add an existing card to a new board, by board name or boardId (creates a new linked widget)')
    .option('--column <columnId>', 'Specific column ID to place the widget in')
    .option('--dry-run', 'Preview without making API calls')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass bounds checking')
    .action(run(async (
      ctx: Ctx,
      board: string,
      cardCommonId: string,
      options: { column?: string; dryRun?: boolean; yes?: boolean; force?: boolean },
    ) => {
      if (
        !options.dryRun &&
        !(await confirmAction(`Add card ${cardCommonId} to board ${board}?`, { yes: options.yes }))
      ) {
        return { item: { added: false, aborted: true, card: cardCommonId }, human: () => 'Aborted.' };
      }

      // Through the ONE dispatch table, as the `add-board-instance` intent
      // (#109). This is the write that MANUFACTURES a card's board instance —
      // the thing whose absence makes a card boardless, which is the shape
      // `dispatch` refuses every other write to. Outside the table it was a
      // write creating the case the table exists to refuse; inside it, it is
      // the one write allowed to.
      //
      // The lock is inside the intent now, over the board the intent itself
      // settles: it checks a `widgetCommonId`, so a NAME has to resolve first
      // or `GET /widgets/Backlog - Web Hub` 404s into "Board … not found", a
      // refusal naming the wrong problem (#82). And it runs before the `dryRun`
      // return, so the preview can no longer promise a commit the real run
      // refuses.
      const result = await dispatch<{ widgetCommonId?: string }>(
        'add-board-instance',
        { board, card: cardCommonId, column: options.column },
        { client: ctx.client, config: ctx.config, force: options.force, dryRun: options.dryRun },
      );

      return {
        dispatch: result,
        // An unconfirmed write is a HOLE, and a hole forbids a clean exit code —
        // exit 0 is a positive claim (#148; `diff.ts` gates exit 1 on
        // `holes.length`). Without this, the human line says UNCONFIRMED and the
        // exit code says confirmed, and `favro widgets add … && next-step`
        // believes the exit code. Non-zero here reports a FINDING, not a failure:
        // the write result is still on stdout, machine mode included (#117).
        //
        // Declared on the result rather than called, because under `run()` a
        // hard exit is banned and a bare `return { dispatch }` would hand this
        // back exit 0 — the silent regression #119 was most at risk of.
        // `undefined` leaves the runner's own answer (`reportDispatch`) standing,
        // which is what a dry run and a failed write both need.
        exitCode:
          result.outcome === 'ok' && result.value !== undefined && !result.value.widgetCommonId
            ? 1
            : undefined,
        human: (widget: { widgetCommonId?: string }) => {
          // The ✓ is spent only on an OBSERVED board id. It used to print
          // unconditionally off `updated.widgetCommonId ?? boardId`, so it read
          // identically whether the commit landed or Favro 200'd and wrote
          // nothing — #82's original bug, re-opened by the fallback.
          if (widget.widgetCommonId) {
            return `✓ Widget added to board (${widget.widgetCommonId})`;
          }
          return (
            `Commit of card ${cardCommonId} to board ${board} was accepted (200) but is UNCONFIRMED: ` +
            `the response carried no widgetCommonId, so nothing here observed the card on that board.\n` +
            `A commit that lands does echo the board back (measured once, #161), but what this PUT answers ` +
            `when it is REFUSED is unmeasured, so an absent echo is not by itself a failure.\n` +
            `Verify with: favro widgets list --card ${cardCommonId}`
          );
        },
      };
    }));
}
