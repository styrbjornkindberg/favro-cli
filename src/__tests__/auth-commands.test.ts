/**
 * Tests for auth commands (CLA-1773: Configuration & Auth Setup)
 *
 * Tests:
 * - auth login saves config correctly
 * - auth login confirms with "✓ API key saved"
 * - auth login handles permission errors gracefully
 * - auth check validates key with API
 * - auth check rejects invalid key with helpful message
 * - auth check reads key from config/env
 * - --api-key flag overrides config
 * - FAVRO_API_KEY env var overrides config
 */
import { Command } from 'commander';
import { registerAuthCommand, validateApiKey, promptInput } from '../commands/auth';
import * as config from '../lib/config';
import * as readline from 'readline';

// Mock fs/promises so writeConfig/readConfig don't touch real filesystem
jest.mock('fs/promises');
import * as fs from 'fs/promises';
const mockFs = fs as jest.Mocked<typeof fs>;

// Mock readline for interactive prompts
jest.mock('readline');
const mockReadline = readline as jest.Mocked<typeof readline>;

// Mock http-client so validateApiKey doesn't hit the network
jest.mock('../lib/http-client');
import FavroHttpClient from '../lib/http-client';
const MockedFavroHttpClient = FavroHttpClient as jest.MockedClass<typeof FavroHttpClient>;

/**
 * A root carrying the flags the runner owns. `cli.ts` declares them on the real
 * root; `resolveFormat` reads them with globals merged, so declaring them on
 * the parse root here is equivalent.
 *
 * The error assertions below pass `--human`, which is what puts the message on
 * stderr through `logError`. Without it the runner's default is JSON and the
 * same message arrives as `{error:{message, retryable}}` on stdout (#118).
 */
function buildRoot(): Command {
  const program = new Command();
  program.option('--human').option('--pretty').option('--verbose');
  return program;
}

