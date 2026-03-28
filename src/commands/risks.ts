/**
 * Risks Command
 * FAVRO-038: Release Check & Risk Dashboard
 *
 * Reports cards that are overdue, blocked, stale, unassigned, or missing required fields.
 */
import { Command } from 'commander';
import CardsAPI, { Card } from '../lib/cards-api';
import { logError, suggestBoard } from '../lib/error-handler';
import BoardsAPI from '../lib/boards-api';
import { createFavroClient } from '../lib/client-factory';

export interface RiskReport {
  board: string;
  totalCards: number;
  generatedAt: string;
  risks: {
    overdue: RiskCard[];
    blocked: RiskCard[];
    stale: RiskCard[];
    unassigned: RiskCard[];
    missingFields: RiskCard[];
  };
  summary: {
    overdue: number;
    blocked: number;
    stale: number;
    unassigned: number;
    missingFields: number;
    total: number;
  };
}

export interface RiskCard {
  cardId: string;
  name: string;
  status?: string;
  dueDate?: string;
  assignees?: string[];
  updatedAt?: string;
  reason?: string;
}

/**
 * Check if a card is overdue (dueDate is in the past).
 */
function isOverdue(card: Card): boolean {
  if (!card.dueDate) return false;
  const dueDate = new Date(card.dueDate);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return dueDate < today;
}

/**
 * Check if a card is stale (not updated in > N days).
 */
function isStale(card: Card, staleDays: number): boolean {
  if (!card.updatedAt) return true; // No update date = consider it stale
  const lastUpdate = new Date(card.updatedAt);
  const now = new Date();
  const daysSinceUpdate = (now.getTime() - lastUpdate.getTime()) / (1000 * 60 * 60 * 24);
  return daysSinceUpdate > staleDays;
}

/**
 * Check if a card is missing required fields.
 */
function hasMissingFields(card: Card): boolean {
  if (!card.name || card.name.trim().length === 0) return true;
  if (!card.status || card.status.trim().length === 0) return true;
  if (!card.assignees || card.assignees.length === 0) return true;
  if (!card.dueDate) return true;
  return false;
}

/**
 * Check if a card is blocked (has blocked tag or status indicates blocking).
 */
function isBlocked(card: Card): boolean {
  if (card.tags && card.tags.some(t => t.toLowerCase().includes('blocked'))) return true;
  if (card.status && card.status.toLowerCase().includes('blocked')) return true;
  return false;
}

