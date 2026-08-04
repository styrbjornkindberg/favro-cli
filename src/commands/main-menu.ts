/**
 * Main Menu — Persistent interactive app shown when `favro` is run with no arguments.
 *
 * Navigation: Collections → Boards → Board view (kanban) → Card detail
 * Always traverse back up the hierarchy. Only Exit or Ctrl+C leaves.
 *
 * ON THE `void` ARM (ADR-0002, #118). Every frame is this command's own, so it
 * returns nothing and the runner writes nothing over it — but it is NOT
 * anonymous: four of the six menu items read Favro, so the runner builds the
 * client and a machine with no key is told so up front instead of being handed
 * a menu where two-thirds of the entries fail one at a time.
 */
import type { Command } from 'commander';
import { c } from '../lib/theme';
import { ContextCard } from '../api/context';
import { renderBoard, renderStatusBar, snapshotToColumns } from '../lib/board-renderer';
import { resolveUserId } from '../lib/config';
import { isOverdue } from '../lib/card-predicates';
import { isPromptCancelled } from '../lib/prompt-cancelled';
import { Ctx, run } from '../lib/run';
import { isDoneStage } from '../lib/workflow-stage';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Select, AutoComplete } = require('enquirer');

// ─── Logo ────────────────────────────────────────────────────────────────────

const LOGO = `
  ${c.brand('███████╗ █████╗ ██╗   ██╗██████╗  ██████╗')}
  ${c.brand('██╔════╝██╔══██╗██║   ██║██╔══██╗██╔═══██╗')}
  ${c.brand('█████╗  ███████║██║   ██║██████╔╝██║   ██║')}
  ${c.brand('██╔══╝  ██╔══██║╚██╗ ██╔╝██╔══██╗██║   ██║')}
  ${c.brand('██║     ██║  ██║ ╚████╔╝ ██║  ██║╚██████╔╝')}
  ${c.brand('╚═╝     ╚═╝  ╚═╝  ╚═══╝  ╚═╝  ╚═╝ ╚═════╝')}
`;

// ─── Prompt helpers ──────────────────────────────────────────────────────────

const BACK = '‹ back';
const PAGE_SIZE = 20;

async function pick(message: string, items: Array<{ name: string; message: string }>): Promise<string> {
  const prompt = new Select({
    name: 'value',
    message,
    choices: items,
    limit: PAGE_SIZE,
    pointer: c.brand('▸'),
    result(name: string) { return name; },
  });
  return prompt.run();
}

async function pickFilter(message: string, items: Array<{ name: string; message: string }>): Promise<string> {
  const prompt = new AutoComplete({
    name: 'value',
    message: `${message} ${c.muted('(type to filter)')}`,
    choices: items,
    limit: PAGE_SIZE,
    pointer: c.brand('▸'),
    result(name: string) { return name; },
  });
  return prompt.run();
}

function pause(): Promise<void> {
  return new Promise(resolve => {
    process.stdout.write(`\n  ${c.muted('Press enter to continue…')}`);
    const onData = () => { process.stdin.removeListener('data', onData); resolve(); };
    process.stdin.once('data', onData);
    if (!process.stdin.isRaw) process.stdin.resume();
  });
}

// ─── Actions ─────────────────────────────────────────────────────────────────
//
// `ctx.api` replaces the four module-level API singletons this file used to
// memoise for itself: the runner's namespace is already lazy and already
// memoised, and a module-level cache outlives the run that filled it.

async function showAuthCheck(): Promise<void> {
  console.log(`\n  ${c.muted('Checking API credentials…')}`);
  try {
    const { resolveAuth } = await import('../lib/config');
    const auth = await resolveAuth({});
    const { validateApiKey } = await import('../commands/auth');
    const valid = await validateApiKey(auth.token!, auth.email!);
    if (valid) {
      console.log(`  ${c.ok} ${c.success('API key is valid')}`);
    } else {
      console.log(`  ${c.fail} ${c.error('API key is invalid')}`);
    }
  } catch (err: any) {
    console.log(`  ${c.fail} ${c.error(err.message ?? 'Auth failed')}`);
  }
  await pause();
}

