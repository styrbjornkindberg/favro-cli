/**
 * Board Renderer — Kanban-style terminal board layout
 *
 * Renders board columns side-by-side with colorized cards.
 * Works with raw terminal stdout — no React/ink dependency.
 */
import { c, stripAnsi, padEnd, tableHeader } from './theme';
import type { ContextCard } from '../api/context';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RenderCard {
  id: string;
  title: string;
  assignee?: string;
  tags?: string[];
  status?: string;
  due?: string;
  blocked?: boolean;
  priority?: 'high' | 'medium' | 'low';
}

export interface RenderColumn {
  name: string;
  cards: RenderCard[];
}

export interface RenderOptions {
  /** Max width per column (default: auto from terminal) */
  columnWidth?: number;
  /** Max cards per column before truncation (default: 20) */
  maxCards?: number;
  /** Board title */
  title?: string;
  /** Show card IDs */
  showIds?: boolean;
  /** Compact mode (one line per card) */
  compact?: boolean;
}

// ─── Snapshot → columns ───────────────────────────────────────────────────────

/**
 * `blocked` is deliberately not set from `blockedBy` (#61). Nothing clears a
 * Favro `isBefore` edge when the blocker finishes, so an edge count asserts
 * "blocked" forever — and the badge sits ahead of the done marker, so a
 * finished card carrying a stale edge rendered as blocked. Judging doneness
 * costs a per-blocker sweep (`judgeBlockers`) that a board render does not pay
 * for. The renderer still flags a genuinely blocked card off its column name
 * (`statusIcon` below), the same evidence `favro standup` uses.
 */
function toRenderCard(card: ContextCard): RenderCard {
  return {
    id: card.id,
    title: card.title,
    assignee: card.owner,
    tags: card.tags,
    status: card.status,
    due: card.due,
  };
}

/**
 * Lay a board snapshot out as render columns — the one home (#89) for what
 * `board` and the interactive menu each held a copy of.
 *
 * A card is placed by `columnId` when the board declares that column, and falls
 * back to its status name otherwise, so a card whose column the snapshot did not
 * carry still appears somewhere instead of vanishing. Declared columns survive
 * empty; status columns only exist once something lands in them.
 */
export function snapshotToColumns(
  snapshot: { columns: Array<{ id: string; name: string }>; cards: ContextCard[] },
): RenderColumn[] {
  const columnMap = new Map<string, RenderCard[]>();
  for (const col of snapshot.columns) columnMap.set(col.name, []);

  // A board with no columns is grouped by status instead.
  if (snapshot.columns.length === 0) {
    for (const card of snapshot.cards) columnMap.set(card.status ?? 'Unknown', []);
  }

  for (const card of snapshot.cards) {
    const col = card.columnId
      ? snapshot.columns.find(candidate => candidate.id === card.columnId)
      : undefined;
    const name = col && columnMap.has(col.name) ? col.name : (card.status ?? 'Unknown');
    if (!columnMap.has(name)) columnMap.set(name, []);
    columnMap.get(name)!.push(toRenderCard(card));
  }

  return Array.from(columnMap.entries()).map(([name, cards]) => ({ name, cards }));
}

// ─── Card Formatting ──────────────────────────────────────────────────────────

/**
 * COSMETIC ONLY — this picks a glyph and decides nothing (#98).
 *
 * DO NOT consolidate this into `isDoneStage` / `detectStage` / `judgeBlockers`,
 * and do not "fix" it to agree with them. #98 collapsed the done judgement into
 * one home and left this substring match standing *on purpose*: a wrong glyph
 * costs a moment's confusion in a rendered board, so `'block'` and `'done'` as
 * substrings are cheap and adequate. The same match deciding whether a card is
 * takeable, countable, or writable is not adequate, and that is the distinction
 * being preserved — not an oversight. If you need a verdict here, take the
 * verdict as a field on `RenderCard` from a caller that paid for it (which is
 * what `blocked` on line 19 is for), rather than deriving one from a name.
 */
function statusIcon(card: RenderCard): string {
  if (card.blocked) return c.error('◆');
  const s = (card.status ?? '').toLowerCase();
  if (s.includes('done') || s.includes('complete') || s.includes('closed')) return c.success('●');
  if (s.includes('progress') || s.includes('active') || s.includes('doing')) return c.info('●');
  if (s.includes('review') || s.includes('test')) return c.warn('●');
  if (s.includes('block')) return c.error('●');
  return c.muted('○');
}

function priorityBadge(p?: 'high' | 'medium' | 'low'): string {
  if (p === 'high') return c.priority.high('▲');
  if (p === 'medium') return c.priority.medium('■');
  if (p === 'low') return c.priority.low('▽');
  return '';
}

