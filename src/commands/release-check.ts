/**
 * Release Check Command
 * FAVRO-038: Release Check & Risk Dashboard
 *
 * Verifies that Review/Done cards have required fields and flags blockers.
 *
 * An ANSWER-CODE command (#117, ADR-0002): the exit code is the verdict, not a
 * failure report. `status` carries the same verdict as declared data, so an
 * agent reading stdout never has to infer it from the code — and a wire failure,
 * which also exits 1, is an `{ error: … }` envelope instead of a report.
 */
import { Command } from 'commander';
import { Card } from '../lib/cards-api';
import { Ctx, run } from '../lib/run';

/** The verdict. `ready` is the only one that exits 0. */
export type ReleaseStatus = 'ready' | 'review-needed' | 'blocked';

export interface ReleaseCheckResult {
  board: string;
  totalCards: number;
  reviewAndDoneCards: number;
  valid: number;
  /**
   * The finding, stated. Derived from `summary` and nothing else, so the exit
   * code, this field and the human render can never disagree — before #117 the
   * verdict existed only inside the human branch, which meant a JSON consumer
   * had to re-derive it and an exit code could not carry it at all.
   */
  status: ReleaseStatus;
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

/** The traffic light, in one place — the render and the exit code both read it. */
function statusFor(summary: ReleaseCheckResult['summary']): ReleaseStatus {
  if (summary.blockers > 0) return 'blocked';
  return summary.totalIssues > 0 ? 'review-needed' : 'ready';
}

const STATUS_LABEL: Record<ReleaseStatus, string> = {
  blocked: '❌ BLOCKED',
  'review-needed': '⚠️  REVIEW NEEDED',
  ready: '✅ READY',
};

/**
 * The human render. Prints for itself and returns `void` — the runner appends
 * nothing under a formatter that already wrote (`writeHuman`).
 */
function formatHuman(result: ReleaseCheckResult): void {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║                   RELEASE CHECK REPORT                      ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Board:              ${result.board}`);
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

  console.log(`Release Status: ${STATUS_LABEL[result.status]}`);
  console.log('');
}

/**
 * Exported for a test that calls it with a fake `Ctx` and reads the `Result`
 * back — no stdout capture, no client mock.
 *
 * `listCards` is a SINGLE call, so it throws rather than returning a short list
 * (`read-shape.ts` rule 3). That is what lets this command score a verdict at
 * all: there is no partial read to score, so an empty `issues` list always means
 * "we looked and found nothing" and never "we could not look".
 */
export async function releaseCheckHandler(ctx: Ctx, board: string) {
  const allCards = await ctx.api.cards.listCards(board);

  // Filter to Review/Done statuses - use exact matching to avoid substring matches
  const reviewAndDoneCards = allCards.filter(card =>
    card.status &&
    ['review', 'done', 'in review'].includes(card.status.toLowerCase())
  );

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

  const summary = {
    blockers: issues.filter(i => i.issues.includes('blocked')).length,
    missingFields: issues.filter(i => i.issues.some(issue =>
      issue !== 'blocked' && issue !== 'missing-due-date'
    )).length,
    totalIssues: issues.length,
  };

  const result: ReleaseCheckResult = {
    board,
    totalCards: allCards.length,
    reviewAndDoneCards: reviewAndDoneCards.length,
    valid: validCount,
    status: statusFor(summary),
    issues,
    summary,
  };

  return {
    item: result,
    human: formatHuman,
    // The finding IS the code. `ready` is the only clean answer, so anything
    // else exits 1 — the same convention `git diff --exit-code` uses.
    exitCode: result.status === 'ready' ? 0 : 1,
  };
}

export function registerReleaseCheckCommand(program: Command): void {
  program
    .command('release-check <board>')
    .description(
      'Verify that cards in Review/Done statuses have required fields and no blockers.\n\n' +
      'Examples:\n' +
      '  favro release-check <board-id>\n' +
      '  favro release-check <board-id> --human\n\n' +
      'Checks for:\n' +
      '  - Card name\n' +
      '  - Status\n' +
      '  - At least one assignee\n' +
      '  - Due date (recommended)\n' +
      '  - Blocked tag\n\n' +
      'Exit code IS the answer: 0 when status is "ready", 1 otherwise. A wire\n' +
      'failure also exits 1 but writes {"error": …} instead of a report.'
    )
    // No `--json`: JSON is the default and `--human` / `--pretty` are root flags
    // the runner owns (ADR-0002, #113).
    .action(run(releaseCheckHandler));
}

export default registerReleaseCheckCommand;
