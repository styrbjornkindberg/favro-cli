/**
 * Diff Command — Board state comparison over time
 *
 * favro diff <boardRef> --since 1d        — Show changes in the last 24h
 * favro diff <boardRef> --since 1w        — Show changes in the last week
 * favro diff <boardRef> --since 1d --human — Color-coded terminal view
 *
 * Color-coded:
 *   Green  → new cards / moved to done
 *   Red    → removed / blocked
 *   Yellow → status changed / reassigned
 *
 * An ANSWER-CODE command (#117, ADR-0002): exit 1 means "there is drift", the
 * convention `git diff --exit-code` uses. A wire failure also exits 1 but writes
 * `{ error: … }` instead of a report, so the two are told apart on stdout.
 */
import { Command } from 'commander';
import { ContextCard } from '../api/context';
import { Ctx, run } from '../lib/run';
import { Unreachable } from '../lib/read-shape';
import { RefusalError } from '../lib/refusal';
import { c } from '../lib/theme';

// ─── Time Parsing ─────────────────────────────────────────────────────────────

function parseSinceArg(since: string): Date {
  const now = Date.now();
  const match = since.match(/^(\d+)\s*(h|d|w|m)$/i);
  // A RefusalError, not a bare one: the same argument declines identically, so
  // `retryable: true` would tell an agent to loop on a typo (`refusal.ts`).
  if (!match) throw new RefusalError(`Invalid --since format: "${since}". Use: 1h, 1d, 1w, 1m`);

  const n = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const ms = { h: 3600000, d: 86400000, w: 604800000, m: 2592000000 }[unit]!;
  return new Date(now - n * ms);
}

// ─── Diff Analysis ────────────────────────────────────────────────────────────

interface DiffEntry {
  type: 'added' | 'removed' | 'moved' | 'reassigned' | 'updated';
  cardId: string;
  title: string;
  detail: string;
}

/** The report, and the shape an agent parses. */
export interface DiffReport {
  board: string;
  /** ISO — the boundary `--since` resolved to, so the answer is reproducible. */
  since: string;
  changes: DiffEntry[];
  summary: {
    added: number;
    moved: number;
    updated: number;
    removed: number;
  };
  /**
   * Facets of the snapshot that could not be read (#116). Present only when
   * non-empty, so absent stays distinguishable from empty — and while it IS
   * present, "no changes" is not an answer this command is entitled to give.
   */
  unreachable?: Unreachable[];
}

function analyzeDiff(cards: ContextCard[], since: Date): DiffEntry[] {
  const entries: DiffEntry[] = [];

  for (const card of cards) {
    const created = card.createdAt ? new Date(card.createdAt) : null;

    // New cards (created after since)
    if (created && created >= since) {
      entries.push({
        type: 'added',
        cardId: card.id,
        title: card.title,
        detail: `Created ${formatRelative(created)}`,
      });
    }
    // Favro sends no last-modified field on a card, so there is no honest
    // signal for "changed since": only creation can be dated.
  }

  return entries;
}

