/**
 * Git Commands
 *
 * favro git link --board <boardId>          — Connect repo to a Favro board
 * favro git branch <card>                 — Create branch from card
 * favro git commit [--card <card>] [-m]   — Smart commit with card reference
 * favro git sync                            — Sync branch state to cards
 * favro git todos [--board <boardId>]       — Scan TODOs and create cards
 *
 * ─── two things #119 decided here, because a rename would have decided them
 * ─── silently ───────────────────────────────────────────────────────────────
 *
 * **`--json` is DELETED from `sync` and `todos`.** It never selected a format on
 * either: it was an early return ABOVE the confirm and the write, so
 * `git sync --json` reported the branch analysis and synced nothing, and
 * `git todos --create --json` printed the scan and created nothing. Under
 * ADR-0002 JSON is the DEFAULT, so carrying the flag across as `format.json`
 * would have made the plain, unflagged `favro git sync` a command that reports
 * and never writes. Neither arm had a test that would have caught it — both
 * `git.test.ts` arms drive the flag explicitly.
 *
 * What replaces each payload, so nothing is only deleted:
 *  - `sync --json`'s `{branches, linkedBoard}` is now the `--dry-run` item, plus
 *    the moves it would make. `--dry-run` is the flag that already meant "report,
 *    write nothing", and unlike `--json` it takes the scope lock first (#155).
 *  - `todos --json`'s `{total, items}` is now the default output of the listing
 *    arm — `rows`/`truncated` through the runner's envelope, which is the shape
 *    `read-shape.ts` rule 1 asks of every list read.
 *
 * **Prose printed BEFORE the runner's output goes to stderr.** The branch
 * analysis, the TODO listing under `--create`, and the card/branch lines a
 * confirm prompt needs for context all print while the command is still working,
 * and stdout now carries the envelope — interleaving prose with it is what makes
 * an agent's parse fail. `process.stderr.write` was already this file's idiom for
 * its progress lines; it is now the idiom for all of it.
 */
import { Command } from 'commander';
import { boardOfCard, checkResolvedScope, confirmAction, dryRunLog, ScopeError } from '../lib/safety';
import { RefusalError } from '../lib/refusal';
import { Card } from '../lib/cards-api';
// The three card writes in this file go through the ONE dispatch table (#109),
// so they inherit the mandatory scope lock, the boardless-write refusal, the
// multi-write cap and a compensation log — none of which a raw
// `api.updateCard` / `api.createCard` here ever had.
import { dispatch, MULTI_WRITE_CAP, UpdateResult } from '../lib/dispatch';
import { parseLimit } from '../lib/read-shape';
import { Ctx, run } from '../lib/run';
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
  analyzeBranches,
  isGitRepo,
  FavroProjectConfig,
  BranchCardMapping,
} from '../lib/git-integration';
import {
  scanTodos,
  groupByFile,
  todoToCardTitle,
  formatTodoAsCardDescription,
  TodoItem,
} from '../lib/todo-scanner';

/**
 * The one wording for "this is not a git repository".
 *
 * A `RefusalError` rather than `console.error` + a hard exit: the runner owns
 * the stream and the code, so this reaches stdout as
 * `{"error":{"message","retryable":false}}` under the default and `✗ Error: …`
 * on stderr under `--human`. Written as `console.error(…); return;` it would
 * have been exit 0 with empty stdout.
 */
const requireGitRepo = (detail = ''): void => {
  if (!isGitRepo()) throw new RefusalError(`Not a git repository.${detail}`);
};

