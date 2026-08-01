/**
 * `reportDispatch` renders the OUTCOME, not the `retryable` summary.
 *
 * `retryable` is one derivation of the outcome, and a wire-level misread can set
 * it wrong (#66) — the retry advice must not move when it does. The other half
 * of the contract: the "Left behind:" header is a promise of a list, so it is
 * only printed when there is one.
 */
import { reportDispatch } from '../lib/report-dispatch';
import { DispatchResult } from '../lib/dispatch';

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

it('a rolled-back result reads as safe to retry even when retryable says otherwise', () => {
  expect(reportDispatch(result({ outcome: 'rolled-back', retryable: false }))).toBe(true);
  expect(lines.join('\n')).toContain('safe to retry');
  expect(lines.join('\n')).not.toContain('Left behind');
});

it('rollback-incomplete with no orphans does not claim wreckage that does not exist', () => {
  reportDispatch(result({ outcome: 'rollback-incomplete', retryable: false, orphans: [] }));
  expect(lines.join('\n')).toContain('do NOT retry');
  expect(lines.join('\n')).not.toContain('Left behind');
});

it('rollback-incomplete WITH orphans lists them under the header', () => {
  reportDispatch(result({
    outcome: 'rollback-incomplete',
    retryable: true,
    orphans: [{ cause: 'compensation-failed', card: 'c1', reason: 'Insufficient privileges' } as never],
  }));
  expect(lines.join('\n')).toContain('Left behind:');
  expect(lines.join('\n')).toContain('Insufficient privileges');
});
