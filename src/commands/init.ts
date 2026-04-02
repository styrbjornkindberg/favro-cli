/**
 * `favro init` — Bootstrap a .favro/context.json in the current repo.
 *
 * Fetches scope, boards, columns/workflow, team members, and custom fields
 * from the Favro API and writes a complete context file that LLMs can consume
 * instantly without additional API calls.
 *
 * Usage:
 *   favro init                    # Create .favro/context.json from scoped collection
 *   favro init --collection <id>  # Specify collection explicitly
 *   favro init --refresh          # Update existing context.json
 */
import { Command } from 'commander';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createFavroClient } from '../lib/client-factory';
import { readConfig, resolveUserId } from '../lib/config';
import BoardsAPI from '../lib/boards-api';
import { ColumnsAPI } from '../lib/columns-api';
import CollectionsAPI from '../lib/collections-api';
import { CustomFieldsAPI } from '../lib/custom-fields-api';
import { FavroApiClient } from '../api/members';
import { logError } from '../lib/error-handler';

// ─── Stage detection (same as context.ts / aggregate.ts) ─────────────────────

type WorkflowStage = 'backlog' | 'queued' | 'active' | 'review' | 'testing' | 'approved' | 'done' | 'archived';

function detectStage(name: string): WorkflowStage {
  const n = name.toLowerCase();
  if (/done|klar|färdig|complete|closed|released|shipped|deploy|live|finished|avslut/i.test(n)) return 'done';
  if (/archived?|arkiver/i.test(n)) return 'archived';
  if (/approv|godkän|accept|verified|sign.?off/i.test(n)) return 'approved';
  if (/progress|develop|pågå|aktiv|doing|working|implement|bygg|coding|current/i.test(n)) return 'active';
  if (/test|qa|kvalit|verif/i.test(n)) return 'testing';
  if (/review|gransk|feedback|pending/i.test(n)) return 'review';
  if (/select|vald|ready|next|sprint|priorit|planned|schedul|redo/i.test(n)) return 'queued';
  if (/backlog|inbox|new|ny|todo|to.do|icke|idea|wish|önskelista|triage|incoming/i.test(n)) return 'backlog';
  return 'queued';
}

// ─── Types for context.json ──────────────────────────────────────────────────

interface ContextWorkflowStep {
  columnId: string;
  name: string;
  stage: WorkflowStage;
  next: string | null;
}

interface ContextBoard {
  boardId: string;
  name: string;
  type?: string;
  description?: string;
  workflow?: ContextWorkflowStep[];
}

interface ContextCustomField {
  fieldId: string;
  type: string;
  description?: string;
  options?: Record<string, string>;
}

interface ContextTeamMember {
  name: string;
  email: string;
  role?: string;
}

interface RepoContext {
  _description: string;
  _updated: string;
  scope: {
    collectionId: string;
    collectionName: string;
  };
  boards: Record<string, ContextBoard>;
  customFields: Record<string, ContextCustomField>;
  team: Record<string, ContextTeamMember>;
  notes: Record<string, string>;
}

// ─── Slug helper ─────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[åä]/g, 'a').replace(/ö/g, 'o').replace(/é/g, 'e')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
}