/** A line of context for the human at the terminal — never the answer. */
const note = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

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
    .action(run(async (
      ctx: Ctx,
      options: { board: string; prefix?: string; branchPattern?: string },
    ) => {
      requireGitRepo(' Run this from within a git repo.');

      // Verify the board exists
      note('Verifying board...');
      const board = await ctx.api.boards.getBoard(options.board);

      const config: FavroProjectConfig = {
        boardId: options.board,
        boardName: board.name,
        cardPrefix: options.prefix,
        branchPattern: options.branchPattern,
        branches: {},
      };

      const configPath = writeProjectConfig(config);

      return {
        item: { linked: true, boardId: options.board, boardName: board.name, configPath },
        human: () => [
          `✓ Linked to board: ${board.name} (${options.board})`,
          `  Config saved: ${configPath}`,
          '',
          '  Next steps:',
          '    favro git branch <card>     Create a branch from a card',
          '    favro git commit -m "msg"     Commit with auto card reference',
          '    favro git sync                Sync branch state to cards',
        ].join('\n'),
      };
    }));

  // ─── git branch <card> ───────────────────────────────────────────

  gitCmd
    .command('branch <card>')
    .description('Create a git branch from a Favro card')
    .option('--no-move', 'Do not move the card to In Progress')
    .option('-y, --yes', 'Skip confirmation')
    .option('--force', 'Bypass scope check')
    .action(run(async (
      ctx: Ctx,
      cardId: string,
      options: { move?: boolean; yes?: boolean; force?: boolean },
    ) => {
      requireGitRepo();

      const config = readProjectConfig();

      note('Fetching card...');
      // The card GET is here for the branch name; it also answers "which
      // board does the move write to?", so the lock costs no extra request.
      // Wrapped, because an unwrapped GET would skip the check entirely on a
      // stale id rather than handing it to the shared refusal.
      let card: Card | undefined;
      let cardError: unknown;
      try {
        card = await ctx.api.cards.getCard(cardId);
      } catch (err) {
        cardError = err;
      }

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
      if (options.move !== false && ctx.config.scopeCollectionId) {
        await dispatch('update', { card: cardId, status: 'In Progress' }, {
          client: ctx.client,
          config: ctx.config,
          force: options.force,
          dryRun: true,
        });
      }
      if (!card) throw cardError;

      const branchName = generateBranchName(cardId, card.name, config?.branchPattern);

      note(`Card: ${card.name}`);
      note(`Branch: ${branchName}`);

      if (!(await confirmAction(`Create branch "${branchName}"?`, { yes: options.yes }))) {
        return { item: { created: false, aborted: true, card: cardId }, human: () => 'Aborted.' };
      }

      createBranch(branchName);

      // Track the branch → card mapping
      if (config) {
        if (!config.branches) config.branches = {};
        config.branches[branchName] = cardId;
        writeProjectConfig(config);
      }

      // Move card to In Progress — through the table, so the write carries the
      // lock and a compensating write of its own.
      let moved: UpdateResult[] | undefined;
      let moveError: string | undefined;
      if (options.move !== false) {
        try {
          const result = await dispatch<UpdateResult[]>('update', { card: cardId, status: 'In Progress' }, {
            client: ctx.client,
            config: ctx.config,
            force: options.force,
          });
          if (result.outcome === 'ok') moved = result.value;
          else moveError = result.error;
        } catch (error) {
          // A SCOPE REFUSAL IS NOT A FAILED MOVE — the same rule #133 landed
          // for `git commit --comment` next door. This catch is best-effort for
          // the move (no such column, a 500, a dropped socket); swallowing the
          // lock's refusal would turn the write guardrail into a notice and
          // exit 0. Rethrown to the runner's boundary, which owns the exit code.
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
          moveError = 'the card could not be read';
        }
      }

      return {
        item: { created: true, branch: branchName, card: cardId, moved: moved !== undefined, moveError },
        human: () => {
          console.log(`✓ Created and checked out: ${branchName}`);
          if (moved !== undefined) console.log('✓ Card moved to "In Progress"');
          else if (moveError) console.log(`  (Could not move card — ${moveError})`);
        },
      };
    }));

  // ─── git commit ────────────────────────────────────────────────────

  gitCmd
    .command('commit')
    .description('Smart commit with auto card reference in message')
    .requiredOption('-m, --message <message>', 'Commit message')
    .option('--card <card>', 'Card ID to reference (auto-detected from branch if omitted)')
    .option('--comment', 'Add a comment to the Favro card with commit details')
    .option('--no-prefix', 'Do not add card ID prefix to commit message')
    .option('--force', 'Bypass scope check')
    .action(run(async (
      ctx: Ctx,
      options: { message: string; card?: string; comment?: boolean; prefix?: boolean; force?: boolean },
    ) => {
      requireGitRepo();

      if (!hasStagedChanges()) {
        throw new RefusalError('No staged changes. Run `git add` first.');
      }

      const config = readProjectConfig();
      const branch = getCurrentBranch();

      // Resolve card ID
      let cardId = options.card;
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

      // Optionally add comment to Favro card
      let commented = false;
      let commentError: string | undefined;
      if (options.comment && cardId) {
        try {
          // The comment is the only Favro write on this path, and a commentId
          // carries no board — so the board has to be resolved from the card,
          // one extra GET on the --comment path only, and only under a lock.
          // The shared resolver wraps it: a stale card
          // reference must reach the shared refusal as '', not kill the
          // command.
          await checkResolvedScope(ctx.client, () => boardOfCard(ctx.client, cardId!), options.force);

          await ctx.api.comments.addComment(cardId, `Commit \`${hash}\`: ${options.message}`);
          commented = true;
        } catch (error) {
          // A REFUSAL IS NOT A FAILED COMMENT (#133). This catch is best-effort
          // for the comment write — a 500, a deleted card, a dropped socket —
          // and until #133 the scope check could not reach it, because
          // `checkScope` called a hard exit from inside. Now it throws,
          // and an unfiltered catch turns the write guardrail into a notice:
          // measured on the built CLI, `git commit --comment` under a lock the
          // card was outside printed `(Could not add comment to card)` and
          // exited 0 where it had printed the violation and exited 1. Rethrown
          // to the runner's boundary, which is the only place that decides an
          // exit code.
          if (error instanceof RefusalError) throw error;
          commentError = 'Could not add comment to card';
        }
      }

      return {
        item: { committed: true, hash, message, card: cardId, commented },
        human: () => {
          console.log(`✓ Committed: ${hash} ${message}`);
          if (commented) console.log('✓ Comment added to card');
          else if (commentError) console.log(`  (${commentError})`);
        },
      };
    }));

  // ─── git sync ──────────────────────────────────────────────────────

  gitCmd
    .command('sync')
    .description('Sync git branch state to Favro cards')
    .option('--dry-run', 'Show what would change without doing it')
    .option('-y, --yes', 'Skip confirmation')
    .option('--force', 'Bypass scope check')
    .action(run(async (
      ctx: Ctx,
      options: { dryRun?: boolean; yes?: boolean; force?: boolean },
    ) => {
      requireGitRepo();

      const config = readProjectConfig();
      const mappings = analyzeBranches(config?.cardPrefix);
      const withCards = mappings.filter((m) => m.cardId);

      if (withCards.length === 0) {
        return {
          item: { branches: mappings, linkedBoard: config?.boardId, moved: [] },
          human: () => {
            console.log('No branches with card references found.');
            console.log('  Link branches by running: favro git branch <card>');
          },
        };
      }

      const merged = withCards.filter((m) => m.status === 'merged');
      const open = withCards.filter((m) => m.status === 'open');
      const current = withCards.filter((m) => m.status === 'current');

      // The analysis describes the LOCAL repository and has to print before the
      // confirm, so it goes to stderr — stdout carries the envelope below.
      note(`Branch analysis (${withCards.length} card-linked branches):\n`);
      const listGroup = (heading: string, group: BranchCardMapping[]): void => {
        if (!group.length) return;
        note(`  ${heading}:`);
        for (const m of group) note(`    ${m.branch} → card ${m.cardId}`);
      };
      listGroup('Merged (→ Done)', merged);
      listGroup('Open (→ In Progress)', open);
      listGroup('Current', current);

      // ONE entry per DISTINCT card, which is also what the old scope pass
      // counted: two branches naming the same card are one write, and letting
      // the duplicate through would spend two of the twenty the cap allows on
      // the same move. First mapping wins; `merged` and `open` are disjoint by
      // construction, so the only duplicates are two branches of one status.
      const targets = [
        ...merged.map((m) => ({ card: m.cardId!, status: 'Done' })),
        ...open.map((m) => ({ card: m.cardId!, status: 'In Progress' })),
      ];
      const cards = [...new Map(targets.map((t) => [t.card, t])).values()];
      /** Which branch pointed at each card, for the abort message below. */
      const branchOf = new Map(withCards.map((m) => [m.cardId!, m.branch]));

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
      // CONFIGURED LOCK, unchanged: touching `ctx.client` is what resolves a
      // credential (#135), so an ungated preview would demand one from a user who
      // has none and bill them N reads for a verdict there is no lock to produce.
      // Consequence, recorded rather than hidden: an UNLOCKED `--dry-run` still
      // makes no request, so it does not preview the cap refusal either — the
      // real run is where an over-cap sync refuses.
      if (options.dryRun) {
        if (cards.length > 0 && ctx.config.scopeCollectionId) {
          await dispatch('update', { cards }, {
            client: ctx.client,
            config: ctx.config,
            force: options.force,
            dryRun: true,
          });
        }
        // This item is the successor to `git sync --json`, which reported the
        // same analysis from ABOVE the write and took no lock at all.
        return {
          item: { dryRun: true, branches: mappings, linkedBoard: config?.boardId, wouldMove: cards },
          human: () => {
            // No `"` inside the target: `dryRunLog` wraps it in quotes of its own,
            // so the inner pair rendered `Would move cards "3 card(s) to "Done""`
            // — the nested-quote defect #162 item 10 fixed at three other sites.
            // The destination stays in the target here rather than being stripped
            // to a bare count: unlike `attachments`, it is derived from the branch
            // mapping, not an argument the caller typed back.
            if (merged.length) dryRunLog('move', 'cards', `${merged.length} card(s) to Done`);
            if (open.length) dryRunLog('move', 'cards', `${open.length} card(s) to In Progress`);
          },
        };
      }

      const total = cards.length;
      if (total === 0) {
        return {
          item: { branches: mappings, linkedBoard: config?.boardId, moved: [] },
          human: () => console.log('\nNo card status changes needed.'),
        };
      }

      if (!(await confirmAction(`Update ${total} card(s)?`, { yes: options.yes }))) {
        return { item: { aborted: true, branches: mappings, moved: [] }, human: () => 'Aborted.' };
      }

      const result = await dispatch<UpdateResult[]>('update', { cards }, {
        client: ctx.client,
        config: ctx.config,
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
        // APPENDS, and does not rewrap. The failures that reach here already
        // say something precise — a deleted card raises a structured
        // `CardResolutionError` naming the reference — and replacing that with
        // a message of our own would trade a good refusal for a guess. What
        // only THIS command knows is which branch pointed at that card, and
        // that nothing was written; that is all this adds.
        //
        // Two exemptions, both because the addition would be noise rather than
        // help: the scope lock's refusal is complete and `error-handler` reads
        // its TYPE to head the line `Scope violation:`, and the cap's refusal is
        // about the batch's size, so listing twenty-one branch mappings under it
        // buries the one sentence that matters.
        if (
          error instanceof ScopeError ||
          (error instanceof RefusalError && /capped at/.test(error.message))
        )
          throw error;
        const mapping = cards
          .map((c) => `${branchOf.get(c.card) ?? '(no branch)'} → ${c.card}`)
          .join('\n    ');
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n` +
            `  git sync refused the WHOLE pass over this, and NOTHING was written: the pass is ONE ` +
            `transaction, and syncing the rest would report a success count for a batch that was ` +
            `never whole.\n` +
            `  Branch → card:\n    ${mapping}\n` +
            `  A stale mapping lives in this repo's .favro.json, under "branches" — remove that entry, ` +
            `or delete the branch, then re-run.`,
        );
      });

      return {
        dispatch: result,
        human: (value: UpdateResult[]) => `\n✓ Updated ${value?.length ?? 0}/${total} cards.`,
      };
    }));

  // ─── git todos ─────────────────────────────────────────────────────

  gitCmd
    .command('todos')
    .description('Scan codebase for TODO/FIXME/HACK comments')
    .option('--board <board>', 'Board for creating cards, by name or boardId (defaults to linked board)')
    .option('--create', 'Create Favro cards from TODOs')
    .option('--dry-run', 'Preview what cards would be created')
    .option('-y, --yes', 'Skip confirmation')
    .option('--force', 'Bypass scope check')
    .option('--limit <n>', 'Max TODOs to show (default: 100)', '100')
    .action(run(async (
      ctx: Ctx,
      options: { board?: string; create?: boolean; dryRun?: boolean; yes?: boolean; force?: boolean; limit?: string },
    ) => {
      // Parsed BEFORE the scan, because the empty-TODO arm returns 0 without
      // ever reading `limit`: `--limit banana` refused on a repo with TODOs and
      // exited 0 saying "No TODO/FIXME/HACK comments found" on a repo without,
      // so whether a typo'd cap was caught depended on the codebase. A refusal
      // must not be conditional on the data it never got to cap. Found in
      // review of #142/#143.
      const limit = parseLimit(options.limit) ?? 100;

      const root = findProjectRoot();
      note('Scanning codebase for TODOs...');
      const todos = scanTodos({ root });

      const writing = Boolean(options.create || options.dryRun);

      if (todos.length === 0) {
        return {
          rows: todos as TodoItem[],
          limit,
          human: () => console.log('No TODO/FIXME/HACK comments found.'),
        };
      }

      // `--limit` caps what is PRINTED (the runner's `capRows` does that) and,
      // separately, what `--create` WRITES. The two used to be the same slice
      // because the listing was printed here; the write still needs its own.
      const limited = todos.slice(0, limit);

      const listing = (items: TodoItem[], emit: (line: string) => void): void => {
        const groups = groupByFile(items);
        emit(`Found ${todos.length} TODO items in ${groups.length} files:\n`);
        for (const group of groups) {
          emit(`  ${group.file}:`);
          for (const item of group.items) {
            emit(`    L${item.line} [${item.type}] ${item.text}`);
          }
        }
      };

      if (!writing) {
        // The listing IS the answer here, so it goes through the envelope —
        // which is what `git todos --json` used to hand-roll as
        // `{total, items}`, from above the write rather than instead of it.
        return {
          rows: todos,
          limit,
          human: (items: TodoItem[]) => listing(items, (line) => console.log(line)),
        };
      }

      // Under `--create`/`--dry-run` the listing is context for the confirm, not
      // the answer — stderr, so the dispatch envelope below is alone on stdout.
      listing(limited, note);

      const config = readProjectConfig();
      const boardId = options.board ?? config?.boardId;

      if (!boardId) {
        throw new RefusalError(
          'No board specified. Use --board <board> — a name or a boardId — or run `favro git link` first.',
        );
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
      if (ctx.config.scopeCollectionId) {
        await checkResolvedScope(
          ctx.client,
          () => ctx.api.boards.resolveBoardId(boardId),
          options.force,
        );
      }

      // The plan for the write, which #155 hoisted BELOW the guard above.
      const plan = [
        `\nWould create ${limited.length} cards on board ${boardId}:`,
        ...limited.map((item) => `  + ${todoToCardTitle(item)}`),
      ];

      if (options.dryRun) {
        // Here the plan IS the answer, so it goes to stdout through the
        // formatter and to the machine through `wouldCreate`.
        return {
          item: { dryRun: true, board: boardId, wouldCreate: limited.map(todoToCardTitle) },
          human: () => [...plan, '', '[dry-run] No cards created.'].join('\n'),
        };
      }

      // On the real run it is context for the confirm below, not the answer.
      plan.forEach(note);

      if (!(await confirmAction(`Create ${limited.length} cards from TODOs?`, { yes: options.yes }))) {
        return { item: { created: 0, aborted: true }, human: () => 'Aborted.' };
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
        client: ctx.client,
        config: ctx.config,
        force: options.force,
      }).catch((error) => {
        // Matched on the cap's own sentence rather than on a re-derived
        // length test: `boundEntries` owns when the cap fires, and a second
        // predicate here is a second place for that to drift.
        if (error instanceof RefusalError && /capped at/.test(error.message)) {
          throw new RefusalError(
            `${error.message}\n` +
              `This list is a codebase SCAN, so there is nothing to split: re-run with ` +
              `--limit ${MULTI_WRITE_CAP} to take the first ${MULTI_WRITE_CAP} TODOs, ` +
              `or narrow the scan.`,
          );
        }
        throw error;
      });

      return {
        dispatch: result,
        human: (value: Card[]) => `\n✓ Created ${value?.length ?? 0}/${limited.length} cards.`,
      };
    }));
}
