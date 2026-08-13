/**
 * The repo's CSV, both directions.
 *
 * WRITING (FAVRO-009, `cards export`): JSON or CSV, headers first, every field
 * quoted, streamed with backpressure so a 10k-card export does not exhaust the
 * I/O buffer.
 *
 * READING (`cards update --from-csv`): the reader moved here from `lib/bulk.ts`
 * when #110 deleted `BulkTransaction`. It is the only half of that module that
 * survived the collapse onto the dispatch table, and a file called `bulk`
 * holding nothing bulky is a file the next reader has to open to find that out.
 */

import fs from 'fs';
import path from 'path';
import { Card } from './cards-api';

// Fields to include in exports (per spec)
export const EXPORT_FIELDS = [
  'id',
  'title',
  'description',
  'status',
  'assignees',
  'labels',
  'dueDate',
  'createdAt',
] as const;

export type ExportField = (typeof EXPORT_FIELDS)[number];

/**
 * Normalize a Card object to the canonical export shape.
 * Maps internal Card properties to spec-required field names.
 */
export interface ExportCard {
  id: string;
  title: string;
  description: string;
  status: string;
  assignees: string;
  labels: string;
  dueDate: string;
  createdAt: string;
}

export function normalizeCard(card: Card): ExportCard {
  return {
    id: card.cardId ?? '',
    title: card.name ?? '',
    description: card.description ?? '',
    status: card.status ?? '',
    assignees: (card.assignees ?? []).join(';'),
    labels: (card.tags ?? []).join(';'),
    dueDate: card.dueDate ?? '',
    createdAt: card.createdAt ?? '',
  };
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

/**
 * Escape and quote a single CSV cell value.
 * - Wraps in double-quotes
 * - Doubles any embedded double-quotes
 */
export function escapeCsvField(value: string): string {
  const str = String(value ?? '');
  // Always quote for safety (handles commas, newlines, quotes)
  const escaped = str.replace(/"/g, '""');
  return `"${escaped}"`;
}

/**
 * Convert an array of ExportCard objects to a CSV string.
 * Suitable for small in-memory exports.
 */
export function cardsToCSV(cards: ExportCard[]): string {
  const header = EXPORT_FIELDS.map(escapeCsvField).join(',');
  const rows = cards.map(card =>
    EXPORT_FIELDS.map(field => escapeCsvField(card[field])).join(',')
  );
  return [header, ...rows].join('\n') + '\n';
}

/**
 * Write a chunk to a WriteStream, awaiting the 'drain' event if the internal
 * buffer is full (backpressure-aware).
 */
async function writeChunk(stream: fs.WriteStream, chunk: string): Promise<void> {
  const ok = stream.write(chunk, 'utf8');
  if (!ok) {
    // Buffer full — wait for drain before continuing
    await new Promise<void>((resolve) => stream.once('drain', resolve));
  }
}

/**
 * Write cards as CSV to a file using streaming writes with backpressure handling.
 * Handles large exports (10k+ cards) without exhausting the I/O buffer.
 *
 * @param cards     Array of Card objects to export
 * @param filePath  Output file path
 */
export async function writeCardsCSV(cards: Card[], filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  // Ensure the output directory exists
  try {
    if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    throw new Error(`Cannot create directory '${dir}': ${(e as Error).message}`);
  }

  let stream: fs.WriteStream;
  try {
    stream = fs.createWriteStream(filePath, { encoding: 'utf8', flags: 'w' });
  } catch (e) {
    throw new Error(`Cannot open file '${filePath}' for writing: ${(e as Error).message}`);
  }

  try {
    // Write header row
    const header = EXPORT_FIELDS.map(escapeCsvField).join(',') + '\n';
    await writeChunk(stream, header);

    // Stream card rows with backpressure handling
    for (const card of cards) {
      const normalized = normalizeCard(card);
      const row = EXPORT_FIELDS.map(field => escapeCsvField(normalized[field])).join(',') + '\n';
      await writeChunk(stream, row);
    }
  } catch (writeErr) {
    stream.destroy();
    throw writeErr;
  }

  await new Promise<void>((resolve, reject) => {
    stream.on('error', (err) => reject(new Error(`Write error to '${filePath}': ${err.message}`)));
    stream.on('finish', resolve);
    stream.end();
  });
}

// ---------------------------------------------------------------------------
// Reading — `cards update --from-csv`
// ---------------------------------------------------------------------------

/**
 * The columns `cards update --from-csv` writes, in their canonical spelling.
 *
 * CLOSED, and that is the behaviour change #110 made here. The old parser in
 * `lib/bulk.ts` accepted `custom_field_*` and every other unknown header,
 * copied them into the operation's `changes`, and sent none of them — its own
 * comment said so ("stored but not directly mapped"). So a CSV naming a field
 * the CLI cannot write reported success having written nothing, which is the
 * silent-wrong-answer shape the whole write seam exists to close. An unknown
 * column refuses now, and the refusal lists the columns that exist.
 */
export const UPDATE_CSV_COLUMNS = ['card_id', 'status', 'owner', 'due_date'] as const;

/**
 * Header spellings accepted as an alias of a canonical column, matched after the
 * header is trimmed and lower-cased. `cardId`, `assignee` and `dueDate` are what
 * `cards export` and the CLI's own `--assignee` flag spell, so a round trip
 * through the export is not a rename exercise.
 */
const HEADER_ALIASES: Readonly<Record<string, string>> = {
  cardid: 'card_id',
  assignee: 'owner',
  duedate: 'due_date',
};

export interface CSVRow {
  card_id: string;
  status?: string;
  owner?: string;
  due_date?: string;
}

export interface CSVValidationError {
  /** 1-based, counting the header as row 1. `0` is a whole-file problem. */
  row: number;
  field: string;
  message: string;
}

export interface CSVParseResult {
  rows: CSVRow[];
  errors: CSVValidationError[];
}

/**
 * Parse `--from-csv` content into rows, or into the errors that stop the run.
 *
 * RFC 4180 quoting, because a column name is free to hold a comma and a
 * description is free to hold a newline.
 *
 * Required column: `card_id`. Optional: `status`, `owner`, `due_date`.
 * A `due_date` cell is required to be `YYYY-MM-DD` here rather than at the wire:
 * `TxCards.setDueDate` accepts a full ISO timestamp too, but a CSV holding
 * `04/01/2026` is a locale mix-up, not a date, and guessing which of the two
 * numbers is the month is how a batch writes the wrong day to twenty cards.
 */
export function parseCSVContent(content: string): CSVParseResult {
  const errors: CSVValidationError[] = [];
  const trimmed = content.trim();

  if (!trimmed) {
    return { rows: [], errors: [{ row: 0, field: 'file', message: 'CSV file is empty' }] };
  }

  const lines = splitCSVLines(trimmed);
  if (lines.length < 2) {
    return {
      rows: [],
      errors: [{ row: 0, field: 'file', message: 'CSV file has no data rows (only header)' }],
    };
  }

  const headers = parseCSVLine(lines[0]).map((h) => {
    const key = h.trim().toLowerCase();
    return HEADER_ALIASES[key] ?? key;
  });

  if (!headers.includes('card_id')) {
    return {
      rows: [],
      errors: [{ row: 0, field: 'card_id', message: 'CSV must include a "card_id" column' }],
    };
  }

  const known = new Set<string>(UPDATE_CSV_COLUMNS);
  for (const header of headers) {
    if (known.has(header)) continue;
    errors.push({
      row: 0,
      field: header,
      message:
        `unknown column "${header}". \`cards update --from-csv\` writes ` +
        `${UPDATE_CSV_COLUMNS.join(', ')} (aliases: cardId, assignee, dueDate). ` +
        `A column it cannot write is refused rather than ignored — the parser this ` +
        `replaced accepted custom_field_* and silently sent none of it.`,
    });
  }
  if (errors.length > 0) return { rows: [], errors };

  const rows: CSVRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue; // skip empty lines

    const values = parseCSVLine(line);
    const cells: Record<string, string> = {};
    headers.forEach((h, idx) => {
      cells[h] = (values[idx] ?? '').trim();
    });

    const rowNum = i + 1; // 1-based row number (including header)

    if (!cells.card_id) {
      errors.push({ row: rowNum, field: 'card_id', message: `Row ${rowNum}: card_id is required` });
      continue;
    }

    if (cells.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(cells.due_date)) {
      errors.push({
        row: rowNum,
        field: 'due_date',
        message: `Row ${rowNum}: due_date "${cells.due_date}" must be in YYYY-MM-DD format`,
      });
    }

    // An EMPTY cell is absent, not present-and-blank. The caller turns a row
    // into `UpdateArgs`, and there `undefined` means "leave this field alone"
    // while `""` would mean a blank name, an unassign, or — for `dueDate` — a
    // value `setDueDate` refuses outright as a measured silent no-op (#106).
    rows.push({
      card_id: cells.card_id,
      ...(cells.status ? { status: cells.status } : {}),
      ...(cells.owner ? { owner: cells.owner } : {}),
      ...(cells.due_date ? { due_date: cells.due_date } : {}),
    });
  }

  return { rows, errors };
}

/**
 * Parse a single CSV line, respecting quoted fields (RFC 4180).
 */
export function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let inQuote = false;
  let i = 0;

  while (i < line.length) {
    const ch = line[i];

    if (inQuote) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          // Escaped double-quote
          field += '"';
          i += 2;
        } else {
          // End of quoted field
          inQuote = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuote = true;
        i++;
      } else if (ch === ',') {
        fields.push(field);
        field = '';
        i++;
      } else {
        field += ch;
        i++;
      }
    }
  }
  fields.push(field);

  return fields;
}

