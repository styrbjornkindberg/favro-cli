/**
 * `favro tracker init` — designate one board in a collection as the tracker (#52).
 *
 * ADOPTS the collection's board rather than duplicating it, and scaffolds a
 * 3-column `To Do` / `Doing` / `Done` board only when the collection has none.
 * A collection with several boards is refused, not guessed: Favro has no
 * "primary board" field, so picking one silently would designate a tracker
 * nobody chose. `--board` settles it.
 *
 * The mapping it produces is two `columnId`s. `detectStage` proposes them; the
 * proposal is confirmed once, here, and never re-derived — `claim` / `resolve`
 * read the stored ids.
 *
 * It PRINTS a paste-ready block. It never writes the repo doc. `--save` stores
 * the same mapping in `~/.favro/config.json`, which is the repo-less fallback.
 */
import { Command } from 'commander';
import FavroHttpClient from '../lib/http-client';
import ColumnDirectory, { listColumnsFor } from '../lib/column-directory';
import type TagsAPI from '../lib/tags-api';
import { TagLookupError } from '../lib/tags-api';
import { ApiNamespace, apiNamespace, Ctx, run } from '../lib/run';
import { resolveNameToId } from '../lib/name-resolve';
import { detectStage, proposeColumnMapping, WorkflowStage } from '../lib/workflow-stage';
import { classifyThrownError } from '../lib/favro-error';
import { invalidateCache } from '../lib/name-cache';
import {
  CATEGORY_TAGS,
  STATE_TAGS,
  TrackerConfigError,
  TrackerMapping,
  TRIAGE_TAGS,
  renderTrackerBlock,
  trackerDocPath,
} from '../lib/tracker-config';

const SCAFFOLD_COLUMNS = ['To Do', 'Doing', 'Done'];
const DEFAULT_BOARD_NAME = 'Issue Tracker';

export interface InitTrackerOptions {
  /** Already resolved — the caller does the scope check against it. */
  collectionId: string;
  /** Selects the board when the collection has several; names it when it has none. */
  board?: string;
  active?: string;
  done?: string;
}

export interface InitTrackerResult {
  mapping: TrackerMapping;
  boardName: string;
  activeColumnName: string;
  doneColumnName: string;
  /** True when the board did not exist and was created here. */
  scaffolded: boolean;
  columns: Array<{ columnId: string; name: string; stage: WorkflowStage }>;
  tags: { existing: string[]; created: string[]; ambiguous: string[] };
  block: string;
}

/**
 * Look the vocabulary up, recording what is already there, and answer with the
 * names nothing in the org holds. An ambiguous name counts as present — Favro
 * has two ids behind one visible name and creating a third would make it worse.
 */
async function findTags(
  api: TagsAPI,
  names: readonly string[],
  tags: InitTrackerResult['tags']
): Promise<string[]> {
  const missing: string[] = [];
  for (const name of names) {
    try {
      await api.getTag(name);
      tags.existing.push(name);
    } catch (error) {
      if (!(error instanceof TagLookupError)) throw error;
      if (error.kind === 'ambiguous') tags.ambiguous.push(name);
      else missing.push(name);
    }
  }
  return missing;
}

/**
 * Provision the triage vocabulary — LOOK UP first, create only what is genuinely
 * absent (#72).
 *
 * Favro tags are organization-level, so minting one is an admin operation and
 * the key running `tracker init` usually cannot: an unknown name offered on a
 * write is a *creation*, refused 403 "User does not have correct permission
 * level in workspace". The normal case in an administered org is that the seven
 * already exist, and then this asks Favro for nothing it may refuse.
 *
 * A name the cached list misses is re-asked once against a fresh one, the same
 * refresh-on-miss `CardsAPI.orgTags` does: a 15-minute-old cache cannot tell
 * "the admin has not added it" from "we have not looked since" — which is also
 * what made a second `init` inside the TTL re-attempt every creation.
 */
