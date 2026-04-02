/**
 * Main Menu — Persistent interactive app shown when `favro` is run with no arguments.
 *
 * Navigation: Collections → Boards → Board view (kanban) → Card detail
 * Always traverse back up the hierarchy. Only Exit or Ctrl+C leaves.
 */
import { c } from '../lib/theme';
import { createFavroClient } from '../lib/client-factory';
import CollectionsAPI from '../lib/collections-api';
import BoardsAPI from '../lib/boards-api';
import CardsAPI from '../lib/cards-api';
import { ContextAPI, ContextCard } from '../api/context';
import { renderBoard, renderStatusBar, RenderColumn, RenderCard } from '../lib/board-renderer';
import { readConfig, resolveUserId } from '../lib/config';
import { outputResult, resolveFormat } from '../lib/output';

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

// ─── API singleton ───────────────────────────────────────────────────────────

let _collections: CollectionsAPI | null = null;
let _boards: BoardsAPI | null = null;
let _cards: CardsAPI | null = null;
let _context: ContextAPI | null = null;

async function api() {
  if (!_boards) {
    const client = await createFavroClient();
    _collections = new CollectionsAPI(client);
    _boards = new BoardsAPI(client);
    _cards = new CardsAPI(client);
    _context = new ContextAPI(client);
  }
  return { collections: _collections!, boards: _boards!, cards: _cards!, context: _context! };
}

// ─── Snapshot → columns helper ───────────────────────────────────────────────

function snapshotToColumns(snapshot: { columns: Array<{ id: string; name: string }>; cards: ContextCard[] }): { columns: RenderColumn[]; allCards: ContextCard[] } {
  const columnMap = new Map<string, { render: RenderCard[]; context: ContextCard[] }>();
  for (const col of snapshot.columns) columnMap.set(col.name, { render: [], context: [] });
  if (snapshot.columns.length === 0) {
    const statuses = new Set(snapshot.cards.map(ca => ca.status ?? 'Unknown'));
    for (const s of statuses) columnMap.set(s, { render: [], context: [] });
  }

  const allCards: ContextCard[] = [];
  for (const card of snapshot.cards) {
    const rc: RenderCard = { id: card.id, title: card.title, assignee: card.owner, tags: card.tags, status: card.status, due: card.due, blocked: (card.blockedBy?.length ?? 0) > 0 };
    let placed = false;
    if (card.columnId) {
      const col = snapshot.columns.find(co => co.id === card.columnId);
      if (col && columnMap.has(col.name)) {
        columnMap.get(col.name)!.render.push(rc);
        columnMap.get(col.name)!.context.push(card);
        placed = true;
      }
    }
    if (!placed) {
      const status = card.status ?? 'Unknown';
      if (!columnMap.has(status)) columnMap.set(status, { render: [], context: [] });
      columnMap.get(status)!.render.push(rc);
      columnMap.get(status)!.context.push(card);
    }
    allCards.push(card);
  }

  const columns: RenderColumn[] = Array.from(columnMap.entries()).map(([name, data]) => ({ name, cards: data.render }));
  return { columns, allCards };
}

// ─── Actions ─────────────────────────────────────────────────────────────────

async function showAuthCheck(): Promise<void> {
  console.log(`\n  ${c.muted('Checking API credentials…')}`);
  try {
    await api();
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

async function showCollections(): Promise<void> {
  const { collections } = await api();

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
    if (col) await showBoardsInCollection(col.collectionId, col.name);
  }
}

async function showBoardsInCollection(collectionId: string, collectionName: string): Promise<void> {
  const { boards } = await api();

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
    if (board) await showBoardView(board.boardId, board.name);
  }
}

async function showBoardView(boardId: string, boardName: string): Promise<void> {
  const { context, cards: cardsApi } = await api();

  while (true) {
    console.log(`\n  ${c.muted('Loading board…')}`);
    let snapshot;
    try {
      snapshot = await context.getSnapshot(boardId, 500);
    } catch (err: any) {
      console.log(`  ${c.error(err.message ?? 'Failed to load board')}`);
      await pause();
      return;
    }

    const { columns, allCards } = snapshotToColumns(snapshot);

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
    if (selected) await showCardDetail(selected.id);
  }
}

