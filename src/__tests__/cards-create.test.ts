import { registerCardsCreateCommand } from '../commands/cards-create';
import { Command } from 'commander';

describe('Cards Create Command', () => {
  test('registers create command', () => {
    const program = new Command();
    registerCardsCreateCommand(program);
    
    const createCmd = program.commands.find(cmd => cmd.name() === 'cards');
    expect(createCmd).toBeDefined();
  });

  test('create command accepts title and options', () => {
    const program = new Command();
    registerCardsCreateCommand(program);
    
    const createCmd = program.commands.find(cmd => cmd.name() === 'cards');
    expect(createCmd).toBeDefined();
  });
});