async function showCollections(ctx: Ctx): Promise<void> {
  const collections = ctx.api.collections;

  while (true) {
    console.log(`\n  ${c.heading('Collections')}`);
    console.log(`  ${c.muted('Loading…')}`);
    const list = await collections.listCollections(100);

    if (list.length === 0) {
      console.log(`  ${c.muted('No collections found.')}`);
      await pause();
      return;
    }

    const items = list.map((col, i) => {
      const extra = col.boardCount != null ? c.muted(` (${col.boardCount} boards)`) : '';
      return { name: String(i), message: `${c.info(col.name)}${extra}` };
    });
    items.push({ name: 'back', message: c.muted(BACK) });

    const answer = await pickFilter(c.label('Collection'), items);
    if (answer === 'back') return;

    const col = list[parseInt(answer, 10)];
    if (col) await showBoardsInCollection(ctx, col.collectionId, col.name);
  }
}

async function showBoardsInCollection(ctx: Ctx, collectionId: string, collectionName: string): Promise<void> {
  const boards = ctx.api.boards;

  while (true) {
    console.log(`\n  ${c.heading(collectionName)}`);
    console.log(`  ${c.muted('Loading boards…')}`);
    const list = await boards.listBoardsByCollection(collectionId);

    if (list.length === 0) {
      console.log(`  ${c.muted('No boards in this collection.')}`);
      await pause();
      return;
    }

    const items = list.map((b, i) => {
      const parts: string[] = [];
      if (b.cardCount != null) parts.push(`${b.cardCount} cards`);
      if (b.columns != null) parts.push(`${b.columns} columns`);
      const extra = parts.length ? c.muted(` (${parts.join(', ')})`) : '';
      return { name: String(i), message: `${c.info(b.name)}${extra}` };
    });
    items.push({ name: 'back', message: c.muted(BACK) });

    const answer = await pickFilter(c.label('Board'), items);
    if (answer === 'back') return;

    const board = list[parseInt(answer, 10)];
    if (board) await showBoardView(ctx, board.boardId);
  }
}

async function showBoardView(ctx: Ctx, boardId: string): Promise<void> {
  const context = ctx.api.context;

  while (true) {
    console.log(`\n  ${c.muted('Loading board…')}`);
    let snapshot;
    try {
      snapshot = await context.getSnapshot(boardId);
    } catch (err: any) {
      console.log(`  ${c.error(err.message ?? 'Failed to load board')}`);
      await pause();
      return;
    }

    const columns = snapshotToColumns(snapshot);
    // The local copy of `snapshotToColumns` also returned the cards it had just
    // been handed, in the order it was handed them (#89). That is the snapshot.
    const allCards = snapshot.cards;

    // Render kanban
    console.log(renderBoard(columns, { title: snapshot.board.name, compact: true }));
    console.log(`  ${renderStatusBar(snapshot.stats.by_status, snapshot.stats.total)}`);
    console.log(`  ${c.muted(`${snapshot.stats.total} cards · ${snapshot.columns.length} columns`)}`);
    console.log('');

    if (allCards.length === 0) {
      console.log(`  ${c.muted('No cards on this board.')}`);
      await pause();
      return;
    }

    // Card picker — grouped by column
    const cardChoices: Array<{ name: string; message: string }> = [];
    let cardIndex = 0;
    const cardLookup: ContextCard[] = [];

    for (const col of columns) {
      if (col.cards.length === 0) continue;
      // Column separator
      cardChoices.push({ name: `sep_${col.name}`, message: c.muted(`── ${col.name} (${col.cards.length}) ──`) });
      for (const rc of col.cards) {
        const ctxCard = allCards.find(ac => ac.id === rc.id);
        if (ctxCard) {
          const assignee = ctxCard.owner ? c.assignee(` @${ctxCard.owner}`) : '';
          const tags = ctxCard.tags?.length ? c.muted(` ${ctxCard.tags.join(', ')}`) : '';
          cardChoices.push({ name: String(cardIndex), message: `${c.info(ctxCard.title)}${assignee}${tags}` });
          cardLookup[cardIndex] = ctxCard;
          cardIndex++;
        }
      }
    }

    cardChoices.push({ name: 'refresh', message: c.muted('↻ refresh') });
    cardChoices.push({ name: 'back', message: c.muted(BACK) });

    const answer = await pickFilter(c.label('Select card'), cardChoices);
    if (answer === 'back') return;
    if (answer === 'refresh') continue;
    if (answer.startsWith('sep_')) continue; // separator selected, re-render

    const idx = parseInt(answer, 10);
    const selected = cardLookup[idx];
    if (selected) await showCardDetail(ctx, selected.id);
  }
}

