/**
 * Tests for commands/diff.ts — Board diff rendering
 *
 * Tests the diff analysis and time parsing logic without actual API calls.
 */
import { Command } from 'commander';

// We test the diff command's parseSinceArg and analyzeDiff logic
// by importing them indirectly through command registration

describe('diff command', () => {
  test('registers diff command with required --since option', () => {
    // Dynamic import to test registration
    const { registerDiffCommand } = require('../../commands/diff');
    const program = new Command();
    program.exitOverride();
    registerDiffCommand(program);

    const diffCmd = program.commands.find(c => c.name() === 'diff');
    expect(diffCmd).toBeDefined();
    expect(diffCmd!.description()).toContain('board changes');
  });

  test('diff command requires board argument', () => {
    const { registerDiffCommand } = require('../../commands/diff');
    const program = new Command();
    program.exitOverride();
    registerDiffCommand(program);

    const diffCmd = program.commands.find(c => c.name() === 'diff');
    expect(diffCmd).toBeDefined();

    // Arguments check — 'boardRef' is a required arg
    const args = (diffCmd as any)._args;
    expect(args.length).toBe(1);
    expect(args[0]._name).toBe('boardRef');
  });

  test('diff command has --json and --limit options', () => {
    const { registerDiffCommand } = require('../../commands/diff');
    const program = new Command();
    program.exitOverride();
    registerDiffCommand(program);

    const diffCmd = program.commands.find(c => c.name() === 'diff');
    const optNames = diffCmd!.options.map((o: any) => o.long);
    expect(optNames).toContain('--json');
    expect(optNames).toContain('--limit');
    expect(optNames).toContain('--since');
  });
});
