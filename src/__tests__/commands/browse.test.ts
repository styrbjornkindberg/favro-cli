/**
 * Tests for the browse command registration and structure
 */
import { Command } from 'commander';
import { registerBrowseCommand } from '../../commands/browse';

describe('browse command', () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    program.exitOverride(); // prevent process.exit in tests
  });

  it('registers the browse command', () => {
    registerBrowseCommand(program);
    const browse = program.commands.find(c => c.name() === 'browse');
    expect(browse).toBeDefined();
    expect(browse!.description()).toContain('Interactive browser');
  });

  it('accepts --board option', () => {
    registerBrowseCommand(program);
    const browse = program.commands.find(c => c.name() === 'browse');
    expect(browse).toBeDefined();
    const boardOpt = browse!.options.find(o => o.long === '--board');
    expect(boardOpt).toBeDefined();
    expect(boardOpt).toBeTruthy();
  });

  it('includes usage examples in description', () => {
    registerBrowseCommand(program);
    const browse = program.commands.find(c => c.name() === 'browse');
    expect(browse!.description()).toContain('favro browse');
    expect(browse!.description()).toContain('--board');
  });
});