/**
 * Split CSV content into lines, respecting quoted newlines.
 */
function splitCSVLines(content: string): string[] {
  const lines: string[] = [];
  let current = '';
  let inQuote = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '"') {
      inQuote = !inQuote;
      current += ch;
    } else if (ch === '\n' && !inQuote) {
      lines.push(current.replace(/\r$/, ''));
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) lines.push(current.replace(/\r$/, ''));
  return lines;
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

/**
 * Write cards as pretty-printed JSON to a file with backpressure handling.
 *
 * @param cards     Array of Card objects to export
 * @param filePath  Output file path
 */
export async function writeCardsJSON(cards: Card[], filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  try {
    if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    throw new Error(`Cannot create directory '${dir}': ${(e as Error).message}`);
  }

  let stream: fs.WriteStream;
  try {
    stream = fs.createWriteStream(filePath, { encoding: 'utf8', flags: 'w' });
  } catch (e) {
    throw new Error(`Cannot open file '${filePath}' for writing: ${(e as Error).message}`);
  }

  try {
    // Stream JSON array to file with backpressure handling
    await writeChunk(stream, '[\n');
    for (let i = 0; i < cards.length; i++) {
      const normalized = normalizeCard(cards[i]);
      const json = JSON.stringify(normalized, null, 2)
        .split('\n')
        .map(line => '  ' + line)
        .join('\n');
      const comma = i < cards.length - 1 ? ',' : '';
      await writeChunk(stream, json + comma + '\n');
    }
    await writeChunk(stream, ']\n');
  } catch (writeErr) {
    stream.destroy();
    throw writeErr;
  }

  await new Promise<void>((resolve, reject) => {
    stream.on('error', (err) => reject(new Error(`Write error to '${filePath}': ${err.message}`)));
    stream.on('finish', resolve);
    stream.end();
  });
}
