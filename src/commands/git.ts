/**
 * Git Commands
 *
 * favro git link --board <boardId>          — Connect repo to a Favro board
 * favro git branch <cardId>                 — Create branch from card
 * favro git commit [--card <cardId>] [-m]   — Smart commit with card reference
 * favro git sync                            — Sync branch state to cards
 * favro git todos [--board <boardId>]       — Scan TODOs and create cards
 */
import { Command } from 'commander';
import { logError } from '../lib/error-handler';
import { createFavroClient } from '../lib/client-factory';
import { confirmAction, dryRunLog } from '../lib/safety';
import CardsAPI from '../lib/cards-api';
import BoardsAPI from '../lib/boards-api';
import { CommentsApiClient } from '../api/comments';
import {
  readProjectConfig,
  writeProjectConfig,
  findProjectRoot,
  getCurrentBranch,
  extractCardIdFromBranch,
  generateBranchName,
  createBranch,
  hasStagedChanges,
  commitWithMessage,
  getLastCommitHash,
  analyzeBranches,
  isGitRepo,
  FavroProjectConfig,
} from '../lib/git-integration';
import {
  scanTodos,
  groupByFile,
  todoToCardTitle,
  formatTodoAsCardDescription,
} from '../lib/todo-scanner';

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerGitCommands(program: Command): void {
  const gitCmd = program.command('git').description('Git ↔ Favro card integration');

  // ─── git link ───────────────────────────────────────────────────────

  gitCmd
    .command('link')
    .description('Connect this repository to a Favro board')
    .requiredOption('--board <boardId>', 'Board ID to link')
    .option('--prefix <prefix>', 'Card ID prefix pattern (e.g. "CARD" for CARD-123)')
    .option('--branch-pattern <pattern>', 'Branch naming pattern (default: feature/{{cardId}}-{{slug}})')
    .action(async (options) => {
      try {
        if (!isGitRepo()) {
          console.error('Not a git repository. Run this from within a git repo.');
          process.exit(1);
        }

        const client = await createFavroClient();
        const boardsApi = new BoardsAPI(client);

        // Verify the board exists
        process.stderr.write('Verifying board...\n');
        const board = await boardsApi.getBoard(options.board);

        const config: FavroProjectConfig = {
          boardId: options.board,
          boardName: board.name,
          cardPrefix: options.prefix,
          branchPattern: options.branchPattern,
          branches: {},
        };

        const configPath = writeProjectConfig(config);
        console.log(`✓ Linked to board: ${board.name} (${options.board})`);
        console.log(`  Config saved: ${configPath}`);
        console.log('\n  Next steps:');
        console.log('    favro git branch <cardId>     Create a branch from a card');
        console.log('    favro git commit -m "msg"     Commit with auto card reference');
        console.log('    favro git sync                Sync branch state to cards');
      } catch (error) {
        logError(error);
        process.exit(1);
      }
    });

  // ─── git branch <cardId> ───────────────────────────────────────────

  gitCmd
    .command('branch <cardId>')
    .description('Create a git branch from a Favro card')
    .option('--no-move', 'Do not move the card to In Progress')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (cardId: string, options) => {
      try {
        if (!isGitRepo()) {
          console.error('Not a git repository.');
          process.exit(1);
        }

        const config = readProjectConfig();
        const client = await createFavroClient();
        const cardsApi = new CardsAPI(client);

        process.stderr.write('Fetching card...\n');
        const card = await cardsApi.getCard(cardId);

        const branchName = generateBranchName(cardId, card.name, config?.branchPattern);

        console.log(`Card: ${card.name}`);
        console.log(`Branch: ${branchName}`);

        if (!(await confirmAction(`Create branch "${branchName}"?`, { yes: options.yes }))) {
          console.log('Aborted.');
          return;
        }

        createBranch(branchName);
        console.log(`✓ Created and checked out: ${branchName}`);

        // Track the branch → card mapping
        if (config) {
          if (!config.branches) config.branches = {};
          config.branches[branchName] = cardId;
          writeProjectConfig(config);
        }

        // Move card to In Progress
        if (options.move !== false) {
          try {
            await cardsApi.updateCard(cardId, { status: 'In Progress' });
            console.log('✓ Card moved to "In Progress"');
          } catch {
            console.log('  (Could not move card — status column may not exist)');
          }
        }
      } catch (error) {
        logError(error);
        process.exit(1);
      }
    });

  // ─── git commit ────────────────────────────────────────────────────

  gitCmd
    .command('commit')
    .description('Smart commit with auto card reference in message')
    .requiredOption('-m, --message <message>', 'Commit message')
    .option('--card <cardId>', 'Card ID to reference (auto-detected from branch if omitted)')
    .option('--comment', 'Add a comment to the Favro card with commit details')
    .option('--no-prefix', 'Do not add card ID prefix to commit message')
    .action(async (options) => {
      try {
        if (!isGitRepo()) {
          console.error('Not a git repository.');
          process.exit(1);
        }

        if (!hasStagedChanges()) {
          console.error('No staged changes. Run `git add` first.');
          process.exit(1);
        }

        const config = readProjectConfig();
        const branch = getCurrentBranch();

        // Resolve card ID
        let cardId = options.card as string | undefined;
        if (!cardId) {
          // Check config mapping first
          cardId = config?.branches?.[branch];
          // Then try to extract from branch name
          if (!cardId) {
            cardId = extractCardIdFromBranch(branch, config?.cardPrefix) ?? undefined;
          }
        }

        // Build commit message
        let message = options.message;
        if (cardId && options.prefix !== false) {
          const prefix = config?.cardPrefix
            ? `[${config.cardPrefix}-${cardId}]`
            : `[${cardId}]`;
          message = `${prefix} ${message}`;
        }

        const hash = commitWithMessage(message);
        console.log(`✓ Committed: ${hash} ${message}`);

        // Optionally add comment to Favro card
        if (options.comment && cardId) {
          try {
            const client = await createFavroClient();
            const commentsApi = new CommentsApiClient(client);
            await commentsApi.addComment(cardId, `Commit \`${hash}\`: ${options.message}`);
            console.log('✓ Comment added to card');
          } catch {
            console.log('  (Could not add comment to card)');
          }
        }
      } catch (error) {
        logError(error);
        process.exit(1);
      }
    });

  // ─── git sync ──────────────────────────────────────────────────────

  gitCmd
    .command('sync')
    .description('Sync git branch state to Favro cards')
    .option('--dry-run', 'Show what would change without doing it')
    .option('-y, --yes', 'Skip confirmation')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        if (!isGitRepo()) {
          console.error('Not a git repository.');
          process.exit(1);
        }

        const config = readProjectConfig();
        const mappings = analyzeBranches(config?.cardPrefix);
        const withCards = mappings.filter(m => m.cardId);

        if (options.json) {
          console.log(JSON.stringify({ branches: mappings, linkedBoard: config?.boardId }, null, 2));
          return;
        }

        if (withCards.length === 0) {
          console.log('No branches with card references found.');
          console.log('  Link branches by running: favro git branch <cardId>');
          return;
        }

        console.log(`Branch analysis (${withCards.length} card-linked branches):\n`);

        const merged = withCards.filter(m => m.status === 'merged');
        const open = withCards.filter(m => m.status === 'open');
        const current = withCards.filter(m => m.status === 'current');

        if (merged.length) {
          console.log(`  Merged (→ Done):`);
          for (const m of merged) console.log(`    ${m.branch} → card ${m.cardId}`);
        }
        if (open.length) {
          console.log(`  Open (→ In Progress):`);
          for (const m of open) console.log(`    ${m.branch} → card ${m.cardId}`);
        }
        if (current.length) {
          console.log(`  Current:`);
          for (const m of current) console.log(`    ${m.branch} → card ${m.cardId}`);
        }

        if (options.dryRun) {
          if (merged.length) dryRunLog('move', 'cards', `${merged.length} card(s) to "Done"`);
          if (open.length) dryRunLog('move', 'cards', `${open.length} card(s) to "In Progress"`);
          return;
        }

        const total = merged.length + open.length;
        if (total === 0) {
          console.log('\nNo card status changes needed.');
          return;
        }

        if (!(await confirmAction(`Update ${total} card(s)?`, { yes: options.yes }))) {
          console.log('Aborted.');
          return;
        }

        const client = await createFavroClient();
        const cardsApi = new CardsAPI(client);
        let updated = 0;

        for (const m of merged) {
          try {
            await cardsApi.updateCard(m.cardId!, { status: 'Done' });
            updated++;
          } catch {
            console.error(`  ✗ Could not update card ${m.cardId}`);
          }
        }

        for (const m of open) {
          try {
            await cardsApi.updateCard(m.cardId!, { status: 'In Progress' });
            updated++;
          } catch {
            console.error(`  ✗ Could not update card ${m.cardId}`);
          }
        }

        console.log(`\n✓ Updated ${updated}/${total} cards.`);
      } catch (error) {
        logError(error);
        process.exit(1);
      }
    });

  // ─── git todos ─────────────────────────────────────────────────────

  gitCmd
    .command('todos')
    .description('Scan codebase for TODO/FIXME/HACK comments')
    .option('--board <boardId>', 'Board ID for creating cards (defaults to linked board)')
    .option('--create', 'Create Favro cards from TODOs')
    .option('--dry-run', 'Preview what cards would be created')
    .option('-y, --yes', 'Skip confirmation')
    .option('--json', 'Output as JSON')
    .option('--limit <n>', 'Max TODOs to show (default: 100)', '100')
    .action(async (options) => {
      try {
        const root = findProjectRoot();
        process.stderr.write('Scanning codebase for TODOs...\n');
        const todos = scanTodos({ root });

        if (todos.length === 0) {
          console.log('No TODO/FIXME/HACK comments found.');
          return;
        }

        const limit = parseInt(options.limit ?? '100', 10);
        const limited = todos.slice(0, limit);

        if (options.json) {
          console.log(JSON.stringify({ total: todos.length, items: limited }, null, 2));
          return;
        }

        const groups = groupByFile(limited);
        console.log(`Found ${todos.length} TODO items in ${groups.length} files:\n`);

        for (const group of groups) {
          console.log(`  ${group.file}:`);
          for (const item of group.items) {
            console.log(`    L${item.line} [${item.type}] ${item.text}`);
          }
        }

        if (todos.length > limit) {
          console.log(`\n  ... and ${todos.length - limit} more (use --limit to show more)`);
        }

        // Create cards from TODOs
        if (options.create || options.dryRun) {
          const config = readProjectConfig();
          const boardId = options.board ?? config?.boardId;

          if (!boardId) {
            console.error('\nNo board specified. Use --board <id> or run `favro git link` first.');
            process.exit(1);
          }

          console.log(`\nWould create ${limited.length} cards on board ${boardId}:`);
          for (const item of limited) {
            console.log(`  + ${todoToCardTitle(item)}`);
          }

          if (options.dryRun) {
            console.log('\n[dry-run] No cards created.');
            return;
          }

          if (!(await confirmAction(`Create ${limited.length} cards from TODOs?`, { yes: options.yes }))) {
            console.log('Aborted.');
            return;
          }

          const client = await createFavroClient();
          const cardsApi = new CardsAPI(client);
          let created = 0;

          for (const item of limited) {
            try {
              await cardsApi.createCard({
                name: todoToCardTitle(item),
                description: formatTodoAsCardDescription(item),
                boardId,
              });
              created++;
            } catch (error) {
              console.error(`  ✗ Failed to create card for ${item.file}:${item.line}`);
            }
          }

          console.log(`\n✓ Created ${created}/${limited.length} cards.`);
        }
      } catch (error) {
        logError(error);
        process.exit(1);
      }
    });
}
