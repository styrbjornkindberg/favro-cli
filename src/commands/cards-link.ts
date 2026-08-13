/**
 * cards link / unlink / move / show / dependencies / blocking / blocked-by
 * CLA-1786 (FAVRO-024): Card Relationship Operations
 */
import { Command } from 'commander';
import { Card, CardLink } from '../lib/cards-api';
import { LINK_TYPES, isLinkType, linkTypeToIsBefore } from '../lib/dependency-direction';
import { RefusalError } from '../lib/refusal';
import { confirmAction } from '../lib/safety';
// `link` and `unlink` write a blocking edge, and the shared table already owns
// that write as `add-blocking-edge` / `remove-blocking-edge`. Going through it
// is what stops this file being a second, weaker path to the same wire call
// (#63): the pre-read, the reverse-edge refusal and the compensation log are all
// on the intent, and a direct `api.linkCard` here would have none of them.
import { dispatch, AddedEdge, EdgeArgs } from '../lib/dispatch';
import { Ctx, run } from '../lib/run';

// 'related' and 'duplicates' are gone — Favro has no API representation for them,
// so they were being silently discarded. See lib/dependency-direction.ts.
export const VALID_LINK_TYPES = [...LINK_TYPES];
const VALID_POSITIONS = ['top', 'bottom'];

/**
 * The 404 rewording each of these seven actions carried inside its own
 * `catch { … }` and a hard exit.
 *
 * Kept, and moved onto the call it is about: the bare wire message names a URL,
 * not the reference the caller typed. A `RefusalError` because a 404 on a named
 * card is deterministic — retrying it finds the same nothing — and because that
 * is what puts the wording through the runner's boundary rather than a per-action
 * `console.error`, which under the JSON default would have been exit 0 and an
 * empty stdout.
 */
const rewrite404 = (message: string) => (error: any): never => {
  if (error?.response?.status === 404) throw new RefusalError(message);
  throw error;
};

/** One edge, as it reads to a person. */
const edgeLine = (glyph: string) => (l: CardLink): string =>
  `  ${glyph} ${l.cardId}${l.cardName ? ` (${l.cardName})` : ''}`;

/**
 * Register link / unlink / move / show / dependencies / blocking / blocked-by
 * subcommands on the `cards` parent command.
 */
