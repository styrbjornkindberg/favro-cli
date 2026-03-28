/**
 * `favro propose` CLI Command
 * CLA-1797 / FAVRO-035: Propose & Execute Change System
 *
 * Usage:
 *   favro propose <board> --action "move card 'Fix login' from In Progress to Review"
 *
 * Returns JSON with changeId, preview of API calls, and expiry time.
 * Run `favro execute <board> --change-id <id>` to apply.
 */

import { Command } from 'commander';
import { createFavroClient } from '../lib/client-factory';
import { logError } from '../lib/error-handler';
import { proposeChange, ValidationError } from '../api/propose';
import { ActionParseError } from '../lib/action-parser';

export function registerProposeCommand(program: Command): void {
  program
    .command('propose <board>')
    .description(
      'Propose a change to a board — generates a dry-run preview with a change ID.\n\n' +
      'The preview shows exactly which API calls will be made.\n' +
      'Use `favro execute <board> --change-id <id>` to apply.\n\n' +
      'Change IDs expire after 10 minutes.\n\n' +
      'Examples:\n' +
      '  favro propose "Sprint 42" --action "move card \'Fix login\' from In Progress to Review"\n' +
      '  favro propose boards-1234 --action "assign \'My Card\' to alice"\n' +
      '  favro propose "Q1 Board" --action "create card \'New task\' in Backlog"\n' +
      '  favro propose "Sprint 42" --action "close \'Old ticket\'"\n\n' +
      'Supported actions: move, assign, set priority, add date, link, create, close.'
    )
    .requiredOption('--action <text>', 'Natural language action to perform')
    .option('--pretty', 'Pretty-print JSON output')
    .action(async (board: string, options) => {
      const verbose = program.opts()?.verbose ?? false;


      try {
        const client = await createFavroClient();
        const result = await proposeChange(board, options.action, client);

        const output = {
          changeId: result.changeId,
          boardName: result.boardName,
          actionText: result.actionText,
          preview: result.preview,
          expiresAt: result.expiresAt,
          message: `Preview ready. Run: favro execute ${board} --change-id ${result.changeId}`,
        };

        if (options.pretty) {
          console.log(JSON.stringify(output, null, 2));
        } else {
          console.log(JSON.stringify(output));
        }
      } catch (error) {
        if (error instanceof ValidationError) {
          console.error(`Error: ${error.message}`);
          if (error.suggestions?.length) {
            console.error(`Suggestions:\n${error.suggestions.map(s => `  - ${s}`).join('\n')}`);
          }
          process.exit(1);
        }
        if (error instanceof ActionParseError) {
          console.error(`Parse error: ${error.message}`);
          console.error('Supported actions: move, assign, set priority, add date, link, create, close.');
          process.exit(1);
        }
        logError(error, verbose);
        process.exit(1);
      }
    });
}
