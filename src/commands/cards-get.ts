/**
 * cards get — Retrieve a single card with optional metadata includes
 * CLA-1785 (FAVRO-023): Advanced Cards Endpoints
 */
import { Command } from 'commander';
import { Card } from '../lib/cards-api';
import { run } from '../lib/run';

const VALID_INCLUDES = ['board', 'collection', 'custom-fields', 'links', 'comments', 'relations'];

/** The one-row summary `--human` shows when no metadata was asked for. */
function formatCardRow(card: Card): void {
  const row: Record<string, string> = {
    ID: card.cardId,
    Title: card.name ?? '—',  // null guard: API may return null name (CLA-1785 critic fix)
    Status: card.status ?? '—',
    Assignees: (card.assignees ?? []).join(', ') || '—',
    Tags: (card.tags ?? []).join(', ') || '—',
    'Due Date': card.dueDate ?? '—',
    Created: card.createdAt ? card.createdAt.slice(0, 10) : '—',
  };
  console.table([row]);
}

/**
 * Register `cards get <id>` as a subcommand on the `cards` parent command.
 */
export function registerCardsGetCommand(cardsCmd: Command): void {
  cardsCmd
    .command('get <card>')
    .description(
      'Retrieve a card by ID with optional metadata.\n\n' +
      'Examples:\n' +
      '  favro cards get <card>\n' +
      '  favro cards get <card> --include board,collection\n' +
      '  favro cards get <card> --include board,collection,custom-fields,links,comments\n\n' +
      `Valid includes: ${VALID_INCLUDES.join(', ')}\n\n` +
      'A facet that could not be read is reported on the card as\n' +
      'unreachable: [{id, reason}] — an absent marker is what makes an empty\n' +
      'links or comments list mean "none" and not "unreadable".'
    )
    .option(
      '--include <items>',
      'Comma-separated list of metadata to include: board,collection,custom-fields,links,comments,relations'
    )
    .action(run(async (ctx, cardId: string, options: { include?: string }) => {
      const includes: string[] = [];
      if (options.include) {
        const requested = options.include.split(',').map((s: string) => s.trim().toLowerCase());
        const invalid = requested.filter((i: string) => !VALID_INCLUDES.includes(i));
        if (invalid.length > 0) {
          throw new Error(`Invalid include value(s): ${invalid.join(', ')}. Valid: ${VALID_INCLUDES.join(', ')}`);
        }
        includes.push(...requested);
      }

      const card = await ctx.api.cards.getCard(cardId, { include: includes }).catch((error: any) => {
        if (error?.response?.status === 404) throw new Error(`Card '${cardId}' not found.`);
        throw error;
      });

      // With metadata asked for, the summary row would hide most of what was
      // fetched, so `--human` falls through to the runner's indented JSON —
      // which is the same text the old `--json` branch printed here.
      return { item: card, human: includes.length > 0 ? undefined : formatCardRow };
    }));
}

export default registerCardsGetCommand;