async function showCardDetail(cardId: string): Promise<void> {
  const { cards: cardsApi } = await api();

  console.log(`  ${c.muted('Loading…')}`);
  try {
    const card = await cardsApi.getCard(cardId, { include: ['comments', 'relations'] });

    console.log('');
    console.log(`  ${c.heading(card.name)}`);
    console.log(`  ${c.muted('─'.repeat(60))}`);
    console.log(`  ${c.label('ID')}          ${c.id(card.cardId)}`);
    if (card.status) console.log(`  ${c.label('Status')}      ${c.value(card.status)}`);
    if (card.assignees?.length) console.log(`  ${c.label('Assignees')}   ${card.assignees.map(a => c.assignee(`@${a}`)).join('  ')}`);
    if (card.tags?.length) console.log(`  ${c.label('Tags')}        ${card.tags.map(t => c.tag(t)).join('  ')}`);
    if (card.dueDate) {
      const overdue = new Date(card.dueDate) < new Date();
      console.log(`  ${c.label('Due')}         ${overdue ? c.error(`${card.dueDate} (overdue)`) : c.value(card.dueDate)}`);
    }
    if (card.createdAt) console.log(`  ${c.label('Created')}     ${c.muted(card.createdAt.slice(0, 10))}`);
    if (card.updatedAt) console.log(`  ${c.label('Updated')}     ${c.muted(card.updatedAt.slice(0, 10))}`);
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

async function showMyWork(): Promise<void> {
  console.log(`\n  ${c.heading('My Work')}`);
  console.log(`  ${c.muted('Loading your cards…')}`);
  try {
    const config = await readConfig();
    const userId = await resolveUserId();
    if (!userId) {
      console.log(`  ${c.error('Could not resolve your userId. Run "favro auth login" to set up credentials.')}`);
      await pause();
      return;
    }
    const client = await createFavroClient();
    const AggregateAPI = (await import('../api/aggregate')).default;
    const agg = new AggregateAPI(client);

    let snapshot;
    if (config.scopeCollectionId) {
      snapshot = await agg.getMultiBoardSnapshot({ collectionIds: [config.scopeCollectionId] }, 500);
    } else {
      snapshot = await agg.getMultiBoardSnapshot({}, 500);
    }

    const myCards = snapshot.allCards.filter(
      (card: any) => card.assignees?.includes(userId)
    );

    if (myCards.length === 0) {
      console.log(`  ${c.muted('No cards assigned to you.')}`);
    } else {
      const active = myCards.filter((ca: any) => ['active', 'review', 'testing'].includes(ca.stage ?? ''));
      const blocked = myCards.filter((ca: any) => ca.blockedBy?.length > 0);
      const other = myCards.filter((ca: any) => !['active', 'review', 'testing', 'done', 'approved', 'archived'].includes(ca.stage ?? '') && !(ca.blockedBy?.length > 0));

      console.log(`  ${c.success(`${myCards.length} cards`)}  ${c.info(`${active.length} active`)}  ${blocked.length > 0 ? c.error(`${blocked.length} blocked`) : ''}  ${c.muted(`${other.length} queued`)}`);
      console.log('');
      for (const card of active.slice(0, 10)) {
        const board = (card as any).boardName ? c.muted(` [${(card as any).boardName}]`) : '';
        console.log(`  ${c.brand('▸')} ${c.info(card.title)}${board}`);
      }
      if (active.length > 10) console.log(`  ${c.muted(`  … +${active.length - 10} more active cards`)}`);
      if (blocked.length > 0) {
        console.log(`\n  ${c.error('Blocked:')}`);
        for (const card of blocked.slice(0, 5)) {
          console.log(`  ${c.error('✗')} ${card.title}`);
        }
      }
    }
  } catch (err: any) {
    console.log(`  ${c.error(err.message ?? 'Failed to load your cards')}`);
  }
  await pause();
}

async function showTeamDashboard(): Promise<void> {
  console.log(`\n  ${c.heading('Team Dashboard')}`);
  console.log(`  ${c.muted('Loading team data…')}`);
  try {
    const config = await readConfig();
    const client = await createFavroClient();
    const AggregateAPI = (await import('../api/aggregate')).default;
    const agg = new AggregateAPI(client);

    let snapshot;
    let scope: string;
    if (config.scopeCollectionId) {
      snapshot = await agg.getMultiBoardSnapshot({ collectionIds: [config.scopeCollectionId] }, 500);
      scope = config.scopeCollectionName ?? config.scopeCollectionId;
    } else {
      snapshot = await agg.getMultiBoardSnapshot({}, 500);
      scope = 'all collections';
    }

    // Per-member card counts
    const memberCounts = new Map<string, { name: string; active: number; total: number; blocked: number }>();
    for (const card of snapshot.allCards) {
      for (const uid of (card.assignees ?? [])) {
        if (!memberCounts.has(uid)) {
          const m = snapshot.members.find((mem: any) => mem.id === uid);
          memberCounts.set(uid, { name: m?.name ?? uid, active: 0, total: 0, blocked: 0 });
        }
        const mc = memberCounts.get(uid)!;
        mc.total++;
        if (['active', 'review', 'testing'].includes(card.stage ?? '')) mc.active++;
        if (card.blockedBy?.length) mc.blocked++;
      }
    }

    console.log(`  ${c.heading(scope)} — ${snapshot.allCards.length} cards, ${memberCounts.size} members\n`);

    const sorted = Array.from(memberCounts.values()).sort((a, b) => b.active - a.active);
    for (const m of sorted.slice(0, 15)) {
      const overload = m.active > 8 ? c.error(' ⚠ overload') : '';
      const blocked = m.blocked > 0 ? c.error(` ${m.blocked} blocked`) : '';
      console.log(`  ${c.info(m.name.padEnd(20))} ${c.value(String(m.active).padStart(2))} active / ${c.muted(String(m.total))} total${blocked}${overload}`);
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
 */
export async function runMainMenu(version: string, outputHelp: () => void): Promise<void> {
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
        case 'My Work':          await showMyWork(); break;
        case 'Team Dashboard':   await showTeamDashboard(); break;
        case 'Browse':           await showCollections(); break;
        case 'Auth / Configure': await showAuthCheck(); break;
        case 'Help':             outputHelp(); await pause(); break;
        case 'Exit':             console.log(`\n  ${c.muted('Goodbye.')}\n`); return;
      }
    } catch (err: any) {
      if (err?.message === '' || err?.code === 'ERR_USE_AFTER_CLOSE') break;
      console.log(`\n  ${c.error(err.message ?? 'Something went wrong')}`);
      await pause();
    }
  }

  console.log(`\n  ${c.muted('Goodbye.')}\n`);
}
