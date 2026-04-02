/**
 * Tests for commands/shell.ts — Shell command registration
 */
import { Command } from 'commander';

describe('shell command', () => {
  test('registers shell command', () => {
    const { registerShellCommand } = require('../../commands/shell');
    const program = new Command();
    program.exitOverride();
    registerShellCommand(program);

    const shellCmd = program.commands.find(c => c.name() === 'shell');
    expect(shellCmd).toBeDefined();
    expect(shellCmd!.description()).toContain('Interactive');
  });

  test('shell command has --board option', () => {
    const { registerShellCommand } = require('../../commands/shell');
    const program = new Command();
    program.exitOverride();
    registerShellCommand(program);

    const shellCmd = program.commands.find(c => c.name() === 'shell');
    const optNames = shellCmd!.options.map((o: any) => o.long);
    expect(optNames).toContain('--board');
  });
});

describe('board-tui command', () => {
  test('registers board command', () => {
    const { registerBoardTuiCommand } = require('../../commands/board-tui');
    const program = new Command();
    program.exitOverride();
    registerBoardTuiCommand(program);

    const boardCmd = program.commands.find(c => c.name() === 'board');
    expect(boardCmd).toBeDefined();
    expect(boardCmd!.description()).toContain('kanban');
  });

  test('board command has --compact, --watch, --ids, --json options', () => {
    const { registerBoardTuiCommand } = require('../../commands/board-tui');
    const program = new Command();
    program.exitOverride();
    registerBoardTuiCommand(program);

    const boardCmd = program.commands.find(c => c.name() === 'board');
    const optNames = boardCmd!.options.map((o: any) => o.long);
    expect(optNames).toContain('--compact');
    expect(optNames).toContain('--watch');
    expect(optNames).toContain('--ids');
    expect(optNames).toContain('--json');
  });
});