async function provisionTags(client: FavroHttpClient, api: TagsAPI): Promise<InitTrackerResult['tags']> {
  const tags: InitTrackerResult['tags'] = { existing: [], created: [], ambiguous: [] };

  let missing = await findTags(api, TRIAGE_TAGS, tags);
  if (missing.length > 0) {
    await invalidateCache(client.organizationId, 'tags');
    missing = await findTags(api, missing, tags);
  }

  // Every refusal is collected before any is reported: a key that cannot create
  // one tag cannot create any, and a list the user can hand to an admin in one
  // go beats seven round-trips discovering them one at a time.
  const refused: string[] = [];
  let denial = '';
  for (const name of missing) {
    try {
      await api.createTag(name);
      tags.created.push(name);
    } catch (error) {
      const classification = classifyThrownError(error);
      if (classification?.kind !== 'permission') throw error;
      denial = classification.raw ?? classification.message;
      refused.push(name);
    }
  }

  if (refused.length > 0) {
    throw new TrackerConfigError(
      `The triage vocabulary is incomplete and this key cannot create the missing tags: ${refused.join(', ')}.\n` +
        `Favro tags are organization-level, so creating one is an admin operation — Favro refused it: "${denial}".\n` +
        (tags.created.length > 0 ? `Created before the refusal: ${tags.created.join(', ')}.\n` : '') +
        `Ask someone who can to run 'favro tags create "${refused[0]}"' for each, then re-run 'favro tracker init'. ` +
        `All seven are needed: 'retag' requires exactly one of ${CATEGORY_TAGS.join('/')} and one of ${STATE_TAGS.join('/')}.`,
      'missing'
    );
  }
  return tags;
}

/**
 * Still takes a bare client, not a `Ctx`: `initTracker` is the reusable half —
 * the wire test drives it directly and any non-CLI caller would too. It builds
 * its own namespace from the client rather than the eighteen bare API
 * constructions the runner replaced (ADR-0002, #118).
 *
 * ponytail: an `apiNamespace` per call, not the runner's memoised one. The
 * getters are lazy so an unused one costs nothing; pass `ctx.api` in as an
 * optional second argument if a caller ever runs this in a loop.
 */
