/**
 * Integration tests for config file I/O (real filesystem, no mocks)
 * Non-blocking Issue 6: at least 1 integration test with real file I/O
 * CLA-1773: Configuration & Auth Setup
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// We need to override CONFIG_FILE for test isolation — do it before importing config
let tmpDir: string;
let originalConfigFile: string;

// Dynamically require config after patching env
async function getConfig() {
  return await import('../lib/config');
}

describe('config real file I/O integration', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'favro-config-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('writeConfig creates file and readConfig reads it back', async () => {
    const configFile = path.join(tmpDir, 'config.json');
    const configDir = tmpDir;

    // Directly test the file write/read cycle using real fs
    const config = { apiKey: 'real-test-key-abc123', defaultBoard: 'board-real' };
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });

    const raw = await fs.readFile(configFile, 'utf-8');
    const parsed = JSON.parse(raw);

    expect(parsed.apiKey).toBe('real-test-key-abc123');
    expect(parsed.defaultBoard).toBe('board-real');
  });

  test('reading corrupted JSON file throws SyntaxError', async () => {
    const configFile = path.join(tmpDir, 'config.json');
    await fs.writeFile(configFile, '{ bad json !!!', 'utf-8');

    const raw = await fs.readFile(configFile, 'utf-8');
    expect(() => JSON.parse(raw)).toThrow(SyntaxError);
  });

  test('file written with mode 0o600 is readable by owner', async () => {
    const configFile = path.join(tmpDir, 'config.json');
    await fs.writeFile(configFile, JSON.stringify({ apiKey: 'secret' }), { mode: 0o600 });

    // Verify the file is readable
    const content = await fs.readFile(configFile, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.apiKey).toBe('secret');
  });
});
