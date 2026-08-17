/**
 * Tests for config management (CLA-1773: Configuration & Auth Setup)
 *
 * Tests:
 * - readConfig returns empty object when no config file
 * - writeConfig saves config correctly
 * - readConfig reads saved config
 * - loadConfig merges env var overrides
 * - resolveApiKey respects priority: flag > env > config
 * - Permission error handling
 */
import { readConfig, writeConfig, loadConfig, resolveApiKey, scopeOverride, configFile, configDir } from '../lib/config';
import * as fs from 'fs/promises';
import * as path from 'path';

jest.mock('fs/promises');
const mockFs = fs as jest.Mocked<typeof fs>;

describe('readConfig', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  test('returns empty object when config file does not exist', async () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockFs.readFile.mockRejectedValueOnce(err);
    const config = await readConfig();
    expect(config).toEqual({});
  });

  test('returns parsed config when file exists', async () => {
    const configData = { apiKey: 'test-key-123', defaultBoard: 'board-abc', outputFormat: 'json' };
    mockFs.readFile.mockResolvedValueOnce(JSON.stringify(configData) as any);
    const config = await readConfig();
    expect(config.apiKey).toBe('test-key-123');
    expect(config.defaultBoard).toBe('board-abc');
    expect(config.outputFormat).toBe('json');
  });

  test('throws permission error when config file is not readable (EACCES)', async () => {
    const err = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    mockFs.readFile.mockRejectedValueOnce(err);
    await expect(readConfig()).rejects.toThrow('Config file permission error');
  });

  test('throws permission error when config file is not readable (EPERM)', async () => {
    const err = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    mockFs.readFile.mockRejectedValueOnce(err);
    await expect(readConfig()).rejects.toThrow('Config file permission error');
  });

  test('wraps generic read error with helpful message', async () => {
    const err = Object.assign(new Error('some weird IO error'), { code: 'EIO' });
    mockFs.readFile.mockRejectedValueOnce(err);
    await expect(readConfig()).rejects.toThrow('Failed to read config');
  });

  test('throws helpful error when config file contains corrupted JSON (SyntaxError)', async () => {
    // SyntaxError has no .code property — explicit instanceof check required (Issue 2 fix)
    mockFs.readFile.mockResolvedValueOnce('{ invalid json :::' as any);
    await expect(readConfig()).rejects.toThrow('corrupted');
  });
});

describe('writeConfig', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockFs.mkdir.mockResolvedValue(undefined as any);
    mockFs.writeFile.mockResolvedValue(undefined);
  });

  test('creates config directory and writes config', async () => {
    const config = { apiKey: 'my-api-key', defaultBoard: 'board-1' };
    await writeConfig(config);

    expect(mockFs.mkdir).toHaveBeenCalledWith(configDir(), { recursive: true });
    expect(mockFs.writeFile).toHaveBeenCalledWith(
      configFile(),
      JSON.stringify(config, null, 2),
      { mode: 0o600 }
    );
  });

  test('writes config with all fields', async () => {
    const config = {
      apiKey: 'key-xyz',
      defaultBoard: 'board-abc',
      defaultCollection: 'coll-123',
      outputFormat: 'csv' as const,
    };
    await writeConfig(config);

    const written = (mockFs.writeFile as jest.Mock).mock.calls[0][1];
    const parsed = JSON.parse(written);
    expect(parsed).toEqual(config);
  });

  test('throws permission error when cannot write config (EACCES)', async () => {
    const err = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    mockFs.writeFile.mockRejectedValueOnce(err);
    await expect(writeConfig({ apiKey: 'x' })).rejects.toThrow('Config file permission error');
  });

  test('throws permission error when cannot write config (EPERM)', async () => {
    const err = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    mockFs.writeFile.mockRejectedValueOnce(err);
    await expect(writeConfig({ apiKey: 'x' })).rejects.toThrow('Config file permission error');
  });

  test('wraps generic write error', async () => {
    const err = Object.assign(new Error('no space left'), { code: 'ENOSPC' });
    mockFs.writeFile.mockRejectedValueOnce(err);
    await expect(writeConfig({ apiKey: 'x' })).rejects.toThrow('Failed to write config');
  });
});

