/**
 * Tests for error-handler.ts
 * CLA-1771 FAVRO-011: Error Handling & User Feedback
 */
import {
  logError,
  suggestBoard,
  notFoundError,
  invalidDateError,
  rateLimitMessage,
  missingApiKeyError,
  ErrorFormatter,
} from '../lib/error-handler';

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
    expect(stderrSpy).toHaveBeenCalledWith('Error: something went wrong');
    // Should only be called once (no stack trace)
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  test('formats string error', () => {
    logError('plain string error');
    expect(stderrSpy).toHaveBeenCalledWith('Error: plain string error');
  });

  test('shows stack trace in verbose mode', () => {
    const err = new Error('verbose error');
    logError(err, true);
    expect(stderrSpy).toHaveBeenCalledWith('Error: verbose error');
    // In verbose mode, stack trace should also be printed
    const calls = stderrSpy.mock.calls.map((c: any[]) => c[0]);
    expect(calls.some((c: any) => typeof c === 'string' && c.includes('Stack trace:'))).toBe(true);
  });

  test('does NOT show stack trace in normal mode', () => {
    const err = new Error('normal mode error');
    logError(err, false);
    const calls = stderrSpy.mock.calls.map((c: any[]) => c[0]);
    expect(calls.some((c: any) => typeof c === 'string' && c.includes('Stack trace:'))).toBe(false);
  });

  test('handles non-Error objects', () => {
    logError({ code: 42 });
    expect(stderrSpy).toHaveBeenCalledWith('Error: [object Object]');
  });
});

describe('suggestBoard', () => {
  test('returns helpful message with available boards', () => {
    const msg = suggestBoard('Q2-Dev', ['Q2-Marketing', 'Q2-Eng', 'Q1-Archive']);
    expect(msg).toBe("Board 'Q2-Dev' not found. Available: Q2-Marketing, Q2-Eng, Q1-Archive");
  });

  test('returns message without list when no boards available', () => {
    const msg = suggestBoard('Missing', []);
    expect(msg).toBe("Board 'Missing' not found. No boards available.");
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
  test('includes retry seconds when provided', () => {
    const msg = rateLimitMessage(30);
    expect(msg).toContain('30 seconds');
    expect(msg.toLowerCase()).toContain('rate limit');
  });

  test('generic message without seconds', () => {
    const msg = rateLimitMessage();
    expect(msg.toLowerCase()).toContain('rate limit');
  });
});

describe('missingApiKeyError', () => {
  test('tells user to run auth login', () => {
    const msg = missingApiKeyError();
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
    expect(stderrSpy).toHaveBeenCalledWith('Error: test error');
    const calls = stderrSpy.mock.calls.map((c: any[]) => c[0]);
    expect(calls.some((c: any) => typeof c === 'string' && c.includes('Stack trace:'))).toBe(false);
  });

  test('log() in verbose mode shows stack trace', () => {
    const fmt = new ErrorFormatter(true);
    fmt.log(new Error('verbose error'));
    const calls = stderrSpy.mock.calls.map((c: any[]) => c[0]);
    expect(calls.some((c: any) => typeof c === 'string' && c.includes('Stack trace:'))).toBe(true);
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
