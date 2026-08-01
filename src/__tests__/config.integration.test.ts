/**
 * Integration tests for config file I/O (real filesystem, no mocks)
 * Non-blocking Issue 6: at least 1 integration test with real file I/O
 * CLA-1773: Configuration & Auth Setup
 *
 * Issue #65: FAVRO_CONFIG_DIR is set here at RUNTIME, after `config` was
 * already imported. If the module froze its paths at import time these tests
 * would touch the developer's real `~/.favro` — the assertions below exist to
 * prove they do not.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { readConfig, writeConfig, resolveApiKey, configDir, configFile } from '../lib/config';

let tmpDir: string;
const origEnv = process.env.FAVRO_CONFIG_DIR;

describe('config real file I/O integration', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'favro-config-test-'));
    process.env.FAVRO_CONFIG_DIR = tmpDir;
    delete process.env.FAVRO_API_KEY;
  });

  afterEach(async () => {
    if (origEnv === undefined) delete process.env.FAVRO_CONFIG_DIR;
    else process.env.FAVRO_CONFIG_DIR = origEnv;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('writeConfig lands in the tmpdir named by FAVRO_CONFIG_DIR, not ~/.favro', async () => {
    await writeConfig({ apiKey: 'real-test-key-abc123', defaultBoard: 'board-real' });

    expect(configDir()).toBe(tmpDir);
    expect(configFile()).toBe(path.join(tmpDir, 'config.json'));

    const parsed = JSON.parse(await fs.readFile(path.join(tmpDir, 'config.json'), 'utf-8'));
    expect(parsed.apiKey).toBe('real-test-key-abc123');
    expect(parsed.defaultBoard).toBe('board-real');
  });

  test('readConfig reads back what writeConfig wrote in the tmpdir', async () => {
    await writeConfig({ apiKey: 'roundtrip-key', organizationId: 'org-1' });
    await expect(readConfig()).resolves.toEqual({ apiKey: 'roundtrip-key', organizationId: 'org-1' });
  });

  test('readConfig returns {} for an empty redirected dir even when ~/.favro has a real config', async () => {
    await expect(readConfig()).resolves.toEqual({});
    await expect(resolveApiKey()).resolves.toBeUndefined();
  });

  test('a second redirect within the same process is honoured', async () => {
    await writeConfig({ apiKey: 'first' });
    const second = await fs.mkdtemp(path.join(os.tmpdir(), 'favro-config-test-2-'));
    try {
      process.env.FAVRO_CONFIG_DIR = second;
      await writeConfig({ apiKey: 'second' });
      await expect(readConfig()).resolves.toEqual({ apiKey: 'second' });
      expect(JSON.parse(await fs.readFile(path.join(tmpDir, 'config.json'), 'utf-8')).apiKey).toBe('first');
    } finally {
      process.env.FAVRO_CONFIG_DIR = tmpDir;
      await fs.rm(second, { recursive: true, force: true });
    }
  });

  test('corrupted JSON throws an error naming the redirected file', async () => {
    await fs.writeFile(path.join(tmpDir, 'config.json'), '{ bad json !!!', 'utf-8');
    await expect(readConfig()).rejects.toThrow(path.join(tmpDir, 'config.json'));
  });

  test('writeConfig creates the directory and writes mode 0o600', async () => {
    const nested = path.join(tmpDir, 'nested');
    process.env.FAVRO_CONFIG_DIR = nested;
    await writeConfig({ apiKey: 'secret' });
    const stat = await fs.stat(path.join(nested, 'config.json'));
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
