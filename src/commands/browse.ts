/**
 * Interactive Browser — Navigate Collections → Boards → Cards → Card details
 *
 * favro browse                    — Start at collections level
 * favro browse --board <boardId>  — Jump directly to a board
 *
 * Uses enquirer for arrow-key menu navigation with search.
 */
import { Command } from 'commander';
import { ApiNamespace, Ctx, run } from '../lib/run';
import type CardsAPI from '../lib/cards-api';
import type { Card } from '../lib/cards-api';
import { c, stripAnsi } from '../lib/theme';
import { isOverdue } from '../lib/card-predicates';
import { isPromptCancelled } from '../lib/prompt-cancelled';

// ─── enquirer import (CJS) ───────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Select } = require('enquirer');

// ─── Constants ───────────────────────────────────────────────────────────────

const BACK = c.muted('‹ back');
const EXIT = c.muted('‹ exit');
const PAGE_SIZE = 15;

// ─── Prompt helper ───────────────────────────────────────────────────────────

async function selectItem(message: string, choices: string[]): Promise<string> {
  const prompt = new Select({
    name: 'value',
    message,
    choices,
    limit: PAGE_SIZE,
  });
  return prompt.run();
}

// ─── Card detail view ────────────────────────────────────────────────────────

function renderCardDetail(card: Card): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(`  ${c.heading(card.name)}`);
  lines.push(`  ${c.muted('─'.repeat(60))}`);
  lines.push(`  ${c.label('ID')}          ${c.id(card.cardId)}`);

  if (card.status) {
    lines.push(`  ${c.label('Status')}      ${c.value(card.status)}`);
  }
  if (card.assignees && card.assignees.length > 0) {
    lines.push(`  ${c.label('Assignees')}   ${card.assignees.map(a => c.assignee(`@${a}`)).join('  ')}`);
  }
  if (card.tags && card.tags.length > 0) {
    lines.push(`  ${c.label('Tags')}        ${card.tags.map(t => c.tag(t)).join('  ')}`);
  }
  if (card.dueDate) {
    // Was a third inline copy (#89): `new Date(dueDate) < new Date()`, which
    // compared against *now* rather than local midnight, so a card due today
    // rendered as overdue from 00:00 onwards.
    const dueFmt = isOverdue(card) ? c.error(`⏰ ${card.dueDate} (overdue)`) : c.value(card.dueDate);
    lines.push(`  ${c.label('Due')}         ${dueFmt}`);
  }
  if (card.createdAt) {
    lines.push(`  ${c.label('Created')}     ${c.muted(card.createdAt.slice(0, 10))}`);
  }
  if (card.description) {
    lines.push('');
    lines.push(`  ${c.label('Description')}`);
    // Wrap description at ~76 chars
    const desc = card.description.replace(/<[^>]+>/g, '').trim();
    const wrapped = desc.match(/.{1,76}/g) ?? [desc];
    for (const line of wrapped) {
      lines.push(`  ${c.muted(line)}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

// ─── Browse levels ───────────────────────────────────────────────────────────

async function browseCardDetail(api: CardsAPI, cardId: string, cardName: string): Promise<void> {
  try {
    const card = await api.getCard(cardId, { include: ['comments', 'relations'] });
    console.log(renderCardDetail(card));

    if (card.comments && card.comments.length > 0) {
      console.log(`  ${c.label('Comments')} (${card.comments.length})`);
      for (const comment of card.comments.slice(0, 5)) {
        console.log(`  ${c.muted('•')} ${c.muted(comment.createdAt?.slice(0, 10) ?? '')}  ${comment.text?.slice(0, 80) ?? ''}`);
      }
      if (card.comments.length > 5) {
        console.log(`  ${c.muted(`  … +${card.comments.length - 5} more`)}`);
      }
      console.log('');
    }

    if (card.relations && card.relations.length > 0) {
      console.log(`  ${c.label('Relations')} (${card.relations.length})`);
      for (const rel of card.relations) {
        const icon = rel.type === 'blocks' ? c.error('→') : c.info('→');
        console.log(`  ${icon} ${rel.type}  ${c.id(rel.cardId)}`);
      }
      console.log('');
    }
  } catch {
    console.log(`  ${c.error('Could not load card details.')}`);
  }

  // Wait for user to press enter to go back
  await selectItem(c.muted('Card detail'), [BACK]);
}

async function browseCards(
  cardsApi: CardsAPI,
  boardId: string,
  boardName: string,
): Promise<'back'> {
  while (true) {
    console.log(`\n  ${c.heading(boardName)}`);
    console.log(`  ${c.muted('Loading cards…')}`);

    const cards = await cardsApi.listCards(boardId);

    if (cards.length === 0) {
      console.log(`  ${c.muted('No cards on this board.')}`);
      await selectItem(c.muted('Empty board'), [BACK]);
      return 'back';
    }

    const choices = cards.map(card => {
      const status = card.status ? c.muted(`${card.status} `) : '';
      const due = card.dueDate ? ` ${c.muted(`due ${card.dueDate}`)}` : '';
      return `${c.id(card.cardId.slice(0, 8))} ${status}${c.info(card.name)}${due}`;
    });
    choices.push(BACK);

    const answer = await selectItem(
      `${c.label(`Cards`)} ${c.muted(`(${cards.length})`)}`,
      choices,
    );

    if (answer === BACK) return 'back';

    // Extract card ID from selection (first 8 chars before space)
    const selectedText = stripAnsi(answer);
    const shortId = selectedText.slice(0, 8);
    const card = cards.find(ca => ca.cardId.startsWith(shortId));
    if (card) {
      await browseCardDetail(cardsApi, card.cardId, card.name);
    }
  }
}

async function browseBoards(
  boardsApi: ApiNamespace['boards'],
  cardsApi: CardsAPI,
  collectionId: string,
  collectionName: string,
): Promise<'back'> {
  while (true) {
    console.log(`\n  ${c.heading(collectionName)}`);
    console.log(`  ${c.muted('Loading boards…')}`);

    const boards = await boardsApi.listBoardsByCollection(collectionId);

    if (boards.length === 0) {
      console.log(`  ${c.muted('No boards in this collection.')}`);
      await selectItem(c.muted('Empty collection'), [BACK]);
      return 'back';
    }

    const choices = boards.map(b => {
      const cards = b.cardCount != null ? c.muted(` (${b.cardCount} cards)`) : '';
      return `${c.id(b.boardId.slice(0, 8))} ${c.info(b.name)}${cards}`;
    });
    choices.push(BACK);

    const answer = await selectItem(
      `${c.label('Boards')} ${c.muted(`(${boards.length})`)}`,
      choices,
    );

    if (answer === BACK) return 'back';

    const selectedText = stripAnsi(answer);
    const shortId = selectedText.slice(0, 8);
    const board = boards.find(b => b.boardId.startsWith(shortId));
    if (board) {
      await browseCards(cardsApi, board.boardId, board.name);
    }
  }
}

async function browseCollections(
  collectionsApi: ApiNamespace['collections'],
  boardsApi: ApiNamespace['boards'],
  cardsApi: CardsAPI,
): Promise<void> {
  while (true) {
    console.log(`\n  ${c.heading('Collections')}`);
    console.log(`  ${c.muted('Loading…')}`);

    const collections = await collectionsApi.listCollections(100);

    if (collections.length === 0) {
      console.log(`  ${c.muted('No collections found.')}`);
      return;
    }

    const choices = collections.map(col => {
      const boards = col.boardCount != null ? c.muted(` (${col.boardCount} boards)`) : '';
      return `${c.id(col.collectionId.slice(0, 8))} ${c.info(col.name)}${boards}`;
    });
    choices.push(EXIT);

    const answer = await selectItem(
      `${c.label('Collections')} ${c.muted(`(${collections.length})`)}`,
      choices,
    );

    if (answer === EXIT) return;

    const selectedText = stripAnsi(answer);
    const shortId = selectedText.slice(0, 8);
    const col = collections.find(co => co.collectionId.startsWith(shortId));
    if (col) {
      await browseBoards(boardsApi, cardsApi, col.collectionId, col.name);
    }
  }
}

// ─── Command ──────────────────────────────────────────────────────────────────

/**
 * ON THE `void` ARM (ADR-0002, #118). Every screen this command draws is its
 * own, so it returns nothing and the runner writes nothing over it.
 *
 * Exported so a test can hand it a fake `Ctx` — no client mock.
 */
export async function browseHandler(ctx: Ctx, options: { board?: string }): Promise<void> {
  try {
    if (options.board) {
      // Jump directly to card browsing on a specific board
      let boardName = options.board;
      try {
        const board = await ctx.api.boards.getBoard(options.board);
        boardName = board.name ?? options.board;
      } catch { /* use ID as name fallback */ }

      await browseCards(ctx.api.cards, options.board, boardName);
    } else {
      await browseCollections(ctx.api.collections, ctx.api.boards, ctx.api.cards);
    }

    console.log(`\n  ${c.muted('Goodbye!')}\n`);
  } catch (error: unknown) {
    // Ctrl+C only. Everything else goes to the runner's boundary, which is the
    // one place that decides the stream and the exit code.
    if (isPromptCancelled(error)) {
      console.log(`\n  ${c.muted('Goodbye!')}\n`);
      return;
    }
    throw error;
  }
}

export function registerBrowseCommand(program: Command): void {
  program
    .command('browse')
    .description(
      'Interactive browser — navigate Collections → Boards → Cards → Card details\n\n' +
      'Use arrow keys to select, Enter to drill in, ← Back to go up.\n\n' +
      'Examples:\n' +
      '  favro browse                    — Start at collections level\n' +
      '  favro browse --board <boardId>  — Jump directly into a board',
    )
    .option('--board <boardId>', 'Jump directly to a specific board')
    .action(run(browseHandler));
}

export default registerBrowseCommand;
