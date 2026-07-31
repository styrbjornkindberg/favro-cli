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
import BoardsAPI from '../lib/boards-api';
import CollectionsAPI from '../lib/collections-api';
import ColumnsAPI from '../lib/columns-api';
import ColumnDirectory from '../lib/column-directory';
import TagsAPI, { TagLookupError } from '../lib/tags-api';
import { createFavroClient } from '../lib/client-factory';
import { logError } from '../lib/error-handler';
import { detectStage, proposeColumnMapping, WorkflowStage } from '../lib/workflow-stage';
import {
  TrackerConfigError,
  TrackerMapping,
  TRIAGE_TAGS,
  renderTrackerBlock,
  trackerDocPath,
} from '../lib/tracker-config';

const SCAFFOLD_COLUMNS = ['To Do', 'Doing', 'Done'];
const DEFAULT_BOARD_NAME = 'Issue Tracker';

const norm = (s: string) => s.trim().toLowerCase();

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
 * Provision the triage vocabulary. A tag that already exists is left exactly as
 * it is — including an ambiguous name, where Favro has two ids behind one
 * visible name and creating a third would make it worse.
 */
async function provisionTags(client: FavroHttpClient): Promise<InitTrackerResult['tags']> {
  const api = new TagsAPI(client);
  const tags: InitTrackerResult['tags'] = { existing: [], created: [], ambiguous: [] };

  for (const name of TRIAGE_TAGS) {
    try {
      await api.getTag(name);
      tags.existing.push(name);
    } catch (error) {
      if (!(error instanceof TagLookupError)) throw error;
      if (error.kind === 'ambiguous') {
        tags.ambiguous.push(name);
        continue;
      }
      await api.createTag(name);
      tags.created.push(name);
    }
  }
  return tags;
}

export async function initTracker(
  client: FavroHttpClient,
  options: InitTrackerOptions
): Promise<InitTrackerResult> {
  const { collectionId } = options;
  const boardsApi = new BoardsAPI(client);
  const columnsApi = new ColumnsAPI(client);

  const boards = await boardsApi.listBoardsByCollection(collectionId);
  const wanted = options.board?.trim();

  let boardId: string;
  let boardName: string;
  let scaffolded = false;

  if (boards.length === 0) {
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
  } else {
    const listed = boards.map((b) => `  ${b.boardId}  ${b.name}`).join('\n');
    let chosen = boards[0];

    if (wanted) {
      const matches = boards.filter((b) => b.boardId === wanted || norm(b.name) === norm(wanted));
      if (matches.length !== 1) {
        throw new TrackerConfigError(
          `"${wanted}" matches ${matches.length} boards in collection ${collectionId}. That collection's boards:\n${listed}`,
          matches.length === 0 ? 'missing' : 'ambiguous'
        );
      }
      chosen = matches[0];
    } else if (boards.length > 1) {
      throw new TrackerConfigError(
        `Collection ${collectionId} has ${boards.length} boards, and Favro has no "primary board" field to break the tie — ` +
          `refusing to designate one for you. Pass --board <board>:\n${listed}`,
        'ambiguous'
      );
    }

    boardId = chosen.boardId;
    boardName = chosen.name;
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
    const listed = columns.map((c) => `  ${c.columnId}  ${c.name}`).join('\n');
    throw new TrackerConfigError(
      `Could not tell which column is open and which is closed on board ${boardId} from the column names alone. ` +
        `Pass --active <column> --done <column>:\n${listed}`,
      'ambiguous',
      columns
    );
  }

  const tags = await provisionTags(client);
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
    .action(async (options) => {
      const verbose = trackerParent.parent?.opts()?.verbose ?? false;
      try {
        const client = await createFavroClient();
        const collectionId = await new CollectionsAPI(client).resolveCollectionId(
          options.collection,
          'favro tracker init --collection <collectionId>'
        );

        const { readConfig, writeConfig } = await import('../lib/config');
        const { checkCollectionScope } = await import('../lib/safety');
        const config = await readConfig();
        checkCollectionScope(collectionId, config, options.force);

        const result = await initTracker(client, {
          collectionId,
          board: options.board,
          active: options.active,
          done: options.done,
        });

        if (options.save) {
          await writeConfig({ ...config, tracker: result.mapping });
        }

        if (options.json) {
          console.log(JSON.stringify({ ...result, saved: Boolean(options.save) }, null, 2));
          return;
        }

        console.log(
          result.scaffolded
            ? `✓ Collection had no board — scaffolded "${result.boardName}" (${result.mapping.boardId}) with ${SCAFFOLD_COLUMNS.join(' / ')}`
            : `✓ Adopted board "${result.boardName}" (${result.mapping.boardId})`
        );
        console.log(`  open   → ${result.activeColumnName} (${result.mapping.columns.active})`);
        console.log(`  closed → ${result.doneColumnName} (${result.mapping.columns.done})`);
        if (result.tags.created.length > 0) console.log(`  tags created: ${result.tags.created.join(', ')}`);
        if (result.tags.existing.length > 0) console.log(`  tags already there: ${result.tags.existing.join(', ')}`);
        if (result.tags.ambiguous.length > 0) {
          console.log(`  ⚠ ambiguous tag names, left alone: ${result.tags.ambiguous.join(', ')}`);
        }
        if (options.save) console.log('  saved to ~/.favro/config.json');

        console.log(`\nPaste this into ${trackerDocPath()} — this command does not write it for you:\n`);
        console.log(result.block);
      } catch (error: any) {
        if (error instanceof TrackerConfigError) {
          console.error(`✗ ${error.message}`);
          process.exit(1);
        }
        logError(error, verbose);
        process.exit(1);
      }
    });
}

export default registerTrackerInitCommand;
