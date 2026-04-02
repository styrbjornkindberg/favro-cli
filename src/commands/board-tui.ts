/**
 * Board TUI Command — Terminal-rendered kanban board view
 *
 * favro board <boardId>               — Render board in kanban layout
 * favro board <boardId> --compact     — One line per card
 * favro board <boardId> --watch       — Auto-refresh (default 30s)
 * favro board <boardId> --ids         — Show card IDs
 * favro board <boardId> --json        — Output structured JSON instead
 */
import { Command } from 'commander';
import { logError } from '../lib/error-handler';
import { createFavroClient } from '../lib/client-factory';
import { ContextAPI, BoardContextSnapshot, ContextCard } from '../api/context';
import { renderBoard, renderStatusBar, RenderColumn, RenderCard } from '../lib/board-renderer';
import { c } from '../lib/theme';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function snapshotToColumns(snapshot: BoardContextSnapshot): RenderColumn[] {
  // Build column map
  const columnMap = new Map<string, RenderCard[]>();

  // Initialize columns from board metadata
  for (const col of snapshot.columns) {
    columnMap.set(col.name, []);
  }

  // If no columns defined, use status grouping
  if (snapshot.columns.length === 0) {
    const statuses = new Set(snapshot.cards.map(c => c.status ?? 'Unknown'));
    for (const s of statuses) {
      columnMap.set(s, []);
    }
  }

  // Place cards in columns
  for (const card of snapshot.cards) {
    // Try to match by columnId first, fall back to status
    let placed = false;

    if (card.columnId) {
      const col = snapshot.columns.find(c => c.id === card.columnId);
      if (col && columnMap.has(col.name)) {
        columnMap.get(col.name)!.push(toRenderCard(card));
        placed = true;
      }
    }

    if (!placed) {
      const status = card.status ?? 'Unknown';
      if (!columnMap.has(status)) {
        columnMap.set(status, []);
      }
      columnMap.get(status)!.push(toRenderCard(card));
    }
  }

  return Array.from(columnMap.entries()).map(([name, cards]) => ({ name, cards }));
}

function toRenderCard(card: ContextCard): RenderCard {
  return {
    id: card.id,
    title: card.title,
    assignee: card.owner,
    tags: card.tags,
    status: card.status,
    due: card.due,
    blocked: (card.blockedBy?.length ?? 0) > 0,
  };
}

// ─── Command ──────────────────────────────────────────────────────────────────

async function renderBoardView(boardRef: string, options: {
  compact?: boolean;
  watch?: boolean | string;
  ids?: boolean;
  json?: boolean;
  limit?: string;
}): Promise<void> {
  const client = await createFavroClient();
  const ctx = new ContextAPI(client);
  const limit = parseInt(options.limit ?? '500', 10);

  async function fetchAndRender(): Promise<void> {
    const snapshot = await ctx.getSnapshot(boardRef, limit);
    const columns = snapshotToColumns(snapshot);

    if (options.json) {
      console.log(JSON.stringify({ board: snapshot.board, columns, stats: snapshot.stats }, null, 2));
      return;
    }

    // Clear screen for watch mode
    if (options.watch) {
      process.stdout.write('\x1B[2J\x1B[0f');
    }

    // Render the board
    const output = renderBoard(columns, {
      title: snapshot.board.name,
      showIds: options.ids,
      compact: options.compact,
    });
    console.log(output);

    // Status bar
    const statusBar = renderStatusBar(snapshot.stats.by_status, snapshot.stats.total);
    console.log(`  ${statusBar}`);
    console.log(`  ${c.muted(`${snapshot.stats.total} cards total · ${snapshot.columns.length} columns · ${new Date().toLocaleTimeString()}`)}`);

    if (options.watch) {
      const interval = typeof options.watch === 'string' ? parseInt(options.watch, 10) : 30;
      console.log(`  ${c.muted(`Auto-refresh every ${interval}s — press Ctrl+C to exit`)}`);
    }
  }

  await fetchAndRender();

  if (options.watch) {
    const interval = typeof options.watch === 'string' ? parseInt(options.watch, 10) : 30;
    const timer = setInterval(async () => {
      try {
        await fetchAndRender();
      } catch (err) {
        console.error(c.error('Refresh failed, retrying...'));
      }
    }, interval * 1000);

    // Keep process alive
    process.on('SIGINT', () => {
      clearInterval(timer);
      console.log(`\n${c.muted('Stopped watching.')}`);
      process.exit(0);
    });

    // Prevent Node from exiting
    await new Promise(() => {});
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerBoardTuiCommand(program: Command): void {
  program
    .command('board <boardRef>')
    .description('Render a kanban board view in your terminal')
    .option('--compact', 'One line per card (default: expanded)')
    .option('--watch [seconds]', 'Auto-refresh interval (default: 30s)')
    .option('--ids', 'Show card IDs')
    .option('--limit <n>', 'Max cards to fetch (default: 500)')
    .option('--json', 'Output as JSON instead of rendered view')
    .action(async (boardRef, options) => {
      try {
        await renderBoardView(boardRef, options);
      } catch (err) {
        logError(err, program.opts().verbose);
        process.exit(1);
      }
    });
}
