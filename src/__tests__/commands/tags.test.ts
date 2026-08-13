/**
 * Unit tests — tags update/delete CLI commands
 */
import { Command } from 'commander';
import { registerTagsCommands } from '../../commands/tags';
import * as config from '../../lib/config';
import * as safety from '../../lib/safety';
import TagsAPI from '../../lib/tags-api';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../lib/safety');
jest.mock('../../lib/tags-api');

const MockTagsAPI = TagsAPI as jest.MockedClass<typeof TagsAPI>;

function buildProgram(): Command {
  const program = new Command();
  // `--human` and `--pretty` declared at the root, and `--human` PREPENDED to
  // every drive: #119 moved this command onto `run()`, so JSON is the default
  // (ADR-0002) and the prose these arms assert lives on the `human` formatter.
  program.option('--human').option('--pretty').option('--verbose', 'Show stack traces');
  registerTagsCommands(program);
  return program;
}

async function runCli(args: string[]): Promise<void> {
  const program = buildProgram();
  program.exitOverride();
  await program.parseAsync(['node', 'favro', '--human', ...args]);
}

beforeEach(() => {
  jest.clearAllMocks();
  (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
  (config.readConfig as jest.Mock).mockResolvedValue({});
  (safety.confirmAction as jest.Mock).mockResolvedValue(true);
});

/**
 * `run()` sets `process.exitCode` instead of exiting, and jest shares one
 * process per worker — an un-reset code leaks into the worker's own exit and
 * into the next arm's assertion.
 */
beforeEach(() => {
  process.exitCode = undefined;
});
afterEach(() => {
  process.exitCode = undefined;
});

describe('favro tags update', () => {
  let consoleSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit must not be called under run()');
  }) as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('updates a tag with name and color', async () => {
    MockTagsAPI.prototype.updateTag = jest.fn().mockResolvedValue({
      tagId: 'tag-1',
      name: 'Renamed',
      color: 'blue',
    });

    await runCli(['tags', 'update', 'tag-1', '--name', 'Renamed', '--color', 'blue', '--yes']);

    expect(MockTagsAPI.prototype.updateTag).toHaveBeenCalledWith('tag-1', { name: 'Renamed', color: 'blue' });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Tag updated'));
  });

  it('dry-run previews without API call', async () => {
    await runCli(['tags', 'update', 'tag-1', '--name', 'New', '--dry-run']);

    expect(safety.dryRunLog).toHaveBeenCalled();
    expect(MockTagsAPI.prototype.updateTag).not.toHaveBeenCalled();
  });

  it('errors when no fields provided', async () => {
    await runCli(['tags', 'update', 'tag-1']);

    expect(process.exitCode).toBe(1);
  });
});

describe('favro tags delete', () => {
  let consoleSpy: jest.SpyInstance;
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit must not be called under run()');
  }) as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('deletes a tag', async () => {
    MockTagsAPI.prototype.deleteTag = jest.fn().mockResolvedValue(undefined);

    await runCli(['tags', 'delete', 'tag-1', '--yes']);

    expect(MockTagsAPI.prototype.deleteTag).toHaveBeenCalledWith('tag-1');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Tag deleted'));
  });

  it('dry-run previews without API call', async () => {
    await runCli(['tags', 'delete', 'tag-1', '--dry-run']);

    expect(safety.dryRunLog).toHaveBeenCalled();
    expect(MockTagsAPI.prototype.deleteTag).not.toHaveBeenCalled();
  });

  it('aborts when user declines confirmation', async () => {
    (safety.confirmAction as jest.Mock).mockResolvedValue(false);

    await runCli(['tags', 'delete', 'tag-1']);

    expect(MockTagsAPI.prototype.deleteTag).not.toHaveBeenCalled();
  });
});
