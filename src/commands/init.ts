/**
 * `favro init` — Bootstrap a .favro/context.json in the current repo.
 *
 * Fetches scope, boards, columns/workflow, team members, and custom fields
 * from the Favro API and writes a complete context file that LLMs can consume
 * instantly without additional API calls.
 *
 * WHAT THIS FILE SAYS ABOUT A FACET IT COULD NOT READ: nothing, because it is
 * never written (#154). Three reads — `/columns`, `/customfields`, `/users` —
 * used to answer a rejection with `[]`, and the schema below has no field for
 * "unread": an absent `workflow`, an empty `customFields` and an empty `team`
 * are what a board with no columns, an org with no fields and a collection with
 * no members produce. So a 403 became a confident finding in a file later
 * agents read with no memory of the failure. Every other consumer of a failed
 * read in this codebase records an `unreachable` marker instead (#116, #148,
 * #149) — but those answer a QUERY, where refusing the whole answer over one
 * dark board is disproportionate. `init` produces a durable artefact and is
 * cheap and idempotent to re-run, so it fails closed instead: the error
 * propagates, no file is written, and `favro init --refresh` is one command.
 *
 * TWO EDGES OF THAT DECISION, both stated rather than implied.
 *
 * The 403 above is the MOTIVATING case, not a measured one: nothing in
 * `docs/research/` records what `/columns`, `/customfields` or `/users` answer a
 * permission-limited key on a LIST read — `scripts/probe-favro-errors.ts` probes
 * bogus ids with a full-permission key, which is a different question. So the
 * cost is real and unquantified: if a plan or a guest role cannot read one of the
 * three, `favro init` now produces NO file where it used to produce a partial
 * one. Measure it before narrowing the refusal; do not narrow it on a guess.
 *
 * And `collectionName` is the one value that does NOT propagate — it takes the
 * OTHER discharge, the one the membership read below already uses. #154 left the
 * call open; it is settled here. The name is display text and `collectionId`,
 * which everything keys off, is always the real one, so refusing the whole file
 * over it would cost a plan or guest role a file for a field nothing reads. But
 * the fallback used to be a plausible value with NO marker, which is the same
 * shape of lie one field over, so it now records itself: `notes.scope` in the
 * artefact plus a line on stderr, naming WHICH of the two fallbacks it took.
 * `notes` is a `Record<string, string>` for exactly this — a facet whose value is
 * not a measurement saying so in prose — so the schema did not grow a state.
 *
 * The errors propagate RAW rather than wrapped in a `RefusalError`, because a
 * 502 on a read is a wire failure and not a deterministic decline —
 * `retryAdvice` is right to call it retryable, and a `RefusalError` would
 * assert `retryable: false`. `listBoardsByCollection` below has always
 * propagated raw for exactly that reason.
 *
 * Usage:
 *   favro init                    # Create .favro/context.json from scoped collection
 *   favro init --collection <id>  # Specify collection explicitly
 *   favro init --refresh          # Update existing context.json
 */
import { Command } from 'commander';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Ctx, run } from '../lib/run';
import { RefusalError } from '../lib/refusal';
import { detectStage, WorkflowStage } from '../lib/workflow-stage';

/** One copy — the created file and the appended block must not drift apart. */
const GITIGNORE_BLOCK = '# Favro CLI context (may contain team emails/IDs)\n.favro/\n';

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
    // NFC first, or the rules below are form-dependent: a decomposed `Å` is a
    // plain `A` plus a combining ring, which `[åä]` never sees and
    // `[^a-z0-9]+` then turns into a separator — so the same visible board
    // name yielded `atgarder-forbattringar` or `a-tga-rder-fo-rba-ttringar`
    // depending on where it was typed, and those are two different KEYS in
    // context.json (#141).
    //
    // ponytail: the explicit å/ä/ö/é map is unchanged, so an accent outside it
    // still degrades to a separator. Swap in strip-combining-marks if a board
    // name ever needs one.
    .normalize('NFC')
    .toLowerCase()
    .replace(/[åä]/g, 'a').replace(/ö/g, 'o').replace(/é/g, 'e')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
}

// ─── Command ─────────────────────────────────────────────────────────────────

interface InitOptions {
  collection?: string;
  refresh?: boolean;
  json?: boolean;
}

/**
 * ON THE `void` ARM (ADR-0002, #118), except under `--json`.
 *
 * The default is a WRITE with a progress trail — the `Fetching …` lines are the
 * command talking while it works, not a view of an answer. `--json` is the
 * inverse opt-in a bootstrap needs: it prints the context it WOULD have
 * written and touches nothing, and there the runner owns the output
 * (`--pretty` indents it).
 *
 * Exported so a test can hand it a fake `Ctx` and read the `Result` back.
 */