async function showCardDetail(ctx: Ctx, cardId: string): Promise<void> {
  console.log(`  ${c.muted('Loading…')}`);
  try {
    const card = await ctx.api.cards.getCard(cardId, { include: ['comments', 'relations'] });

    console.log('');
    console.log(`  ${c.heading(card.name)}`);
    console.log(`  ${c.muted('─'.repeat(60))}`);
    console.log(`  ${c.label('ID')}          ${c.id(card.cardId)}`);
    if (card.status) console.log(`  ${c.label('Status')}      ${c.value(card.status)}`);
    if (card.assignees?.length) console.log(`  ${c.label('Assignees')}   ${card.assignees.map(a => c.assignee(`@${a}`)).join('  ')}`);
    if (card.tags?.length) console.log(`  ${c.label('Tags')}        ${card.tags.map(t => c.tag(t)).join('  ')}`);
    if (card.dueDate) {
      // The FOURTH inline copy of the overdue test (#89 killed three of them).
      // `new Date(dueDate) < new Date()` compares a date-only string parsed as
      // UTC midnight against *now*, so a card due today read as overdue from
      // 00:00 onwards west of Greenwich. `isOverdue` is the surviving copy and
      // takes the date-only branch for a date-only string.
      const overdue = isOverdue(card);
      console.log(`  ${c.label('Due')}         ${overdue ? c.error(`${card.dueDate} (overdue)`) : c.value(card.dueDate)}`);
    }
    if (card.createdAt) console.log(`  ${c.label('Created')}     ${c.muted(card.createdAt.slice(0, 10))}`);
    if (card.description) {
      console.log('');
      console.log(`  ${c.label('Description')}`);
      const desc = card.description.replace(/<[^>]+>/g, '').trim();
      for (const line of (desc.match(/.{1,76}/g) ?? [desc])) {
        console.log(`  ${c.muted(line)}`);
      }
    }
    if (card.comments?.length) {
      console.log('');
      console.log(`  ${c.label('Comments')} ${c.muted(`(${card.comments.length})`)}`);
      for (const cm of card.comments.slice(0, 5)) {
        console.log(`  ${c.muted('·')} ${c.muted(cm.createdAt?.slice(0, 10) ?? '')}  ${cm.text?.slice(0, 80) ?? ''}`);
      }
      if (card.comments.length > 5) console.log(`  ${c.muted(`  … +${card.comments.length - 5} more`)}`);
    }
    console.log('');
  } catch {
    console.log(`  ${c.error('Could not load card.')}`);
  }
  await pause();
}

// ─── Main Menu Loop ──────────────────────────────────────────────────────────

