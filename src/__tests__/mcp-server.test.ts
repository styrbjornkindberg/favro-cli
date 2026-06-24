/**
 * Unit tests for src/mcp-server.ts
 *
 * Tests the createMcpServer() factory. child_process is mocked so no
 * real CLI binary is invoked — these tests are fast and offline.
 */

import { execFile } from 'child_process';

jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

// Import after mocking so promisify picks up the mock
import { createMcpServer, ToolResult } from '../mcp-server';

const mockExecFile = execFile as jest.MockedFunction<typeof execFile>;

/** Make execFile resolve with the given stdout/stderr */
function mockExecSuccess(stdout: string, stderr = '') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mockExecFile as any).mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: null, result: { stdout: string; stderr: string }) => void;
    cb(null, { stdout, stderr });
  });
}

/** Make execFile reject (non-zero exit) */
function mockExecFailure(message: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mockExecFile as any).mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error) => void;
    cb(new Error(message));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Test 0: splitCommand (via tool handlers) ─────────────────────────────────

describe('quoted arguments in favro_run', () => {
  test('passes multi-word double-quoted argument as single token', async () => {
    mockExecSuccess('created');
    const { tools } = createMcpServer();

    await tools.get('favro_run')!({ command: 'cards create "Möjlighet att ändra betalsätt" --board abc123' });

    const callArgs = mockExecFile.mock.calls[0];
    expect(callArgs[1]).toEqual([
      expect.stringContaining('cli.js'),
      'cards',
      'create',
      'Möjlighet att ändra betalsätt',
      '--board',
      'abc123',
    ]);
  });

  test('passes multi-word single-quoted argument as single token', async () => {
    mockExecSuccess('created');
    const { tools } = createMcpServer();

    await tools.get('favro_run')!({ command: "cards create 'My Card Title' --board abc123" });

    const callArgs = mockExecFile.mock.calls[0];
    expect(callArgs[1]).toEqual([
      expect.stringContaining('cli.js'),
      'cards',
      'create',
      'My Card Title',
      '--board',
      'abc123',
    ]);
  });
});

// ─── credsEnv injection (HTTP transport) ─────────────────────────────────────

describe('credsEnv injection', () => {
  test('injects FAVRO_* creds into child env when credsEnv given', async () => {
    mockExecSuccess('ok');
    const credsEnv = {
      FAVRO_EMAIL: 'a@b.com',
      FAVRO_API_KEY: 'tok123',
      FAVRO_ORGANIZATION_ID: 'org123',
    };
    const { tools } = createMcpServer({ credsEnv });

    await tools.get('favro_run')!({ command: 'cards list' });

    const options = mockExecFile.mock.calls[0][2] as { env?: NodeJS.ProcessEnv };
    expect(options.env).toMatchObject(credsEnv);
    // Ambient env is preserved (merged, not replaced)
    expect(options.env).toMatchObject({ PATH: process.env.PATH });
  });

  test('passes ambient process.env when no credsEnv given', async () => {
    mockExecSuccess('ok');
    const { tools } = createMcpServer();

    await tools.get('favro_help')!({ command: undefined });

    const options = mockExecFile.mock.calls[0][2] as { env?: NodeJS.ProcessEnv };
    expect(options.env).toBe(process.env);
  });
});

// ─── Test 1: tool registration ────────────────────────────────────────────────

describe('createMcpServer()', () => {
  test('registers exactly 2 tools: favro_help and favro_run', () => {
    const { tools } = createMcpServer();
    expect(tools.size).toBe(2);
    expect(tools.has('favro_help')).toBe(true);
    expect(tools.has('favro_run')).toBe(true);
  });
});

// ─── Test 2 & 3: favro_help ───────────────────────────────────────────────────

describe('favro_help tool', () => {
  test('calls cli with --help when no command given', async () => {
    mockExecSuccess('Favro CLI help text');
    const { tools } = createMcpServer();

    const result = await tools.get('favro_help')!({ command: undefined }) as ToolResult;

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const callArgs = mockExecFile.mock.calls[0];
    // callArgs: ['node', [favroBin, '--help'], options, cb]
    expect(callArgs[0]).toBe('node');
    expect(callArgs[1]).toEqual([expect.stringContaining('cli.js'), '--help']);
    expect(result.content[0].text).toBe('Favro CLI help text');
  });

  test('appends --help after command tokens when command is given', async () => {
    mockExecSuccess('Cards list help text');
    const { tools } = createMcpServer();

    await tools.get('favro_help')!({ command: 'cards list' });

    const callArgs = mockExecFile.mock.calls[0];
    expect(callArgs[1]).toEqual([
      expect.stringContaining('cli.js'),
      'cards',
      'list',
      '--help',
    ]);
  });
});

// ─── Test 4 & 5: favro_run ────────────────────────────────────────────────────

describe('favro_run tool', () => {
  test('returns stdout as text content', async () => {
    mockExecSuccess('card-123  My Card  In Progress');
    const { tools } = createMcpServer();

    const result = await tools.get('favro_run')!({ command: 'cards list --board abc123 --json' }) as ToolResult;

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe('card-123  My Card  In Progress');
  });

  test('appends stderr under separator when stderr is non-empty', async () => {
    mockExecSuccess('main output', 'some warning');
    const { tools } = createMcpServer();

    const result = await tools.get('favro_run')!({ command: 'cards list --board abc123' }) as ToolResult;

    expect(result.content[0].text).toContain('main output');
    expect(result.content[0].text).toContain('--- stderr ---');
    expect(result.content[0].text).toContain('some warning');
  });

  test('returns isError: true when command exits with non-zero', async () => {
    mockExecFailure('Command failed: favro cards list\nError: invalid board ID');
    const { tools } = createMcpServer();

    const result = await tools.get('favro_run')!({ command: 'cards list --board bad-id' }) as ToolResult;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Command failed');
  });
});
