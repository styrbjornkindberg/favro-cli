/**
 * Interactive Shell — REPL with tab completion, history, and board context
 *
 * favro shell                     — Start interactive shell
 * favro shell --board <boardId>   — Start with board pre-selected
 *
 * Inside the shell:
 *   use <boardId>    — Set current board context
 *   exit / quit      — Leave shell
 *   help             — Show available commands
 *   Any favro command runs without the "favro " prefix
 */
import { Command } from 'commander';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { c, box } from '../lib/theme';

// ─── History ──────────────────────────────────────────────────────────────────

function getHistoryPath(): string {
  const dir = path.join(process.env.HOME ?? '~', '.favro');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'history');
}

function loadHistory(): string[] {
  const p = getHistoryPath();
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).slice(-500);
}

function saveHistory(lines: string[]): void {
  fs.writeFileSync(getHistoryPath(), lines.slice(-500).join('\n') + '\n', 'utf-8');
}

// ─── Completions ──────────────────────────────────────────────────────────────

const TOP_COMMANDS = [
  'auth', 'scope', 'boards', 'cards', 'collections', 'columns', 'tags',
  'tasks', 'tasklists', 'dependencies', 'attachments', 'users', 'members',
  'comments', 'webhooks', 'batch', 'batch-smart', 'context', 'query',
  'standup', 'sprint-plan', 'propose', 'execute', 'audit', 'who-changed',
  'risks', 'release-check', 'ai', 'skill', 'git',
  'use', 'help', 'exit', 'quit', 'clear',
];

const SUBCOMMANDS: Record<string, string[]> = {
  auth: ['login', 'logout', 'check', 'verify'],
  scope: ['set', 'show', 'clear'],
  boards: ['list', 'get', 'create', 'update', 'delete'],
  cards: ['list', 'get', 'create', 'update', 'export', 'link', 'unlink', 'move'],
  collections: ['list', 'get', 'create', 'update', 'delete'],
  columns: ['list', 'add', 'update', 'delete'],
  tags: ['list', 'create', 'update', 'delete'],
  tasks: ['list', 'create', 'update', 'delete'],
  tasklists: ['list', 'create', 'update', 'delete'],
  dependencies: ['list', 'add', 'remove'],
  attachments: ['list', 'upload', 'delete'],
  users: ['list', 'get'],
  ai: ['setup', 'ask', 'do', 'explain'],
  skill: ['list', 'run', 'create', 'edit', 'export', 'import', 'delete', 'record', 'stop'],
  git: ['link', 'branch', 'commit', 'sync', 'todos'],
  batch: ['update', 'move', 'assign'],
};

function completer(line: string): [string[], string] {
  const parts = line.trim().split(/\s+/);

  if (parts.length <= 1) {
    const prefix = parts[0] ?? '';
    const hits = TOP_COMMANDS.filter(c => c.startsWith(prefix));
    return [hits.length ? hits : TOP_COMMANDS, prefix];
  }

  const cmd = parts[0];
  const sub = parts[1] ?? '';
  const subs = SUBCOMMANDS[cmd];
  if (subs) {
    const hits = subs.filter(s => s.startsWith(sub));
    return [hits.length ? hits : subs, sub];
  }

  return [[], line];
}

// ─── Shell State ──────────────────────────────────────────────────────────────

interface ShellState {
  board?: string;
  boardName?: string;
}

function buildPrompt(state: ShellState): string {
  const scope = state.boardName
    ? c.brand(`[${state.boardName}]`) + ' '
    : state.board
      ? c.brand(`[${state.board.slice(0, 8)}…]`) + ' '
      : '';
  return `${c.brand('favro')} ${scope}${c.bold('❯')} `;
}

// ─── REPL ─────────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(box('Favro Shell', [
    `${c.bold('use <boardId>')}    ${c.muted('Set current board context')}`,
    `${c.bold('clear')}            ${c.muted('Clear the screen')}`,
    `${c.bold('help')}             ${c.muted('Show this help')}`,
    `${c.bold('exit / quit')}      ${c.muted('Leave the shell')}`,
    '',
    `${c.muted('Type any favro command without the "favro" prefix:')}`,
    `  ${c.info('cards list --board abc123')}`,
    `  ${c.info('boards list')}`,
    `  ${c.info('git sync --dry-run')}`,
  ]));
}

function printBanner(): void {
  console.log('');
  console.log(c.brand('  ╭─────────────────────────────────╮'));
  console.log(c.brand('  │') + c.bold('   Favro CLI — Interactive Shell  ') + c.brand('│'));
  console.log(c.brand('  │') + c.muted('   Type "help" for commands        ') + c.brand('│'));
  console.log(c.brand('  ╰─────────────────────────────────╯'));
  console.log('');
}

async function runShell(initialBoard?: string): Promise<void> {
  const state: ShellState = { board: initialBoard };
  const history = loadHistory();

  printBanner();

  // If board is set, try to resolve its name
  if (state.board) {
    console.log(`${c.ok} Board context: ${c.value(state.board)}`);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(state),
    completer,
    terminal: true,
  });

  // Load history into readline
  for (const line of history) {
    (rl as any).history?.push(line);
  }

  rl.prompt();

  rl.on('line', (raw: string) => {
    const line = raw.trim();
    if (!line) {
      rl.prompt();
      return;
    }

    history.push(line);

    // Built-in shell commands
    if (line === 'exit' || line === 'quit') {
      saveHistory(history);
      console.log(c.muted('Goodbye!'));
      rl.close();
      return;
    }

    if (line === 'help') {
      printHelp();
      rl.prompt();
      return;
    }

    if (line === 'clear') {
      process.stdout.write('\x1B[2J\x1B[0f');
      rl.prompt();
      return;
    }

    if (line.startsWith('use ')) {
      const boardId = line.slice(4).trim();
      if (!boardId) {
        console.log(c.warn('Usage: use <boardId>'));
      } else {
        state.board = boardId;
        state.boardName = undefined;
        console.log(`${c.ok} Board context set to ${c.value(boardId)}`);
        rl.setPrompt(buildPrompt(state));
      }
      rl.prompt();
      return;
    }

    // Execute as a favro CLI command
    let cmd = line;
    // Auto-inject --board if we have one and the command likely needs it
    if (state.board && !cmd.includes('--board') && !cmd.startsWith('auth') && !cmd.startsWith('scope')) {
      // Commands that take --board
      const boardCmds = ['cards list', 'standup', 'sprint-plan', 'context', 'query', 'risks', 'audit', 'batch-smart'];
      if (boardCmds.some(bc => cmd.startsWith(bc))) {
        cmd += ` --board ${state.board}`;
      }
    }

    try {
      const output = execSync(`favro ${cmd}`, {
        encoding: 'utf-8',
        stdio: ['inherit', 'pipe', 'pipe'],
        timeout: 60000,
      });
      if (output.trim()) console.log(output.trimEnd());
    } catch (err: any) {
      if (err.stderr) {
        console.error(c.error(err.stderr.trim()));
      } else if (err.message) {
        console.error(c.error(err.message));
      }
    }

    rl.setPrompt(buildPrompt(state));
    rl.prompt();
  });

  rl.on('close', () => {
    saveHistory(history);
    process.exit(0);
  });
}

// ─── Registration ─────────────────────────────────────────────────────────────

export function registerShellCommand(program: Command): void {
  program
    .command('shell')
    .description('Interactive Favro shell with tab completion and history')
    .option('--board <boardId>', 'Pre-select a board context')
    .action(async (options) => {
      await runShell(options.board);
    });
}
