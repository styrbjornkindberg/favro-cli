/**
 * Tracker mapping — where "which board is the tracker" is stored, and how it is
 * checked before anything is written against it (#52).
 *
 * The mapping is two `columnId`s. Ids, not names: a rename is not drift, and an
 * added column is not drift either. Favro's UI "status" IS the column — there is
 * no `state` field — so `active` / `done` are the open/closed axis, and the
 * triage vocabulary rides tags instead.
 *
 * Storage has no Favro-side home: neither `collections get` nor `boards get`
 * carries a description field. So the authoritative store is the git-committed
 * `docs/agents/issue-tracker.md` (team-shared, reviewable, versioned) with
 * `~/.favro/config.json` as the repo-less fallback. `.favro/context.json` was
 * rejected: its cwd walk-up answers by whatever directory the process happens to
 * sit in, which under `favro-mcp-http` is not the caller's repo at all. The doc
 * is therefore read at a FIXED path relative to cwd — no walk-up — and simply
 * not finding it falls through to the config.
 *
 * `tracker init` PRINTS the block. It never writes the repo doc.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import FavroHttpClient from './http-client';
import ColumnsAPI from './columns-api';
import { readConfig } from './config';
import { MISSING_WORDING } from './favro-error';

export interface TrackerMapping {
  collectionId: string;
  boardId: string;
  /** The open/closed axis, by id. */
  columns: { active: string; done: string };
}

export type TrackerSource = 'doc' | 'config';

export interface StoredTracker {
  mapping: TrackerMapping;
  source: TrackerSource;
  /** Where the mapping was read from, for a refusal that points somewhere real. */
  location: string;
}

export type TrackerFailure = 'missing' | 'malformed' | 'drift' | 'ambiguous';

/** A structured refusal. `columns` lists the board's real columns on 'drift'. */
export class TrackerConfigError extends Error {
  constructor(
    message: string,
    readonly kind: TrackerFailure,
    readonly columns: Array<{ columnId: string; name: string }> = []
  ) {
    super(message);
    this.name = 'TrackerConfigError';
  }
}

/**
 * The triage vocabulary (docs/agents/triage-labels.md), carried by tags rather
 * than by the column — the column already carries open/closed and cannot carry
 * both. `tracker init` provisions all five so a later `retag` can refuse an
 * unknown tag instead of quietly creating one.
 */
export const TRIAGE_TAGS = [
  'needs-triage',
  'needs-info',
  'ready-for-agent',
  'ready-for-human',
  'wontfix',
] as const;

const BEGIN = '<!-- favro-tracker -->';
const END = '<!-- /favro-tracker -->';

/** The team-shared store, at a fixed path under cwd. `FAVRO_TRACKER_DOC` overrides. */
export function trackerDocPath(): string {
  return process.env.FAVRO_TRACKER_DOC || path.join(process.cwd(), 'docs', 'agents', 'issue-tracker.md');
}

function validate(value: unknown, location: string): TrackerMapping {
  const m = value as Partial<TrackerMapping> | null;
  const ok =
    m &&
    typeof m.collectionId === 'string' && m.collectionId.trim() !== '' &&
    typeof m.boardId === 'string' && m.boardId.trim() !== '' &&
    typeof m.columns?.active === 'string' && m.columns.active.trim() !== '' &&
    typeof m.columns?.done === 'string' && m.columns.done.trim() !== '';

  if (!ok) {
    throw new TrackerConfigError(
      `The tracker block in ${location} is incomplete — it needs collectionId, boardId, and both columns (active, done). ` +
        `Run 'favro tracker init --collection <collection>' and paste the block it prints.`,
      'malformed'
    );
  }
  return {
    collectionId: m!.collectionId!.trim(),
    boardId: m!.boardId!.trim(),
    columns: { active: m!.columns!.active.trim(), done: m!.columns!.done.trim() },
  };
}

/** Pull the mapping out of the doc's marked block. Undefined when there is none. */
export function parseTrackerBlock(markdown: string, location = trackerDocPath()): TrackerMapping | undefined {
  const start = markdown.indexOf(BEGIN);
  if (start === -1) return undefined;
  const end = markdown.indexOf(END, start);
  const section = markdown.slice(start + BEGIN.length, end === -1 ? undefined : end);

  const fence = section.match(/```json\s*([\s\S]*?)```/);
  if (!fence) {
    throw new TrackerConfigError(
      `${location} has a ${BEGIN} marker but no \`\`\`json block inside it. ` +
        `Run 'favro tracker init --collection <collection>' and paste the block it prints.`,
      'malformed'
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fence[1]);
  } catch {
    throw new TrackerConfigError(
      `The tracker block in ${location} is not valid JSON. ` +
        `Run 'favro tracker init --collection <collection>' and paste the block it prints.`,
      'malformed'
    );
  }
  return validate(parsed, location);
}

