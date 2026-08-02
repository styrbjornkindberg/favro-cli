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
import { parseQuery, ParseError, Operator, Query, QueryNode, FieldPredicate } from './query-parser';

export interface ValueContext {
  client: FavroHttpClient;
  /** The board whose columns settle a `status:` value. */
  boardId?: string;
}

/**
 * Parse a `--filter` string AND settle its closed-vocabulary values — the whole
 * protocol, in ONE call (#83).
 *
 * `parseQuery` on its own is half of it. It fails closed on field NAMES with no
 * network, and says nothing about VALUES; a caller that stops there refuses
 * `tag:` with a typo'd *field* and answers a plausible `0 rows` for a typo'd
 * *tag*. `cards export` stopped there while `cards list` did not, so the same
 * grammar carried opposite guarantees depending on which command you typed.
 * Composing the two steps here is what makes the second one
 * unskippable: `src/__tests__/filter-fail-closed-coverage.test.ts` fails the
 * build if any command reaches for `parseQuery` directly again.
 *
 * @throws ParseError — carrying `detail`, for every refusal either half raises.
 */
export async function resolveQuery(filter: string, ctx: ValueContext): Promise<Query> {
  return validateQueryValues(parseQuery(filter), ctx);
}

/**
 * The filtering flags a card read declares, in one bag.
 *
 * `--tag` and `--assignee` are not a second filtering mechanism; they are the
 * flag spelling of `tag:` and `assignee:`, two predicates in the grammar
 * `--filter` already speaks.
 */
export interface FilterFlags {
  /** `--filter`, the query grammar. */
  filter?: string;
  /** `--tag`, i.e. `tag:<value>`. */
  tag?: string;
  /** `--assignee`, i.e. `assignee:<value>`. */
  assignee?: string;
}

/**
 * Settle the WHOLE filtering flag row into one resolved query (#84).
 *
 * `--tag` and `--assignee` used to be a raw lowercase `includes()` over the
 * fetched cards, sitting on the same flag row as a `--filter` that refuses an
 * unknown tag and prints the org's vocabulary. Three things came of that, and
 * only the first is an empty answer:
 *
 *   - `--tag typoo` answered zero rows where `--filter "tag:typoo"` refused;
 *   - `--tag bug` also matched `debug` — populated and wrong, which is worse.
 *     A substring that happens to hit one tag is right by luck, and turns wrong
 *     the day someone creates a second tag containing it;
 *   - `--assignee` matched against `card.assignees`, which holds `userId`s, so
 *     it compared a typed name to an opaque id.
 *
 * Guarding each flag where it is applied would be the same bug with two more
 * places to forget it. They are predicates, so they become predicates — ANDed
 * onto whatever `--filter` said and handed to the one resolution both halves
 * already share. Built as AST nodes rather than spliced into the filter string:
 * a tag named `in progress` or `a:b` must not become grammar.
 *
 * Returns `undefined` when no filtering flag was passed at all.
 *
 * @throws ParseError / RefusalError — whatever the closed vocabulary raises.
 */
export async function resolveCardFilter(
  flags: FilterFlags,
  ctx: ValueContext
): Promise<Query | undefined> {
  const nodes: QueryNode[] = [];
  const raw: string[] = [];

  if (flags.filter) {
    raw.push(flags.filter);
    const parsed = parseQuery(flags.filter);
    if (parsed.ast) nodes.push(parsed.ast);
  }

  const predicates: ReadonlyArray<[field: string, value: string | undefined]> = [
    ['tag', flags.tag],
    ['assignee', flags.assignee],
  ];
  for (const [field, value] of predicates) {
    if (!value) continue;
    // `=`, never `~`: exact is the only thing that resolves. See `checkTag`.
    nodes.push({ kind: 'field', field, operator: '=', value });
    raw.push(`${field}:${value}`);
  }

  if (raw.length === 0) return undefined;
  const ast = nodes.length === 0
    ? null
    : nodes.reduce((left, right): QueryNode => ({ kind: 'and', left, right }));
  return validateQueryValues({ ast, raw: raw.join(' AND ') }, ctx);
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
      return mapValues(node, (v) => checkTag(v, ctx, node.operator));
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
 * The tag must exist in the org, spelled the way the OPERATOR will match it.
 *
 * `~` asks for a substring and is settled by one — still closed, since a
 * substring matching no tag can only ever return nothing. Every other operator
 * matches the card's tag exactly, so an inexact hit is not evidence the value
 * is in the vocabulary: `tag:bu` used to validate against `bug` and then match
 * no card at all, which is the plausible zero rows this module exists to
 * abolish (#84).
 */
async function checkTag(value: string, ctx: ValueContext, operator: Operator): Promise<string> {
  const orgId = ctx.client.organizationId;
  const hit = (names: string[]) => {
    const wanted = value.toLowerCase();
    return names.some((n) =>
      operator === '~' ? n.toLowerCase().includes(wanted) : n.toLowerCase() === wanted
    );
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