function formatRelative(date: Date): string {
  const diff = Date.now() - date.getTime();
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function renderDiff(report: DiffReport): string {
  const entries = report.changes;
  const since = new Date(report.since);
  const lines: string[] = [];

  lines.push('');
  lines.push(c.heading(`  📊 Board Diff — ${report.board}`));
  lines.push(`  ${c.muted(`Changes since ${since.toLocaleDateString()} ${since.toLocaleTimeString()}`)}`);
  lines.push(`  ${c.separator()}`);
  lines.push('');

  // Ahead of the entries, not under them: "no changes detected" read as an
  // answer when it was a failed read, and a footnote does not undo a headline.
  if (report.unreachable?.length) {
    lines.push(`  ${c.error(`⚠️  Incomplete — ${report.unreachable.length} part(s) of this board could not be read:`)}`);
    for (const hole of report.unreachable) lines.push(`    ${c.muted(`${hole.id} — ${hole.reason}`)}`);
    lines.push('');
  }

  if (entries.length === 0) {
    lines.push(`  ${c.muted('No changes detected in this period.')}`);
    lines.push('');
    return lines.join('\n');
  }

  // Group by type
  const groups: Record<string, DiffEntry[]> = {};
  for (const e of entries) {
    (groups[e.type] ??= []).push(e);
  }

  const typeOrder: DiffEntry['type'][] = ['added', 'moved', 'updated', 'reassigned', 'removed'];
  const typeLabels: Record<string, string> = {
    added: c.success('New Cards'),
    moved: c.info('Completed / Moved'),
    updated: c.warn('Updated'),
    reassigned: c.warn('Reassigned'),
    removed: c.error('Blocked / Removed'),
  };

  for (const type of typeOrder) {
    const group = groups[type];
    if (!group?.length) continue;

    lines.push(`  ${typeLabels[type]} ${c.muted(`(${group.length})`)}`);
    lines.push('');

    for (const e of group) {
      let icon: string;
      let titleFn: (s: string) => string;
      switch (e.type) {
        case 'added':
          icon = c.success('+');
          titleFn = c.success;
          break;
        case 'moved':
          icon = c.info('→');
          titleFn = c.info;
          break;
        case 'removed':
          icon = c.error('✗');
          titleFn = c.error;
          break;
        default:
          icon = c.warn('~');
          titleFn = c.warn;
      }

      lines.push(`    ${icon} ${titleFn(e.title)}`);
      lines.push(`      ${c.muted(e.detail)}  ${c.cardId(e.cardId.slice(0, 10))}`);
    }
    lines.push('');
  }

  // Summary
  const summary = [
    groups.added?.length ? c.success(`+${groups.added.length} new`) : null,
    groups.moved?.length ? c.info(`${groups.moved.length} completed`) : null,
    groups.updated?.length ? c.warn(`~${groups.updated.length} updated`) : null,
    groups.removed?.length ? c.error(`${groups.removed.length} blocked`) : null,
  ].filter(Boolean).join('  ');

  lines.push(`  ${c.bold('Summary:')} ${summary}`);
  lines.push('');

  return lines.join('\n');
}

// ─── Command ──────────────────────────────────────────────────────────────────

interface DiffOptions {
  since: string;
}

/**
 * Exported for a test that calls it with a fake `Ctx` and reads the `Result`
 * back — no stdout capture, no client mock.
 */
export async function diffHandler(ctx: Ctx, boardRef: string, options: DiffOptions) {
  const since = parseSinceArg(options.since);
  const snapshot = await ctx.api.context.getSnapshot(boardRef);
  const changes = analyzeDiff(snapshot.cards, since);
  const holes = snapshot.unreachable ?? [];

  const report: DiffReport = {
    board: snapshot.board.name,
    since: since.toISOString(),
    changes,
    summary: {
      added: changes.filter(e => e.type === 'added').length,
      moved: changes.filter(e => e.type === 'moved').length,
      updated: changes.filter(e => e.type === 'updated').length,
      removed: changes.filter(e => e.type === 'removed').length,
    },
    // Spread in only when non-empty, so absent means "nothing was missed" and
    // never "nobody asked" (#116).
    ...(holes.length > 0 ? { unreachable: holes } : {}),
  };

  return {
    item: report,
    human: renderDiff,
    // Exit 0 is a POSITIVE claim — "nothing changed" — so a snapshot with a hole
    // in it cannot earn one. `getSnapshot` fans out over five facets and each
    // falls back on failure; a failed cards read used to come back as an empty
    // card list, which this command rendered as "No changes detected".
    exitCode: changes.length > 0 || holes.length > 0 ? 1 : 0,
  };
}

export function registerDiffCommand(program: Command): void {
  program
    .command('diff <boardRef>')
    .description(
      'Show board changes over time — color-coded diff view.\n\n' +
      'Exit code IS the answer: 0 when nothing changed and the whole board was\n' +
      'readable, 1 when there is drift OR part of the board could not be read. A\n' +
      'wire failure also exits 1 but writes {"error": …} instead of a report.'
    )
    .requiredOption('--since <period>', 'Time range: 1h, 1d, 1w, 1m')
    // No `--json`: JSON is the default and `--human` / `--pretty` are root flags
    // the runner owns (ADR-0002, #113).
    .action(run(diffHandler));
}
