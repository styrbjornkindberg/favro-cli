/**
 * Tests for Bulk Operation Framework (lib/bulk.ts)
 * CLA-1781 / FAVRO-019
 */
import {
  parseCSVContent,
  parseCSVLine,
  csvRowToBulkOperation,
  buildBulkUpdateRequest,
  buildBulkRollbackRequest,
  BulkTransaction,
  BulkOperation,
  formatBulkSummary,
  formatBulkPreview,
} from '../../lib/bulk';
import CardsAPI, { Card } from '../../lib/cards-api';
import FavroHttpClient from '../../lib/http-client';

jest.mock('../../lib/cards-api');
jest.mock('../../lib/http-client');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeOp(overrides: Partial<BulkOperation> = {}): BulkOperation {
  return {
    type: 'update',
    cardId: 'card-1',
    cardName: 'Test Card',
    changes: { status: 'Done' },
    previousState: { status: 'Backlog' },
    status: 'pending',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// CSV Parsing
// ---------------------------------------------------------------------------

describe('parseCSVLine', () => {
  it('parses simple comma-separated values', () => {
    expect(parseCSVLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('parses quoted fields with commas', () => {
    expect(parseCSVLine('"hello, world",b')).toEqual(['hello, world', 'b']);
  });

  it('handles escaped double-quotes inside quoted fields', () => {
    expect(parseCSVLine('"he said ""hi""",b')).toEqual(['he said "hi"', 'b']);
  });

  it('handles empty fields', () => {
    expect(parseCSVLine('a,,c')).toEqual(['a', '', 'c']);
  });

  it('handles trailing comma', () => {
    expect(parseCSVLine('a,b,')).toEqual(['a', 'b', '']);
  });
});

describe('parseCSVContent', () => {
  it('returns error for empty content', () => {
    const result = parseCSVContent('');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.rows.length).toBe(0);
  });

  it('returns error for header-only CSV', () => {
    const result = parseCSVContent('card_id,status,owner');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.rows.length).toBe(0);
  });

  it('returns error when card_id column is missing', () => {
    const result = parseCSVContent('status,owner\nDone,alice');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].field).toBe('card_id');
  });

  it('parses valid CSV with card_id', () => {
    const csv = 'card_id,status,owner\ncard-1,Done,alice\ncard-2,In Progress,bob';
    const result = parseCSVContent(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].card_id).toBe('card-1');
    expect(result.rows[0].status).toBe('Done');
    expect(result.rows[0].owner).toBe('alice');
    expect(result.rows[1].card_id).toBe('card-2');
  });

  it('parses CSV with due_date column', () => {
    const csv = 'card_id,due_date\ncard-1,2026-04-01';
    const result = parseCSVContent(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.rows[0].due_date).toBe('2026-04-01');
  });

  it('returns error for invalid due_date format', () => {
    const csv = 'card_id,due_date\ncard-1,04/01/2026';
    const result = parseCSVContent(csv);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].field).toBe('due_date');
  });

  it('skips rows with missing card_id but continues with valid rows', () => {
    const csv = 'card_id,status\n,Done\ncard-2,Backlog';
    const result = parseCSVContent(csv);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].card_id).toBe('card-2');
  });

  it('skips blank lines', () => {
    const csv = 'card_id,status\ncard-1,Done\n\ncard-3,Backlog';
    const result = parseCSVContent(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(2);
  });

  it('handles quoted fields in data rows', () => {
    const csv = 'card_id,status\n"card-1","In Progress"';
    const result = parseCSVContent(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.rows[0].card_id).toBe('card-1');
    expect(result.rows[0].status).toBe('In Progress');
  });

  it('parses custom_field columns', () => {
    const csv = 'card_id,custom_field_priority\ncard-1,high';
    const result = parseCSVContent(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.rows[0]['custom_field_priority']).toBe('high');
  });

  it('handles Windows-style CRLF line endings', () => {
    const csv = 'card_id,status\r\ncard-1,Done\r\ncard-2,Backlog';
    const result = parseCSVContent(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// csvRowToBulkOperation
// ---------------------------------------------------------------------------

describe('csvRowToBulkOperation', () => {
  it('maps card_id correctly', () => {
    const op = csvRowToBulkOperation({ card_id: 'card-123', status: 'Done' });
    expect(op.cardId).toBe('card-123');
    expect(op.type).toBe('update');
    expect(op.status).toBe('pending');
  });

  it('maps status to changes', () => {
    const op = csvRowToBulkOperation({ card_id: 'card-1', status: 'In Progress' });
    expect(op.changes.status).toBe('In Progress');
  });

  it('maps owner to assignees', () => {
    const op = csvRowToBulkOperation({ card_id: 'card-1', owner: 'alice' });
    expect(op.changes.assignees).toEqual(['alice']);
  });

  it('maps due_date to dueDate', () => {
    const op = csvRowToBulkOperation({ card_id: 'card-1', due_date: '2026-04-01' });
    expect(op.changes.dueDate).toBe('2026-04-01');
  });

  it('omits undefined optional fields', () => {
    const op = csvRowToBulkOperation({ card_id: 'card-1' });
    expect(op.changes.status).toBeUndefined();
    expect(op.changes.assignees).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// buildBulkUpdateRequest / buildBulkRollbackRequest
// ---------------------------------------------------------------------------

describe('buildBulkUpdateRequest', () => {
  it('maps status change', () => {
    const op = makeOp({ changes: { status: 'Done' } });
    const req = buildBulkUpdateRequest(op);
    expect(req.status).toBe('Done');
  });

  it('maps assignees change', () => {
    const op = makeOp({ changes: { assignees: ['alice', 'bob'] } });
    const req = buildBulkUpdateRequest(op);
    expect(req.assignees).toEqual(['alice', 'bob']);
  });

  it('maps name change', () => {
    const op = makeOp({ changes: { name: 'New Title' } });
    const req = buildBulkUpdateRequest(op);
    expect(req.name).toBe('New Title');
  });

  it('maps tags change', () => {
    const op = makeOp({ changes: { tags: ['bug', 'urgent'] } });
    const req = buildBulkUpdateRequest(op);
    expect(req.tags).toEqual(['bug', 'urgent']);
  });

  it('does not include undefined fields', () => {
    const op = makeOp({ changes: { status: 'Done' } });
    const req = buildBulkUpdateRequest(op);
    expect(req.name).toBeUndefined();
    expect(req.assignees).toBeUndefined();
  });
});

describe('buildBulkRollbackRequest', () => {
  it('restores previous status', () => {
    const op = makeOp({ previousState: { status: 'Backlog' } });
    const req = buildBulkRollbackRequest(op);
    expect(req.status).toBe('Backlog');
  });

  it('restores previous assignees', () => {
    const op = makeOp({ previousState: { assignees: ['alice'] } });
    const req = buildBulkRollbackRequest(op);
    expect(req.assignees).toEqual(['alice']);
  });

  it('handles no previous state', () => {
    const op = makeOp({ previousState: undefined });
    const req = buildBulkRollbackRequest(op);
    expect(req.status).toBeUndefined();
    expect(req.assignees).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// BulkTransaction
// ---------------------------------------------------------------------------

describe('BulkTransaction', () => {
  let mockApi: jest.Mocked<CardsAPI>;

  beforeEach(() => {
    jest.clearAllMocks();
    const mockClient = new FavroHttpClient() as jest.Mocked<FavroHttpClient>;
    mockApi = new CardsAPI(mockClient) as jest.Mocked<CardsAPI>;
  });

  it('preview() returns dry-run result without executing', async () => {
    const tx = new BulkTransaction(mockApi);
    tx.add(makeOp({ cardId: 'card-1' }));
    tx.add(makeOp({ cardId: 'card-2' }));

    const result = tx.preview();
    expect(result.total).toBe(2);
    expect(result.success).toBe(0);
    expect(result.failure).toBe(0);
    expect(result.operations).toHaveLength(2);
    expect(mockApi.updateCard).not.toHaveBeenCalled();
  });

  it('execute() with dryRun=true returns preview without API calls', async () => {
    const tx = new BulkTransaction(mockApi);
    tx.add(makeOp({ cardId: 'card-1' }));

    const result = await tx.execute({ dryRun: true });
    expect(result.total).toBe(1);
    expect(mockApi.updateCard).not.toHaveBeenCalled();
  });

  it('execute() updates all cards on success', async () => {
    const card: Card = {
      cardId: 'card-1', name: 'Test', status: 'Done', createdAt: new Date().toISOString()
    };
    mockApi.updateCard.mockResolvedValue(card);

    const tx = new BulkTransaction(mockApi);
    tx.add(makeOp({ cardId: 'card-1' }));
    tx.add(makeOp({ cardId: 'card-2' }));

    const result = await tx.execute();
    expect(result.success).toBe(2);
    expect(result.failure).toBe(0);
    expect(result.rolledBack).toBe(0);
    expect(mockApi.updateCard).toHaveBeenCalledTimes(2);
  });

  it('execute() rolls back on failure (atomic semantics)', async () => {
    const card: Card = { cardId: 'card-1', name: 'Test', status: 'Done', createdAt: new Date().toISOString() };
    mockApi.updateCard
      .mockResolvedValueOnce(card)          // card-1 succeeds
      .mockRejectedValueOnce(new Error('API error'))  // card-2 fails
      .mockResolvedValue(card);              // rollback succeeds

    const tx = new BulkTransaction(mockApi);
    tx.add(makeOp({ cardId: 'card-1', previousState: { status: 'Backlog' } }));
    tx.add(makeOp({ cardId: 'card-2' }));
    tx.add(makeOp({ cardId: 'card-3' }));

    const result = await tx.execute();
    expect(result.failure).toBeGreaterThan(0);
    expect(result.success).toBe(0);
    expect(result.rolledBack).toBe(1); // card-1 was rolled back

    // 2 updates (card-1 success, card-2 fail) + 1 rollback (card-1)
    expect(mockApi.updateCard).toHaveBeenCalledTimes(3);
  });

  it('execute() stops on first failure (no more updates after failure)', async () => {
    mockApi.updateCard
      .mockRejectedValueOnce(new Error('fail'));

    const tx = new BulkTransaction(mockApi);
    tx.add(makeOp({ cardId: 'card-1' }));
    tx.add(makeOp({ cardId: 'card-2' })); // should never be called

    await tx.execute();
    // Only 1 update attempt (card-1), not card-2
    expect(mockApi.updateCard).toHaveBeenCalledTimes(1);
  });

  it('getOperations() returns all added operations', () => {
    const tx = new BulkTransaction(mockApi);
    tx.add(makeOp({ cardId: 'card-1' }));
    tx.add(makeOp({ cardId: 'card-2' }));
    expect(tx.getOperations()).toHaveLength(2);
  });

  it('addAll() adds multiple operations', () => {
    const tx = new BulkTransaction(mockApi);
    tx.addAll([makeOp({ cardId: 'card-1' }), makeOp({ cardId: 'card-2' })]);
    expect(tx.getOperations()).toHaveLength(2);
  });

  it('formatDryRunJSON() returns valid JSON with dryRun flag', () => {
    const tx = new BulkTransaction(mockApi);
    tx.add(makeOp({ cardId: 'card-1', cardName: 'My Card', changes: { status: 'Done' } }));
    const json = tx.formatDryRunJSON();
    const parsed = JSON.parse(json);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.total).toBe(1);
    expect(parsed.operations[0].cardId).toBe('card-1');
    expect(parsed.operations[0].changes.status).toBe('Done');
  });

  it('empty transaction execute() succeeds with zero counts', async () => {
    const tx = new BulkTransaction(mockApi);
    const result = await tx.execute();
    expect(result.total).toBe(0);
    expect(result.success).toBe(0);
    expect(result.failure).toBe(0);
    expect(mockApi.updateCard).not.toHaveBeenCalled();
  });

  it('rollback continues even if one rollback fails', async () => {
    const card: Card = { cardId: 'card-1', name: 'Test', status: 'Done', createdAt: new Date().toISOString() };
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mockApi.updateCard
      .mockResolvedValueOnce(card)  // card-1 succeeds
      .mockResolvedValueOnce(card)  // card-2 succeeds
      .mockRejectedValueOnce(new Error('fail'))  // card-3 fails
      .mockRejectedValueOnce(new Error('rollback-fail'))  // rollback of card-2 fails
      .mockResolvedValue(card);     // rollback of card-1 succeeds

    const tx = new BulkTransaction(mockApi);
    tx.add(makeOp({ cardId: 'card-1', previousState: { status: 'Backlog' } }));
    tx.add(makeOp({ cardId: 'card-2', previousState: { status: 'Backlog' } }));
    tx.add(makeOp({ cardId: 'card-3' }));

    const result = await tx.execute();
    expect(result.failure).toBeGreaterThan(0);
    stderrSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// formatBulkSummary
// ---------------------------------------------------------------------------

describe('formatBulkSummary', () => {
  it('shows success summary on all-success result', () => {
    const result = {
      total: 3, success: 3, failure: 0, skipped: 0, rolledBack: 0, errors: [], operations: [],
    };
    const text = formatBulkSummary(result);
    expect(text).toContain('✅');
    expect(text).toContain('Success: 3');
    expect(text).toContain('Failed: 0');
  });

  it('shows failure summary and errors on failure', () => {
    const result = {
      total: 2,
      success: 0,
      failure: 2,
      skipped: 0,
      rolledBack: 1,
      errors: [{ cardId: 'card-1', cardName: 'My Card', error: 'API timeout' }],
      operations: [],
    };
    const text = formatBulkSummary(result);
    expect(text).toContain('❌');
    expect(text).toContain('rolled back');
    expect(text).toContain('card-1');
    expect(text).toContain('API timeout');
  });

  it('shows skipped count when > 0', () => {
    const result = {
      total: 5, success: 5, failure: 0, skipped: 2, rolledBack: 0, errors: [], operations: [],
    };
    const text = formatBulkSummary(result);
    expect(text).toContain('Skipped: 2');
  });
});

// ---------------------------------------------------------------------------
// formatBulkPreview
// ---------------------------------------------------------------------------

describe('formatBulkPreview', () => {
  it('shows preview header with count', () => {
    const ops = [makeOp({ cardId: 'card-1', cardName: 'My Card', changes: { status: 'Done' } })];
    const text = formatBulkPreview(ops, 'Preview');
    expect(text).toContain('Preview');
    expect(text).toContain('1 card');
    expect(text).toContain('card-1');
    expect(text).toContain('My Card');
  });

  it('truncates long card names', () => {
    const longName = 'A'.repeat(80);
    const ops = [makeOp({ cardId: 'card-1', cardName: longName })];
    const text = formatBulkPreview(ops, 'Preview');
    expect(text).toContain('...');
  });

  it('uses cardId when cardName is missing', () => {
    const ops = [makeOp({ cardId: 'card-xyz', cardName: undefined })];
    const text = formatBulkPreview(ops, 'Preview');
    expect(text).toContain('card-xyz');
  });

  it('shows plural for multiple cards', () => {
    const ops = [makeOp({ cardId: 'c-1' }), makeOp({ cardId: 'c-2' })];
    const text = formatBulkPreview(ops, 'Preview');
    expect(text).toContain('2 cards');
  });
});

// ---------------------------------------------------------------------------
// Stress test: 1000+ operations (validate framework handles large batches)
// ---------------------------------------------------------------------------

describe('BulkTransaction stress test', () => {
  it('preview() handles 1000 operations efficiently', () => {
    const mockClient = new FavroHttpClient() as jest.Mocked<FavroHttpClient>;
    const api = new CardsAPI(mockClient) as jest.Mocked<CardsAPI>;
    const tx = new BulkTransaction(api);

    const ops: BulkOperation[] = Array.from({ length: 1000 }, (_, i) => makeOp({
      cardId: `card-${i}`,
      cardName: `Card ${i}`,
      changes: { status: 'Done' },
    }));
    tx.addAll(ops);

    const result = tx.preview();
    expect(result.total).toBe(1000);
    expect(result.operations).toHaveLength(1000);
  });

  it('parseCSVContent handles 1000+ rows', () => {
    const header = 'card_id,status,owner,due_date\n';
    const rows = Array.from({ length: 1000 }, (_, i) =>
      `card-${i},Done,alice,2026-04-${String((i % 28) + 1).padStart(2, '0')}`
    ).join('\n');
    const csv = header + rows;

    const result = parseCSVContent(csv);
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(1000);
  });
});
