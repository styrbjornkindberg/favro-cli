/**
 * Tests for favro-error.ts — classification is on message, never on status.
 */
import { join } from 'node:path';
import {
  classifyFavroError,
  classifyThrownError,
  isTransientStatus,
  isWireFailure,
  MISSING_WORDING,
  WireRefusalError,
} from '../lib/favro-error';
import { RefusalError } from '../lib/refusal';
import { logError } from '../lib/error-handler';
import { stripAnsi } from '../lib/theme';
import { tempConfigDir } from '../test-support/config-dir';

// Never let a require below reach the real ~/.favro/config.json.
tempConfigDir('favro-error-test-');

// Required after the env is set, so dispatch's module graph cannot see a real config.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isRetryable, retryAdvice } = require('../lib/dispatch') as typeof import('../lib/dispatch');

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

  // An unrecognised message is decided by STATUS now (#162). It used to be read
  // as transient whatever the status, which is what put `"retryable": true` on a
  // 400 — see the live case two tests down.
  test('an unrecognised message on a 404 is NOT retryable — the status names the request', () => {
    const error: any = new Error('Request failed with status code 404');
    error.response = { status: 404, data: { message: 'Some brand new 404' } };
    expect(isRetryable('rolled-back', error)).toBe(false);
  });

  // The other half of the same rule, so inverting the gate cannot pass by
  // answering `false` to everything: these four are exactly what `HttpClient`
  // already retries in-process, and `isTransientStatus` is the shared expression.
  test.each([408, 429, 500, 503])('an unrecognised message on a %i is still retryable', (status) => {
    const error: any = new Error(`Request failed with status code ${status}`);
    error.response = { status, data: { message: 'Some brand new failure' } };
    expect(isRetryable('rolled-back', error)).toBe(true);
  });

  // The live case (#162 item 2), measured against the real API on 2026-08-13:
  //   PUT /cards/{cardId} {"name": <1115 chars>}
  //     → 400 {"message":"Card can't have more than 1024 characters."}
  // Two identical runs, identical answer, and the CLI reported `retryable: true`
  // with *"safe to retry"* on both — while `favro help issue-tracker` tells
  // agents to "read the 'retryable' field, never the outcome".
  test('the live 400 that reported retryable twice running', () => {
    const error: any = new Error('Request failed with status code 400');
    error.isAxiosError = true;
    error.response = { status: 400, data: { message: "Card can't have more than 1024 characters." } };
    expect(isRetryable('rolled-back', error)).toBe(false);
    expect(retryAdvice('rolled-back', error)).toBe(false);
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

  // The fail-closed rule (#165). A 2xx carrying a top-level message is a
  // refusal whether or not the closed sets above name it — measured, 28 of 28
  // message-carrying 2xx were denials, and 47 of 47 successful 2xx carried no
  // message at all. Seven of the ten measured denial messages are unnamed, so
  // the arm below is the majority of the family and not an edge.
  test.each([
    ['Lanes are not enabled on this widget'],
    ['Cannot unset main status field value'],
    ['Start date cannot be later than due date'],
    ['Invalid custom field item'],
    ['Invalid status value'],
    ['Match failed'],
    ['Invalid date'],
    // The eleventh, found by DRIVING this rule rather than by probing for it:
    // `favro custom-fields set <card> <Relations field> nonsense`, live
    // 2026-08-14. It needed nothing added here to be caught, which is the
    // property the default exists for.
    ['Unsupported custom field type'],
  ])('202 {"message":"%s"} is a failure even though no closed set names it', (said) => {
    const result = classifyFavroError(202, said);
    expect(result.isFailure).toBe(true);
    expect(result.kind).toBe('unknown');
    expect(result.raw).toBe(said);
    // Quoted verbatim rather than paraphrased: the vocabulary is open, so the
    // only honest thing to report is what Favro actually said.
    expect(result.message).toContain(`"${said}"`);
  });

  test('a message nobody has measured refuses too — the default is what is being tested', () => {
    // This row carries the ARGUMENT, not a measurement: `Card updated` is not a
    // denial anybody has seen. The rule is fail-closed on the presence of a
    // message, so a denial Favro invents next month is caught with nothing added
    // to the list above — which is the whole reason the closed sets were not
    // widened instead.
    expect(classifyFavroError(202, 'Card updated').isFailure).toBe(true);
  });

  test('the 202 wording says part of the write may have applied, and is uncompensated', () => {
    // Measured 2026-08-14: `PUT {name, columnId:<bogus>, widgetCommonId:<the
    // card's board>}` answers `202 {"message":"Invalid column"}` and the name
    // changes anyway. A reader told only "refused" would not re-read the card,
    // and one told "rolled-back" would believe the applied half was undone.
    const message = classifyFavroError(202, 'Lanes are not enabled on this widget').message;
    expect(message).toContain('refuses at least ONE field of the request, not necessarily all of them');
    expect(message).toContain('is not logged for compensation');
  });

  test('the caveat rides EVERY 202 refusal, including the three a closed set names', () => {
    // The trap that ate it once already: `failureMessage` prefers the
    // classifier's wording over the error's own, and the closed sets name three
    // of the ten measured denial messages — so a caveat written into the 2xx
    // branch alone, or onto `WireRefusalError` alone, silently skips those three.
    for (const said of ['Access denied', 'Invalid column', 'Dependency already exists']) {
      expect(classifyFavroError(202, said).message).toContain('is not logged for compensation');
    }
  });

  test('and rides NOTHING else — not a 200, not a 4xx', () => {
    // The caveat is a 202 measurement. On a 200 it would name a status the
    // response falsifies, and `Read the card back` is not advice a refused GET
    // or DELETE can act on. The REFUSAL is still wider than the wording: the
    // wire boundary fires on any 2xx carrying a message.
    expect(classifyFavroError(200, 'Card updated').isFailure).toBe(true);
    expect(classifyFavroError(200, 'Card updated').message).not.toContain('A 202 refuses');
    expect(classifyFavroError(403, 'Access denied').message).not.toContain('A 202 refuses');
  });

  test('a 2xx denial is never retryable, by status as well as by marker', () => {
    // Two independent gates land `retryable: false`, and this is the second:
    // `isRetryable` reads `kind: 'unknown'` and then asks the status, which for
    // a 202 is not transient. So the advice holds even for a caller that never
    // sees the `WireRefusalError` wrapper.
    expect(isTransientStatus(202)).toBe(false);
  });
});

describe('WireRefusalError — the 2xx-denial boundary throw (#165)', () => {
  const thrown = () => new WireRefusalError('PUT', '/cards/abc', 202, { message: 'Invalid column' });

  test('is a RefusalError, so the dispatch table lands retryable: false', () => {
    expect(thrown()).toBeInstanceOf(RefusalError);
  });

  test('carries the response the 11 classifyThrownError call sites read', () => {
    const classified = classifyThrownError(thrown());
    expect(classified?.isFailure).toBe(true);
    expect(classified?.raw).toBe('Invalid column');
  });

  test('is a wire failure structurally, not by its wording', () => {
    expect(isWireFailure(thrown())).toBe(true);
  });

  test('its own message is the classifier’s, plus the request it was answering', () => {
    // The request line is the ONE thing this error adds. Everything a reader
    // needs to decide with — the refusal, the partial-write caveat, the
    // uncompensated half — is in the classifier's wording, because that is what
    // `failureMessage` reports and this error's own `.message` is not.
    const message = thrown().message;
    expect(message).toContain(classifyFavroError(202, 'Invalid column').message);
    expect(message).toContain('PUT /cards/abc');
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
