/**
 * Semantic Query CLI Command
 * CLA-1798 / FAVRO-036: Semantic Query Command
 *
 * Usage:
 *   favro query <board> <natural language query>
 *   favro query "Sprint 42" "status:done"
 *   favro query boards-1234 "blocked cards"
 *   favro query "My Board" "assigned to @alice and status:In Progress"
 *
 * Returns matching cards with a human-readable summary.
 * If no cards match, explains why.
 *
 * The grammar is a FAIL-OPEN parser and #95's business, not this file's — #116
 * migrated the plumbing around it and left `parseQueryFilter` untouched.
 */
import { Command } from 'commander';
import type { QueryResult } from '../types/query';
import { parseLimit } from '../lib/read-shape';
import { Ctx, run } from '../lib/run';

/** The result, as it reads to a person. Byte-identical to the pre-#116 render. */
function formatHuman(result: QueryResult): string {
  const lines: string[] = [result.summary];

  if (result.matches.length > 0) {
    lines.push('');
    for (const { card, matchReason } of result.matches) {
      const status = card.status ? ` [${card.status}]` : '';
      const assignees = card.assignees && card.assignees.length > 0
        ? ` — ${card.assignees.join(', ')}`
        : '';
      const tags = card.tags && card.tags.length > 0
        ? ` #${card.tags.join(' #')}`
        : '';
      lines.push(`  • ${card.title}${status}${assignees}${tags}`);
      lines.push(`    (${matchReason})`);
    }
  }

  // A hole in the snapshot makes "no cards match" a claim about what we could
  // see, not about the board (#116). Never let the summary above stand alone.
  if (result.unreachable?.length) {
    lines.push('');
    lines.push(`  Searched an incomplete board — ${result.unreachable.length} part(s) could not be read:`);
    for (const u of result.unreachable) lines.push(`    • ${u.id} — ${u.reason}`);
  }

  return lines.join('\n');
}

interface QueryOptions {
  limit?: string;
}

/** Exported for a test that reads the `Result` back off a fake `Ctx`. */
export async function queryHandler(
  ctx: Ctx,
  board: string,
  queryParts: string[],
  options: QueryOptions,
) {
  const cardLimit = parseLimit(options.limit) ?? 1000;
  const result = await ctx.api.query.execute(board, queryParts.join(' '), cardLimit);

  // A single read: the query result IS the entity, matches and all. Returning
  // `{ rows: matches }` would drop `summary`, `total` and `unreachable`.
  return { item: result, human: formatHuman };
}

export function registerQueryCommand(program: Command): void {
  program
    .command('query <board> <query...>')
    .description(
      'Semantic query — search cards on a board with natural language.\n\n' +
      'Supported query patterns:\n' +
      '  status:done                  Cards with a specific status\n' +
      '  assigned:@alice              Cards assigned to a user\n' +
      '  priority:high                Cards with a priority custom field\n' +
      '  label:bug / tag:bug          Cards with a specific tag/label\n' +
      '  due:overdue                  Cards past their due date\n' +
      '  Free text                    Title/tag search\n\n' +
      'Blocking is NOT asked here. Use the fail-closed filter grammar:\n' +
      '  favro cards list <board> --filter "unblocked"\n' +
      '  favro cards list <board> --filter "blocked-by:CLA-1804"\n\n' +
      'Examples:\n' +
      '  favro query boards-1234 "status:done"\n' +
      '  favro query "Sprint 42" "assigned:@alice"\n' +
      '  favro query boards-1234 "high priority status:In Progress"\n\n' +
      'If no results are found, an explanation is provided.\n' +
      'Use --human for the summary view; JSON is the default.'
    )
    .option('--limit <number>', 'Maximum number of cards to search (default 1000)', '1000')
    .action(run(queryHandler));
}