describe('resolveApiKey', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetAllMocks();  // Clear queue AND implementations to prevent mock leakage
    process.env = { ...originalEnv };
    delete process.env.FAVRO_API_KEY;
    delete process.env.FAVRO_API_TOKEN;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('flag api key takes priority over env and config', async () => {
    process.env.FAVRO_API_KEY = 'env-key';
    // NOTE: do NOT set readFile mock — flag returns early before reading config

    const key = await resolveApiKey('flag-key');
    expect(key).toBe('flag-key');
    expect(mockFs.readFile).not.toHaveBeenCalled();
  });

  test('env var FAVRO_API_KEY takes priority over config file', async () => {
    process.env.FAVRO_API_KEY = 'env-key';
    // NOTE: do NOT set readFile mock — env var returns early before reading config

    const key = await resolveApiKey();
    expect(key).toBe('env-key');
    expect(mockFs.readFile).not.toHaveBeenCalled();
  });

  test('config file apiKey used when no flag or env', async () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    // readFile will be called — return config with apiKey
    mockFs.readFile.mockResolvedValueOnce(JSON.stringify({ apiKey: 'config-key' }) as any);

    const key = await resolveApiKey();
    expect(key).toBe('config-key');
  });

  test('FAVRO_API_TOKEN used as legacy fallback when nothing else configured', async () => {
    process.env.FAVRO_API_TOKEN = 'legacy-token';
    const noFile = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockFs.readFile.mockRejectedValueOnce(noFile);

    const key = await resolveApiKey();
    expect(key).toBe('legacy-token');
  });

  test('returns undefined when no key source is configured', async () => {
    const noFile = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockFs.readFile.mockRejectedValueOnce(noFile);

    const key = await resolveApiKey();
    expect(key).toBeUndefined();
  });

  test('throws error when FAVRO_API_KEY is set to empty string (non-blocking Issue 5 fix)', async () => {
    process.env.FAVRO_API_KEY = '';
    await expect(resolveApiKey()).rejects.toThrow('FAVRO_API_KEY is set but empty');
  });
});

describe('loadConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetAllMocks();  // Prevent mock queue leakage between tests
    process.env = { ...originalEnv };
    delete process.env.FAVRO_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('returns file config when no env or overrides', async () => {
    mockFs.readFile.mockResolvedValueOnce(JSON.stringify({
      apiKey: 'file-key',
      defaultBoard: 'board-1',
      outputFormat: 'table',
    }) as any);

    const config = await loadConfig();
    expect(config.apiKey).toBe('file-key');
    expect(config.defaultBoard).toBe('board-1');
  });

  test('FAVRO_API_KEY env var overrides config file', async () => {
    process.env.FAVRO_API_KEY = 'env-key';
    mockFs.readFile.mockResolvedValueOnce(JSON.stringify({ apiKey: 'file-key' }) as any);

    const config = await loadConfig();
    expect(config.apiKey).toBe('env-key');
  });

  test('overrides parameter takes top priority', async () => {
    process.env.FAVRO_API_KEY = 'env-key';
    mockFs.readFile.mockResolvedValueOnce(JSON.stringify({ apiKey: 'file-key' }) as any);

    const config = await loadConfig({ apiKey: 'override-key' });
    expect(config.apiKey).toBe('override-key');
  });

  test('merges all config sources correctly', async () => {
    mockFs.readFile.mockResolvedValueOnce(JSON.stringify({
      apiKey: 'file-key',
      defaultBoard: 'board-from-file',
      outputFormat: 'json',
    }) as any);

    const config = await loadConfig({ defaultBoard: 'board-override' });
    expect(config.apiKey).toBe('file-key');
    expect(config.defaultBoard).toBe('board-override');
    expect(config.outputFormat).toBe('json');
  });

  test('handles missing config file gracefully', async () => {
    const noFile = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockFs.readFile.mockRejectedValueOnce(noFile);

    const config = await loadConfig();
    expect(config).toEqual({});
  });
});

describe('FAVRO_CONFIG_DIR override', () => {
  const orig = process.env.FAVRO_CONFIG_DIR;
  afterEach(() => {
    if (orig === undefined) delete process.env.FAVRO_CONFIG_DIR;
    else process.env.FAVRO_CONFIG_DIR = orig;
  });

  test('configDir/configFile honor FAVRO_CONFIG_DIR set AFTER import (issue #65)', () => {
    process.env.FAVRO_CONFIG_DIR = '/tmp/custom-favro';
    expect(configDir()).toBe('/tmp/custom-favro');
    expect(configFile()).toBe(path.join('/tmp/custom-favro', 'config.json'));
  });

  test('defaults to ~/.favro when FAVRO_CONFIG_DIR is unset', () => {
    delete process.env.FAVRO_CONFIG_DIR;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const os = require('os');
    expect(configDir()).toBe(path.join(os.homedir(), '.favro'));
  });
});

/**
 * `FAVRO_SCOPE_COLLECTION_ID` — the per-session scope lock (#174).
 *
 * Two halves, and the second is the one that bites: the override has to reach
 * every read (so `readConfig`, the function every scope guard actually calls),
 * and it must never reach DISK — six writers spread a `readConfig()`-derived
 * object into `writeConfig`, so a naive merge would promote a session lock to the
 * global one on the next `auth login` or `resolveUserId` auto-resolve.
 */
