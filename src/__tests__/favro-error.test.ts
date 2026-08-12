/**
 * Tests for favro-error.ts — classification is on message, never on status.
 */
import { join } from 'node:path';
import { classifyFavroError, classifyThrownError, MISSING_WORDING } from '../lib/favro-error';
import { logError } from '../lib/error-handler';
import { stripAnsi } from '../lib/theme';
import { tempConfigDir } from '../test-support/config-dir';

// Never let a require below reach the real ~/.favro/config.json.
tempConfigDir('favro-error-test-');

// Required after the env is set, so dispatch's module graph cannot see a real config.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isRetryable } = require('../lib/dispatch') as typeof import('../lib/dispatch');

describe('classifyFavroError — closed not-found set', () => {
  const notFound = [
    'Access denied',
    'Access Denied',
    'Page not found',
    'Custom field does not exist',
    'Tag does not exist',
    'User does not exist',
    // Probe-verified additions — #58. Same wire, same grammar, three by-id GETs.
    'Task does not exist',
    'TaskList does not exist',
    'Comment does not exist',
    // #58/#68 — measured on DELETE /cards/{id}/dependencies/{far}. Note the
    // DIFFERENT grammatical form: "not found", not "does not exist".
    'Dependency not found',
  ];

  test.each(notFound)('%s is a not-found on 403', (message) => {
    const result = classifyFavroError(403, message);
    expect(result.kind).toBe('not-found');
    expect(result.isFailure).toBe(true);
    expect(result.message).toContain(MISSING_WORDING);
    expect(result.raw).toBe(message);
  });

  test.each(notFound)('%s is a not-found on 404 too (status-agnostic)', (message) => {
    expect(classifyFavroError(404, message).kind).toBe('not-found');
  });

  test('terminal wording never says a bare "not found"', () => {
    for (const message of notFound) {
      const rendered = classifyFavroError(403, message).message;
      expect(rendered).toContain(MISSING_WORDING);
      // "Page not found" may appear only inside the quoted raw message.
      expect(rendered.replace(`"${message}"`, '')).not.toMatch(/not found/i);
    }
  });

  test('a classified not-found is escalatable for a read caller', () => {
    expect(classifyFavroError(403, 'Access Denied').escalatableOnRead).toBe(true);
  });

  // `isRetryable` is the single source of truth. A named not-found is a
  // deterministic refusal: retrying the same request answers the same way.
  test.each(notFound)('%s is never advertised as retryable', (message) => {
    const error: any = new Error('Request failed with status code 404');
    error.response = { status: 404, data: { message } };
    expect(isRetryable('rolled-back', error)).toBe(false);
  });

  test('an unrecognised message on the same status is still retryable', () => {
    const error: any = new Error('Request failed with status code 404');
    error.response = { status: 404, data: { message: 'Some brand new 404' } };
    expect(isRetryable('rolled-back', error)).toBe(true);
  });
});

describe('classifyFavroError — other recognised messages', () => {
  test('Dependency already exists is a conflict, never escalates', () => {
    const result = classifyFavroError(403, 'Dependency already exists');
    expect(result.kind).toBe('conflict');
    expect(result.isFailure).toBe(true);
    expect(result.escalatableOnRead).toBe(false);
  });

  test('Invalid column is an input error, never escalates', () => {
    const result = classifyFavroError(400, 'Invalid column');
    expect(result.kind).toBe('invalid');
    expect(result.escalatableOnRead).toBe(false);
  });
});

describe('classifyFavroError — default refuse', () => {
  test('unrecognised 403 refuses as permission and quotes Favro verbatim', () => {
    const result = classifyFavroError(403, 'Some brand new refusal');
    expect(result.kind).toBe('permission');
    expect(result.isFailure).toBe(true);
    expect(result.message).toContain('Some brand new refusal');
    expect(result.raw).toBe('Some brand new refusal');
    expect(result.escalatableOnRead).toBe(false);
  });

  test('403 with no message still refuses as permission', () => {
    const result = classifyFavroError(403);
    expect(result.kind).toBe('permission');
    expect(result.isFailure).toBe(true);
  });

  test('unknown 500 is neither permission nor not-found', () => {
    const result = classifyFavroError(500, 'Internal error');
    expect(result.kind).toBe('unknown');
    expect(result.isFailure).toBe(true);
    expect(result.escalatableOnRead).toBe(false);
  });
});

describe('classifyFavroError — credentials', () => {
  test('401 is its own class, never permission', () => {
    const result = classifyFavroError(401, 'Unauthorized');
    expect(result.kind).toBe('credentials');
    expect(result.isFailure).toBe(true);
  });

  test('401 without a message is still credentials', () => {
    expect(classifyFavroError(401).kind).toBe('credentials');
  });
});

describe('classifyFavroError — 2xx carrying a denial', () => {
  test('202 {"message":"Access Denied"} is a failure, not a success', () => {
    const result = classifyFavroError(202, 'Access Denied');
    expect(result.isFailure).toBe(true);
    expect(result.kind).toBe('not-found');
  });

  test('clean 200 with no message is not a failure', () => {
    const result = classifyFavroError(200);
    expect(result.kind).toBe('none');
    expect(result.isFailure).toBe(false);
  });

  test('200 with an unrelated message is not a failure', () => {
    expect(classifyFavroError(200, 'Card updated').isFailure).toBe(false);
  });
});

describe('classifyThrownError', () => {
  test('reads status and message off an axios-shaped error', () => {
    const error: any = new Error('Request failed with status code 403');
    error.response = { status: 403, data: { message: 'Access Denied' } };
    expect(classifyThrownError(error)?.kind).toBe('not-found');
  });

  test('returns undefined for an error with no HTTP response', () => {
    expect(classifyThrownError(new Error('socket hang up'))).toBeUndefined();
  });
});

describe('logError surfaces response.data.message', () => {
  let stderrSpy: jest.SpyInstance;

  beforeEach(() => {
    stderrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    stderrSpy.mockRestore();
  });

  const output = () => stripAnsi(stderrSpy.mock.calls.map((call: any[]) => String(call[0])).join('\n'));

  test('renders Favro message instead of the bare axios status line', () => {
    const error: any = new Error('Request failed with status code 403');
    error.response = { status: 403, data: { message: 'Access Denied' } };
    logError(error);
    expect(output()).toContain('Access Denied');
    expect(output()).toContain(MISSING_WORDING);
    expect(output()).not.toContain('Request failed with status code 403');
  });

  test('quotes an unrecognised 403 message verbatim', () => {
    const error: any = new Error('Request failed with status code 403');
    error.response = { status: 403, data: { message: 'Widget is read only' } };
    logError(error);
    expect(output()).toContain('Widget is read only');
  });

  test('leaves a plain Error untouched', () => {
    logError(new Error('something went wrong'));
    expect(output()).toContain('something went wrong');
  });
});