async function showMyWork(ctx: Ctx): Promise<void> {
  console.log(`\n  ${c.heading('My Work')}`);
  console.log(`  ${c.muted('Loading your cards…')}`);
  try {
    const config = ctx.config;
    const userId = await resolveUserId();
    if (!userId) {
      console.log(`  ${c.error('Could not resolve your userId. Run "favro auth login" to set up credentials.')}`);
      await pause();
      return;
    }
    const agg = ctx.api.aggregate;

    let snapshot;
    if (config.scopeCollectionId) {
      snapshot = await agg.getMultiBoardSnapshot({ collectionIds: [config.scopeCollectionId] });
    } else {
      snapshot = await agg.getMultiBoardSnapshot({});
    }

    const myCards = snapshot.allCards.filter(
      (card: any) => card.assignees?.includes(userId)
    );

    if (myCards.length === 0) {
      console.log(`  ${c.muted('No cards assigned to you.')}`);
    } else {
      // A `blockedBy` edge is a dependency count, not a blocked state (#61).
      // Nothing clears a Favro `isBefore` edge when the blocker finishes, and
      // this path does not pay for `judgeBlockers`, so the edges are reported
      // under an honest name and no longer partition the card list: `queued`
      // keeps every card that is neither active nor done, edges or not.
      const active = myCards.filter((ca: any) => ['active', 'review', 'testing'].includes(ca.stage ?? ''));
      const withDeps = myCards.filter((ca: any) => ca.blockedBy?.length > 0);
      // The done half of this was the fifth copy of the finished-stage set,
      // inlined and fused with the active one (#98). The active half stays local
      // — it is the same list line 302 filters `active` by, and consolidating
      // *that* set is a different question from consolidating doneness.
      const other = myCards.filter((ca: any) => !['active', 'review', 'testing'].includes(ca.stage ?? '') && !isDoneStage(ca.stage));

      console.log(`  ${c.success(`${myCards.length} cards`)}  ${c.info(`${active.length} active`)}  ${withDeps.length > 0 ? c.muted(`${withDeps.length} with dependencies`) : ''}  ${c.muted(`${other.length} queued`)}`);
      console.log('');
      for (const card of active.slice(0, 10)) {
        const board = (card as any).boardName ? c.muted(` [${(card as any).boardName}]`) : '';
        console.log(`  ${c.brand('▸')} ${c.info(card.title)}${board}`);
      }
      if (active.length > 10) console.log(`  ${c.muted(`  … +${active.length - 10} more active cards`)}`);
      if (withDeps.length > 0) {
        console.log(`\n  ${c.muted('With dependencies:')}`);
        for (const card of withDeps.slice(0, 5)) {
          console.log(`  ${c.muted('↳')} ${card.title}`);
        }
      }
    }
  } catch (err: any) {
    console.log(`  ${c.error(err.message ?? 'Failed to load your cards')}`);
  }
  await pause();
}

async function showTeamDashboard(ctx: Ctx): Promise<void> {
  console.log(`\n  ${c.heading('Team Dashboard')}`);
  console.log(`  ${c.muted('Loading team data…')}`);
  try {
    const config = ctx.config;
    const agg = ctx.api.aggregate;

    let snapshot;
    let scope: string;
    if (config.scopeCollectionId) {
      snapshot = await agg.getMultiBoardSnapshot({ collectionIds: [config.scopeCollectionId] });
      scope = config.scopeCollectionName ?? config.scopeCollectionId;
    } else {
      snapshot = await agg.getMultiBoardSnapshot({});
      scope = 'all collections';
    }

    // Per-member card counts
    // `dependencies` counts cards carrying at least one edge — an edge count,
    // not a blocked count (#61). Same treatment as `favro team`'s
    // `dependencyCount`; this path does not pay for `judgeBlockers` either.
    const memberCounts = new Map<string, { name: string; active: number; total: number; dependencies: number }>();
    for (const card of snapshot.allCards) {
      for (const uid of (card.assignees ?? [])) {
        if (!memberCounts.has(uid)) {
          const m = snapshot.members.find((mem: any) => mem.id === uid);
          memberCounts.set(uid, { name: m?.name ?? uid, active: 0, total: 0, dependencies: 0 });
        }
        const mc = memberCounts.get(uid)!;
        mc.total++;
        if (['active', 'review', 'testing'].includes(card.stage ?? '')) mc.active++;
        if (card.blockedBy?.length) mc.dependencies++;
      }
    }

    console.log(`  ${c.heading(scope)} — ${snapshot.allCards.length} cards, ${memberCounts.size} members\n`);

    const sorted = Array.from(memberCounts.values()).sort((a, b) => b.active - a.active);
    for (const m of sorted.slice(0, 15)) {
      const overload = m.active > 8 ? c.error(' ⚠ overload') : '';
      const deps = m.dependencies > 0 ? c.muted(` ${m.dependencies} with deps`) : '';
      console.log(`  ${c.info(m.name.padEnd(20))} ${c.value(String(m.active).padStart(2))} active / ${c.muted(String(m.total))} total${deps}${overload}`);
    }
    if (sorted.length > 15) console.log(`  ${c.muted(`  … +${sorted.length - 15} more members`)}`);
  } catch (err: any) {
    console.log(`  ${c.error(err.message ?? 'Failed to load team data')}`);
  }
  await pause();
}

