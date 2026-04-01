/**
 * TODO Scanner — Extract TODO/FIXME/HACK comments from codebase
 *
 * Scans source files for TODO-style comments, groups by file,
 * and generates card-ready descriptions with file:line references.
 */
import fs from 'fs';
import path from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TodoItem {
  file: string;          // Relative path from project root
  line: number;          // 1-based line number
  type: 'TODO' | 'FIXME' | 'HACK' | 'XXX';
  text: string;          // The comment text after the tag
  author?: string;       // Extracted from TODO(author): pattern
  fullLine: string;      // The complete source line
}

export interface TodoGroup {
  file: string;
  items: TodoItem[];
}

// ─── Patterns ─────────────────────────────────────────────────────────────────

const TODO_REGEX = /\b(TODO|FIXME|HACK|XXX)(?:\(([^)]+)\))?[:\s]+(.+)/i;

// Default ignore patterns (glob-like, used for simple prefix matching)
const DEFAULT_IGNORE_DIRS = [
  'node_modules', '.git', 'dist', 'build', 'coverage',
  '.next', '.nuxt', '__pycache__', '.venv', 'vendor',
  '.cache', '.turbo', '.svelte-kit',
];

const DEFAULT_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.cpp', '.h', '.hpp', '.cs',
  '.sh', '.bash', '.zsh',
  '.yaml', '.yml', '.toml',
  '.md', '.mdx',
  '.css', '.scss', '.less',
  '.html', '.vue', '.svelte',
];

// ─── Scanner ──────────────────────────────────────────────────────────────────

export interface ScanOptions {
  /** Project root directory */
  root?: string;
  /** File extensions to scan (default: common source files) */
  extensions?: string[];
  /** Directories to skip */
  ignoreDirs?: string[];
  /** Max files to scan (safety limit) */
  maxFiles?: number;
}

/**
 * Scan the codebase for TODO/FIXME/HACK comments.
 */
export function scanTodos(options: ScanOptions = {}): TodoItem[] {
  const root = options.root ?? process.cwd();
  const extensions = new Set(options.extensions ?? DEFAULT_EXTENSIONS);
  const ignoreDirs = new Set(options.ignoreDirs ?? DEFAULT_IGNORE_DIRS);
  const maxFiles = options.maxFiles ?? 10000;

  const items: TodoItem[] = [];
  let filesScanned = 0;

  function walk(dir: string): void {
    if (filesScanned >= maxFiles) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (filesScanned >= maxFiles) return;

      if (entry.isDirectory()) {
        if (ignoreDirs.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (!extensions.has(ext)) continue;

        const filePath = path.join(dir, entry.name);
        const relPath = path.relative(root, filePath);
        filesScanned++;

        scanFile(filePath, relPath, items);
      }
    }
  }

  walk(root);
  return items;
}

function scanFile(filePath: string, relPath: string, items: TodoItem[]): void {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return;
  }

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(TODO_REGEX);
    if (match) {
      items.push({
        file: relPath,
        line: i + 1,
        type: match[1].toUpperCase() as TodoItem['type'],
        text: match[3].trim(),
        author: match[2] ?? undefined,
        fullLine: line.trim(),
      });
    }
  }
}

/**
 * Group todo items by file.
 */
export function groupByFile(items: TodoItem[]): TodoGroup[] {
  const groups = new Map<string, TodoItem[]>();

  for (const item of items) {
    const existing = groups.get(item.file) ?? [];
    existing.push(item);
    groups.set(item.file, existing);
  }

  return Array.from(groups.entries())
    .map(([file, fileItems]) => ({ file, items: fileItems }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Format a TodoItem as a Favro card description.
 */
export function formatTodoAsCardDescription(item: TodoItem): string {
  const parts = [
    `**${item.type}**: ${item.text}`,
    `File: \`${item.file}:${item.line}\``,
  ];
  if (item.author) parts.push(`Author: ${item.author}`);
  parts.push(`\`\`\`\n${item.fullLine}\n\`\`\``);
  return parts.join('\n');
}

/**
 * Generate a card title from a TODO item.
 */
export function todoToCardTitle(item: TodoItem): string {
  // Truncate to reasonable card title length
  const text = item.text.length > 80 ? item.text.slice(0, 77) + '...' : item.text;
  return `[${item.type}] ${text}`;
}
