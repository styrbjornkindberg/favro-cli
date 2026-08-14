/**
 * Filter values against their closed vocabularies (#46).
 *
 * `parseQuery` fails closed on field NAMES with no network. This is the other
 * half: the three fields whose values come from a list Favro owns —
 * `tag:`/`label:` from the org tag list, `status:` from the board's columns,
 * `assignee:` from the org's users — are checked against that list before any
 * query runs, so a typo refuses instead of answering a plausible `0 rows`.
 *
 * `blocked-by:`/`blocks:` join them for the same reason on a narrower axis
 * (#162): their values are card references, and the one spelling a card carries
 * no key for — a sequentialId label — is resolved here or refused here.
 *
 * A cache miss is never the answer on its own: every refusal refills first.
 * `status:` needs `--board`, because a column name is only unique within one.
 *
 * Lives apart from `query-parser` so that module stays free of the client.
 */
import FavroHttpClient from './http-client';
import ColumnDirectory from './column-directory';
import { cachedTags } from './tags-api';
import CardReferenceResolver, { sequentialNumber } from './card-reference';
import { foldName } from './fold-name';
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
 * @throws ParseError for every refusal either half raises.
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
 * Returns `undefined` when no filtering flag was passed at all. A flag passed
 * with an EMPTY value is not that: `--tag "$SPRINT_TAG"` with the variable
 * unset asked to narrow to one tag, and answering the whole board instead is a
 * fail-open on the exact axis this function exists to close. It refuses.
 *
 * @throws ParseError / RefusalError — whatever the closed vocabulary raises.
 */
export async function resolveCardFilter(
  flags: FilterFlags,
  ctx: ValueContext
): Promise<Query | undefined> {
  const nodes: QueryNode[] = [];
  const raw: string[] = [];

  refuseEmpty('filter', flags.filter);
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
    refuseEmpty(field, value);
    if (!value) continue;
    // `=`, never `~`: exact is the only thing that resolves. See `checkTag`.
    nodes.push({ kind: 'field', field, operator: '=', value });
    raw.push(`${field}:${value}`);
  }

  if (raw.length === 0) return undefined;
  const ast = nodes.length === 0
    ? null
    : nodes.reduce((left, right): QueryNode => ({ kind: 'and', left, right }));
  // Parenthesise on composition. The AST is already right — the reduce ANDs
  // whole parsed nodes — but `--filter "a OR b" --tag bug` flattens to
  // `a OR b AND tag:bug`, which re-parses to the WRONG tree. Nothing re-parses
  // `raw` today; a trap laid for the first reader who does is still a trap.
  const composed = raw.length === 1 ? raw[0] : raw.map((r) => `(${r})`).join(' AND ');
  return validateQueryValues({ ast, raw: composed }, ctx);
}

/**
 * A flag passed with an empty value narrows nothing, and treating it as an
 * absent flag answers the whole board — the fail-open direction. Refuse.
 *
 * Exported because `applyFilters` needs the SAME refusal, in the same words:
 * `cards list --filter ""` refused here while `batch move --filter "" --yes`
 * moved the whole board, which is the #138 fail-open in its widest direction.
 */
export function refuseEmpty(field: string, value: string | undefined): void {
  if (value === undefined || value.trim() !== '') return;
  throw new ParseError(
    `--${field} was passed with an empty value — it narrows nothing, and ignoring ` +
      `it would answer the whole board. Pass a value, or drop the flag.`
  );
}

/**
 * Check every closed-vocabulary value in a query, and rewrite it to the form the
 * cards carry — `assignee:` to a `userId`, `status:` to the column's own name.
 *
 * @throws ParseError on a value outside its vocabulary, or on `status:` with no
 *         board to settle it against.
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
    case 'blocked-by':
    case 'blocks':
      return mapValues(node, (v) => resolveCardReference(v, ctx));
    default:
      return node;
  }
}

/**
 * A `blocked-by:`/`blocks:` value, rewritten to something an edge can carry.
 *
 * `query-parser.ts` documents `blocked-by:CLA-1804` and it had never worked:
 * the predicate compares the value against the edge's own keys, and
 * `cardSequentialId` is a key **Favro has never been measured sending** on
 * either dependency shape (#162). So the sequential spelling matched nothing —
 * silently, as a plausible zero rows, which is the fail-open this module exists
 * to abolish.
 *
 * A hex reference passes through untouched and costs no call: an edge carries
 * `cardId` AND `cardCommonId`, so `linkMatches` settles either one locally. Only
 * a sequential reference needs the wire, and it resolves to `cardCommonId`
 * rather than `cardId` — the common id is board-independent, so it still matches
 * an edge onto a card that lives on several boards.
 *
 * Deliberately NOT `CardReferenceResolver.toCardCommonId`, and NOT scoped to
 * `ctx.boardId`. That route ends in `pickOneInstance`, which refuses a card
 * living on two boards with *"pass --board"* and a card outside the listed board
 * with *"missing or not visible to your key"* — both wrong here, and wrong in
 * exactly the case this predicate exists for. `docs/commands.md` calls the
 * blocking grammar board-agnostic ("a blocker is a blocker wherever it lives"),
 * and a blocker on another board is the normal case, not an ambiguity: every
 * instance of a card shares ONE `cardCommonId`, which is the only value needed,
 * so there is nothing for a `--board` to disambiguate.
 *
 * The one honest refusal is a reference that names no card at all.
 */