export function registerCardsLinkCommands(cardsCmd: Command): void {
  // ─── cards link ─────────────────────────────────────────────────────────────
  cardsCmd
    .command('link <card> <toCardId>')
    .description(
      'Record a blocking edge between two cards — the CLI surface of the\n' +
      '`add-blocking-edge` intent.\n\n' +
      'There is at most ONE edge per card pair (undirected identity, directed\n' +
      'semantics), so a pair\n' +
      'already holding the reverse edge is REFUSED, not overwritten — reversing is\n' +
      '`cards unlink` then `cards link`. An edge that is already there is reported,\n' +
      'not rewritten, so retrying after a failure is safe.\n\n' +
      'Examples:\n' +
      '  favro cards link CARD-A CARD-B --type depends-on   # B blocks A\n' +
      '  favro cards link CARD-A CARD-B --type blocks       # A blocks B\n\n' +
      `Valid types: ${VALID_LINK_TYPES.join(', ')}`
    )
    .requiredOption('--type <type>', `Link type: ${VALID_LINK_TYPES.join('|')}`)
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--dry-run', 'Preview the edge write without making it')
    .option('--force', 'Bypass scope check')
    .addHelpText('after', '\nIntent contract: run `favro help issue-tracker`.')
    .action(run(async (
      ctx: Ctx,
      cardId: string,
      toCardId: string,
      options: { type: string; yes?: boolean; dryRun?: boolean; force?: boolean },
    ) => {
      // Self-link prevention
      if (cardId === toCardId) {
        throw new RefusalError('Cannot link a card to itself.');
      }

      const type = options.type.toLowerCase();
      // `isLinkType` rather than `VALID_LINK_TYPES.includes`, which no longer
      // compiles now that `options` is typed: the array's element type is the
      // narrow union, and the guard exported beside it is the published test.
      if (!isLinkType(type)) {
        throw new RefusalError(
          `Invalid link type '${options.type}'. Valid: ${VALID_LINK_TYPES.join(', ')}`,
        );
      }

      if (!(await confirmAction(`Link card ${cardId} to ${toCardId} (${type})?`, { yes: options.yes }))) {
        return { item: { linked: false, aborted: true }, human: () => 'Aborted.' };
      }

      // One intent, two spellings of the same edge. `depends-on` means the
      // target comes BEFORE this card, so the target is the blocker; `blocks`
      // is that same edge read from the other end, so the arguments swap.
      //
      // No cycle walk here and none in the intent: the old `wouldCreateCycle`
      // BFS was unbounded (derived N), followed `depends-on` only, and
      // swallowed every read failure — and the one real thing it caught, a
      // pair linked both ways round, is what the intent's bounded pre-read
      // settles for BOTH directions in one call.
      const args: EdgeArgs = linkTypeToIsBefore(type)
        ? { card: cardId, blockedBy: toCardId }
        : { card: toCardId, blockedBy: cardId };

      const result = await dispatch<AddedEdge>('add-blocking-edge', { ...args }, {
        client: ctx.client,
        config: ctx.config,
        force: options.force,
        dryRun: options.dryRun,
      }).catch(rewrite404(`Card '${cardId}' or target '${toCardId}' not found.`));

      return {
        dispatch: result,
        human: (value: AddedEdge) => {
          // "Created" and "already there" stay distinguishable, exactly as the
          // intent keeps them: reporting a no-op as a fresh write is the
          // silent-wrong-answer class this build exists to close.
          //
          // Both arms speak the refs the CALLER typed. The intent answers
          // resolved 24-hex ids, and echoing those on one arm only made one
          // command talk in two vocabularies.
          const blocker = args.card === cardId ? toCardId : cardId;
          const blocked = args.card === cardId ? cardId : toCardId;
          return value.created
            ? `✓ Linked card ${cardId} → ${toCardId} (${type})`
            : `✓ Already linked: ${blocker} blocks ${blocked} — nothing written`;
        },
      };
    }));

  // ─── cards unlink ───────────────────────────────────────────────────────────
  cardsCmd
    .command('unlink <card> <fromCardId>')
    .description(
      'Remove the blocking edge between two cards — the CLI surface of the\n' +
      '`remove-blocking-edge` intent.\n\n' +
      'Direction-agnostic: there is at most one edge per pair, so this removes\n' +
      'whichever way round it points. No edge to remove is reported as such and is\n' +
      'not an error, so a retry after a failed run can still reach a clean result.\n\n' +
      'Examples:\n' +
      '  favro cards unlink CARD-A CARD-B\n'
    )
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--dry-run', 'Preview the removal without making it')
    .option('--force', 'Bypass scope check')
    .addHelpText('after', '\nIntent contract: run `favro help issue-tracker`.')
    .action(run(async (
      ctx: Ctx,
      cardId: string,
      fromCardId: string,
      options: { yes?: boolean; dryRun?: boolean; force?: boolean },
    ) => {
      if (!(await confirmAction(`Unlink card ${cardId} from ${fromCardId}?`, { yes: options.yes }))) {
        return { item: { unlinked: false, aborted: true }, human: () => 'Aborted.' };
      }

      const result = await dispatch<{ removed: boolean; isBefore?: boolean }>(
        'remove-blocking-edge',
        { ...({ card: cardId, blockedBy: fromCardId } as EdgeArgs) },
        {
          client: ctx.client,
          config: ctx.config,
          force: options.force,
          dryRun: options.dryRun,
        },
      ).catch(rewrite404(`Card '${cardId}' or link to '${fromCardId}' not found.`));

      return {
        dispatch: result,
        human: (value: { removed: boolean }) =>
          value.removed
            ? `✓ Unlinked card ${cardId} from ${fromCardId}`
            : `✓ No edge between ${cardId} and ${fromCardId} — nothing written`,
      };
    }));

  // ─── cards move ─────────────────────────────────────────────────────────────
  cardsCmd
    .command('move <card>')
    .description(
      'Move a card to a different board.\n\n' +
      'Examples:\n' +
      '  favro cards move <card> --to-board <board>\n' +
      '  favro cards move <card> --to-board <board> --position top\n' +
      '  favro cards move <card> --to-board <board> --position bottom\n\n' +
      `Valid positions: ${VALID_POSITIONS.join(', ')}`
    )
    .requiredOption('--to-board <board>', 'Destination board, by name or boardId')
    .option('--position <pos>', `Position on board: ${VALID_POSITIONS.join('|')}`)
    .option('--dry-run', 'Preview the move. Takes the scope lock on both boards first')
    .option('-y, --yes', 'Skip confirmation prompt')
    .option('--force', 'Bypass scope check')
    .addHelpText('after', '\nIntent contract: run `favro help issue-tracker`.')
    .action(run(async (
      ctx: Ctx,
      cardId: string,
      options: { toBoard: string; position?: string; dryRun?: boolean; yes?: boolean; force?: boolean },
    ) => {
      if (options.position && !VALID_POSITIONS.includes(options.position.toLowerCase())) {
        throw new RefusalError(
          `Invalid position '${options.position}'. Valid: ${VALID_POSITIONS.join(', ')}`,
        );
      }

      if (
        !options.dryRun &&
        !(await confirmAction(`Move card ${cardId} to board ${options.toBoard}?`, { yes: options.yes }))
      ) {
        return { item: { moved: false, aborted: true, card: cardId }, human: () => 'Aborted.' };
      }

      // Through the ONE dispatch table, as the `move-board` intent (#109).
      // BOTH board locks live inside it now: the intent's `board()` returns the
      // card's origin board and the SETTLED destination, and the table checks
      // every distinct one before anything is written — so a move out of the
      // locked collection and a move into it refuse alike, and a fork (no
      // origin `widgetCommonId`) still refuses rather than riding in on the
      // destination. The destination settles inside the intent for #82's
      // reason: the lock GETs `/widgets/<id>` and a NAME 404s into "Board … not
      // found", a refusal naming the wrong problem.
      //
      // The move is IRREVERSIBLE as far as this facade is concerned and the
      // intent is `terminal` — the card's column on the old board is not
      // captured, so nothing here can claim `rolled-back` honestly. See
      // `TxCards.moveToBoard`.
      const result = await dispatch<Card>(
        'move-board',
        {
          card: cardId,
          toBoard: options.toBoard,
          position: options.position?.toLowerCase() as 'top' | 'bottom' | undefined,
        },
        { client: ctx.client, config: ctx.config, force: options.force, dryRun: options.dryRun },
      ).catch(rewrite404(`Card '${cardId}' or board '${options.toBoard}' not found.`));

      return {
        dispatch: result,
        // Unconfirmed is a HOLE, and a hole forbids a clean exit code (#148, and
        // `diff.ts` gates exit 1 on `holes.length`): `favro cards move … &&
        // next-step` must not proceed on a board nothing observed.
        //
        // DECLARED rather than called. Under `run()` a hard exit is banned, and
        // the mechanical migration — a bare `return { dispatch: result }` — hands
        // this back exit 0 and loses the finding silently, with no type error to
        // catch it. `undefined` leaves `reportDispatch`'s own answer standing,
        // which is what a dry run and a failed write both need.
        exitCode:
          result.outcome === 'ok' && result.value !== undefined && !result.value.boardId
            ? 1
            : undefined,
        human: (card: Card) =>
          // The ✓ is spent only on an OBSERVED board. The old line — `✓ Card …
          // moved to board ${options.toBoard}` — echoed the argument as an
          // outcome: it printed the board the user typed, so it read identically
          // whether the move landed or Favro 200'd and wrote nothing.
          //
          // `card.boardId` is the echoed `widgetCommonId` (see
          // `CardsAPI.moveCard`) — the same field `widgets add` spends its ✓ on,
          // because it is the same PUT.
          card.boardId
            ? `✓ Card ${cardId} moved to board (${card.boardId})`
            : `Move of card ${cardId} to board ${options.toBoard} was accepted (200) but is UNCONFIRMED: ` +
              `the response carried no widgetCommonId, so nothing here observed the card's board.\n` +
              `Whether this PUT echoes widgetCommonId is unmeasured, so an absent echo is not by itself a failure.\n` +
              `Verify with: favro cards get ${cardId}`,
      };
    }));

  // ─── cards show --relationships ─────────────────────────────────────────────
  cardsCmd
    .command('show <card>')
    .description(
      'Show card details with optional relationship info.\n\n' +
      'Examples:\n' +
      '  favro cards show CARD-ID --relationships\n'
    )
    .option('--relationships', 'Show all relationship links for this card')
    .action(run(async (ctx: Ctx, cardId: string, options: { relationships?: boolean }) => {
      const includes = options.relationships ? ['links'] : [];
      const card = await ctx.api.cards
        .getCard(cardId, { include: includes })
        .catch(rewrite404(`Card '${cardId}' not found.`));

      return {
        item: card,
        // `--relationships` used to force raw indented JSON on BOTH modes,
        // because the table below has no column for links. It still has none, so
        // that flag hands the runner NO formatter and takes its fallback —
        // `console.log(stringify(value, true))`, the same indented JSON, chosen
        // by the mode rather than forced by the flag.
        human: options.relationships
          ? undefined
          : (c: Card) => {
              console.table([{
                ID: c.cardId,
                Title: c.name ?? '—',
                Status: c.status ?? '—',
                Assignees: (c.assignees ?? []).join(', ') || '—',
                Tags: (c.tags ?? []).join(', ') || '—',
                'Due Date': c.dueDate ?? '—',
                Created: c.createdAt ? c.createdAt.slice(0, 10) : '—',
              }]);
            },
      };
    }));

  // ─── cards dependencies ─────────────────────────────────────────────────────
  cardsCmd
    .command('dependencies <card>')
    .description(
      'List all cards this card depends on.\n\n' +
      'Examples:\n' +
      '  favro cards dependencies CARD-ID\n'
    )
    .option('--limit <n>', 'Cap how many rows are printed; sets "truncated"')
    .action(run(async (ctx: Ctx, cardId: string, options: { limit?: string }) => {
      const links = await ctx.api.cards
        .getCardLinks(cardId)
        .catch(rewrite404(`Card '${cardId}' not found.`));

      return {
        // The filter runs over the WHOLE edge set, then the cap runs over the
        // filtered rows — that order is the point of capping the print (#99),
        // and the cap is the runner's now.
        rows: links.filter((l) => l.isBefore),
        limit: options.limit,
        human: (rows: CardLink[]) => {
          if (rows.length === 0) {
            console.log(`Card ${cardId} has no dependencies.`);
            return;
          }
          console.log(`Dependencies of card ${cardId}:`);
          rows.forEach((l) => console.log(edgeLine('→')(l)));
        },
      };
    }));

  // ─── cards blocking ─────────────────────────────────────────────────────────
  // Renamed from `cards blockers` (#47): it returns the cards this card BLOCKS,
  // exactly as its own help string always said. `blockers` named the other end.
  cardsCmd
    .command('blocking <card>')
    .description(
      'List all cards blocked by this card.\n\n' +
      'Examples:\n' +
      '  favro cards blocking CARD-ID\n'
    )
    .option('--limit <n>', 'Cap how many rows are printed; sets "truncated"')
    .action(run(async (ctx: Ctx, cardId: string, options: { limit?: string }) => {
      const links = await ctx.api.cards
        .getCardLinks(cardId)
        .catch(rewrite404(`Card '${cardId}' not found.`));

      return {
        // Cards this card blocks come after it: isBefore === false.
        rows: links.filter((l) => !l.isBefore),
        limit: options.limit,
        human: (rows: CardLink[]) => {
          if (rows.length === 0) {
            console.log(`Card ${cardId} is not blocking any cards.`);
            return;
          }
          console.log(`Cards blocked by ${cardId}:`);
          rows.forEach((l) => console.log(edgeLine('⛔')(l)));
        },
      };
    }));

  // ─── cards blocked-by ───────────────────────────────────────────────────────
  cardsCmd
    .command('blocked-by <card>')
    .description(
      'List all cards that are blocking this card.\n\n' +
      'Examples:\n' +
      '  favro cards blocked-by CARD-ID\n'
    )
    .option('--limit <n>', 'Cap how many rows are printed; sets "truncated"')
    .action(run(async (ctx: Ctx, cardId: string, options: { limit?: string }) => {
      // blocked-by = cards that come before this one, i.e. edges with
      // isBefore === true. Same edge set as `cards dependencies`.
      const links = await ctx.api.cards
        .getCardLinks(cardId)
        .catch(rewrite404(`Card '${cardId}' not found.`));

      return {
        rows: links.filter((l) => l.isBefore),
        limit: options.limit,
        human: (rows: CardLink[]) => {
          if (rows.length === 0) {
            console.log(`Card ${cardId} is not blocked by any cards.`);
            return;
          }
          console.log(`Cards blocking ${cardId}:`);
          rows.forEach((l) => console.log(edgeLine('🚫')(l)));
        },
      };
    }));
}

export default registerCardsLinkCommands;
