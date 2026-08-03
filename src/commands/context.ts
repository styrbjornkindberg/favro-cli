/**
 * Board Context Snapshot CLI Command
 * CLA-1796 / FAVRO-034: Board Context Snapshot Command
 *
 * Usage:
 *   favro context <board-name|board-id>
 *   favro context <board-name|board-id> --pretty
 *
 * Returns a single JSON object with complete board state for AI workflows:
 *   - Board metadata (id, name, description, type, collection, members list)
 *   - Columns (all columns on the board)
 *   - Custom fields (all custom field definitions with options)
 *   - Members (all board members with roles)
 *   - Cards (full card list with all relationships)
 *   - Stats (card counts by status and owner)
 *   - `unreachable`, when a sub-fetch could not be read (#116)
 */
import { Command } from 'commander';
import { Ctx, run } from '../lib/run';

/**
 * Exported for a test that calls it with a fake `Ctx` and reads the `Result`
 * back — no stdout capture, no client mock.
 *
 * No options left to take. `--limit` was the only one, and it was inert:
 * `getSnapshot` declared `cardLimit` and never read it, so the flag advertised a
 * fetch cap the fetch never applied (#143 close comment). The board is read to
 * completion, as it always in fact was.
 */
export async function contextHandler(ctx: Ctx, board: string) {
  // A single read, so it stays bare (`read-shape.ts` rule 1) — the snapshot IS
  // the entity. Its own `unreachable` rides inside it, where the composite
  // fetch that produced the holes put it.
  return { item: await ctx.api.context.getSnapshot(board) };
}

export function registerContextCommand(program: Command): void {
  program
    .command('context <board>')
    .description(
      'Get complete board context snapshot for AI workflows.\n\n' +
      'Returns a single JSON object with:\n' +
      '  - Board metadata (id, name, description, members)\n' +
      '  - Columns (all board columns)\n' +
      '  - Custom fields (definitions with allowed values)\n' +
      '  - Members (all board members with roles)\n' +
      '  - Cards (full card list with relationships)\n' +
      '  - Stats (counts by status and owner)\n' +
      '  - unreachable: the sub-fetches that failed, if any — an absent marker\n' +
      '    is what makes an empty card list mean "empty" and not "unreadable"\n\n' +
      'Examples:\n' +
      '  favro context boards-1234\n' +
      '  favro context "Sprint 42"\n' +
      '  favro context boards-1234 | jq \'.stats\'\n\n' +
      'Performance: < 1s for 500-card boards (parallel data fetching).\n' +
      'Use: favro boards list to find board IDs.'
    )
    // `--pretty` is a ROOT flag now (ADR-0002, #113/#114). Re-declaring it here
    // would be a leaf shadowing an ancestor, which commander resolves at the
    // root anyway — the #115 trap.
    .action(run(contextHandler));
}
