/**
 * Release Check Command
 * FAVRO-038: Release Check & Risk Dashboard
 * 
 * Verifies that Review/Done cards have required fields and flags blockers.
 */
import { Command } from 'commander';
import CardsAPI, { Card } from '../lib/cards-api';
import FavroHttpClient from '../lib/http-client';
import { logError, missingApiKeyError, suggestBoard } from '../lib/error-handler';
import BoardsAPI from '../lib/boards-api';
import { resolveApiKey } from '../lib/config';

export interface ReleaseCheckResult {
  board: string;
  totalCards: number;
  reviewAndDoneCards: number;
  valid: number;
  issues: ReleaseIssue[];
  summary: {
    blockers: number;
    missingFields: number;
    totalIssues: number;
  };
}

export interface ReleaseIssue {
  cardId: string;
  name: string;
  status: string;
  issues: string[];
}

/**
 * Check if a card has the required fields for release.
 * Required fields for Release/Done: name, status, assignees, dueDate (optional but highly recommended)
 */
function checkCardRequirements(card: Card): string[] {
  const issues: string[] = [];

  if (!card.name || card.name.trim().length === 0) {
    issues.push('missing-name');
  }

  if (!card.status || card.status.trim().length === 0) {
    issues.push('missing-status');
  }

  if (!card.assignees || card.assignees.length === 0) {
    issues.push('unassigned');
  }

  // dueDate is not strictly required but is recommended for release planning
  if (!card.dueDate) {
    issues.push('missing-due-date');
  }

  // Check if card is blocked
  if (card.tags && card.tags.some(t => t.toLowerCase().includes('blocked'))) {
    issues.push('blocked');
  }

  return issues;
}

export function registerReleaseCheckCommand(program: Command): void {
  program
    .command('release-check <board>')
    .description(
      'Verify that cards in Review/Done statuses have required fields and no blockers.\n\n' +
      'Examples:\n' +
      '  favro release-check <board-id>\n' +
      '  favro release-check <board-id> --json\n\n' +
      'Checks for:\n' +
      '  - Card name\n' +
      '  - Status\n' +
      '  - At least one assignee\n' +
      '  - Due date (recommended)\n' +
      '  - Blocked tag'
    )
    .option('--json', 'Output as JSON')
    .action(async (board: string, options) => {
      const verbose = program.parent?.opts()?.verbose ?? program.opts()?.verbose ?? false;
      try {
        const token = await resolveApiKey();
        if (!token) {
          console.error(`Error: ${missingApiKeyError()}`);
          process.exit(1);
        }

        const client = new FavroHttpClient({ auth: { token } });
        const api = new CardsAPI(client);

        // Fetch all cards from board (with high limit)
        const allCards = await api.listCards(board, 10000);

        // Filter to Review/Done statuses - use exact matching to avoid substring matches
        const reviewAndDoneCards = allCards.filter(card =>
          card.status &&
          ['review', 'done', 'in review'].includes(card.status.toLowerCase())
        );

        // Check each card for issues
        const issues: ReleaseIssue[] = [];
        let validCount = 0;

        reviewAndDoneCards.forEach(card => {
          const cardIssues = checkCardRequirements(card);
          if (cardIssues.length > 0) {
            issues.push({
              cardId: card.cardId,
              name: card.name,
              status: card.status || 'unknown',
              issues: cardIssues,
            });
          } else {
            validCount++;
          }
        });

        const blockerCount = issues.filter(i => i.issues.includes('blocked')).length;

        const result: ReleaseCheckResult = {
          board,
          totalCards: allCards.length,
          reviewAndDoneCards: reviewAndDoneCards.length,
          valid: validCount,
          issues,
          summary: {
            blockers: blockerCount,
            missingFields: issues.filter(i => i.issues.some(issue => 
              issue !== 'blocked' && issue !== 'missing-due-date'
            )).length,
            totalIssues: issues.length,
          },
        };

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log('');
          console.log('╔════════════════════════════════════════════════════════════╗');
          console.log('║                   RELEASE CHECK REPORT                      ║');
          console.log('╚════════════════════════════════════════════════════════════╝');
          console.log('');
          console.log(`Board:              ${board}`);
          console.log(`Total cards:        ${result.totalCards}`);
          console.log(`Review/Done cards:  ${result.reviewAndDoneCards}`);
          console.log(`Valid for release:  ${result.valid}`);
          console.log('');
          console.log(`Summary:`);
          console.log(`  • Blockers:              ${result.summary.blockers}`);
          console.log(`  • Missing fields:       ${result.summary.missingFields}`);
          console.log(`  • Total issues:         ${result.summary.totalIssues}`);
          console.log('');

          if (result.issues.length === 0) {
            console.log('✓ All Review/Done cards are ready for release!');
          } else {
            console.log(`⚠ Found ${result.issues.length} card(s) with issues:`);
            console.log('');

            const blockedCards = result.issues.filter(i => i.issues.includes('blocked'));
            if (blockedCards.length > 0) {
              console.log('🔴 BLOCKERS (prevent release):');
              blockedCards.forEach(card => {
                console.log(`  ${card.cardId}: ${card.name}`);
                console.log(`    Issues: ${card.issues.filter(i => i === 'blocked').join(', ')}`);
              });
              console.log('');
            }

            const otherIssues = result.issues.filter(i => !i.issues.includes('blocked'));
            if (otherIssues.length > 0) {
              console.log('🟡 WARNINGS (should be fixed):');
              otherIssues.forEach(card => {
                console.log(`  ${card.cardId}: ${card.name}`);
                const issueLabels = card.issues.map(issue => {
                  if (issue === 'missing-name') return 'Missing name';
                  if (issue === 'missing-status') return 'Missing status';
                  if (issue === 'unassigned') return 'Unassigned';
                  if (issue === 'missing-due-date') return 'Missing due date';
                  return issue;
                });
                console.log(`    Issues: ${issueLabels.join(', ')}`);
              });
              console.log('');
            }
          }

          const status = result.summary.blockers > 0 ? '❌ BLOCKED' :
                        result.summary.totalIssues > 0 ? '⚠️  REVIEW NEEDED' :
                        '✅ READY';
          console.log(`Release Status: ${status}`);
          console.log('');
        }
      } catch (error: any) {
        if (board && error?.response?.status === 404) {
          // Board not found — fetch available boards and suggest
          try {
            const token = await resolveApiKey();
            const boardsApi = new BoardsAPI(new FavroHttpClient({ auth: { token: token! } }));
            const boards = await boardsApi.listBoards();
            const boardNames = boards.map(b => b.name);
            const helpfulMsg = suggestBoard(board, boardNames);
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

export default registerReleaseCheckCommand;