async function resolveCardReference(value: string, ctx: ValueContext): Promise<string> {
  // `blocked-by:true` is "any blocker at all", not a reference — and neither is
  // a hex id. Both decline here and cost no call. (Bare `blocked-by` with no
  // value does not reach this function at all: `unblocked` is the only entry in
  // the parser's `BARE_KEYWORDS`, so the bare spelling refuses as an
  // unrecognised token.)
  const sequential = sequentialNumber(value);
  if (sequential === undefined) return value;

  const instances = await new CardReferenceResolver(ctx.client)
    .query({ cardSequentialId: sequential });
  const commonIds = [
    ...new Set(instances.map((i) => i.cardCommonId).filter((id): id is string => Boolean(id))),
  ];
  if (commonIds.length === 1) return commonIds[0];

  if (commonIds.length === 0) {
    throw new ParseError(
      `No card with sequentialId "${value}" — it is missing, or not visible to your key. ` +
        `A sequentialId label is capitalised (CLA-1804). ` +
        `Filter on a cardId or cardCommonId instead, or run 'favro cards list <board>' ` +
        `to see what is there.`
    );
  }
  // Every board instance and every fork of one card carries the same
  // `cardCommonId`, so this is unreachable unless Favro answers one
  // `cardSequentialId` with genuinely different cards. Refusing beats picking
  // one: this predicate's whole defect was a silently wrong identifier.
  throw new ParseError(
    `sequentialId "${value}" came back naming ${commonIds.length} different cards ` +
      `(${commonIds.join(', ')}), which one sequentialId cannot do — refusing to pick one. ` +
      `Filter on a cardId or cardCommonId instead.`
  );
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
 *
 * CASE COLLISIONS DO NOT REFUSE, deliberately — #84's "ambiguity refuses and
 * lists every colliding id" is an `assignee:` criterion (`resolveAssignee`
 * meets it, naming userId, name and email per collision). A tag has no id to
 * disambiguate TO: it is filtered by name, and an org holding both `Bug` and
 * `bug` gets the cards of both. "Cards tagged bug, any casing" is a coherent
 * answer to a coherent question; "assign this to one of two Alices" is not.
 *
 * Returns the TYPED value, not the canonical spelling — unlike `resolveStatus`,
 * which must return the column's own name because a `columnId` was accepted as
 * input. That works because `compareValues` lowercases both sides, which is the
 * same case-insensitivity this function validated under.
 */
async function checkTag(value: string, ctx: ValueContext, operator: Operator): Promise<string> {
  const orgId = ctx.client.organizationId;
  const hit = (names: string[]) => {
    // `foldName`, not `toLowerCase`: a decomposed input refused against the
    // precomposed tag it matches on screen, and the refusal then listed a
    // candidate identical to what had just been typed (#141).
    const wanted = foldName(value);
    return names.some((n) =>
      operator === '~' ? foldName(n).includes(wanted) : foldName(n) === wanted
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
      names.sort().map((n) => `  ${n}`).join('\n')
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
        `Pass --board <board>, or filter on 'columnId:' instead.`
    );
  }
  const directory = new ColumnDirectory(ctx.client, ctx.client.organizationId);
  const columnId = await directory.resolveColumnId(value, ctx.boardId);
  // Cards carry the column NAME under `status`; return the canonical spelling so
  // an id, or a differently-cased name, still matches.
  return (await directory.nameOf(columnId)) ?? value;
}

export default validateQueryValues;