export async function initTracker(
  client: FavroHttpClient,
  options: InitTrackerOptions,
  api: ApiNamespace = apiNamespace(client)
): Promise<InitTrackerResult> {
  const { collectionId } = options;
  const boardsApi = api.boards;
  const columnsApi = api.columns;

  const boards = await boardsApi.listBoardsByCollection(collectionId);
  const wanted = options.board?.trim();

  let boardId: string;
  let boardName: string;
  let scaffolded = false;
  let chosen: { boardId: string; name: string } | undefined;

  if (boards.length > 0) {
    const listed = boards.map((b) => `  ${b.boardId}  ${b.name}`).join('\n');
    chosen = boards[0];

    if (wanted) {
      // `resolveNameToId`, not a fourth private matcher (#123): id-first, then
      // exact folded name, refusing both zero and many with every candidate
      // listed. `organizationId` is deliberately OMITTED, which disables the
      // cache in both directions — these boards are ONE collection's, so reading
      // the shared `boards` entry would match outside the collection and writing
      // it would hand `resolveBoardId` a partial org listing.
      const wantedId = await resolveNameToId({
        kind: 'boards',
        fetch: async () => boards.map((b) => ({ id: b.boardId, name: b.name })),
        value: wanted,
        label: 'board',
        listCommand: `favro boards list --collection ${collectionId}`,
        useIdWith: 'favro tracker init --collection <collection> --board <boardId>',
      });
      chosen = boards.find((b) => b.boardId === wantedId)!;
    } else if (boards.length > 1) {
      throw new TrackerConfigError(
        `Collection ${collectionId} has ${boards.length} boards, and Favro has no "primary board" field to break the tie — ` +
          `refusing to designate one for you. Pass --board <board>:\n${listed}`,
        'ambiguous'
      );
    }
  }

  // Before the scaffold, not after it: provisioning is a pure lookup when the
  // seven already exist, so this costs nothing in the normal case — but a key
  // with board rights (collection-level) and no tag rights (org-level) would
  // otherwise leave a board and its columns behind on its way to the refusal.
  const tags = await provisionTags(client, api.tags);

  if (chosen) {
    boardId = chosen.boardId;
    boardName = chosen.name;
  } else {
    const created = await boardsApi.createBoardInCollection(collectionId, {
      name: wanted || DEFAULT_BOARD_NAME,
      type: 'board',
    });
    boardId = created.boardId;
    boardName = created.name;
    scaffolded = true;
    for (const [position, name] of SCAFFOLD_COLUMNS.entries()) {
      await columnsApi.createColumn(boardId, name, position);
    }
  }

  const columns = (await columnsApi.listColumns(boardId)).map((c) => ({
    columnId: c.columnId,
    name: c.name,
    stage: detectStage(c.name),
  }));

  if (columns.length < 2) {
    throw new TrackerConfigError(
      `Board ${boardId} has ${columns.length} column(s) — a tracker needs one for open and one for closed. ` +
        `Add columns on the board, then re-run 'favro tracker init'.`,
      'missing'
    );
  }

  const directory = new ColumnDirectory(client, client.organizationId);
  const proposed = proposeColumnMapping(columns);
  const activeId = options.active
    ? await directory.resolveColumnId(options.active, boardId)
    : proposed.active?.columnId;
  const doneId = options.done
    ? await directory.resolveColumnId(options.done, boardId)
    : proposed.done?.columnId;

  if (!activeId || !doneId || activeId === doneId) {
    const listed = listColumnsFor(columns);
    throw new TrackerConfigError(
      `Could not tell which column is open and which is closed on board ${boardId} from the column names alone. ` +
        `Pass --active <column> --done <column>:\n${listed}`,
      'ambiguous',
      columns
    );
  }

  const mapping: TrackerMapping = { collectionId, boardId, columns: { active: activeId, done: doneId } };
  const nameOf = (id: string) => columns.find((c) => c.columnId === id)!.name;

  return {
    mapping,
    boardName,
    activeColumnName: nameOf(activeId),
    doneColumnName: nameOf(doneId),
    scaffolded,
    columns,
    tags,
    block: renderTrackerBlock(mapping, {
      boardName,
      activeColumnName: nameOf(activeId),
      doneColumnName: nameOf(doneId),
    }),
  };
}

/**
 * Where a new card LANDS, said out loud when it is not the open column (#162
 * item 9).
 *
 * The mapping is two roles, and every other column carries none — so the two
 * lines above describe the board a card is moved INTO, and say nothing about the
 * one it arrives in. Measured on the scratch board 2026-08-14: `cards create`
 * with no `--status` put the card in `Todo`, `position: 0`. One board, so this
 * says "the first column" and leaves the general rule unclaimed.
 *
 * WHAT THIS IS NOT. #162 item 9 read the landing column's name — Favro's default
 * `New column` — as the problem, and proposed renaming it to something the role
 * proposal can classify. That remedy does nothing, measured through
 * `detectStage`: `New column`, `Todo` and `To Do` all classify `backlog`, and
 * `proposeColumnMapping` leaves the first column unmapped for all three — on a
 * board of three or more columns. On a TWO-column board `active` falls through
 * to `rest[0]`, which IS the first column, so the same names map it. That is why
 * the guard below asks the MAPPING rather than the stage. The scaffold this same
 * command writes when a collection has no board is `To Do` / `Doing` / `Done` —
 * which produces exactly the shape the report calls a defect. So an unmapped
 * landing column is the DESIGN, and what was missing is that nothing said so.
 * Nothing is renamed here.
 *
 * Silent when the first column IS one of the two mapped ones: then the open/
 * closed lines above already name where cards land.
 */
