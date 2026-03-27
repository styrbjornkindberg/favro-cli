/**
 * Tests for auth / token validation behavior
 * CLA-1774: Unit Tests — All Commands
 *
 * Tests:
 * - FAVRO_API_TOKEN env var missing → commands exit with helpful error
 * - Token interceptor behavior
 * - Request auth headers
 */
import FavroHttpClient from '../lib/http-client';
import BoardsAPI from '../lib/boards-api';
import { registerCardsCreateCommand } from '../commands/cards-create';
import { registerCardsListCommand } from '../commands/cards-list';
import { registerCardsUpdateCommand } from '../commands/cards-update';
import { Command } from 'commander';

jest.mock('axios');
import axios from 'axios';

// Mock command-level dependencies (used in fast-fail tests)
jest.mock('../lib/cards-api');

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
      auth: { token: process.env.FAVRO_API_TOKEN }
    });

    expect((client as any).auth).toEqual({ token: 'env-token-xyz' });

    if (originalToken === undefined) delete process.env.FAVRO_API_TOKEN;
    else process.env.FAVRO_API_TOKEN = originalToken;
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

describe('Missing FAVRO_API_TOKEN — command fast-fail', () => {
  let consoleErrorSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    delete process.env.FAVRO_API_TOKEN;
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  test('registerCardsCreateCommand exits with helpful error when FAVRO_API_TOKEN is missing', async () => {
    const program = new Command();
    registerCardsCreateCommand(program);

    await expect(
      program.parseAsync(['node', 'test', 'cards', 'create', 'Test Card'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('API key')
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('registerCardsListCommand exits with helpful error when FAVRO_API_TOKEN is missing', async () => {
    const program = new Command();
    registerCardsListCommand(program);

    await expect(
      program.parseAsync(['node', 'test', 'cards', 'list'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('API key')
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('registerCardsUpdateCommand exits with helpful error when FAVRO_API_TOKEN is missing', async () => {
    const program = new Command();
    registerCardsUpdateCommand(program);

    await expect(
      program.parseAsync(['node', 'test', 'cards', 'update', 'card-123', '--yes'])
    ).rejects.toThrow('process.exit');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('API key')
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('error message includes helpful hint to run auth login', async () => {
    const program = new Command();
    registerCardsCreateCommand(program);

    await expect(
      program.parseAsync(['node', 'test', 'cards', 'create', 'Test'])
    ).rejects.toThrow('process.exit');

    // The error message should tell the user to run `favro auth login`
    const errorMsg = consoleErrorSpy.mock.calls[0][0];
    expect(errorMsg).toContain('favro auth login');
    expect(typeof errorMsg).toBe('string');
  });
});
