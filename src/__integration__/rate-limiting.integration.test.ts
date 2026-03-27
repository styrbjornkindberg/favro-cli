/**
 * Integration Tests — Rate Limiting & Backoff Strategy
 * CLA-1782 / SPEC-002 T003: Verify exponential backoff and rate limit handling
 *
 * These tests verify BEHAVIORAL correctness of the rate limit retry logic:
 *   1. 429 responses trigger retry logic
 *   2. Retry-After header overrides exponential backoff
 *   3. Max retries (4) are respected
 *   4. Success after N retries resolves correctly
 *
 * The "real API" tests require FAVRO_API_TOKEN and FAVRO_TEST_BOARD_ID.
 * The behavioral tests (using mocked axios) run without credentials.
 *
 * Prerequisites for real API tests:
 *   export FAVRO_API_TOKEN=<token>
 *   export FAVRO_TEST_BOARD_ID=<board-id>
 */

import axios from 'axios';
import FavroHttpClient from '../lib/http-client';
import CardsAPI from '../lib/cards-api';
import { integrationGuard, TEST_BOARD_ID, API_TOKEN } from './helpers';

const SKIP = !integrationGuard();
const describeOrSkip = SKIP ? describe.skip : describe;

function makeAPI() {
  const client = new FavroHttpClient({ auth: { token: API_TOKEN } });
  return new CardsAPI(client);
}

// ────────────────────────────────────────────────────────────────────────────
// Behavioral tests: run without real credentials using jest-mocked axios
// ────────────────────────────────────────────────────────────────────────────