export function registerRisksCommand(program: Command): void {
  program
    .command('risks <board>')
    .description(
      'Identify at-risk cards: overdue, blocked, stale, unassigned, or with missing fields.\n\n' +
      'Examples:\n' +
      '  favro risks <board-id>\n' +
      '  favro risks <board-id> --stale-days 14\n' +
      '  favro risks <board-id> --json\n\n' +
      'Risk categories:\n' +
      '  - Overdue: Due date is in the past\n' +
      '  - Blocked: Has "blocked" tag or status\n' +
      '  - Stale: No updates for >7 days (configurable)\n' +
      '  - Unassigned: No assignees\n' +
      '  - Missing Fields: Missing name, status, assignees, or due date'
    )
    .option('--stale-days <number>', 'Days without update to consider stale', '7')
    .option('--json', 'Output as JSON')
    .action(async (board: string, options) => {
      const verbose = program.parent?.opts()?.verbose ?? program.opts()?.verbose ?? false;
      try {

        const staleDaysParsed = parseInt(options.staleDays, 10);
        const staleDays = isNaN(staleDaysParsed) || staleDaysParsed < 1 ? 7 : staleDaysParsed;

        const client = await createFavroClient();
        const api = new CardsAPI(client);

        // Fetch all cards from board
        const allCards = await api.listCards(board, 10000);

        // Categorize risks (cards can appear in multiple categories)
        const overdue: RiskCard[] = [];
        const blocked: RiskCard[] = [];
        const stale: RiskCard[] = [];
        const unassigned: RiskCard[] = [];
        const missingFields: RiskCard[] = [];

        const uniqueAtRiskCardIds = new Set<string>();

        allCards.forEach(card => {
          if (isOverdue(card)) {
            overdue.push({
              cardId: card.cardId,
              name: card.name,
              status: card.status,
              dueDate: card.dueDate,
              assignees: card.assignees,
              reason: `Due date was ${card.dueDate}`,
            });
            uniqueAtRiskCardIds.add(card.cardId);
          }

          if (isBlocked(card)) {
            blocked.push({
              cardId: card.cardId,
              name: card.name,
              status: card.status,
              assignees: card.assignees,
              reason: 'Has "blocked" tag or status',
            });
            uniqueAtRiskCardIds.add(card.cardId);
          }

          if (isStale(card, staleDays)) {
            stale.push({
              cardId: card.cardId,
              name: card.name,
              status: card.status,
              updatedAt: card.updatedAt,
              reason: `No updates for >${staleDays} days`,
            });
            uniqueAtRiskCardIds.add(card.cardId);
          }

          if (!card.assignees || card.assignees.length === 0) {
            unassigned.push({
              cardId: card.cardId,
              name: card.name,
              status: card.status,
              reason: 'No assignee',
            });
            uniqueAtRiskCardIds.add(card.cardId);
          }

          if (hasMissingFields(card)) {
            const missing: string[] = [];
            if (!card.name) missing.push('name');
            if (!card.status) missing.push('status');
            if (!card.assignees || card.assignees.length === 0) missing.push('assignees');
            if (!card.dueDate) missing.push('dueDate');

            missingFields.push({
              cardId: card.cardId,
              name: card.name,
              status: card.status,
              reason: `Missing: ${missing.join(', ')}`,
            });
            uniqueAtRiskCardIds.add(card.cardId);
          }
        });

        const report: RiskReport = {
          board,
          totalCards: allCards.length,
          generatedAt: new Date().toISOString(),
          risks: {
            overdue,
            blocked,
            stale,
            unassigned,
            missingFields,
          },
          summary: {
            overdue: overdue.length,
            blocked: blocked.length,
            stale: stale.length,
            unassigned: unassigned.length,
            missingFields: missingFields.length,
            total: uniqueAtRiskCardIds.size,
          },
        };

        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          console.log('');
          console.log('╔════════════════════════════════════════════════════════════╗');
          console.log('║                    RISK DASHBOARD REPORT                    ║');
          console.log('╚════════════════════════════════════════════════════════════╝');
          console.log('');
          console.log(`Board:        ${board}`);
          console.log(`Total cards:  ${report.totalCards}`);
          console.log(`At-risk:      ${report.summary.total}`);
          console.log(`Stale days:   ${staleDays}+`);
          console.log('');

          console.log('Summary:');
          console.log(`  🔴 Overdue:          ${report.summary.overdue}`);
          console.log(`  🚫 Blocked:          ${report.summary.blocked}`);
          console.log(`  ⏳ Stale:            ${report.summary.stale}`);
          console.log(`  👤 Unassigned:       ${report.summary.unassigned}`);
          console.log(`  ⚠️  Missing Fields:   ${report.summary.missingFields}`);
          console.log('');

          if (report.summary.total === 0) {
            console.log('✓ All cards are healthy!');
          } else {
            if (report.risks.overdue.length > 0) {
              console.log('🔴 OVERDUE:');
              report.risks.overdue.slice(0, 5).forEach(card => {
                console.log(`  ${card.cardId}: ${card.name}`);
                console.log(`    Due: ${card.dueDate}`);
              });
              if (report.risks.overdue.length > 5) {
                console.log(`  ... and ${report.risks.overdue.length - 5} more`);
              }
              console.log('');
            }

            if (report.risks.blocked.length > 0) {
              console.log('🚫 BLOCKED:');
              report.risks.blocked.slice(0, 5).forEach(card => {
                console.log(`  ${card.cardId}: ${card.name}`);
              });
              if (report.risks.blocked.length > 5) {
                console.log(`  ... and ${report.risks.blocked.length - 5} more`);
              }
              console.log('');
            }

            if (report.risks.stale.length > 0) {
              console.log(`⏳ STALE (>${staleDays} days no update):`);
              report.risks.stale.slice(0, 5).forEach(card => {
                console.log(`  ${card.cardId}: ${card.name}`);
                console.log(`    Last update: ${card.updatedAt}`);
              });
              if (report.risks.stale.length > 5) {
                console.log(`  ... and ${report.risks.stale.length - 5} more`);
              }
              console.log('');
            }

            if (report.risks.unassigned.length > 0) {
              console.log('👤 UNASSIGNED:');
              report.risks.unassigned.slice(0, 5).forEach(card => {
                console.log(`  ${card.cardId}: ${card.name}`);
              });
              if (report.risks.unassigned.length > 5) {
                console.log(`  ... and ${report.risks.unassigned.length - 5} more`);
              }
              console.log('');
            }

            if (report.risks.missingFields.length > 0) {
              console.log('⚠️  MISSING FIELDS:');
              report.risks.missingFields.slice(0, 5).forEach(card => {
                console.log(`  ${card.cardId}: ${card.name}`);
                console.log(`    ${card.reason}`);
              });
              if (report.risks.missingFields.length > 5) {
                console.log(`  ... and ${report.risks.missingFields.length - 5} more`);
              }
              console.log('');
            }
          }

          const riskLevel = report.summary.total === 0 ? '✅ HEALTHY' :
                           report.summary.overdue > 0 || report.summary.blocked > 0 ? '🔴 CRITICAL' :
                           report.summary.total > 10 ? '🟠 HIGH' :
                           '🟡 MEDIUM';
          console.log(`Overall Risk Level: ${riskLevel}`);
          console.log('');
        }
      } catch (error: any) {
        if (board && error?.response?.status === 404) {
          // Board not found — fetch available boards and suggest
          try {
            const boardsApi = new BoardsAPI(await createFavroClient());
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

export default registerRisksCommand;