describe('auth login command', () => {
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;
  const realIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    // `promptInput` refuses without a terminal (#147), and jest's stdin is a
    // pipe. These tests are the WITH-a-terminal half, so they say so rather than
    // being exempted by a `NODE_ENV === 'test'` back door — which would have
    // left the guard untested in the only place it can be tested. The pipe half
    // is the first two tests below.
    process.stdin.isTTY = true;
    jest.resetAllMocks();  // Clears queued mock return values to prevent cross-test leakage
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    // The runner sets `process.exitCode` and never calls `process.exit` — the
    // spy is here to prove the second half, not to steer control flow (#118).
    process.exitCode = undefined;
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit must not be called under run()');
    }) as never);

    mockFs.mkdir.mockResolvedValue(undefined as any);
    mockFs.writeFile.mockResolvedValue(undefined);
    // Default: no existing config
    const noFile = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockFs.readFile.mockRejectedValue(noFile);
    
    // Add default safe mock for interactive prompts
    (mockReadline.createInterface as jest.Mock).mockImplementation(() => ({
      question: jest.fn((_q: string, cb: (a: string) => void) => cb('test-answer')),
      close: jest.fn(),
      output: { write: jest.fn() },
    }));

    // Default successful organization fetch
    MockedFavroHttpClient.prototype.get = jest.fn().mockImplementation((url: string) => {
      if (url === '/organizations') {
        return Promise.resolve({ entities: [{ organizationId: 'org-1', name: 'Test Org' }] });
      }
      return Promise.resolve({});
    });
  });

  afterEach(() => {
    process.stdin.isTTY = realIsTTY;
    process.exitCode = undefined;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  test('refuses to prompt when stdin is not a terminal, rather than blocking on it', async () => {
    // THE HOLE THIS CLOSES (#147). `readline` on a pipe never resolves —
    // measured, a 60022ms `favro_run` timeout ending in a bare "Command failed".
    // The interactive-command list cannot cover it: the list lets `--email` +
    // `--api-key` through on purpose, and that form still prompts when the
    // account has several organizations, or when either value is empty.
    process.stdin.isTTY = false;

    await expect(promptInput('Select organization [1-2]: ')).rejects.toThrow(/without a terminal/);
    // The load-bearing half: it refused instead of opening the interface it
    // would then have waited on forever.
    expect(mockReadline.createInterface).not.toHaveBeenCalled();
  });

  test('a flagged auth login still refuses rather than hanging on the organization picker', async () => {
    // The flagged form is the one an agent uses and the one the list waves
    // through. Two organizations is all it takes to reach a prompt no flag skips.
    process.stdin.isTTY = false;
    MockedFavroHttpClient.prototype.get = jest.fn().mockImplementation((url: string) =>
      url === '/organizations'
        ? Promise.resolve({
            entities: [
              { organizationId: 'org-1', name: 'One' },
              { organizationId: 'org-2', name: 'Two' },
            ],
          })
        : Promise.resolve({}),
    );

    const program = buildRoot();
    registerAuthCommand(program);

    await program.parseAsync([
      'node', 'test', '--human', 'auth', 'login', '--email', 'a@b.c', '--api-key', 'k',
    ]);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('without a terminal'));
    expect(process.exitCode).toBe(1);
    // Nothing saved: it refused before `writeConfig`, so a half-written config
    // is not the price of the guard.
    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });

  test('saves API key via --api-key flag without prompt', async () => {
    const program = buildRoot();
    registerAuthCommand(program);

    await program.parseAsync(['node', 'test', 'auth', 'login', '--email', 'test@example.com', '--api-key', 'my-test-key']);

    expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
    const written = (mockFs.writeFile as jest.Mock).mock.calls[0][1];
    const parsed = JSON.parse(written);
    expect(parsed.apiKey).toBe('my-test-key');
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Credentials saved to'));
  });

  test('confirms with ✓ API key saved message', async () => {
    const program = buildRoot();
    registerAuthCommand(program);

    await program.parseAsync(['node', 'test', 'auth', 'login', '--email', 'test@example.com', '--api-key', 'key-abc']);

    const logCalls = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
    expect(logCalls).toContain('✓ Credentials saved to');
  });

  test('saves config with correct file permissions (0o600)', async () => {
    const program = buildRoot();
    registerAuthCommand(program);

    await program.parseAsync(['node', 'test', 'auth', 'login', '--email', 'test@example.com', '--api-key', 'secure-key']);

    expect(mockFs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('config.json'),
      expect.any(String),
      { mode: 0o600 }
    );
  });

  test('handles permission error gracefully during save', async () => {
    const permErr = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    mockFs.writeFile.mockRejectedValueOnce(permErr);

    const program = buildRoot();
    registerAuthCommand(program);

    await program.parseAsync(['node', 'test', '--human', 'auth', 'login', '--email', 'test@example.com', '--api-key', 'key-xyz']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('permission error'));
    expect(process.exitCode).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test('exits with error if no API key provided', async () => {
    // Mock readline to return empty string
    const mockRl = {
      // First prompt is for email, second for API key. 
      // We return a valid email for the first call, and empty for the second to trigger "No API key" error.
      question: jest.fn()
        .mockImplementationOnce((_q, cb) => cb('test@example.com'))
        .mockImplementationOnce((_q, cb) => cb('')),
      close: jest.fn(),
      output: { write: jest.fn() },
    };
    (mockReadline.createInterface as jest.Mock).mockReturnValue(mockRl);

    const program = buildRoot();
    registerAuthCommand(program);

    await program.parseAsync(['node', 'test', '--human', 'auth', 'login']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('No API key'));
    expect(process.exitCode).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test('an empty key is a refusal, so the machine mode says do not retry', async () => {
    const mockRl = {
      question: jest.fn()
        .mockImplementationOnce((_q: string, cb: (a: string) => void) => cb('test@example.com'))
        .mockImplementationOnce((_q: string, cb: (a: string) => void) => cb('')),
      close: jest.fn(),
      output: { write: jest.fn() },
    };
    (mockReadline.createInterface as jest.Mock).mockReturnValue(mockRl);

    const program = buildRoot();
    registerAuthCommand(program);

    // No `--human`: JSON is the default, and the envelope is on STDOUT because
    // MCP hands an agent stdout first (ADR-0002 rule 3).
    await program.parseAsync(['node', 'test', 'auth', 'login']);

    const envelope = consoleLogSpy.mock.calls
      .map((cl) => String(cl[0]))
      .filter((line) => line.startsWith('{"error"'))
      .map((line) => JSON.parse(line).error)[0];
    expect(envelope).toEqual({ message: 'No API key provided.', retryable: false });
    expect(process.exitCode).toBe(1);
  });

  test('prompts interactively when no --api-key flag given', async () => {
    const mockRl = {
      question: jest.fn()
        .mockImplementationOnce((_q, cb) => cb('test@example.com')) // email
        .mockImplementationOnce((_q, cb) => cb('prompted-key')), // key
      close: jest.fn(),
      output: { write: jest.fn() },
    };
    (mockReadline.createInterface as jest.Mock).mockReturnValue(mockRl);

    const program = buildRoot();
    registerAuthCommand(program);

    await program.parseAsync(['node', 'test', 'auth', 'login']);

    expect(mockReadline.createInterface).toHaveBeenCalled();
    const written = (mockFs.writeFile as jest.Mock).mock.calls[0][1];
    expect(JSON.parse(written).apiKey).toBe('prompted-key');
  });

  test('merges new apiKey into existing config (preserves other fields)', async () => {
    // readFile returns existing config with other fields
    mockFs.readFile.mockResolvedValue(JSON.stringify({
      apiKey: 'old-key',
      defaultBoard: 'board-existing',
      outputFormat: 'json',
    }) as any);

    const program = buildRoot();
    registerAuthCommand(program);

    await program.parseAsync(['node', 'test', 'auth', 'login', '--email', 'test@example.com', '--api-key', 'new-key']);

    const written = (mockFs.writeFile as jest.Mock).mock.calls[0][1];
    const parsed = JSON.parse(written);
    expect(parsed.apiKey).toBe('new-key');
    expect(parsed.defaultBoard).toBe('board-existing');
    expect(parsed.outputFormat).toBe('json');
  });
});

describe('auth check command', () => {
  let consoleLogSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();  // Clears queued mock values AND implementations to prevent leakage
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    // The runner sets `process.exitCode` and never calls `process.exit` — the
    // spy is here to prove the second half, not to steer control flow (#118).
    process.exitCode = undefined;
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit must not be called under run()');
    }) as never);

    // Re-establish fs mocks after resetAllMocks
    mockFs.mkdir.mockResolvedValue(undefined as any);
    mockFs.writeFile.mockResolvedValue(undefined);

    delete process.env.FAVRO_API_KEY;
    process.env.FAVRO_EMAIL = 'test@example.com';
    const noFile = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockFs.readFile.mockRejectedValue(noFile);
  });

  afterEach(() => {
    process.exitCode = undefined;
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
    delete process.env.FAVRO_API_KEY;
    delete process.env.FAVRO_EMAIL;
  });

  test('exits with error when no key is configured', async () => {
    const program = buildRoot();
    registerAuthCommand(program);

    await program.parseAsync(['node', 'test', '--human', 'auth', 'check']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('API key not found'));
    expect(process.exitCode).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test('prints ✓ API key is valid when check succeeds', async () => {
    const mockClientInstance = {
      get: jest.fn().mockResolvedValueOnce({ entities: [] }),
    };
    MockedFavroHttpClient.mockImplementationOnce(() => mockClientInstance as any);

    const program = buildRoot();
    registerAuthCommand(program);

    await program.parseAsync(['node', 'test', 'auth', 'check', '--api-key', 'valid-key']);

    const logOutput = consoleLogSpy.mock.calls.map(c => c[0]).join('\n');
    expect(logOutput).toContain('✓ API key is valid');
  });

  test('rejects invalid key with helpful message', async () => {
    const mockClientInstance = {
      get: jest.fn().mockRejectedValueOnce(
        Object.assign(new Error('Unauthorized'), { response: { status: 401 } })
      ),
    };
    MockedFavroHttpClient.mockImplementationOnce(() => mockClientInstance as any);

    const program = buildRoot();
    registerAuthCommand(program);

    await program.parseAsync(['node', 'test', '--human', 'auth', 'check', '--api-key', 'bad-key']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('invalid or unauthorized'));
    expect(process.exitCode).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test('--api-key flag overrides config and env', async () => {
    process.env.FAVRO_API_KEY = 'env-key';
    mockFs.readFile.mockResolvedValue(JSON.stringify({ apiKey: 'config-key' }) as any);

    const mockClientInstance = {
      get: jest.fn().mockResolvedValueOnce({}),
    };
    MockedFavroHttpClient.mockImplementationOnce(() => mockClientInstance as any);

    const program = buildRoot();
    registerAuthCommand(program);

    await program.parseAsync(['node', 'test', 'auth', 'check', '--api-key', 'flag-key']);

    // Verify it was called with flag-key (not env or config)
    expect(MockedFavroHttpClient).toHaveBeenCalledWith(
      expect.objectContaining({ auth: expect.objectContaining({ token: 'flag-key' }) })
    );
  });

  test('FAVRO_API_KEY env var used when no flag', async () => {
    process.env.FAVRO_API_KEY = 'env-key';
    // No config file
    const noFile = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockFs.readFile.mockRejectedValue(noFile);

    const mockClientInstance = {
      get: jest.fn().mockResolvedValueOnce({}),
    };
    MockedFavroHttpClient.mockImplementationOnce(() => mockClientInstance as any);

    const program = buildRoot();
    registerAuthCommand(program);

    await program.parseAsync(['node', 'test', 'auth', 'check']);

    expect(MockedFavroHttpClient).toHaveBeenCalledWith(
      expect.objectContaining({ auth: expect.objectContaining({ token: 'env-key' }) })
    );
  });

  test('config file key used when no flag or env', async () => {
    mockFs.readFile.mockResolvedValue(JSON.stringify({ apiKey: 'config-key' }) as any);

    const mockClientInstance = {
      get: jest.fn().mockResolvedValueOnce({}),
    };
    MockedFavroHttpClient.mockImplementationOnce(() => mockClientInstance as any);

    const program = buildRoot();
    registerAuthCommand(program);

    await program.parseAsync(['node', 'test', 'auth', 'check']);

    expect(MockedFavroHttpClient).toHaveBeenCalledWith(
      expect.objectContaining({ auth: expect.objectContaining({ token: 'config-key' }) })
    );
  });

  test('shows helpful hint to run auth login when no key configured', async () => {
    const program = buildRoot();
    registerAuthCommand(program);

    await program.parseAsync(['node', 'test', '--human', 'auth', 'check']);

    const errorOutput = consoleErrorSpy.mock.calls.map(c => c[0]).join('\n');
    expect(errorOutput).toContain('favro auth login');
    expect(process.exitCode).toBe(1);
  });
});

describe('validateApiKey', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  test('returns true when API responds with 200', async () => {
    const mockClientInstance = {
      get: jest.fn().mockResolvedValueOnce({ entities: [] }),
    };
    MockedFavroHttpClient.mockImplementationOnce(() => mockClientInstance as any);

    const result = await validateApiKey('valid-key', 'test@example.com');
    expect(result).toBe(true);
  });

  test('returns false on 401 Unauthorized', async () => {
    const mockClientInstance = {
      get: jest.fn().mockRejectedValueOnce(
        Object.assign(new Error('Unauthorized'), { response: { status: 401 } })
      ),
    };
    MockedFavroHttpClient.mockImplementationOnce(() => mockClientInstance as any);

    const result = await validateApiKey('bad-key', 'test@example.com');
    expect(result).toBe(false);
  });

  test('returns false on 403 Forbidden', async () => {
    const mockClientInstance = {
      get: jest.fn().mockRejectedValueOnce(
        Object.assign(new Error('Forbidden'), { response: { status: 403 } })
      ),
    };
    MockedFavroHttpClient.mockImplementationOnce(() => mockClientInstance as any);

    const result = await validateApiKey('bad-key', 'test@example.com');
    expect(result).toBe(false);
  });

  test('re-throws network errors (not 401/403)', async () => {
    const mockClientInstance = {
      get: jest.fn().mockRejectedValueOnce(
        Object.assign(new Error('Network Error'), { code: 'ECONNREFUSED' })
      ),
    };
    MockedFavroHttpClient.mockImplementationOnce(() => mockClientInstance as any);

    await expect(validateApiKey('some-key', 'test@example.com')).rejects.toThrow('Network Error');
  });
});
