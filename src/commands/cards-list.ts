/**
 * Cards List Command
 * FAVRO-008: Cards List Command with filtering and table output
 */
import { Command } from 'commander';
import { createFavroClient } from '../lib/client-factory';
import CardsAPI, { Card } from '../lib/cards-api';
import { logError, missingApiKeyError, suggestBoard } from '../lib/error-handler';
import BoardsAPI from '../lib/boards-api';
import { parseQuery, filterCards } from '../lib/query-parser';

function formatCardsTable(cards: Card[]): void {
  if (cards.length === 0) {
    console.log('No cards found.');
    return;
  }

  const rows = cards.map(card => ({
    ID: card.cardId,
    Title: card.name.length > 40 ? card.name.slice(0, 37) + '...' : card.name,
    Status: card.status || '—',
    Assignees: (card.assignees || []).join(', ') || '—',
    Tags: (card.tags || []).join(', ') || '—',
    Created: card.createdAt ? card.createdAt.slice(0, 10) : '—',
  }));

  console.table(rows);
}

function formatCardsCSV(cards: Card[]): void {
  const header = ['ID', 'Title', 'Status', 'Assignees', 'Tags', 'DueDate', 'Created', 'Updated'];
  const rows = cards.map(card => [
    card.cardId,
    card.name,
    card.status || '',
    (card.assignees || []).join(';'),
    (card.tags || []).join(';'),
    card.dueDate || '',
    card.createdAt ? card.createdAt.slice(0, 10) : '',
    card.updatedAt ? card.updatedAt.slice(0, 10) : '',
  ]);

  const escape = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
  console.log(header.map(escape).join(','));
  rows.forEach(row => console.log(row.map(escape).join(',')));
}

export function registerCardsListCommand(program: Command): void {
  program
    .command('cards list')
    .description('List cards from a board')
    .option('--board <id>', 'Board ID to list cards from')
    .option('--status <status>', 'Filter by status (legacy, use --filter instead)')
    .option('--assignee <user>', 'Filter by assignee (legacy, use --filter instead)')
    .option('--tag <tag>', 'Filter by tag (legacy, use --filter instead)')
    .option('--filter <expression>', 'Filter cards using enhanced query syntax (e.g. "status:done OR status:in-progress")', (val, prev: string[]) => prev.concat([val]), [] as string[])
    .option('--limit <number>', 'Maximum number of cards to return', '50')
    .option('--json', 'Output as JSON')
    .option('--csv', 'Output as CSV')
    .action(async (_listArg, options) => {
      const verbose = program.parent?.opts()?.verbose ?? program.opts()?.verbose ?? false;
      try {
        const token = process.env.FAVRO_API_TOKEN;
        const client = await createFavroClient();
        const api = new CardsAPI(client);

        const parsedLimit = parseInt(options.limit, 10);
        const limit = isNaN(parsedLimit) || parsedLimit < 1 ? 50 : parsedLimit;
        let cards = await api.listCards(options.board, limit);

        // Apply enhanced query filters (if provided)
        if (options.filter && options.filter.length > 0) {
          try {
            const combinedFilter = options.filter.join(' AND ');
            const query = parseQuery(combinedFilter);
            cards = filterCards(query, cards);
          } catch (err: any) {
            console.error(`✗ Invalid filter expression: ${err.message}`);
            process.exit(1);
          }
        } else {
          // Fallback to legacy options for backward compatibility
          if (options.status) {
            cards = cards.filter(c => c.status?.toLowerCase() === options.status.toLowerCase());
          }
          if (options.assignee) {
            cards = cards.filter(c => (c.assignees || []).some(
              a => a.toLowerCase().includes(options.assignee.toLowerCase())
            ));
          }
          if (options.tag) {
            cards = cards.filter(c => (c.tags || []).some(
              t => t.toLowerCase().includes(options.tag.toLowerCase())
            ));
          }
        }

        if (options.json) {
          console.log(JSON.stringify(cards, null, 2));
        } else if (options.csv) {
          formatCardsCSV(cards);
        } else {
          console.log(`Found ${cards.length} card(s):`);
          formatCardsTable(cards);
        }
      } catch (error: any) {
        if (options.board && error?.response?.status === 404) {
          // Board not found — fetch available boards and suggest
          try {
            const boardsApi = new BoardsAPI(new (await import('../lib/http-client')).default({ auth: { token: process.env.FAVRO_API_TOKEN! } }));
            const boards = await boardsApi.listBoards();
            const boardNames = boards.map(b => b.name);
            const helpfulMsg = suggestBoard(options.board, boardNames);
            console.error(`Error: ${helpfulMsg}`);
          } catch {
            logError(error, verbose);
          }
        } else {
          logError(error, verbose);
        }
        process.exit(1);
      }
    });
}

export default registerCardsListCommand;