export async function initHandler(ctx: Ctx, options: InitOptions) {
  const config = ctx.config;
  const client = ctx.client;

  // Resolve collection. A refusal, not an exit: no scope is configured
  // and no `--collection` was passed, so there is nothing to guess at and
  // the same call declines again (fail-closed).
  const collectionId: string = options.collection ?? config.scopeCollectionId ?? '';
  if (!collectionId) {
    throw new RefusalError(
      'No collection specified. Use --collection <id> or set scope with `favro scope set <id>`',
    );
  }

  const contextDir = path.join(process.cwd(), '.favro');
  const contextFile = path.join(contextDir, 'context.json');

  // Refuse to clobber an existing context.json.
  //
  // The existence CHECK is a value and the refusal is thrown, because
  // they used to share a `try`: `fs.access` rejecting meant "no file
  // yet", so the guard's own hard `process.exit` sat inside that
  // `catch {}` and any stub for it — throwing OR returning — was
  // swallowed, dropping execution into the very write the guard exists
  // to stop (#131).
  //
  // A `RefusalError` rather than an exit because a refusal is a value
  // the error boundary below renders (`logError` + exit 1), and a value
  // cannot be swallowed on the way there. It is also the honest
  // classification: this decline is deterministic, and `refusal.ts` is
  // where that claim is defined.
  if (!options.refresh && !options.json) {
    const exists = await fs.access(contextFile).then(() => true, () => false);
    if (exists) {
      throw new RefusalError(
        '.favro/context.json already exists — refusing to overwrite it. ' +
        'Run `favro init --refresh` to rebuild it in place, or `favro init --json` to print the new context without writing.',
      );
    }
  }

  console.log('Fetching collection info...');
  // The one read here that FALLS BACK instead of propagating — see the header.
  // Both fallbacks are plausible names, so neither may be silent: the note says
  // which one was taken, and its absence is what makes the read a measurement.
  let collectionName: string;
  let scopeNote: string | undefined;
  try {
    const coll = await ctx.api.collections.getCollection(collectionId);
    collectionName = coll.name;
  } catch {
    const stored = config.scopeCollectionName;
    collectionName = stored ?? collectionId;
    scopeNote =
      "The collection's name could not be read, so `scope.collectionName` is " +
      (stored
        ? 'the name stored in ~/.favro/config.json and may be STALE'
        : 'the raw `collectionId`, not a name') +
      '. It is not a claim about what the collection is called. `collectionId` is ' +
      'unaffected — key off it. Re-run `favro init --refresh` with a key that can ' +
      `read /collections/${collectionId} to replace it.`;
    console.error(`⚠ ${scopeNote}`);
  }

  // Fetch boards in collection
  console.log('Fetching boards...');
  const columnsApi = ctx.api.columns;
  const rawBoards = await ctx.api.boards.listBoardsByCollection(collectionId);

  const boards: Record<string, ContextBoard> = {};
  for (const board of rawBoards) {
    console.log(`  Board: ${board.name}`);
    const slug = slugify(board.name);

    // Fetch columns for workflow. NOT tolerated — see the header. A failed
    // read became `[]`, which the ternary below wrote as an ABSENT `workflow`,
    // which is what a board with no columns produces. Now that the read cannot
    // fail quietly, an absent `workflow` is a measurement: `/columns` answered,
    // and this board has none.
    //
    // The transform is OUTSIDE any catch, which is the older half of this. The
    // two used to share a `try` written for "some boards have no columns", so
    // anything the MAP threw was read as that too — and `detectStage` threw a
    // TypeError on a column Favro sent with no name, silently costing the whole
    // board its workflow on exit 0. The guard for that now lives in
    // `detectStage` itself, where all four of its callers get it.
    const cols = await columnsApi.listColumns(board.boardId);
    const workflow: ContextWorkflowStep[] | undefined =
      cols.length > 0
        ? cols.map((col, i) => ({
            columnId: col.columnId,
            name: col.name,
            stage: detectStage(col.name),
            // `?? null`, because `next` is declared `string | null`: an
            // unnamed neighbour was leaving `undefined` there, which JSON
            // drops and the type does not permit.
            next: i < cols.length - 1 ? cols[i + 1].name ?? null : null,
          }))
        : undefined;

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
  const fieldsApi = ctx.api.customFields;
  const customFields: Record<string, ContextCustomField> = {};
  const boardIds = new Set(rawBoards.map(b => b.boardId));
  // NEITHER the fetch nor the transform is tolerated. The fetch used to be:
  // `[]` on a 403 wrote an empty `customFields` map, indistinguishable from an
  // org that has none, and every agent reading the file afterwards could not
  // set those fields and had no way to learn they existed (#154).
  //
  // The transform was the same defect one layer in (#100): the two shared a
  // `try` and `customFields[field.name] = entry` mutates the outer map inside
  // the loop, so a throw at field N left 1..N-1 in place, swallowed the error,
  // and fell through to `writeFile`.
  const allFields = await fieldsApi.listFields();
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

  // Fetch team members — /users is org-scoped, so we filter by the
  // collection's sharedToUsers to get only collection members.
  //
  // NOT tolerated either: `[]` wrote an empty `team` that read as "this
  // collection has no members" (#154). Note this is a different answer from the
  // membership read just below, which DOES fall back — and is right to, because
  // its fallback is recorded in `notes.team` and on stderr, so it is a reported
  // third state rather than a manufactured finding.
  console.log('Fetching team members...');
  const allUsers = await ctx.api.members.getMembers();

  // Get collection member IDs from raw API response (sharedToUsers).
  //
  // FAILS CLOSED. This is a privacy filter: `/users` is org-scoped, so
  // without it `team` is every person in the organisation, name and
  // email, written to a file this same command force-adds to .gitignore
  // precisely because it carries those. The old `catch {}` left
  // `collectionUserIds` undefined and the loop below then applied NO
  // filter, so a 403 on `/collections/:id` — a token without collection
  // read — turned "the six people on this collection" into "all 140 in
  // the org". An absent `sharedToUsers` took the same path, though it
  // means "unknown", not "shared with everyone".
  //
  // Unknown membership now yields NOBODY rather than everybody. It does
  // not refuse outright: one sub-fetch failing should not block a
  // bootstrap whose boards and custom fields are still correct. But an
  // empty `team` with no explanation is its own quiet lie, so the reason
  // goes to stderr AND into the file, where the agents that read it
  // will not mistake it for "this collection has no members".
  const membership = await client
    .get<any>(`/collections/${collectionId}`)
    .then((raw) =>
      Array.isArray(raw?.sharedToUsers)
        ? new Set<string>(raw.sharedToUsers.map((u: any) => u.userId))
        : undefined,
    )
    .catch(() => undefined);

  if (membership === undefined) {
    console.error(
      `⚠ Could not read the collection's membership — writing an EMPTY team rather than ` +
        `every user in the organisation. Re-run with a key that can read ` +
        `/collections/${collectionId} to populate it.`,
    );
  }

  const team: Record<string, ContextTeamMember> = {};
  for (const m of allUsers) {
    if (!membership?.has(m.id)) continue;
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
      // Present only when `getCollection` failed. Without it a fallback name is
      // indistinguishable from the collection's real one.
      ...(scopeNote ? { scope: scopeNote } : {}),
      // Present only when the filter could not run. An empty `team` with
      // no note would read as "this collection has no members".
      ...(membership === undefined
        ? {
            team:
              "The collection's membership could not be read, so `team` is EMPTY rather " +
              'than every user in the organisation. It is not a claim that the collection ' +
              'has no members. Re-run `favro init --refresh` with a key that can read the ' +
              'collection to populate it.',
          }
        : {}),
    },
  };

  // The one arm that is not `void`: nothing is written, so the context IS
  // the answer and the runner writes it (`--pretty` to indent).
  if (options.json) return { item: context };

  // Write file
  await fs.mkdir(contextDir, { recursive: true });
  await fs.writeFile(contextFile, JSON.stringify(context, null, 2) + '\n', 'utf-8');

  // Ensure .favro/ is in .gitignore (context may contain IDs/emails).
  //
  // The read is a value and the append is OUTSIDE its catch, because they
  // used to share a `try` whose `catch` meant "there is no .gitignore,
  // create one". A transient EACCES or a full disk on the APPEND landed
  // in that branch too, and `writeFile` replaced a 200-line .gitignore
  // with two lines under a success message (#144). An append that fails
  // now propagates to the error boundary, which is the only honest
  // outcome: the entry was not added and nothing was lost.
  //
  // Only ENOENT reads as "create one". Any other read failure — EACCES on
  // a file that does exist, EISDIR, EIO — is a file we cannot see, and
  // writing two lines over a file we cannot see is the same data loss
  // through a quieter door. It propagates.
  const gitignorePath = path.join(process.cwd(), '.gitignore');
  const gitignoreContent = await fs
    .readFile(gitignorePath, 'utf-8')
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
  if (gitignoreContent === null) {
    await fs.writeFile(gitignorePath, GITIGNORE_BLOCK);
    console.log('Created .gitignore with .favro/');
  } else if (!gitignoreContent.includes('.favro/')) {
    await fs.appendFile(gitignorePath, `\n${GITIGNORE_BLOCK}`);
    console.log('Added .favro/ to .gitignore');
  }

  console.log(`\n✓ Created .favro/context.json`);
  console.log(`  Collection: ${collectionName}`);
  console.log(`  Boards: ${Object.keys(boards).length}`);
  console.log(`  Custom fields: ${Object.keys(customFields).length}`);
  console.log(`  Team members: ${Object.keys(team).length}`);
  console.log(`\nLLMs can now read .favro/context.json for instant board context.`);
  console.log(`Run \`favro init --refresh\` to update after board changes.`);
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Bootstrap .favro/context.json in current repo from Favro API')
    .option('--collection <id>', 'Collection ID to scope (defaults to favro scope)')
    .option('--refresh', 'Update existing context.json')
    .option('--json', 'Print generated context to stdout instead of writing file')
    .action(run(initHandler));
}

export default registerInitCommand;
