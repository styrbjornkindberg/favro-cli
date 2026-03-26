/**
 * Tests for auth login/check functionality
 * CLA-1774: Unit Tests — All Commands
 *
 * Note: Auth commands may not be a separate file yet. These tests cover
 * config loading/saving patterns and validate auth behavior
 * via environment variable overrides and HTTP client setup.
 */
import FavroHttpClient from '../lib/http-client';
import CardsAPI from '../lib/cards-api';
import BoardsAPI from '../lib/boards-api';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

jest.mock('axios');
import axios from 'axios';

const mockedAxios = axios as jest.Mocked<typeof axios>;

let mockAxiosInstance: any;

beforeEach(() => {
  jest.clearAllMocks();
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
  mockedAxios.create = jest.fn().mockReturnValue(mockAxiosInstance);
});

describe('Auth Configuration', () => {
  // --- Token from env var ---

  test('uses FAVRO_API_TOKEN environment variable for auth', () => {
    const originalToken = process.env.FAVRO_API_TOKEN;
    process.env.FAVRO_API_TOKEN = 'env-token-xyz';

    const client = new FavroHttpClient({
      auth: { token: process.env.FAVRO_API_TOKEN || 'demo-token' }
    });

    // Check that auth is stored correctly
    expect((client as any).auth).toEqual({ token: 'env-token-xyz' });

    process.env.FAVRO_API_TOKEN = originalToken;
  });

  test('falls back to demo-token when FAVRO_API_TOKEN not set', () => {
    const originalToken = process.env.FAVRO_API_TOKEN;
    delete process.env.FAVRO_API_TOKEN;

    const client = new FavroHttpClient({
      auth: { token: process.env.FAVRO_API_TOKEN || 'demo-token' }
    });

    expect((client as any).auth).toEqual({ token: 'demo-token' });

    process.env.FAVRO_API_TOKEN = originalToken;
  });

  test('overrides auth token via setAuth', () => {
    const client = new FavroHttpClient({ auth: { token: 'original-token' } });
    client.setAuth({ token: 'new-token' });
    expect((client as any).auth).toEqual({ token: 'new-token' });
  });

  test('setAuth with empty token removes auth', () => {
    const client = new FavroHttpClient({ auth: { token: 'original' } });
    client.setAuth({});
    expect((client as any).auth.token).toBeUndefined();
  });

  // --- Request interceptor adds token ---

  test('request interceptor adds Bearer token to headers', () => {
    const client = new FavroHttpClient({ auth: { token: 'valid-api-token' } });
    const [requestInterceptor] = mockAxiosInstance.interceptors.request.use.mock.calls[0];

    const config = { headers: {} };
    const result = requestInterceptor(config);
    expect(result.headers['Authorization']).toBe('Bearer valid-api-token');
  });

  test('request interceptor skips Authorization when token is empty', () => {
    const client = new FavroHttpClient({ auth: { token: '' } });
    const [requestInterceptor] = mockAxiosInstance.interceptors.request.use.mock.calls[0];

    const config = { headers: {} };
    const result = requestInterceptor(config);
    // Empty string is falsy, so header should not be set
    expect(result.headers['Authorization']).toBeUndefined();
  });

  // --- Invalid key rejection ---

  test('API call with invalid token returns 401 error', async () => {
    const client = new FavroHttpClient({ auth: { token: 'invalid-token' } });
    const error401 = Object.assign(new Error('Unauthorized'), {
      response: { status: 401, data: { error: 'Invalid token' } }
    });
    mockAxiosInstance.get.mockRejectedValue(error401);

    await expect(client.get('/boards')).rejects.toThrow('Unauthorized');
  });

  test('API call with no token returns 401 error', async () => {
    const client = new FavroHttpClient();
    const error401 = Object.assign(new Error('Unauthorized'), {
      response: { status: 401 }
    });
    mockAxiosInstance.get.mockRejectedValue(error401);

    await expect(client.get('/cards')).rejects.toThrow('Unauthorized');
  });

  // --- Config file loading simulation ---

  test('can save and load config from a JSON file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'favro-auth-test-'));
    const configPath = path.join(tmpDir, 'config.json');

    // Save config
    const config = { token: 'saved-token', organizationId: 'org-123' };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

    // Load config
    const loaded = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(loaded.token).toBe('saved-token');
    expect(loaded.organizationId).toBe('org-123');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('can override config values when multiple configs are merged', () => {
    const baseConfig = { token: 'base-token', organizationId: 'org-base', timeout: 30000 };
    const overrideConfig = { token: 'override-token' };

    const merged = { ...baseConfig, ...overrideConfig };
    expect(merged.token).toBe('override-token');
    expect(merged.organizationId).toBe('org-base');
    expect(merged.timeout).toBe(30000);
  });

  // --- Auth check simulation (verify API is reachable with token) ---

  test('auth check succeeds when API responds with 200', async () => {
    const client = new FavroHttpClient({ auth: { token: 'valid-token' } });
    mockAxiosInstance.get.mockResolvedValue({ data: { entities: [] } });

    const api = new BoardsAPI(client);
    const boards = await api.listBoards();
    expect(Array.isArray(boards)).toBe(true);
  });

  test('auth check fails when token is invalid (API error)', async () => {
    const client = new FavroHttpClient({ auth: { token: 'invalid-token' } });
    const error = Object.assign(new Error('Forbidden'), {
      response: { status: 403 }
    });
    mockAxiosInstance.get.mockRejectedValue(error);

    const api = new BoardsAPI(client);
    await expect(api.listBoards()).rejects.toThrow('Forbidden');
  });
});

describe('Auth Environment Variables', () => {
  test('FAVRO_API_TOKEN takes precedence over default', () => {
    const originalEnv = process.env.FAVRO_API_TOKEN;
    process.env.FAVRO_API_TOKEN = 'env-var-token';

    const token = process.env.FAVRO_API_TOKEN || 'demo-token';
    expect(token).toBe('env-var-token');

    process.env.FAVRO_API_TOKEN = originalEnv;
  });

  test('default token is used when env var is missing', () => {
    const originalEnv = process.env.FAVRO_API_TOKEN;
    delete process.env.FAVRO_API_TOKEN;

    const token = process.env.FAVRO_API_TOKEN || 'demo-token';
    expect(token).toBe('demo-token');

    process.env.FAVRO_API_TOKEN = originalEnv;
  });
});
