import { registerCardsUpdateCommand } from '../commands/cards-update';
import { Command } from 'commander';

describe('Cards Update Command', () => {
  test('registers update command', () => {
    const program = new Command();
    registerCardsUpdateCommand(program);
    expect(program.commands.length).toBeGreaterThan(0);
  });
});
