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
import { readConfig, writeConfig, loadConfig, resolveApiKey, CONFIG_FILE, CONFIG_DIR } from '../lib/config';
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

    expect(mockFs.mkdir).toHaveBeenCalledWith(CONFIG_DIR, { recursive: true });
    expect(mockFs.writeFile).toHaveBeenCalledWith(
      CONFIG_FILE,
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
