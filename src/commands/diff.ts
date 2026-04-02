/**
 * Diff Command — Board state comparison over time
 *
 * favro diff <boardRef> --since 1d        — Show changes in the last 24h
 * favro diff <boardRef> --since 1w        — Show changes in the last week
 * favro diff <boardRef> --json            — JSON output
 *
 * Color-coded:
 *   Green  → new cards / moved to done
 *   Red    → removed / blocked
 *   Yellow → status changed / reassigned
 */
import { Command } from 'commander';
import { logError } from '../lib/error-handler';
import { createFavroClient } from '../lib/client-factory';
import { ContextAPI, ContextCard } from '../api/context';
import { c, kv } from '../lib/theme';

// ─── Time Parsing ─────────────────────────────────────────────────────────────

function parseSinceArg(since: string): Date {
  const now = Date.now();
  const match = since.match(/^(\d+)\s*(h|d|w|m)$/i);
  if (!match) throw new Error(`Invalid --since format: "${since}". Use: 1h, 1d, 1w, 1m`);

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

function analyzeDiff(cards: ContextCard[], since: Date): DiffEntry[] {
  const entries: DiffEntry[] = [];

  for (const card of cards) {
    const created = card.createdAt ? new Date(card.createdAt) : null;
    const updated = card.updatedAt ? new Date(card.updatedAt) : null;

    // New cards (created after since)
    if (created && created >= since) {
      entries.push({
        type: 'added',
        cardId: card.id,
        title: card.title,
        detail: `Created ${formatRelative(created)}`,
      });
      continue; // Don't double-report
    }

    // Updated cards
    if (updated && updated >= since) {
      // Classify the change type based on available signals
      const status = card.status ?? '';
      const s = status.toLowerCase();

      if (s.includes('done') || s.includes('complete') || s.includes('closed')) {
        entries.push({
          type: 'moved',
          cardId: card.id,
          title: card.title,
          detail: `Moved to ${status}`,
        });
      } else if ((card.blockedBy?.length ?? 0) > 0) {
        entries.push({
          type: 'removed', // "removed" from progress — blocked
          cardId: card.id,
          title: card.title,
          detail: `Blocked (${card.blockedBy!.length} blocker${card.blockedBy!.length > 1 ? 's' : ''})`,
        });
      } else {
        entries.push({
          type: 'updated',
          cardId: card.id,
          title: card.title,
          detail: `Updated ${formatRelative(updated)} — status: ${status || 'unknown'}`,
        });
      }
    }
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

function renderDiff(entries: DiffEntry[], boardName: string, since: Date): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(c.heading(`  📊 Board Diff — ${boardName}`));
  lines.push(`  ${c.muted(`Changes since ${since.toLocaleDateString()} ${since.toLocaleTimeString()}`)}`);
  lines.push(`  ${c.separator()}`);
  lines.push('');

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

export function registerDiffCommand(program: Command): void {
  program
    .command('diff <boardRef>')
    .description('Show board changes over time — color-coded diff view')
    .requiredOption('--since <period>', 'Time range: 1h, 1d, 1w, 1m')
    .option('--json', 'Output as JSON')
    .option('--limit <n>', 'Max cards to scan (default: 1000)')
    .action(async (boardRef, options) => {
      try {
        const client = await createFavroClient();
        const ctx = new ContextAPI(client);
        const since = parseSinceArg(options.since);
        const limit = parseInt(options.limit ?? '1000', 10);

        const snapshot = await ctx.getSnapshot(boardRef, limit);
        const entries = analyzeDiff(snapshot.cards, since);

        if (options.json) {
          console.log(JSON.stringify({
            board: snapshot.board.name,
            since: since.toISOString(),
            changes: entries,
            summary: {
              added: entries.filter(e => e.type === 'added').length,
              moved: entries.filter(e => e.type === 'moved').length,
              updated: entries.filter(e => e.type === 'updated').length,
              removed: entries.filter(e => e.type === 'removed').length,
            },
          }, null, 2));
          return;
        }

        console.log(renderDiff(entries, snapshot.board.name, since));
      } catch (err) {
        logError(err, program.opts().verbose);
        process.exit(1);
      }
    });
}
