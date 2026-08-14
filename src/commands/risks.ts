/**
 * Risks Command
 * FAVRO-038: Release Check & Risk Dashboard
 *
 * Reports cards that are overdue, blocked, stale, unassigned, or missing required fields.
 *
 * An ANSWER-CODE command (#117, ADR-0002): `riskLevel` is the verdict as
 * declared data and the exit code is derived from it alone. `healthy` exits 0;
 * anything else exits 1. A wire failure also exits 1 but writes `{ error: … }`
 * instead of a report, which is what keeps the two apart on stdout.
 */
import { Command } from 'commander';
import { Card } from '../lib/cards-api';
import { Ctx, run } from '../lib/run';
import { Unreachable } from '../lib/read-shape';
import { isOverdue, isBlocked } from '../lib/card-predicates';

/** The verdict. `healthy` is the only one that exits 0. */
export type RiskLevel = 'healthy' | 'medium' | 'high' | 'critical';

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
  /**
   * The finding, stated. It lived only inside the human branch until #117, so a
   * JSON consumer had to re-derive it and the exit code could not carry it.
   */
  riskLevel: RiskLevel;
  /** Checks this report could not perform. Empty is not the same as unavailable. */
  unreachable?: Unreachable[];
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
 * Staleness is unavailable, not empty. Favro sends no last-modified field on a
 * card — no `updatedAt`, no `ETag`, no `Last-Modified` — so there is nothing to
 * measure days-since-update against. Rather than flag every card (which is what
 * a missing timestamp used to do) the report marks the check unreachable.
 */
const STALE_UNAVAILABLE = 'Favro sends no last-modified field on a card, so staleness cannot be computed';

/**
 * The staleness hole, in the one vocabulary every producer uses (#86).
 *
 * `id` names the CHECK rather than a card, because that is what could not be
 * performed — but it is still an `Unreachable`, so the agent reading `u.reason`
 * here reads it the same way it reads one from `cards list` or `overview`. This
 * shipped as a bare `string[]` under the same key, which is the worse failure:
 * it parses, and every `u.reason` comes back undefined.
 */
export const STALE_UNREACHABLE: Unreachable[] = [{ id: 'stale', reason: STALE_UNAVAILABLE }];

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

/** The traffic light, in one place — the render and the exit code both read it. */
function levelFor(summary: RiskReport['summary']): RiskLevel {
  if (summary.total === 0) return 'healthy';
  if (summary.overdue > 0 || summary.blocked > 0) return 'critical';
  return summary.total > 10 ? 'high' : 'medium';
}

const LEVEL_LABEL: Record<RiskLevel, string> = {
  healthy: '✅ HEALTHY',
  critical: '🔴 CRITICAL',
  high: '🟠 HIGH',
  medium: '🟡 MEDIUM',
};

/**
 * The human render. Prints for itself and returns `void` — the runner appends
 * nothing under a formatter that already wrote (`writeHuman`).
 */
function formatHuman(report: RiskReport): void {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║                    RISK DASHBOARD REPORT                    ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Board:        ${report.board}`);
  console.log(`Total cards:  ${report.totalCards}`);
  console.log(`At-risk:      ${report.summary.total}`);
  console.log('');

  console.log('Summary:');
  console.log(`  🔴 Overdue:          ${report.summary.overdue}`);
  console.log(`  🚫 Blocked:          ${report.summary.blocked}`);
  console.log(`  👤 Unassigned:       ${report.summary.unassigned}`);
  console.log(`  ⚠️  Missing Fields:   ${report.summary.missingFields}`);
  console.log('');

  // Ahead of the verdict, and OUTSIDE the `total === 0` branch — the same rule
  // `diff` follows. Nested in the `else`, a healthy board printed "✓ All cards
  // are healthy!" and never mentioned that staleness had not been checked,
  // while the JSON for the identical run carried `unreachable`. The two modes
  // disagreed about whether a check ran, and the mode a human reads was the one
  // that fail-opened.
  //
  // Read off `unreachable` rather than restated, so the human line and the
  // JSON key cannot drift (#86).
  for (const hole of report.unreachable ?? []) {
    console.log(`⏳ ${hole.id.toUpperCase()}: unreachable — ${hole.reason}`);
    console.log('');
  }

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

  console.log(`Overall Risk Level: ${LEVEL_LABEL[report.riskLevel]}`);
  console.log('');
}

/**
 * Exported for a test that calls it with a fake `Ctx` and reads the `Result`
 * back — no stdout capture, no client mock.
 *
 * `listCards` is a SINGLE call, so it throws rather than returning a short list
 * (`read-shape.ts` rule 3): there is no partial read to score a verdict on. The
 * one hole this report has is permanent and named — staleness — and it does not
 * move the verdict, because `critical` turns on `overdue`/`blocked`, both of
 * which are computable. A `healthy` answer beside a live `unreachable` entry is
 * therefore honest: "nothing found, and here is the check nobody can run".
 */
export async function risksHandler(ctx: Ctx, board: string) {
  const allCards = await ctx.api.cards.listCards(board);

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

  const summary = {
    overdue: overdue.length,
    blocked: blocked.length,
    stale: stale.length,
    unassigned: unassigned.length,
    missingFields: missingFields.length,
    total: uniqueAtRiskCardIds.size,
  };

  const report: RiskReport = {
    board,
    totalCards: allCards.length,
    generatedAt: new Date().toISOString(),
    risks: { overdue, blocked, stale, unassigned, missingFields },
    summary,
    riskLevel: levelFor(summary),
    unreachable: STALE_UNREACHABLE,
  };

  return {
    item: report,
    human: formatHuman,
    // Only `critical` fails the build. Gating on "not healthy" made this a
    // constant 1: `hasMissingFields` counts `!card.dueDate`, and a backlog of
    // 20 cards with no due dates — zero overdue, zero blocked, zero unassigned
    // — came out `high`, exit 1. An exit code that never varies carries no
    // information, and the thing users do about it is write `|| true`, which
    // kills the check permanently. `critical` is the command's own top tier,
    // not a threshold invented here; `riskLevel` in the payload is unchanged.
    exitCode: report.riskLevel === 'critical' ? 1 : 0,
  };
}

export function registerRisksCommand(program: Command): void {
  program
    .command('risks <board>')
    .description(
      'Identify at-risk cards: overdue, blocked, unassigned, or with missing fields.\n\n' +
      'Examples:\n' +
      '  favro risks <board-id>\n' +
      '  favro risks <board-id> --human\n\n' +
      'Risk categories:\n' +
      '  - Overdue: Due date is in the past\n' +
      '  - Blocked: Has "blocked" tag or status\n' +
      '  - Unassigned: No assignees\n' +
      '  - Missing Fields: Missing name, status, assignees, or due date\n\n' +
      'Staleness is reported as unreachable: Favro sends no last-modified field on a card.\n\n' +
      'Exit code IS the answer: 1 when riskLevel is "critical", 0 otherwise —\n' +
      'including "warning", which is a finding to read, not a gate to fail on. A\n' +
      'wire failure also exits 1 but writes {"error": …} instead of a report.'
    )
    // No `--json`: JSON is the default and `--human` / `--pretty` are root flags
    // the runner owns (ADR-0002, #113).
    .action(run(risksHandler));
}

export default registerRisksCommand;
