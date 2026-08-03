/**
 * Board TUI Command — Terminal-rendered kanban board view
 *
 * favro board <boardId>               — Render board in kanban layout
 * favro board <boardId> --compact     — One line per card
 * favro board <boardId> --watch       — Auto-refresh (default 30s)
 * favro board <boardId> --ids         — Show card IDs
 * favro board <boardId> --json        — Hand the snapshot to the runner instead
 *
 * ON THE `void` ARM (ADR-0002, #118). The render IS the answer here, so this
 * command owns its stdout and says so by returning nothing. `--json` is the
 * inverse opt-in the root `--human` cannot express: for a TUI the default is
 * already the human view, so the machine shape is what has to be asked for.
 */
import { Command } from 'commander';
import { parseLimit } from '../lib/read-shape';
import { Ctx, run } from '../lib/run';
import { renderBoard, renderStatusBar, snapshotToColumns } from '../lib/board-renderer';
import { c } from '../lib/theme';

interface BoardTuiOptions {
  compact?: boolean;
  watch?: boolean | string;
  ids?: boolean;
  json?: boolean;
  limit?: string;
}

const DEFAULT_WATCH_SECONDS = 30;

const watchSeconds = (watch: boolean | string | undefined): number =>
  typeof watch === 'string' ? parseInt(watch, 10) : DEFAULT_WATCH_SECONDS;

/**
 * Exported so a test can hand it a fake `Ctx` and read the `Result` back — no
 * stdout capture, no client mock.
 */
export async function boardTuiHandler(ctx: Ctx, boardRef: string, options: BoardTuiOptions) {
  const limit = parseLimit(options.limit) ?? 500;

  // One shot, and the runner writes it. `--watch --json` used to concatenate a
  // fresh pretty-printed object onto stdout every interval, which no parser can
  // read; it is now a single snapshot.
  if (options.json) {
    const snapshot = await ctx.api.context.getSnapshot(boardRef, limit);
    return {
      item: {
        board: snapshot.board,
        columns: snapshotToColumns(snapshot),
        stats: snapshot.stats,
        // `getSnapshot` reports the facets it could not read (#116), and this
        // arm picked three keys and dropped that one — so a failed `columns`
        // read reached an agent as a board with no columns and stats that look
        // measured. Every other `getSnapshot` caller (`diff`, `standup`,
        // `sprint-plan`, `risks`) carries the key; `board` was the sibling left
        // behind. Spread in only when non-empty — absent must stay
        // distinguishable from empty (`read-shape.ts` rule 3).
        ...(snapshot.unreachable?.length ? { unreachable: snapshot.unreachable } : {}),
      },
    };
  }

  async function fetchAndRender(): Promise<void> {
    const snapshot = await ctx.api.context.getSnapshot(boardRef, limit);
    const columns = snapshotToColumns(snapshot);

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

    // Same hole, said to a human. A board rendered from a partial read must not
    // look like a complete one; the wording matches `standup` and `sprint-plan`.
    if (snapshot.unreachable?.length) {
      console.log(`\n  ${c.error(`⚠️  Incomplete — ${snapshot.unreachable.length} part(s) of this board could not be read:`)}`);
      for (const hole of snapshot.unreachable) console.log(`    ${c.muted(`${hole.id} — ${hole.reason}`)}`);
    }

    if (options.watch) {
      console.log(`  ${c.muted(`Auto-refresh every ${watchSeconds(options.watch)}s — press Ctrl+C to exit`)}`);
    }
  }

  await fetchAndRender();

  if (!options.watch) return;

  // Ctrl+C RESOLVES rather than exiting: a hard `process.exit` here terminated
  // before a pending stdout write flushed, and stdout is a pipe under MCP
  // (ADR-0002 rule 2). Clearing the interval empties the event loop, so node
  // leaves on its own with the runner's exit code.
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      fetchAndRender().catch(() => {
        console.error(c.error('Refresh failed, retrying...'));
      });
    }, watchSeconds(options.watch) * 1000);

    process.once('SIGINT', () => {
      clearInterval(timer);
      console.log(`\n${c.muted('Stopped watching.')}`);
      resolve();
    });
  });
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
    .option('--json', 'Emit the snapshot as JSON instead of rendering it (--pretty to indent)')
    .action(run(boardTuiHandler));
}
