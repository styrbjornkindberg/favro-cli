/**
 * `favro query <board> <query…>` — the CLI leaf.
 *
 * The grammar is the one `cards list --filter` speaks, and it FAILS CLOSED:
 * #95 deleted the second, regex-based parser this command used to run. See
 * `api/query.ts` for what that changes and why.
 */
import { Command } from 'commander';
import type { QueryResult } from '../types/query';
import { Ctx, run } from '../lib/run';

/** The result, as it reads to a person. */
function formatHuman(result: QueryResult): string {
  const lines: string[] = [result.summary];

  if (result.matches.length > 0) {
    lines.push('');
    for (const card of result.matches) {
      const status = card.status ? ` [${card.status}]` : '';
      const assignees = card.assignees && card.assignees.length > 0
        ? ` — ${card.assignees.join(', ')}`
        : '';
      const tags = card.tags && card.tags.length > 0
        ? ` #${card.tags.join(' #')}`
        : '';
      lines.push(`  • ${card.title}${status}${assignees}${tags}`);
    }
  }

  // A hole in the read makes "no cards match" a claim about what we could see,
  // not about the board (#116). Never let the summary above stand alone.
  if (result.unreachable?.length) {
    lines.push('');
    lines.push(`  Searched an incomplete board — ${result.unreachable.length} part(s) could not be read:`);
    for (const u of result.unreachable) lines.push(`    • ${u.id} — ${u.reason}`);
  }

  return lines.join('\n');
}

/**
 * Exported for a test that reads the `Result` back off a fake `Ctx`.
 *
 * No options left to take. `--limit` was the only one and it was inert: it rode
 * `QueryAPI.execute` into `getSnapshot`'s `cardLimit`, which nothing read — so
 * the query always ran over the whole board (#143 close comment).
 */
export async function queryHandler(ctx: Ctx, board: string, queryParts: string[]) {
  const result = await ctx.api.query.execute(board, queryParts.join(' '));

  // A single read: the query result IS the entity, matches and all. Returning
  // `{ rows: matches }` would drop `summary`, `total` and `unreachable`.
  return { item: result, human: formatHuman };
}

export function registerQueryCommand(program: Command): void {
  program
    .command('query <board> <query...>')
    .description(
      'Filter one board with the fail-closed query grammar.\n\n' +
      'The expression is the same one `cards list --filter` takes, and the whole\n' +
      'grammar is documented there — run `favro cards list --help`. A field this\n' +
      'CLI does not have, a token carrying no operator, a tag outside the org, a\n' +
      'column the board lacks: each REFUSES and names what it refused. None of\n' +
      'them answers zero rows.\n\n' +
      'Common shapes:\n' +
      '  status:done                  Cards in a column, by its real name\n' +
      '  assignee:alice               By name, email, userId or @me\n' +
      '  tag:bug                      By exact tag name\n' +
      '  due_date:overdue             Past their due date\n' +
      '  title~"login"                Free text — this is the ONLY spelling of it\n' +
      '  customField:Priority=high    Any custom field on the board\n' +
      '  status:done AND tag:bug      AND / OR / parentheses\n\n' +
      'Free text is `title~"…"` and nothing else (#95). This command used to sweep\n' +
      'anything it could not parse into a title search, so `"statuz:done"` answered\n' +
      'a confident zero rows; it now refuses. `assigned:`, `owner:`, `priority:`,\n' +
      '`due:` and bare words were that parser\'s inventions and refuse too — say\n' +
      '`assignee:`, `customField:Priority=`, `due_date:`.\n\n' +
      'Blocking: `blocks:<ref>` and `blocked-by:<ref>` are answered here.\n' +
      '`unblocked` is NOT — it has to judge each blocker, and this command makes\n' +
      'no reads to report on. Ask the frontier where it is answered:\n' +
      '  favro cards list <board> --filter "unblocked"\n\n' +
      'Examples:\n' +
      '  favro query boards-1234 "status:done"\n' +
      '  favro query "Sprint 42" "assignee:alice AND tag:bug"\n' +
      '  favro query boards-1234 "title~\\"login\\" OR customField:Priority=high"\n\n' +
      'Use --human for the summary view; JSON is the default.'
    )
    .action(run(queryHandler));
}
