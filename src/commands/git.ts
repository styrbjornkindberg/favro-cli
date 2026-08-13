/**
 * Git Commands
 *
 * favro git link --board <boardId>          — Connect repo to a Favro board
 * favro git branch <card>                 — Create branch from card
 * favro git commit [--card <card>] [-m]   — Smart commit with card reference
 * favro git sync                            — Sync branch state to cards
 * favro git todos [--board <boardId>]       — Scan TODOs and create cards
 */
import { Command } from 'commander';
import { logError } from '../lib/error-handler';
import { createFavroClient } from '../lib/client-factory';
import { boardOfCard, checkResolvedScope, confirmAction, dryRunLog, ScopeError } from '../lib/safety';
import { RefusalError } from '../lib/refusal';
import { readConfig } from '../lib/config';
import CardsAPI, { Card } from '../lib/cards-api';
import BoardsAPI from '../lib/boards-api';
// The three card writes in this file go through the ONE dispatch table (#109),
// so they inherit the mandatory scope lock, the boardless-write refusal, the
// multi-write cap and a compensation log — none of which a raw
// `api.updateCard` / `api.createCard` here ever had.
import { dispatch, MULTI_WRITE_CAP, UpdateResult } from '../lib/dispatch';
import { reportDispatch } from '../lib/report-dispatch';
import { CommentsApiClient } from '../api/comments';
import { parseLimit } from '../lib/read-shape';
import {
  readProjectConfig,
  writeProjectConfig,
  findProjectRoot,
  getCurrentBranch,
  extractCardIdFromBranch,
  generateBranchName,
  createBranch,
  hasStagedChanges,
  commitWithMessage,
  getLastCommitHash,
  analyzeBranches,
  isGitRepo,
  FavroProjectConfig,
} from '../lib/git-integration';
import {
  scanTodos,
  groupByFile,
  todoToCardTitle,
  formatTodoAsCardDescription,
} from '../lib/todo-scanner';

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerGitCommands(program: Command): void {
  const gitCmd = program.command('git').description('Git ↔ Favro card integration');

  // ─── git link ───────────────────────────────────────────────────────

  gitCmd
    .command('link')
    .description('Connect this repository to a Favro board')
    .requiredOption('--board <boardId>', 'Board ID to link')
    .option('--prefix <prefix>', 'Card ID prefix pattern (e.g. "CARD" for CARD-123)')
    .option('--branch-pattern <pattern>', 'Branch naming pattern (default: feature/{{cardId}}-{{slug}})')
    .action(async (options) => {
      try {
        if (!isGitRepo()) {
          console.error('Not a git repository. Run this from within a git repo.');
          process.exit(1);
        }

        const client = await createFavroClient();
        const boardsApi = new BoardsAPI(client);

        // Verify the board exists
        process.stderr.write('Verifying board...\n');
        const board = await boardsApi.getBoard(options.board);

        const config: FavroProjectConfig = {
          boardId: options.board,
          boardName: board.name,
          cardPrefix: options.prefix,
          branchPattern: options.branchPattern,
          branches: {},
        };

        const configPath = writeProjectConfig(config);
        console.log(`✓ Linked to board: ${board.name} (${options.board})`);
        console.log(`  Config saved: ${configPath}`);
        console.log('\n  Next steps:');
        console.log('    favro git branch <card>     Create a branch from a card');
        console.log('    favro git commit -m "msg"     Commit with auto card reference');
        console.log('    favro git sync                Sync branch state to cards');
      } catch (error) {
        logError(error);
        process.exit(1);
      }
    });

  // ─── git branch <card> ───────────────────────────────────────────

  gitCmd
    .command('branch <card>')
    .description('Create a git branch from a Favro card')
    .option('--no-move', 'Do not move the card to In Progress')
    .option('-y, --yes', 'Skip confirmation')
    .option('--force', 'Bypass scope check')
    .action(async (cardId: string, options) => {
      try {
        if (!isGitRepo()) {
          console.error('Not a git repository.');
          process.exit(1);
        }

        const config = readProjectConfig();
        const client = await createFavroClient();
        const cardsApi = new CardsAPI(client);

        process.stderr.write('Fetching card...\n');
        // The card GET is here for the branch name; it also answers "which
        // board does the move write to?", so the lock costs no extra request.
        // Wrapped, because an unwrapped GET would skip the check entirely on a
        // stale id rather than handing it to the shared refusal.
        let card: Awaited<ReturnType<CardsAPI['getCard']>> | undefined;
        let cardError: unknown;
        try {
          card = await cardsApi.getCard(cardId);
        } catch (err) {
          cardError = err;
        }

        const favroConfig = (await readConfig()) ?? {};

        // Only the move writes to Favro — `--no-move` creates a local branch and
        // nothing else, so it has no board for the lock to hold.
        //
        // The lock now lives INSIDE the `update` intent (#109), and this is the
        // same intent invoked with `dryRun` so the check happens BEFORE the
        // confirm and before the branch exists — the ordering the hand-rolled
        // `checkScope` here bought, kept, without a second spelling of the check
        // beside the one that governs the write. A dry dispatch resolves the
        // board and runs `assertScope`, and returns before writing anything; its
        // preview is deliberately discarded, because the branch prompt below is
        // this command's preview.
        //
        // GATED ON A CONFIGURED LOCK, like every sibling hoist in this file: the
        // dry dispatch reads the card, and an ungated one would bill an unlocked
        // user a request for a verdict there is no lock to produce (#102/#104).
        //
        // What changes when the card cannot be read: this used to hand `''` to
        // `checkScope` and refuse with "this write names no board". The intent's
        // `board()` makes the read itself, so an unreadable card now refuses with
        // the wire's own error. Both refuse; the second names the real problem.
        if (options.move !== false && favroConfig.scopeCollectionId) {
          await dispatch('update', { card: cardId, status: 'In Progress' }, {
            client,
            config: favroConfig,
            force: options.force,
            dryRun: true,
          });
        }
        if (!card) throw cardError;

        const branchName = generateBranchName(cardId, card.name, config?.branchPattern);

        console.log(`Card: ${card.name}`);
        console.log(`Branch: ${branchName}`);

        if (!(await confirmAction(`Create branch "${branchName}"?`, { yes: options.yes }))) {
          console.log('Aborted.');
          return;
        }

        createBranch(branchName);
        console.log(`✓ Created and checked out: ${branchName}`);

        // Track the branch → card mapping
        if (config) {
          if (!config.branches) config.branches = {};
          config.branches[branchName] = cardId;
          writeProjectConfig(config);
        }

        // Move card to In Progress — through the table, so the write carries the
        // lock and a compensating write of its own.
        if (options.move !== false) {
          try {
            const moved = await dispatch<UpdateResult>('update', { card: cardId, status: 'In Progress' }, {
              client,
              config: favroConfig,
              force: options.force,
            });
            if (moved.outcome === 'ok') console.log('✓ Card moved to "In Progress"');
            else console.log(`  (Could not move card — ${moved.error})`);
          } catch (error) {
            // A SCOPE REFUSAL IS NOT A FAILED MOVE — the same rule #133 landed
            // for `git commit --comment` next door. This catch is best-effort for
            // the move (no such column, a 500, a dropped socket); swallowing the
            // lock's refusal would turn the write guardrail into a notice and
            // exit 0. Rethrown to the outer boundary, which owns the exit code.
            //
            // Narrower than that catch on purpose, and NOT for the reason first
            // written here. `ColumnResolutionError` is a `RefusalError` and used
            // to be the case this arm protected — but it is raised inside
            // `intent.run`, so it comes back as a non-`ok` OUTCOME on the line
            // above and never reaches this catch at all. What still reaches it is
            // a throw from `board()`, which runs outside the table's try: an
            // unreadable card, or the lock. Only the lock is a guardrail, so only
            // the lock is rethrown.
            if (error instanceof ScopeError) throw error;
            console.log('  (Could not move card — the card could not be read)');
          }
        }
      } catch (error) {
        logError(error);
        process.exit(1);
      }
    });

  // ─── git commit ────────────────────────────────────────────────────

  gitCmd
    .command('commit')
    .description('Smart commit with auto card reference in message')
    .requiredOption('-m, --message <message>', 'Commit message')
    .option('--card <card>', 'Card ID to reference (auto-detected from branch if omitted)')
    .option('--comment', 'Add a comment to the Favro card with commit details')
    .option('--no-prefix', 'Do not add card ID prefix to commit message')
    .option('--force', 'Bypass scope check')
    .action(async (options) => {
      try {
        if (!isGitRepo()) {
          console.error('Not a git repository.');
          process.exit(1);
        }

        if (!hasStagedChanges()) {
          console.error('No staged changes. Run `git add` first.');
          process.exit(1);
        }

        const config = readProjectConfig();
        const branch = getCurrentBranch();

        // Resolve card ID
        let cardId = options.card as string | undefined;
        if (!cardId) {
          // Check config mapping first
          cardId = config?.branches?.[branch];
          // Then try to extract from branch name
          if (!cardId) {
            cardId = extractCardIdFromBranch(branch, config?.cardPrefix) ?? undefined;
          }
        }

        // Build commit message
        let message = options.message;
        if (cardId && options.prefix !== false) {
          const prefix = config?.cardPrefix
            ? `[${config.cardPrefix}-${cardId}]`
            : `[${cardId}]`;
          message = `${prefix} ${message}`;
        }

        const hash = commitWithMessage(message);
        console.log(`✓ Committed: ${hash} ${message}`);

        // Optionally add comment to Favro card
        if (options.comment && cardId) {
          try {
            const client = await createFavroClient();

            // The comment is the only Favro write on this path, and a commentId
            // carries no board — so the board has to be resolved from the card,
            // one extra GET on the --comment path only, and only under a lock.
            // The shared resolver wraps it: a stale card
            // reference must reach the shared refusal as '', not kill the
            // command.
            await checkResolvedScope(client, () => boardOfCard(client, cardId), options.force);

            const commentsApi = new CommentsApiClient(client);
            await commentsApi.addComment(cardId, `Commit \`${hash}\`: ${options.message}`);
            console.log('✓ Comment added to card');
          } catch (error) {
            // A REFUSAL IS NOT A FAILED COMMENT (#133). This catch is best-effort
            // for the comment write — a 500, a deleted card, a dropped socket —
            // and until #133 the scope check could not reach it, because
            // `checkScope` called `process.exit(1)` from inside. Now it throws,
            // and an unfiltered catch turns the write guardrail into a notice:
            // measured on the built CLI, `git commit --comment` under a lock the
            // card was outside printed `(Could not add comment to card)` and
            // exited 0 where it had printed the violation and exited 1. Rethrown
            // to the outer boundary, which is the only place that decides an
            // exit code.
            if (error instanceof RefusalError) throw error;
            console.log('  (Could not add comment to card)');
          }
        }
      } catch (error) {
        logError(error);
        process.exit(1);
      }
    });

  // ─── git sync ──────────────────────────────────────────────────────

  gitCmd
    .command('sync')
    .description('Sync git branch state to Favro cards')
    .option('--dry-run', 'Show what would change without doing it')
    .option('-y, --yes', 'Skip confirmation')
    .option('--force', 'Bypass scope check')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        if (!isGitRepo()) {
          console.error('Not a git repository.');
          process.exit(1);
        }

        const config = readProjectConfig();
        const mappings = analyzeBranches(config?.cardPrefix);
        const withCards = mappings.filter(m => m.cardId);

        if (options.json) {
          console.log(JSON.stringify({ branches: mappings, linkedBoard: config?.boardId }, null, 2));
          return;
        }

        if (withCards.length === 0) {
          console.log('No branches with card references found.');
          console.log('  Link branches by running: favro git branch <card>');
          return;
        }

        console.log(`Branch analysis (${withCards.length} card-linked branches):\n`);

        const merged = withCards.filter(m => m.status === 'merged');
        const open = withCards.filter(m => m.status === 'open');
        const current = withCards.filter(m => m.status === 'current');

        if (merged.length) {
          console.log(`  Merged (→ Done):`);
          for (const m of merged) console.log(`    ${m.branch} → card ${m.cardId}`);
        }
        if (open.length) {
          console.log(`  Open (→ In Progress):`);
          for (const m of open) console.log(`    ${m.branch} → card ${m.cardId}`);
        }
        if (current.length) {
          console.log(`  Current:`);
          for (const m of current) console.log(`    ${m.branch} → card ${m.cardId}`);
        }

        // ONE entry per DISTINCT card, which is also what the old scope pass
        // counted: two branches naming the same card are one write, and letting
        // the duplicate through would spend two of the twenty the cap allows on
        // the same move. First mapping wins; `merged` and `open` are disjoint by
        // construction, so the only duplicates are two branches of one status.
        const targets = [
          ...merged.map(m => ({ card: m.cardId!, status: 'Done' })),
          ...open.map(m => ({ card: m.cardId!, status: 'In Progress' })),
        ];
        const cards = [...new Map(targets.map(t => [t.card, t])).values()];
        /** Which branch pointed at each card, for the abort message below. */
        const branchOf = new Map(withCards.map(m => [m.cardId!, m.branch]));

        // ONE `update` invocation over the enumerated list, so the whole pass is
        // one transaction (#109). What that replaces, and why each half mattered:
        //
        //  - a hand-rolled per-card scope pass beside the writes. The lock is now
        //    inside the intent, over every DISTINCT board of the batch, and it
        //    still refuses as a WHOLE before anything is written.
        //  - a write loop with no bound. Twenty is the cap, and over it the intent
        //    refuses rather than moving the first twenty — `boundEntries` runs
        //    before the intent's first request, so an over-cap sync costs nothing.
        //  - a write loop with no inverse. A failure on card 4 of 6 now moves 1–3
        //    back, LIFO, and the run reports `rolled-back`.
        //  - `updated++` counted PUTs that answered 200. `moveColumn` re-reads the
        //    card and throws if it did not land there, so the count below counts
        //    observations.
        //
        // The preview goes through the same intent with `dryRun`, so it can no
        // longer promise a sweep the real run refuses (#155). It stays GATED ON A
        // CONFIGURED LOCK, unchanged: `createFavroClient()` is eager, so an
        // ungated preview would demand a credential from a user who has none and
        // bill them N reads for a verdict there is no lock to produce.
        // Consequence, recorded rather than hidden: an UNLOCKED `--dry-run` still
        // makes no request, so it does not preview the cap refusal either — the
        // real run is where an over-cap sync refuses.
        const globalConfig = (await readConfig()) ?? {};

        if (options.dryRun) {
          if (cards.length > 0 && globalConfig.scopeCollectionId) {
            await dispatch('update', { cards }, {
              client: await createFavroClient(),
              config: globalConfig,
              force: options.force,
              dryRun: true,
            });
          }
          if (merged.length) dryRunLog('move', 'cards', `${merged.length} card(s) to "Done"`);
          if (open.length) dryRunLog('move', 'cards', `${open.length} card(s) to "In Progress"`);
          return;
        }

        const total = cards.length;
        if (total === 0) {
          console.log('\nNo card status changes needed.');
          return;
        }

        if (!(await confirmAction(`Update ${total} card(s)?`, { yes: options.yes }))) {
          console.log('Aborted.');
          return;
        }

        const result = await dispatch<UpdateResult[]>('update', { cards }, {
          client: await createFavroClient(),
          config: globalConfig,
          force: options.force,
        }).catch((error) => {
          // `board()` runs OUTSIDE the table's try, so a stale branch mapping
          // onto a deleted card escapes as the wire's own error — bare
          // `404 Not Found`, naming neither the card nor the branch that pointed
          // at it. Aborting is right: the pass is one transaction, and a card
          // that cannot be read cannot be scope-checked. A refusal that does not
          // name the fix is only half a refusal, so this adds the mapping and the
          // repair, and nothing else.
          //
          // Narrow on purpose. Every REFUSAL — the scope lock, the cap, the
          // boardless-write rule — already names its own fix, so rewrapping one
          // would replace a precise message with a guess about card reads. What
          // is left is a throw out of `board()`, which is the read.
          if (error instanceof RefusalError) throw error;
          const mapping = cards
            .map((c) => `${branchOf.get(c.card) ?? '(no branch)'} → ${c.card}`)
            .join('\n    ');
          throw new Error(
            `git sync could not read one of the ${cards.length} cards its branches point at, so the ` +
              `whole pass was refused and NOTHING was written.\n` +
              `  The pass is ONE transaction: a card that cannot be read cannot be checked against the ` +
              `scope lock, and syncing the rest would report a success count for a batch that was never whole.\n` +
              `  Branch → card:\n    ${mapping}\n` +
              `  Underlying error: ${error instanceof Error ? error.message : String(error)}\n` +
              `  A stale mapping lives in this repo's .favro.json, under "branches" — remove the entry (or ` +
              `the branch) and re-run, or run 'favro git branch <card>' to re-point it.`,
          );
        });
        if (reportDispatch(result)) process.exit(1);

        console.log(`\n✓ Updated ${result.value?.length ?? 0}/${total} cards.`);
      } catch (error) {
        logError(error);
        process.exit(1);
      }
    });

  // ─── git todos ─────────────────────────────────────────────────────

  gitCmd
    .command('todos')
    .description('Scan codebase for TODO/FIXME/HACK comments')
    .option('--board <board>', 'Board for creating cards, by name or boardId (defaults to linked board)')
    .option('--create', 'Create Favro cards from TODOs')
    .option('--dry-run', 'Preview what cards would be created')
    .option('-y, --yes', 'Skip confirmation')
    .option('--force', 'Bypass scope check')
    .option('--json', 'Output as JSON')
    .option('--limit <n>', 'Max TODOs to show (default: 100)', '100')
    .action(async (options) => {
      try {
        // Parsed BEFORE the scan, because the empty-TODO arm returns 0 without
        // ever reading `limit`: `--limit banana` refused on a repo with TODOs and
        // exited 0 saying "No TODO/FIXME/HACK comments found" on a repo without,
        // so whether a typo'd cap was caught depended on the codebase. A refusal
        // must not be conditional on the data it never got to cap. Found in
        // review of #142/#143.
        const limit = parseLimit(options.limit) ?? 100;

        const root = findProjectRoot();
        process.stderr.write('Scanning codebase for TODOs...\n');
        const todos = scanTodos({ root });

        if (todos.length === 0) {
          console.log('No TODO/FIXME/HACK comments found.');
          return;
        }

        const limited = todos.slice(0, limit);

        if (options.json) {
          console.log(JSON.stringify({ total: todos.length, items: limited }, null, 2));
          return;
        }

        const groups = groupByFile(limited);
        console.log(`Found ${todos.length} TODO items in ${groups.length} files:\n`);

        for (const group of groups) {
          console.log(`  ${group.file}:`);
          for (const item of group.items) {
            console.log(`    L${item.line} [${item.type}] ${item.text}`);
          }
        }

        if (todos.length > limit) {
          console.log(`\n  ... and ${todos.length - limit} more (use --limit to show more)`);
        }

        // Create cards from TODOs
        if (options.create || options.dryRun) {
          const config = readProjectConfig();
          const boardId = options.board ?? config?.boardId;

          if (!boardId) {
            console.error('\nNo board specified. Use --board <board> — a name or a boardId — or run `favro git link` first.');
            process.exit(1);
          }

          // The board comes from --board or the repo's link config, neither of
          // which is bound by the scope lock. Check BEFORE the confirm, like
          // every other caller: no point asking "create 100 cards?" and only
          // then admitting the board is locked out.
          //
          // And before the PREVIEW too (#155). This sat below the `--dry-run`
          // return, so `git todos --board <outside-the-lock> --dry-run` printed
          // `Would create N cards on board <outside-the-lock>` and every card
          // title at exit 0, with zero requests — the worst of the five, because
          // it names a board the lock forbids and plans a write there in volume.
          //
          // Either source is a NAME or a boardId, and the lock GETs
          // `/widgets/<id>` — handed a name it 404s into "Board … not found",
          // a refusal naming the wrong problem (#82).
          //
          // GATED ON A CONFIGURED LOCK. `checkResolvedScope` already declines to
          // resolve when nothing is locked, but its `client` parameter is EAGER —
          // its own docstring says so — so the gate is what keeps the credential
          // out of an unlocked preview. That makes this a second copy of the
          // guard's "is a lock configured" test, the same duplication #152 was
          // reviewed for; the arm that keys on `scopeCollectionName` instead is
          // pinned in `dry-run-scope-order-wire.test.ts`.
          const favroConfig = (await readConfig()) ?? {};
          if (favroConfig.scopeCollectionId) {
            const client = await createFavroClient();
            await checkResolvedScope(client, () => new BoardsAPI(client).resolveBoardId(boardId), options.force);
          }

          console.log(`\nWould create ${limited.length} cards on board ${boardId}:`);
          for (const item of limited) {
            console.log(`  + ${todoToCardTitle(item)}`);
          }

          if (options.dryRun) {
            console.log('\n[dry-run] No cards created.');
            return;
          }

          const client = await createFavroClient();

          if (!(await confirmAction(`Create ${limited.length} cards from TODOs?`, { yes: options.yes }))) {
            console.log('Aborted.');
            return;
          }

          // ONE `create` invocation over the enumerated TODO list (#109), which
          // is what the file already is: every card the scan will make is named
          // before the first write. So the batch is one transaction — a failure
          // on card 7 of 12 deletes 1–6 and reports `rolled-back`, where the old
          // loop left them and printed "Created 6/12".
          //
          // It also inherits the cap, and THAT IS A CLIFF ON THIS COMMAND: the
          // listing's `--limit` defaults to 100, so any repo with more than
          // `MULTI_WRITE_CAP` TODOs refuses `--create` by default. Refusing is
          // right — creating twenty and dropping the rest would report success
          // for cards that were never made — but the table's refusal ends
          // "split an enumerated list, or act on a derived one entry at a time",
          // and neither is available here: the list is a SCAN. `--limit` is the
          // only remedy, the table cannot know that, so the sentence is added
          // here rather than restating the cap's reason in a second place.
          const cards = limited.map((item) => ({
            name: todoToCardTitle(item),
            description: formatTodoAsCardDescription(item),
            board: boardId,
          }));
          const result = await dispatch<Card[]>('create', { cards }, {
            client,
            config: favroConfig,
            force: options.force,
          }).catch((error) => {
            if (error instanceof RefusalError && cards.length > MULTI_WRITE_CAP) {
              throw new RefusalError(
                `${error.message}\n` +
                  `This list is a codebase SCAN, so there is nothing to split: re-run with ` +
                  `--limit ${MULTI_WRITE_CAP} to take the first ${MULTI_WRITE_CAP} TODOs, ` +
                  `or narrow the scan.`,
              );
            }
            throw error;
          });
          if (reportDispatch(result)) process.exit(1);

          console.log(`\n✓ Created ${result.value?.length ?? 0}/${limited.length} cards.`);
        }
      } catch (error) {
        logError(error);
        process.exit(1);
      }
    });
}
