/**
 * Unit tests — custom-fields CLI commands
 * CLA-1792 FAVRO-030: Integration Test Suite (coverage gap fix)
 *
 * Tests the command action handlers for:
 *   favro custom-fields list <board-id>
 *   favro custom-fields get <field-id>
 *   favro custom-fields set <card-id> <field-id> <value>
 *   favro custom-fields values <field-id>
 */
import { Command } from 'commander';
import { registerCustomFieldsCommands } from '../../commands/custom-fields';
import * as config from '../../lib/config';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../lib/custom-fields-api');

import CustomFieldsAPI from '../../lib/custom-fields-api';
const MockCustomFieldsAPI = CustomFieldsAPI as jest.MockedClass<typeof CustomFieldsAPI>;

jest.mock('../../lib/cards-api', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      getCard: jest.fn().mockResolvedValue({ boardId: 'board-1' })
    }))
  };
});

jest.mock('../../lib/safety', () => ({
  checkScope: jest.fn().mockResolvedValue(true),
  confirmAction: jest.fn().mockResolvedValue(true)
}));

const SAMPLE_TEXT_FIELD = {
  fieldId: 'field-1',
  name: 'Notes',
  type: 'text',
  required: false,
  boardId: 'board-1',
};

const SAMPLE_SELECT_FIELD = {
  fieldId: 'field-2',
  name: 'Priority',
  type: 'select',
  required: true,
  boardId: 'board-1',
  options: [
    { optionId: 'o1', name: 'High', color: '#f00' },
    { optionId: 'o2', name: 'Low', color: '#0f0' },
  ],
};

const SAMPLE_FIELD_VALUE = {
  fieldId: 'field-1',
  value: 'Some text',
  displayValue: 'Some text',
};

function buildProgram(): Command {
  const program = new Command();
  program.option('--verbose', 'Show stack traces');
  registerCustomFieldsCommands(program);
  return program;
}

async function runCli(args: string[]): Promise<void> {
  const program = buildProgram();
  program.exitOverride();
  await program.parseAsync(['node', 'favro', ...args]);
}

beforeEach(() => {
  jest.clearAllMocks();
  (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
});

// =============================================================================
// custom-fields list <board-id>
// =============================================================================

describe('favro custom-fields list', () => {
  let consoleSpy: jest.SpyInstance;
  let consoleTableSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleTableSpy = jest.spyOn(console, 'table').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleTableSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('lists fields in table format by default', async () => {
    MockCustomFieldsAPI.prototype.listFields = jest.fn().mockResolvedValue([
      SAMPLE_TEXT_FIELD,
      SAMPLE_SELECT_FIELD,
    ]);
    await runCli(['custom-fields', 'list', 'board-1']);
    expect(MockCustomFieldsAPI.prototype.listFields).toHaveBeenCalledWith('board-1');
    expect(consoleTableSpy).toHaveBeenCalled();
  });

  it('lists fields as JSON with --json flag', async () => {
    MockCustomFieldsAPI.prototype.listFields = jest.fn().mockResolvedValue([SAMPLE_TEXT_FIELD]);
    await runCli(['custom-fields', 'list', 'board-1', '--json']);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('"fieldId"')
    );
  });

  it('shows "no fields found" when board has no custom fields', async () => {
    MockCustomFieldsAPI.prototype.listFields = jest.fn().mockResolvedValue([]);
    await runCli(['custom-fields', 'list', 'board-1']);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('No custom fields')
    );
  });

  it('exits with error when API token is missing', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(null);
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    await expect(runCli(['custom-fields', 'list', 'board-1'])).rejects.toThrow();
    mockExit.mockRestore();
  });

  it('exits with error when API call fails', async () => {
    MockCustomFieldsAPI.prototype.listFields = jest.fn().mockRejectedValue(
      new Error('Network error')
    );
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    await expect(runCli(['custom-fields', 'list', 'board-1'])).rejects.toThrow();
    mockExit.mockRestore();
  });
});

// =============================================================================
// custom-fields get <field-id>
// =============================================================================