const MENU_ITEMS = [
  { label: 'My Work',          description: 'Your cards across all boards' },
  { label: 'Team Dashboard',   description: 'Team workload & bottlenecks' },
  { label: 'Browse',           description: 'Collections → Boards → Cards' },
  { label: 'Auth / Configure', description: 'Check API credentials' },
  { label: 'Help',             description: 'Show all CLI commands' },
  { label: 'Exit',             description: '' },
];

/**
 * Run the persistent interactive menu. Loops until user exits.
 *
 * Takes the root `Command` rather than an `outputHelp` closure so the runner
 * can resolve `--human`/`--verbose` off it the way it does for every other
 * action — `commandFrom` detects it by shape as the last argument.
 */
async function mainMenuHandler(ctx: Ctx, version: string, program: Command): Promise<void> {
  console.log(LOGO);
  console.log(`  ${c.muted(`CLI v${version}`)}`);

  while (true) {
    console.log('');

    const choices = MENU_ITEMS.map((m, i) => {
      const desc = m.description ? c.muted(`  ${m.description}`) : '';
      const isExit = m.label === 'Exit';
      const label = isExit ? c.muted(m.label) : c.info(m.label);
      return { name: String(i), message: `${label}${desc}` };
    });

    let answer: string;
    try {
      answer = await pick(c.brand('›'), choices);
    } catch {
      break; // Ctrl+C
    }

    const idx = parseInt(answer, 10);
    if (isNaN(idx) || idx >= MENU_ITEMS.length) break;
    const item = MENU_ITEMS[idx];

    try {
      switch (item.label) {
        case 'My Work':          await showMyWork(ctx); break;
        case 'Team Dashboard':   await showTeamDashboard(ctx); break;
        case 'Browse':           await showCollections(ctx); break;
        case 'Auth / Configure': await showAuthCheck(); break;
        case 'Help':             program.outputHelp(); await pause(); break;
        case 'Exit':             console.log(`\n  ${c.muted('Goodbye.')}\n`); return leave();
      }
    } catch (err: any) {
      if (isPromptCancelled(err)) break;
      console.log(`\n  ${c.error(err?.message ?? 'Something went wrong')}`);
      await pause();
    }
  }

  console.log(`\n  ${c.muted('Goodbye.')}\n`);
  leave();
}

/**
 * Release stdin so node can leave on its own.
 *
 * `pause()` resumes stdin and never pauses it back, which keeps a live handle
 * on the event loop — that is what the old hard `process.exit` in `cli.ts` was
 * papering over. A hard exit terminates before a pending stdout write flushes
 * (ADR-0002 rule 2), so the handle is released instead and the runner's exit
 * code stands.
 */
function leave(): void {
  process.stdin.pause();
}

export const runMainMenu = run(mainMenuHandler);