function dueBadge(due?: string): string {
  if (!due) return '';
  const d = new Date(due);
  const now = new Date();
  const diff = (d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
  if (diff < 0) return c.error('⏰ overdue');
  if (diff < 2) return c.warn('⏰ soon');
  return '';
}

function formatCardCompact(card: RenderCard, width: number, showId: boolean): string {
  const icon = statusIcon(card);
  const pri = priorityBadge(card.priority);
  const prefix = [icon, pri].filter(Boolean).join(' ');
  const idPart = showId ? c.cardId(card.id.slice(0, 8)) + ' ' : '';

  // Title gets remaining space
  const used = stripAnsi(prefix).length + 1 + stripAnsi(idPart).length;
  const titleWidth = Math.max(10, width - used - 1);
  let title = card.title;
  if (title.length > titleWidth) title = title.slice(0, titleWidth - 1) + '…';

  return `${prefix} ${idPart}${c.cardTitle(title)}`;
}

function formatCardFull(card: RenderCard, width: number, showId: boolean): string[] {
  const lines: string[] = [];

  // Line 1: status icon + title
  const icon = statusIcon(card);
  const pri = priorityBadge(card.priority);
  const prefix = [icon, pri].filter(Boolean).join(' ');
  const idPart = showId ? c.cardId(card.id.slice(0, 8)) + ' ' : '';

  const used = stripAnsi(prefix).length + 1 + stripAnsi(idPart).length;
  const titleWidth = Math.max(10, width - used - 1);
  let title = card.title;
  if (title.length > titleWidth) title = title.slice(0, titleWidth - 1) + '…';

  lines.push(`${prefix} ${idPart}${c.cardTitle(title)}`);

  // Line 2: metadata
  const meta: string[] = [];
  if (card.assignee) meta.push(c.assignee(`@${card.assignee}`));
  if (card.tags?.length) meta.push(card.tags.map(t => c.tag(t)).join(' '));
  const dueStr = dueBadge(card.due);
  if (dueStr) meta.push(dueStr);

  if (meta.length) {
    lines.push('  ' + meta.join(' '));
  }

  return lines;
}

// ─── Column Rendering ─────────────────────────────────────────────────────────

function renderColumn(col: RenderColumn, width: number, maxCards: number, showIds: boolean, compact: boolean): string[] {
  const lines: string[] = [];

  // Header
  const count = c.muted(`(${col.cards.length})`);
  const headerText = `${c.column(col.name)} ${count}`;
  lines.push(headerText);
  lines.push(c.brand('─'.repeat(width)));

  // Cards
  const visibleCards = col.cards.slice(0, maxCards);
  for (const card of visibleCards) {
    if (compact) {
      lines.push(formatCardCompact(card, width, showIds));
    } else {
      const cardLines = formatCardFull(card, width, showIds);
      lines.push(...cardLines);
      lines.push(''); // spacer between cards
    }
  }

  // Truncation notice
  if (col.cards.length > maxCards) {
    lines.push(c.muted(`  … +${col.cards.length - maxCards} more`));
  }

  // Pad to consistent height if needed
  if (visibleCards.length === 0) {
    lines.push(c.muted('  (empty)'));
  }

  return lines;
}

// ─── Board Layout ─────────────────────────────────────────────────────────────

/**
 * Render a full kanban board to a string.
 */
export function renderBoard(columns: RenderColumn[], options: RenderOptions = {}): string {
  const termWidth = process.stdout.columns ?? 120;
  const numCols = columns.length || 1;
  const gap = 3; // space between columns
  const colWidth = options.columnWidth ?? Math.max(20, Math.floor((termWidth - gap * (numCols - 1)) / numCols));
  const maxCards = options.maxCards ?? 20;
  const showIds = options.showIds ?? false;
  const compact = options.compact ?? false;

  const output: string[] = [];

  // Title
  if (options.title) {
    output.push('');
    output.push(c.heading(`  📋 ${options.title}`));
    output.push('');
  }

  // Render each column into line arrays
  const columnLines = columns.map(col =>
    renderColumn(col, colWidth, maxCards, showIds, compact)
  );

  // Find max height
  const maxHeight = Math.max(...columnLines.map(cl => cl.length));

  // Pad all columns to same height
  for (const cl of columnLines) {
    while (cl.length < maxHeight) cl.push('');
  }

  // Merge columns side-by-side
  for (let row = 0; row < maxHeight; row++) {
    const cells = columnLines.map(cl => padEnd(cl[row] ?? '', colWidth));
    output.push(cells.join(c.muted(' │ ')));
  }

  output.push('');
  return output.join('\n');
}

/**
 * Render a simple card list (non-kanban view).
 */
export function renderCardList(cards: RenderCard[], options: { title?: string; showIds?: boolean } = {}): string {
  const lines: string[] = [];

  if (options.title) {
    lines.push('');
    lines.push(c.heading(`  ${options.title}`));
    lines.push(`  ${c.separator()}`);
    lines.push('');
  }

  for (const card of cards) {
    const cardLines = formatCardFull(card, process.stdout.columns ?? 80, options.showIds ?? false);
    lines.push(...cardLines.map(l => `  ${l}`));
    lines.push('');
  }

  if (cards.length === 0) {
    lines.push(c.muted('  No cards found.'));
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Render a compact status summary bar.
 */
export function renderStatusBar(stats: Record<string, number>, total: number): string {
  const parts: string[] = [];
  for (const [status, count] of Object.entries(stats)) {
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    const s = status.toLowerCase();
    let colorFn = c.muted;
    if (s.includes('done') || s.includes('complete')) colorFn = c.success;
    else if (s.includes('progress')) colorFn = c.info;
    else if (s.includes('review')) colorFn = c.warn;
    else if (s.includes('block')) colorFn = c.error;

    parts.push(`${colorFn('●')} ${status}: ${c.bold(String(count))} ${c.muted(`(${pct}%)`)}`);
  }
  return parts.join('  ');
}