describe('favro custom-fields get', () => {
  let consoleSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('gets a field and shows detail', async () => {
    MockCustomFieldsAPI.prototype.getField = jest.fn().mockResolvedValue(SAMPLE_TEXT_FIELD);
    await runCli(['custom-fields', 'get', 'field-1']);
    expect(MockCustomFieldsAPI.prototype.getField).toHaveBeenCalledWith('field-1');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('field-1'));
  });

  it('gets a field as JSON with --json flag', async () => {
    MockCustomFieldsAPI.prototype.getField = jest.fn().mockResolvedValue(SAMPLE_SELECT_FIELD);
    await runCli(['custom-fields', 'get', 'field-2', '--json']);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('"fieldId"')
    );
  });

  it('exits with error when field not found', async () => {
    MockCustomFieldsAPI.prototype.getField = jest.fn().mockRejectedValue(
      new Error('Field not found')
    );
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    await expect(runCli(['custom-fields', 'get', 'nonexistent'])).rejects.toThrow();
    mockExit.mockRestore();
  });

  it('exits with error when API token is missing', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(null);
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    await expect(runCli(['custom-fields', 'get', 'field-1'])).rejects.toThrow();
    mockExit.mockRestore();
  });
});

// =============================================================================
// custom-fields set <card-id> <field-id> <value>
// =============================================================================

describe('favro custom-fields set', () => {
  let consoleSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('sets a field value and shows confirmation', async () => {
    MockCustomFieldsAPI.prototype.setFieldValue = jest.fn().mockResolvedValue(SAMPLE_FIELD_VALUE);
    await runCli(['custom-fields', 'set', 'card-1', 'field-1', 'Some text']);
    expect(MockCustomFieldsAPI.prototype.setFieldValue).toHaveBeenCalledWith('card-1', 'field-1', 'Some text');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('✓ Custom field updated'));
  });

  it('sets a field value as JSON with --json flag', async () => {
    MockCustomFieldsAPI.prototype.setFieldValue = jest.fn().mockResolvedValue(SAMPLE_FIELD_VALUE);
    await runCli(['custom-fields', 'set', 'card-1', 'field-1', 'text', '--json']);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('"fieldId"')
    );
  });

  it('exits with error when set fails', async () => {
    MockCustomFieldsAPI.prototype.setFieldValue = jest.fn().mockRejectedValue(
      new Error('Invalid value')
    );
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    await expect(runCli(['custom-fields', 'set', 'card-1', 'field-1', 'bad'])).rejects.toThrow();
    mockExit.mockRestore();
  });

  it('exits with error when API token is missing', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(null);
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    await expect(runCli(['custom-fields', 'set', 'card-1', 'field-1', 'val'])).rejects.toThrow();
    mockExit.mockRestore();
  });
});

// =============================================================================
// custom-fields values <field-id>
// =============================================================================

describe('favro custom-fields values', () => {
  let consoleSpy: jest.SpyInstance;
  let consoleTableSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleTableSpy = jest.spyOn(console, 'table').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleTableSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('lists options in table format', async () => {
    MockCustomFieldsAPI.prototype.listFieldValues = jest.fn().mockResolvedValue(
      SAMPLE_SELECT_FIELD.options
    );
    await runCli(['custom-fields', 'values', 'field-2']);
    expect(MockCustomFieldsAPI.prototype.listFieldValues).toHaveBeenCalledWith('field-2', undefined);
    expect(consoleTableSpy).toHaveBeenCalled();
  });

  it('lists options with --board flag', async () => {
    MockCustomFieldsAPI.prototype.listFieldValues = jest.fn().mockResolvedValue(
      SAMPLE_SELECT_FIELD.options
    );
    await runCli(['custom-fields', 'values', 'field-2', '--board', 'board-1']);
    expect(MockCustomFieldsAPI.prototype.listFieldValues).toHaveBeenCalledWith('field-2', 'board-1');
  });

  it('lists options as JSON with --json flag', async () => {
    MockCustomFieldsAPI.prototype.listFieldValues = jest.fn().mockResolvedValue(
      SAMPLE_SELECT_FIELD.options
    );
    await runCli(['custom-fields', 'values', 'field-2', '--json']);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('"optionId"')
    );
  });

  it('shows "no options found" when field has no options', async () => {
    MockCustomFieldsAPI.prototype.listFieldValues = jest.fn().mockResolvedValue([]);
    await runCli(['custom-fields', 'values', 'field-1']);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('No options found')
    );
  });

  it('exits with error when API call fails', async () => {
    MockCustomFieldsAPI.prototype.listFieldValues = jest.fn().mockRejectedValue(
      new Error('Field not found')
    );
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    await expect(runCli(['custom-fields', 'values', 'nonexistent'])).rejects.toThrow();
    mockExit.mockRestore();
  });

  it('exits with error when API token is missing', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(null);
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    await expect(runCli(['custom-fields', 'values', 'field-1'])).rejects.toThrow();
    mockExit.mockRestore();
  });
});