// ─── Command ─────────────────────────────────────────────────────────────────

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Bootstrap .favro/context.json in current repo from Favro API')
    .option('--collection <id>', 'Collection ID to scope (defaults to favro scope)')
    .option('--refresh', 'Update existing context.json')
    .option('--json', 'Print generated context to stdout instead of writing file')
    .action(async (options) => {
      const verbose = program.opts()?.verbose ?? false;
      try {
        const config = await readConfig();
        const client = await createFavroClient();

        // Resolve collection
        const collectionId = options.collection ?? config.scopeCollectionId;
        if (!collectionId) {
          console.error('Error: No collection specified. Use --collection <id> or set scope with `favro scope set <id>`');
          process.exit(1);
        }

        const contextDir = path.join(process.cwd(), '.favro');
        const contextFile = path.join(contextDir, 'context.json');

        // Check if file exists and --refresh not set
        if (!options.refresh && !options.json) {
          try {
            await fs.access(contextFile);
            console.error('Error: .favro/context.json already exists. Use --refresh to update.');
            process.exit(1);
          } catch {
            // File doesn't exist — good
          }
        }

        console.log('Fetching collection info...');
        const collectionsApi = new CollectionsAPI(client);
        let collectionName: string;
        try {
          const coll = await collectionsApi.getCollection(collectionId);
          collectionName = coll.name;
        } catch {
          collectionName = config.scopeCollectionName ?? collectionId;
        }

        // Fetch boards in collection
        console.log('Fetching boards...');
        const boardsApi = new BoardsAPI(client);
        const columnsApi = new ColumnsAPI(client);
        const rawBoards = await boardsApi.listBoardsByCollection(collectionId);

        const boards: Record<string, ContextBoard> = {};
        for (const board of rawBoards) {
          console.log(`  Board: ${board.name}`);
          const slug = slugify(board.name);

          // Fetch columns for workflow
          let workflow: ContextWorkflowStep[] | undefined;
          try {
            const cols = await columnsApi.listColumns(board.boardId);
            if (cols.length > 0) {
              workflow = cols.map((col, i) => ({
                columnId: col.columnId,
                name: col.name,
                stage: detectStage(col.name),
                next: i < cols.length - 1 ? cols[i + 1].name : null,
              }));
            }
          } catch {
            // Some boards may not have columns
          }

          boards[slug] = {
            boardId: board.boardId,
            name: board.name,
            type: board.type ?? undefined,
            workflow,
          };
        }

        // Fetch custom fields — Favro's /customfields endpoint is org-scoped with
        // no server-side board filter, so we fetch once and filter client-side.
        // We keep only fields that are board-local to one of our boards.
        console.log('Fetching custom fields...');
        const fieldsApi = new CustomFieldsAPI(client);
        const customFields: Record<string, ContextCustomField> = {};
        const boardIds = new Set(rawBoards.map(b => b.boardId));
        try {
          const allFields = await fieldsApi.listFields(); // fetch all once
          for (const field of allFields) {
            if (!field.name) continue;
            // Keep only board-local fields belonging to our boards
            if (field.widgetCommonId && !boardIds.has(field.widgetCommonId)) continue;
            // Skip org-wide shared fields (no widgetCommonId) — too noisy
            if (!field.widgetCommonId) continue;
            const entry: ContextCustomField = {
              fieldId: field.fieldId,
              type: field.type,
            };
            if (field.options && field.options.length > 0) {
              entry.options = {};
              for (const opt of field.options) {
                entry.options[opt.name] = opt.optionId;
              }
            }
            customFields[field.name] = entry;
          }
        } catch {
          // Custom fields fetch may fail
        }

        // Fetch team members
        console.log('Fetching team members...');
        const membersApi = new FavroApiClient(client);
        const members = await membersApi.getMembers({ collectionId }).catch(() => []);
        const team: Record<string, ContextTeamMember> = {};
        for (const m of members) {
          team[m.id] = { name: m.name, email: m.email, role: m.role };
        }

        // Determine repo name from cwd
        const repoName = path.basename(process.cwd());

        const context: RepoContext = {
          _description: `Favro context for ${repoName} repo. Used by AI agents to bootstrap Favro operations without repeated lookups.`,
          _updated: new Date().toISOString().slice(0, 10),
          scope: {
            collectionId,
            collectionName,
          },
          boards,
          customFields,
          team,
          notes: {
            cardIds: 'Cards may have different cardIds across boards. Use cardCommonId for cross-board operations (tasks, tasklists, widgets). Use board-specific cardId for column moves.',
            moveCards: 'Use --column flag (not --status) to move cards between kanban columns. --status sets completion metadata, not column position.',
          },
        };

        const json = JSON.stringify(context, null, 2);

        if (options.json) {
          process.stdout.write(json + '\n');
          return;
        }

        // Write file
        await fs.mkdir(contextDir, { recursive: true });
        await fs.writeFile(contextFile, json + '\n', 'utf-8');

        // Ensure .favro/ is in .gitignore (context may contain IDs/emails)
        const gitignorePath = path.join(process.cwd(), '.gitignore');
        try {
          const gitignoreContent = await fs.readFile(gitignorePath, 'utf-8');
          if (!gitignoreContent.includes('.favro/')) {
            await fs.appendFile(gitignorePath, '\n# Favro CLI context (may contain team emails/IDs)\n.favro/\n');
            console.log('Added .favro/ to .gitignore');
          }
        } catch {
          // No .gitignore — create one
          await fs.writeFile(gitignorePath, '# Favro CLI context (may contain team emails/IDs)\n.favro/\n');
          console.log('Created .gitignore with .favro/');
        }

        console.log(`\n✓ Created .favro/context.json`);
        console.log(`  Collection: ${collectionName}`);
        console.log(`  Boards: ${Object.keys(boards).length}`);
        console.log(`  Custom fields: ${Object.keys(customFields).length}`);
        console.log(`  Team members: ${Object.keys(team).length}`);
        console.log(`\nLLMs can now read .favro/context.json for instant board context.`);
        console.log(`Run \`favro init --refresh\` to update after board changes.`);
      } catch (err: any) {
        logError(err, verbose);
        process.exit(1);
      }
    });
}

export default registerInitCommand;
