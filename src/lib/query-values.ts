/**
 * Filter values against their closed vocabularies (#46).
 *
 * `parseQuery` fails closed on field NAMES with no network. This is the other
 * half: the three fields whose values come from a list Favro owns —
 * `tag:`/`label:` from the org tag list, `status:` from the board's columns,
 * `assignee:` from the org's users — are checked against that list before any
 * query runs, so a typo refuses instead of answering a plausible `0 rows`.
 *
 * A cache miss is never the answer on its own: every refusal refills first.
 * `status:` needs `--board`, because a column name is only unique within one.
 *
 * Lives apart from `query-parser` so that module stays free of the client.
 */
import FavroHttpClient from './http-client';
import ColumnDirectory from './column-directory';
import { cachedTags } from './tags-api';
import { invalidateCache } from './name-cache';
import { resolveAssignee } from './assignee';
import { ParseError, Query, QueryNode, FieldPredicate } from './query-parser';

export interface ValueContext {
  client: FavroHttpClient;
  /** The board whose columns settle a `status:` value. */
  boardId?: string;
}

/**
 * Check every closed-vocabulary value in a query, and rewrite it to the form the
 * cards carry — `assignee:` to a `userId`, `status:` to the column's own name.
 *
 * @throws ParseError with `detail.kind` `unknown-value` or `missing-board`.
 */
export async function validateQueryValues(query: Query, ctx: ValueContext): Promise<Query> {
  if (!query.ast) return query;
  return { ...query, ast: await walk(query.ast, ctx) };
}

async function walk(node: QueryNode, ctx: ValueContext): Promise<QueryNode> {
  if (node.kind === 'and' || node.kind === 'or') {
    return { ...node, left: await walk(node.left, ctx), right: await walk(node.right, ctx) };
  }
  if (node.kind !== 'field') return node;

  switch (node.field) {
    case 'tag':
    case 'label':
      return mapValues(node, (v) => checkTag(v, ctx));
    case 'status':
      return mapValues(node, (v) => resolveStatus(v, ctx));
    case 'assignee':
      return mapValues(node, (v) => resolveAssignee(ctx.client, v));
    default:
      return node;
  }
}

/** Apply a per-value check across `=`/`~` and the comma list of `in(…)`. */
async function mapValues(
  node: FieldPredicate,
  check: (value: string) => Promise<string>
): Promise<FieldPredicate> {
  const values = node.operator === 'in' ? node.value.split(',') : [node.value];
  const checked: string[] = [];
  for (const value of values) checked.push(await check(value.trim()));
  return { ...node, value: checked.join(',') };
}

/**
 * The tag must exist in the org. `~` matches a substring — still closed, since
 * a substring matching no tag can only ever return nothing.
 */
async function checkTag(value: string, ctx: ValueContext): Promise<string> {
  const orgId = ctx.client.organizationId;
  const hit = (names: string[]) => {
    const wanted = value.toLowerCase();
    return names.some((n) => n.toLowerCase() === wanted || n.toLowerCase().includes(wanted));
  };

  let names = (await cachedTags(ctx.client, orgId)).map((t) => t.name);
  if (hit(names)) return value;

  // Never refuse on cache evidence alone.
  await invalidateCache(orgId, 'tags');
  names = (await cachedTags(ctx.client, orgId)).map((t) => t.name);
  if (hit(names)) return value;

  throw new ParseError(
    `No tag matching "${value}" — it is missing or not visible to your key. ` +
      `Run 'favro tags list' to see them. The org's tags:\n` +
      names.sort().map((n) => `  ${n}`).join('\n'),
    { kind: 'unknown-value', field: 'tag', value, candidates: names.sort() }
  );
}

/**
 * `status` is the column's name. Settle it against the board's real columns —
 * ColumnDirectory refuses with the board's list, and refills before it does.
 */
async function resolveStatus(value: string, ctx: ValueContext): Promise<string> {
  if (!ctx.boardId) {
    throw new ParseError(
      `'status:${value}' needs a board — a column name is only unique within one. ` +
        `Pass --board <board>, or filter on 'columnId:' instead.`,
      { kind: 'missing-board', field: 'status', value }
    );
  }
  const directory = new ColumnDirectory(ctx.client, ctx.client.organizationId);
  const columnId = await directory.resolveColumnId(value, ctx.boardId);
  // Cards carry the column NAME under `status`; return the canonical spelling so
  // an id, or a differently-cased name, still matches.
  return (await directory.nameOf(columnId)) ?? value;
}

export default validateQueryValues;