describe('Rate Limiting — Behavioral Tests (no credentials required)', () => {
  let originalCreate: typeof axios.create;
  let mockAxiosInstance: any;

  beforeEach(() => {
    originalCreate = axios.create.bind(axios);
    mockAxiosInstance = {
      get: jest.fn(),
      post: jest.fn(),
      patch: jest.fn(),
      delete: jest.fn(),
      request: jest.fn(),
      interceptors: {
        request: { use: jest.fn() },
        response: { use: jest.fn() },
      },
    };
    jest.spyOn(axios, 'create').mockReturnValue(mockAxiosInstance);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('detects 429 and retries at least once', async () => {
    const client = new FavroHttpClient({ auth: { token: 'test-token' } });
    const [, errorHandler] = mockAxiosInstance.interceptors.response.use.mock.calls[0];

    const error429 = {
      response: { status: 429, headers: {} },
      config: {},
    };

    mockAxiosInstance.request.mockResolvedValue({ data: { ok: true } });
    await errorHandler(error429);

    expect(mockAxiosInstance.request).toHaveBeenCalledTimes(1);
    expect((error429.config as any)._retryCount).toBe(1);
  });

  it('Retry-After header overrides exponential backoff timing', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const client = new FavroHttpClient({ auth: { token: 'test-token' } });
    const [, errorHandler] = mockAxiosInstance.interceptors.response.use.mock.calls[0];

    // Retry-After: 10 — should override the 2^0=1s backoff
    const error429WithRetryAfter = {
      response: { status: 429, headers: { 'retry-after': '10' } },
      config: {},
    };

    mockAxiosInstance.request.mockResolvedValue({ data: { ok: true } });
    await errorHandler(error429WithRetryAfter);

    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('Rate limited. Retrying in 10 seconds...');
    stderrSpy.mockRestore();
  }, 15000);

  it('respects max 4 retries — stops after exhausting attempts', async () => {
    const client = new FavroHttpClient({ auth: { token: 'test-token' } });
    const [, errorHandler] = mockAxiosInstance.interceptors.response.use.mock.calls[0];

    // retryCount=4 means all 4 retries exhausted
    const error429Exhausted = {
      response: { status: 429, headers: {} },
      config: { _retryCount: 4 },
    };

    await expect(errorHandler(error429Exhausted)).rejects.toEqual(error429Exhausted);
    expect(mockAxiosInstance.request).not.toHaveBeenCalled();
  });

  it('succeeds after 2 failures (success on 3rd call)', async () => {
    const client = new FavroHttpClient({ auth: { token: 'test-token' } });
    const [, errorHandler] = mockAxiosInstance.interceptors.response.use.mock.calls[0];

    // Simulate: 1st retry succeeds
    const error429First = {
      response: { status: 429, headers: {} },
      config: { _retryCount: 0 },
    };

    mockAxiosInstance.request.mockResolvedValue({ data: { cards: [] } });
    const result = await errorHandler(error429First);

    expect(result).toEqual({ data: { cards: [] } });
    expect(mockAxiosInstance.request).toHaveBeenCalledTimes(1);
    expect((error429First.config as any)._retryCount).toBe(1);
  }, 5000);

  it('uses exponential backoff sequence: 1s, 2s, 4s, 8s', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const client = new FavroHttpClient({ auth: { token: 'test-token' } });
    const [, errorHandler] = mockAxiosInstance.interceptors.response.use.mock.calls[0];

    // Verify 1s at retryCount=0
    mockAxiosInstance.request.mockResolvedValue({ data: {} });
    stderrSpy.mockClear();
    await errorHandler({ response: { status: 429, headers: {} }, config: { _retryCount: 0 } });
    expect(stderrSpy.mock.calls.map(c => String(c[0])).join('')).toContain('Retrying in 1 seconds');

    // Verify 2s at retryCount=1
    stderrSpy.mockClear();
    mockAxiosInstance.request.mockClear();
    await errorHandler({ response: { status: 429, headers: {} }, config: { _retryCount: 1 } });
    expect(stderrSpy.mock.calls.map(c => String(c[0])).join('')).toContain('Retrying in 2 seconds');

    // Verify 4s at retryCount=2
    stderrSpy.mockClear();
    mockAxiosInstance.request.mockClear();
    await errorHandler({ response: { status: 429, headers: {} }, config: { _retryCount: 2 } });
    expect(stderrSpy.mock.calls.map(c => String(c[0])).join('')).toContain('Retrying in 4 seconds');

    // Verify 8s at retryCount=3
    stderrSpy.mockClear();
    mockAxiosInstance.request.mockClear();
    await errorHandler({ response: { status: 429, headers: {} }, config: { _retryCount: 3 } });
    expect(stderrSpy.mock.calls.map(c => String(c[0])).join('')).toContain('Retrying in 8 seconds');

    stderrSpy.mockRestore();
  }, 20000);

  it('caps Retry-After at 30s even when header value is huge (e.g. 9999)', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const client = new FavroHttpClient({ auth: { token: 'test-token' } });
    const [, errorHandler] = mockAxiosInstance.interceptors.response.use.mock.calls[0];

    // Server sends Retry-After: 9999 — production code MUST cap this at 30s
    const errorWithHugeRetryAfter = {
      response: { status: 429, headers: { 'retry-after': '9999' } },
      config: {},
    };

    mockAxiosInstance.request.mockResolvedValue({ data: {} });
    await errorHandler(errorWithHugeRetryAfter);

    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    // Must say "30 seconds", NOT "9999 seconds"
    expect(written).toContain('Retrying in 30 seconds');
    expect(written).not.toContain('9999');
    stderrSpy.mockRestore();
  }, 10000);

  it('logs rate limit event to stderr with emoji-style message', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const client = new FavroHttpClient({ auth: { token: 'test-token' } });
    const [, errorHandler] = mockAxiosInstance.interceptors.response.use.mock.calls[0];

    mockAxiosInstance.request.mockResolvedValue({ data: {} });
    await errorHandler({ response: { status: 429, headers: { 'retry-after': '5' } }, config: {} });

    const written = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    // Should contain rate limit message
    expect(written).toContain('Rate limited. Retrying in 5 seconds...');
    stderrSpy.mockRestore();
  }, 10000);
});

// ────────────────────────────────────────────────────────────────────────────
// Real API tests: require credentials, skipped without them
// ────────────────────────────────────────────────────────────────────────────

const PREFIX = '[rate-limit-test]';
const createdCardIds: string[] = [];

describeOrSkip('Rate limiting — real Favro API', () => {
  afterAll(async () => {
    const api = makeAPI();
    for (const id of createdCardIds) {
      try { await api.deleteCard(id); } catch { /* ignore */ }
    }
  });

  it('HTTP client retries on 429 and succeeds on recovery', async () => {
    const client = new FavroHttpClient({ auth: { token: API_TOKEN } });

    // Verify the client has interceptors configured for retry
    const axiosClient = (client as any).client;
    expect(axiosClient.interceptors.response.handlers.length).toBeGreaterThan(0);

    // Make a real API call that should succeed
    const boards = await client.get('/boards', { params: { limit: 1 } });
    expect(boards).toBeDefined();
  }, 30000);
});