function landingNote(result: InitTrackerResult): string[] {
  const first = result.columns[0];
  const { active, done } = result.mapping.columns;
  if (!first || first.columnId === active || first.columnId === done) return [];
  return [
    `  a new card lands in "${first.name}" (${first.columnId}, stage ${first.stage}), which carries neither role —`,
    `    'favro cards claim <card> --assignee <user>' is what moves it to ${result.activeColumnName}.`,
  ];
}

/**
 * ON THE `void` ARM (ADR-0002, #118), except under `--json`.
 *
 * The default output is a paste-ready block — a document for a human to move
 * into the repo doc, not a view of an entity. `--json` hands the mapping to the
 * runner instead.
 *
 * Exported so a test can hand it a fake `Ctx` and read the `Result` back.
 */
export async function trackerInitHandler(
  ctx: Ctx,
  options: {
    collection: string;
    board?: string;
    active?: string;
    done?: string;
    save?: boolean;
    json?: boolean;
    force?: boolean;
  },
) {
  const collectionId = await ctx.api.collections.resolveCollectionId(
    options.collection,
    'favro tracker init --collection <collectionId>'
  );

  const { writeConfig } = await import('../lib/config');
  const { checkCollectionScope } = await import('../lib/safety');
  checkCollectionScope(collectionId, ctx.config, options.force);

  const result = await initTracker(
    ctx.client,
    {
      collectionId,
      board: options.board,
      active: options.active,
      done: options.done,
    },
    ctx.api,
  );

  if (options.save) {
    await writeConfig({ ...ctx.config, tracker: result.mapping });
  }

  if (options.json) return { item: { ...result, saved: Boolean(options.save) } };

  console.log(
    result.scaffolded
      ? `✓ Collection had no board — scaffolded "${result.boardName}" (${result.mapping.boardId}) with ${SCAFFOLD_COLUMNS.join(' / ')}`
      : `✓ Adopted board "${result.boardName}" (${result.mapping.boardId})`
  );
  console.log(`  open   → ${result.activeColumnName} (${result.mapping.columns.active})`);
  console.log(`  closed → ${result.doneColumnName} (${result.mapping.columns.done})`);
  landingNote(result).forEach((line) => console.log(line));
  if (result.tags.created.length > 0) console.log(`  tags created: ${result.tags.created.join(', ')}`);
  if (result.tags.existing.length > 0) console.log(`  tags already there: ${result.tags.existing.join(', ')}`);
  if (result.tags.ambiguous.length > 0) {
    console.log(`  ⚠ ambiguous tag names, left alone: ${result.tags.ambiguous.join(', ')}`);
  }
  if (options.save) console.log('  saved to ~/.favro/config.json');

  console.log(`\nPaste this into ${trackerDocPath()} — this command does not write it for you:\n`);
  console.log(result.block);
}

export function registerTrackerInitCommand(trackerParent: Command): void {
  trackerParent
    .command('init')
    .description('Designate one board in a collection as the tracker and print a paste-ready block')
    .requiredOption('--collection <collection>', 'Collection name or collectionId')
    .option('--board <board>', 'Board to adopt (name or id); names the scaffolded board when the collection has none')
    .option('--active <column>', 'Column carrying open, by name or columnId (default: proposed from the column names)')
    .option('--done <column>', 'Column carrying closed, by name or columnId (default: proposed from the column names)')
    .option('--save', 'Also store the mapping in ~/.favro/config.json (the repo-less fallback)')
    .option('--json', 'Output the mapping and the block as JSON')
    .option('--force', 'Bypass scope check')
    // No local `TrackerConfigError` arm any more: it extends `RefusalError`, so
    // the runner already renders it as `✗ Error: …` on stderr in human mode and
    // as `{error:{message, retryable:false}}` in JSON. One boundary, one
    // wording, and the machine mode now says a refusal is not worth retrying.
    .action(run(trackerInitHandler));
}

export default registerTrackerInitCommand;
