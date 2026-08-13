/**
 * `reportDispatch` renders the retry advice from `retryable`, and the detail
 * from the outcome and the orphan list.
 *
 * It used to derive the advice from the outcome instead, on the reasoning that
 * `retryable` was the summary a wire-level misread could set wrong. #66 settled
 * that the other way: the misread was the bug, `retryable` is now the table's
 * one derivation (`isRetryable`), and the outcome CANNOT carry the answer —
 * a deterministic refusal unwinds perfectly cleanly and is still not worth
 * repeating, and the three-outcome contract must not grow a fourth state.
 *
 * The other half of the contract is unchanged: the "Left behind:" header is a
 * promise of a list, so it is only printed when there is one.
 */
import { previewOnly, reportDispatch } from '../lib/report-dispatch';
import { DispatchResult, RefusalError } from '../lib/dispatch';

const result = (over: Partial<DispatchResult>): DispatchResult => ({
  intent: 'retag',
  outcome: 'rolled-back',
  retryable: true,
  error: 'boom',
  ...over,
});

let lines: string[];
let spy: jest.SpyInstance;

beforeEach(() => {
  lines = [];
  spy = jest.spyOn(console, 'error').mockImplementation((m?: unknown) => { lines.push(String(m)); });
});
afterEach(() => spy.mockRestore());

it('a retryable rollback reads as safe to retry', () => {
  expect(reportDispatch(result({ outcome: 'rolled-back', retryable: true }))).toBe(true);
  expect(lines.join('\n')).toContain('safe to retry');
  expect(lines.join('\n')).not.toContain('Left behind');
});

it('a rolled-back result that is NOT retryable says so, and does not claim wreckage', () => {
  // The #66 case a caller sees: the unwind was clean — no orphans, nothing to
  // go and clear up — but the failure was deterministic, so the advice is "do
  // NOT retry" WITHOUT the "rollback incomplete" wording, which would send the
  // reader looking for leftovers that are not there.
  expect(reportDispatch(result({ outcome: 'rolled-back', retryable: false }))).toBe(true);
  const out = lines.join('\n');
  expect(out).toContain('NOT retry');
  expect(out).not.toContain('safe to retry');
  expect(out).not.toContain('Rollback incomplete');
  expect(out).not.toContain('Left behind');
});

it('rollback-incomplete with no orphans does not claim wreckage that does not exist', () => {
  reportDispatch(result({ outcome: 'rollback-incomplete', retryable: false, orphans: [] }));
  expect(lines.join('\n')).toContain('do NOT retry');
  expect(lines.join('\n')).not.toContain('Left behind');
});

it('rollback-incomplete WITH orphans lists them under the header', () => {
  reportDispatch(result({
    outcome: 'rollback-incomplete',
    // `isRetryable` cannot produce true here — an unwind that left something
    // behind is never retryable — so the fixture states the reachable shape.
    retryable: false,
    orphans: [{ cause: 'compensation-failed', card: 'c1', reason: 'Insufficient privileges' } as never],
  }));
  expect(lines.join('\n')).toContain('Left behind:');
  expect(lines.join('\n')).toContain('Insufficient privileges');
});

describe('the reporter never promises safety over an incomplete unwind', () => {
  // `reportDispatch` is a public presentation function taking ANY
  // `DispatchResult`, so "`isRetryable` cannot produce this" is not a guard —
  // it is an assumption about one caller. A wrong `retryable` on an unwind that
  // left something behind must not print "nothing was left behind": the reader
  // would retry over wreckage they were never shown. The advice is therefore
  // gated on the outcome that actually means a clean unwind.

  it('does not read as safe to retry when orphans exist, whatever retryable claims', () => {
    reportDispatch(result({
      outcome: 'rollback-incomplete',
      retryable: true,
      orphans: [{ cause: 'compensation-failed', card: 'c1', reason: 'Insufficient privileges' } as never],
    }));
    const out = lines.join('\n');
    expect(out).not.toContain('safe to retry');
    expect(out).not.toContain('nothing was left behind');
    // and the wreckage is still reported, not swallowed
    expect(out).toContain('Left behind:');
    expect(out).toContain('Insufficient privileges');
  });

  it('does not read as safe to retry on an incomplete unwind with an empty orphan list', () => {
    reportDispatch(result({ outcome: 'rollback-incomplete', retryable: true, orphans: [] }));
    const out = lines.join('\n');
    expect(out).not.toContain('safe to retry');
    expect(out).toContain('do NOT retry');
    expect(out).not.toContain('Left behind');
  });
});

/**
 * `previewOnly` renders an intent's preview WITHOUT dispatching, for the one case
 * where dispatching to reach a preview costs a caller money it should not owe: a
 * `--dry-run` with no scope lock configured (#109).
 *
 * The guard is the interesting half. All three callers gate on
 * `!scopeCollectionId` correctly, and that gate is invisible from inside — a
 * fourth call site calling this unconditionally would rebuild #155's hole
 * exactly, a preview promising a write the lock refuses.
 */
describe('previewOnly refuses to preview around a configured lock', () => {
  // The preview goes to stdout, not to the error stream the arms above read.
  let logged: string[];
  let logSpy: jest.SpyInstance;
  beforeEach(() => {
    logged = [];
    logSpy = jest.spyOn(console, 'log').mockImplementation((m?: unknown) => { logged.push(String(m)); });
  });
  afterEach(() => logSpy.mockRestore());

  it('throws a RefusalError when a lock is configured, and prints nothing', () => {
    expect(() => previewOnly('update', { card: 'c1', name: 'x' }, { scopeCollectionId: 'coll-1' }))
      .toThrow(RefusalError);
    expect(() => previewOnly('update', { card: 'c1', name: 'x' }, { scopeCollectionId: 'coll-1' }))
      .toThrow(/#155/);
    expect(logged).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('renders the intent\'s own lines when nothing is locked — the falsifying half', () => {
    previewOnly('update', { card: 'c1', name: 'x' }, {});
    const out = logged.join('\n');
    expect(out).toContain('[dry-run] update card c1');
    expect(out).toContain('name: "x"');
  });

  it('an unknown intent refuses rather than previewing nothing at all', () => {
    expect(() => previewOnly('no-such-intent', {}, undefined)).toThrow(/No such intent/);
  });
});
