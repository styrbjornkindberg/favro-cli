import { registerCardsListCommand } from '../commands/cards-list';
import { Command } from 'commander';
import CardsAPI from '../lib/cards-api';
import FavroHttpClient from '../lib/http-client';

jest.mock('../lib/cards-api');
jest.mock('../lib/http-client');

describe('Cards List Command', () => {
  test('registers list command on program', () => {
    const program = new Command();
    registerCardsListCommand(program);

    const listCmd = program.commands.find(cmd => cmd.name() === 'cards');
    expect(listCmd).toBeDefined();
  });

  test('list command has expected options', () => {
    const program = new Command();
    registerCardsListCommand(program);

    const listCmd = program.commands.find(cmd => cmd.name() === 'cards');
    expect(listCmd).toBeDefined();

    const optionNames = listCmd!.options.map(o => o.long);
    expect(optionNames).toContain('--board');
    expect(optionNames).toContain('--status');
    expect(optionNames).toContain('--assignee');
    expect(optionNames).toContain('--tag');
    expect(optionNames).toContain('--limit');
    expect(optionNames).toContain('--json');
  });

  test('calls listCards with board id and limit', async () => {
    const mockCards = [
      {
        cardId: 'card-1',
        name: 'Test Card',
        status: 'todo',
        assignees: ['alice'],
        tags: ['bug'],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      },
    ];

    const mockListCards = jest.fn().mockResolvedValue(mockCards);
    (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => ({
      listCards: mockListCards,
      getCard: jest.fn(),
      createCard: jest.fn(),
      createCards: jest.fn(),
      updateCard: jest.fn(),
      deleteCard: jest.fn(),
      searchCards: jest.fn(),
    } as any));

    (FavroHttpClient as jest.MockedClass<typeof FavroHttpClient>).mockImplementation(() => ({} as any));

    const program = new Command();
    registerCardsListCommand(program);

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const tablespy = jest.spyOn(console, 'table').mockImplementation(() => {});

    await program.parseAsync(['node', 'test', 'cards', 'list', '--board', 'board-123', '--limit', '10']);

    expect(mockListCards).toHaveBeenCalledWith('board-123', 10);
    expect(consoleSpy).toHaveBeenCalledWith('Found 1 card(s):');

    consoleSpy.mockRestore();
    tablespy.mockRestore();
  });
});