/**
 * Read the mapping: repo doc first, `~/.favro/config.json` second.
 * Undefined when neither carries one — the caller decides whether that refuses.
 */
export async function readTrackerMapping(): Promise<StoredTracker | undefined> {
  const doc = trackerDocPath();
  try {
    const raw = await fs.readFile(doc, 'utf-8');
    const mapping = parseTrackerBlock(raw, doc);
    if (mapping) return { mapping, source: 'doc', location: doc };
  } catch (err: any) {
    if (err instanceof TrackerConfigError) throw err;
    if (err?.code !== 'ENOENT') throw err;
  }

  const config = await readConfig();
  if (config.tracker) {
    const { CONFIG_FILE } = await import('./config');
    return { mapping: validate(config.tracker, CONFIG_FILE), source: 'config', location: CONFIG_FILE };
  }
  return undefined;
}

/** Same read, but a missing mapping is a structured refusal naming the fix. */
export async function requireTrackerMapping(): Promise<StoredTracker> {
  const stored = await readTrackerMapping();
  if (stored) return stored;
  throw new TrackerConfigError(
    `No tracker is designated. Nothing in ${trackerDocPath()} or your ~/.favro/config.json says which board is the tracker.\n` +
      `Run 'favro tracker init --collection <collection>' — it prints a block to paste into docs/agents/issue-tracker.md.`,
    'missing'
  );
}

export interface VerifiedTracker extends StoredTracker {
  activeColumnName: string;
  doneColumnName: string;
}

/**
 * Verify the mapping against the board, in ONE call, before acting on it.
 *
 * A mapped column that is gone REFUSES and does not self-heal. Re-deriving the
 * mapping here — by name, by position, by `detectStage` — would silently
 * re-point at a different column, so cards would move somewhere nobody chose
 * and the CLI would report success. The refusal lists the board's real columns
 * so the fix is one edit away.
 */
export async function verifyTrackerMapping(
  client: FavroHttpClient,
  stored: StoredTracker
): Promise<VerifiedTracker> {
  const { mapping } = stored;
  const columns = await new ColumnsAPI(client).listColumns(mapping.boardId);
  const byId = new Map(columns.map((c) => [c.columnId, c.name]));

  const gone = (['active', 'done'] as const).filter((role) => !byId.has(mapping.columns[role]));
  if (gone.length > 0) {
    const listed = columns.length === 0
      ? '  (that board has no columns)'
      : columns.map((c) => `  ${c.columnId}  ${c.name}`).join('\n');
    const named = gone.map((role) => `${role} = ${mapping.columns[role]}`).join(', ');
    throw new TrackerConfigError(
      `The tracker mapping in ${stored.location} points at a column that is ${MISSING_WORDING}: ${named}.\n` +
        `Refusing to re-point it — a deleted column must not silently become a different one. Board ${mapping.boardId} has:\n${listed}\n` +
        `Fix the block by hand, or re-run 'favro tracker init --collection ${mapping.collectionId}'.`,
      'drift',
      columns.map((c) => ({ columnId: c.columnId, name: c.name }))
    );
  }

  return {
    ...stored,
    activeColumnName: byId.get(mapping.columns.active)!,
    doneColumnName: byId.get(mapping.columns.done)!,
  };
}

export interface TrackerBlockLabels {
  collectionName?: string;
  boardName?: string;
  activeColumnName?: string;
  doneColumnName?: string;
}

/** The paste-ready block. `tracker init` prints this; nothing writes the doc. */
export function renderTrackerBlock(mapping: TrackerMapping, labels: TrackerBlockLabels = {}): string {
  const named = (id: string, name?: string) => (name ? `${name} (\`${id}\`)` : `\`${id}\``);
  return [
    BEGIN,
    '## Favro tracker',
    '',
    `- Collection: ${named(mapping.collectionId, labels.collectionName)}`,
    `- Board: ${named(mapping.boardId, labels.boardName)}`,
    `- Open cards live in ${named(mapping.columns.active, labels.activeColumnName)}; closed cards in ${named(mapping.columns.done, labels.doneColumnName)}.`,
    '',
    'The mapping is by `columnId`, so renaming or adding a column is not drift.',
    'A mapped column that is deleted is refused, never re-pointed.',
    '',
    '```json',
    JSON.stringify(mapping, null, 2),
    '```',
    END,
  ].join('\n');
}
