/**
 * CSV and JSON Export Utilities
 * FAVRO-009: Cards Export Command
 *
 * Supports:
 * - JSON export: array of card objects, pretty-printed, UTF-8
 * - CSV export: headers in first row, quoted fields, escape handling
 * - Streaming writes for large exports (10k+ cards)
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
  'updatedAt',
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
  updatedAt: string;
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
    updatedAt: card.updatedAt ?? '',
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
