/**
 * Tests for error-handler.ts
 * CLA-1771 FAVRO-011: Error Handling & User Feedback
 */
import {
  logError,
  notFoundError,
  invalidDateError,
  rateLimitMessage,
  missingApiKeyError,
  ErrorFormatter,
} from '../lib/error-handler';
import { stripAnsi } from '../lib/theme';

describe('logError', () => {
  let stderrSpy: jest.SpyInstance;

  beforeEach(() => {
    stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    stderrSpy.mockRestore();
  });

  test('formats Error instance without stack trace in normal mode', () => {
    logError(new Error('something went wrong'));
    const output = stripAnsi(stderrSpy.mock.calls.map((c: any[]) => c[0]).join(''));
    expect(output).toContain('Error:');
    expect(output).toContain('something went wrong');
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  test('formats string error', () => {
    logError('plain string error');
    const output = stripAnsi(stderrSpy.mock.calls.map((c: any[]) => c[0]).join(''));
    expect(output).toContain('Error:');
    expect(output).toContain('plain string error');
  });

  test('shows stack trace in verbose mode', () => {
    const err = new Error('verbose error');
    logError(err, true);
    const output = stderrSpy.mock.calls.map((c: any[]) => stripAnsi(String(c[0]))).join('\n');
    expect(output).toContain('Error:');
    expect(output).toContain('verbose error');
    expect(output).toContain('Stack trace:');
  });

  test('does NOT show stack trace in normal mode', () => {
    const err = new Error('normal mode error');
    logError(err, false);
    const calls = stderrSpy.mock.calls.map((c: any[]) => c[0]);
    expect(calls.some((c: any) => typeof c === 'string' && c.includes('Stack trace:'))).toBe(false);
  });

  test('handles non-Error objects', () => {
    logError({ code: 42 });
    const output = stripAnsi(stderrSpy.mock.calls.map((c: any[]) => c[0]).join(''));
    expect(output).toContain('Error:');
    expect(output).toContain('[object Object]');
  });

  // ─── the scope heading, and the de-duplication under it (#133) ─────────────
  //
  // `logError` heads a `ScopeError` with `Scope violation:` and then strips that
  // same prefix off the message so it is not printed twice. Both conjuncts of
  // the strip were mutated separately: dropping the `.name` check failed three
  // tests, dropping the `startsWith` check passed all 3070 — so these arms
  // exist because the second one had nothing holding it.
  //
  // A ScopeError is built here from `{ name }` rather than imported, because
  // importing `safety.ts` for a name string would pull the whole write-guardrail
  // module into a formatting test. The read under test IS the string.
  const named = (name: string, message: string): Error =>
    Object.assign(new Error(message), { name });

  const line = (): string =>
    stripAnsi(stderrSpy.mock.calls.map((c: any[]) => String(c[0])).join('\n'));

  test('heads a ScopeError with Scope violation and prints its body once', () => {
    logError(named('ScopeError', 'Scope violation: board "b" is not in locked collection "L".'));
    expect(line()).toBe('✗ Scope violation: board "b" is not in locked collection "L".');
  });

  test('keeps a ScopeError message that does NOT carry the prefix intact', () => {
    // THE FOREIGN ARM, and the one the surviving mutation needed. With the
    // `startsWith` conjunct gone the slice runs unconditionally on any
    // ScopeError, so a refusal worded without the prefix loses its first 16
    // characters silently — 'the lock refuses this' became 'ck refuses this'.
    // Every ScopeError in `safety.ts` happens to carry the prefix today, which
    // is exactly why nothing failed.
    logError(named('ScopeError', 'the lock refuses this'));
    expect(line()).toBe('✗ Scope violation: the lock refuses this');
  });

  test('does not head a NON-scope error with Scope violation, whatever it says', () => {
    // The other polarity. A bare `Error` whose message opens with the same words
    // — `assertScope`'s wording reaches `cli.ts` through mocked `safety` modules
    // in four command suites — keeps `Error:` and keeps its whole message.
    logError(new Error('Scope violation: something else built this'));
    expect(line()).toBe('✗ Error: Scope violation: something else built this');
  });
});

describe('notFoundError', () => {
  test('formats not found message with available list', () => {
    const msg = notFoundError('Collection', 'Q2-Dev', ['Q2-Marketing', 'Q1-Archive']);
    expect(msg).toContain("Collection 'Q2-Dev' not found.");
    expect(msg).toContain('Q2-Marketing');
    expect(msg).toContain('Q1-Archive');
  });

  test('formats not found message without list', () => {
    const msg = notFoundError('Board', 'Unknown', []);
    expect(msg).toBe("Board 'Unknown' not found.");
  });
});

describe('invalidDateError', () => {
  test('returns format hint matching spec exactly', () => {
    const msg = invalidDateError('25-12-2026');
    expect(msg).toBe('Invalid date format. Use YYYY-MM-DD');
    expect(msg).toContain('YYYY-MM-DD');
  });
});

describe('rateLimitMessage', () => {
  test('rateLimitMessage includes retry seconds when provided', () => {
    const msg = stripAnsi(rateLimitMessage(30));
    expect(msg).toContain('30');
    expect(msg.toLowerCase()).toContain('rate limit');
  });

  test('rateLimitMessage generic message without seconds', () => {
    const msg = stripAnsi(rateLimitMessage());
    expect(msg.toLowerCase()).toContain('rate limit');
  });
});

describe('missingApiKeyError', () => {
  test('tells user to run auth login', () => {
    const msg = stripAnsi(missingApiKeyError());
    expect(msg).toContain('favro auth login');
    expect(msg.toLowerCase()).toContain('api key');
  });
});

describe('ErrorFormatter', () => {
  let stderrSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
  });
  afterEach(() => {
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  test('log() in normal mode shows message without stack trace', () => {
    const fmt = new ErrorFormatter(false);
    fmt.log(new Error('test error'));
    const output = stderrSpy.mock.calls.map((c: any[]) => stripAnsi(String(c[0]))).join('\n');
    expect(output).toContain('Error:');
    expect(output).toContain('test error');
    expect(output).not.toContain('Stack trace:');
  });

  test('log() in verbose mode shows stack trace', () => {
    const fmt = new ErrorFormatter(true);
    fmt.log(new Error('verbose error'));
    const output = stderrSpy.mock.calls.map((c: any[]) => stripAnsi(String(c[0]))).join('\n');
    expect(output).toContain('Stack trace:');
  });

  test('fatal() logs error and calls process.exit(1)', () => {
    const fmt = new ErrorFormatter(false);
    expect(() => fmt.fatal(new Error('fatal error'))).toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('notFound() returns helpful message', () => {
    const fmt = new ErrorFormatter();
    const msg = fmt.notFound('Board', 'Sprint-1', ['Sprint-2', 'Sprint-3']);
    expect(msg).toContain("Board 'Sprint-1' not found.");
    expect(msg).toContain('Sprint-2');
  });
});