describe('FAVRO_SCOPE_COLLECTION_ID', () => {
  const orig = process.env.FAVRO_SCOPE_COLLECTION_ID;

  /** What `writeConfig` actually handed the filesystem. */
  function written(): Record<string, unknown> {
    const calls = (mockFs.writeFile as jest.Mock).mock.calls;
    return JSON.parse(calls[calls.length - 1][1]);
  }

  const FILE_LOCK = { apiKey: 'k', scopeCollectionId: 'coll-file', scopeCollectionName: 'File Lock' };

  beforeEach(() => {
    jest.resetAllMocks();
    mockFs.mkdir.mockResolvedValue(undefined as any);
    mockFs.writeFile.mockResolvedValue(undefined);
    delete process.env.FAVRO_SCOPE_COLLECTION_ID;
  });

  afterEach(() => {
    if (orig === undefined) delete process.env.FAVRO_SCOPE_COLLECTION_ID;
    else process.env.FAVRO_SCOPE_COLLECTION_ID = orig;
  });

  describe('scopeOverride', () => {
    test('undefined when the var is unset — the file lock is untouched', () => {
      expect(scopeOverride()).toBeUndefined();
    });

    test('trims, so a shell-quoting accident still names a collection', () => {
      process.env.FAVRO_SCOPE_COLLECTION_ID = '  coll-env  ';
      expect(scopeOverride()).toBe('coll-env');
    });

    test('an EMPTY value throws — it must not resolve to "no lock"', () => {
      process.env.FAVRO_SCOPE_COLLECTION_ID = '';
      expect(() => scopeOverride()).toThrow('FAVRO_SCOPE_COLLECTION_ID is set but empty');
    });

    test('a WHITESPACE-ONLY value throws too — trimming must not unlock', () => {
      process.env.FAVRO_SCOPE_COLLECTION_ID = '   ';
      expect(() => scopeOverride()).toThrow('FAVRO_SCOPE_COLLECTION_ID is set but empty');
    });
  });

  describe('readConfig', () => {
    test('the env value IS the lock, and the file lock is not consulted', async () => {
      process.env.FAVRO_SCOPE_COLLECTION_ID = 'coll-env';
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(FILE_LOCK) as any);

      const config = await readConfig();
      expect(config.scopeCollectionId).toBe('coll-env');
      // The cached name belongs to the FILE's collection. Carrying it forward
      // would make every refusal name the wrong collection.
      expect(config.scopeCollectionName).toBeUndefined();
      // Unrelated fields survive — this is an override, not a replacement.
      expect(config.apiKey).toBe('k');
    });

    test('locks even when the file has NO lock — the env cannot be a downgrade', async () => {
      process.env.FAVRO_SCOPE_COLLECTION_ID = 'coll-env';
      const noFile = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      mockFs.readFile.mockRejectedValueOnce(noFile);

      await expect(readConfig()).resolves.toEqual({
        scopeCollectionId: 'coll-env',
        scopeCollectionName: undefined,
      });
    });

    test('an empty value REFUSES rather than falling through to the file lock', async () => {
      process.env.FAVRO_SCOPE_COLLECTION_ID = '  ';
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(FILE_LOCK) as any);

      await expect(readConfig()).rejects.toThrow('FAVRO_SCOPE_COLLECTION_ID is set but empty');
    });

    test('unset — byte-identical to the file contents', async () => {
      mockFs.readFile.mockResolvedValueOnce(JSON.stringify(FILE_LOCK) as any);
      await expect(readConfig()).resolves.toEqual(FILE_LOCK);
    });
  });

  describe('writeConfig does not leak the session lock to disk', () => {
    test("the file's OWN lock survives a write carrying the env one", async () => {
      process.env.FAVRO_SCOPE_COLLECTION_ID = 'coll-env';
      mockFs.readFile.mockResolvedValue(JSON.stringify(FILE_LOCK) as any);

      // The exact shape all six callers use: spread a `readConfig()` result and
      // add a field. `userId` is `resolveUserId`'s auto-resolve, which fires on
      // `next`, `my-cards`, `my-standup` and `@me`.
      await writeConfig({ ...(await readConfig()), userId: 'user-9' });

      expect(written()).toEqual({
        apiKey: 'k',
        userId: 'user-9',
        scopeCollectionId: 'coll-file',
        scopeCollectionName: 'File Lock',
      });
    });

    test('a file with NO lock stays unlocked — the key is absent, not blanked', async () => {
      process.env.FAVRO_SCOPE_COLLECTION_ID = 'coll-env';
      mockFs.readFile.mockResolvedValue(JSON.stringify({ apiKey: 'k' }) as any);

      await writeConfig({ ...(await readConfig()), userId: 'user-9' });

      const after = written();
      expect('scopeCollectionId' in after).toBe(false);
      expect('scopeCollectionName' in after).toBe(false);
      expect(after).toEqual({ apiKey: 'k', userId: 'user-9' });
    });

    test('with the var UNSET the write is unchanged, and no file read happens', async () => {
      await writeConfig({ ...FILE_LOCK, userId: 'user-9' });

      expect(mockFs.readFile).not.toHaveBeenCalled();
      expect(written()).toEqual({ ...FILE_LOCK, userId: 'user-9' });
    });
  });
});
