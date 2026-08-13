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

// `custom-fields set` is routed through the `update` intent (#109), so the write
// leaves through `TxCards` → `CardsAPI.updateCard`, and the field VALUE is
// resolved separately by `CustomFieldsAPI.fieldWrite` — a read. The stand below
// answers both, and echoes the customFields it was sent so `setFieldValue`'s
// read-back sees the write land.
const mockUpdateCard = jest.fn(async (cardId: string, data: any) => ({
  cardId,
  customFields: data.customFields ?? [],
}));
jest.mock('../../lib/cards-api', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      getCard: jest.fn().mockResolvedValue({ cardId: 'card-1', boardId: 'board-1', customFields: [] }),
      updateCard: mockUpdateCard,
    }))
  };
});

jest.mock('../../lib/safety', () => ({
  // `assertScope` is the check the dispatch table takes; `checkScope` is what the
  // unrouted commands in this file still take. Both are stubbed.
  assertScope: jest.fn().mockResolvedValue(undefined),
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
  // `--human` and `--pretty` declared at the root, and `--human` PREPENDED to
  // every drive: #119 moved this command onto `run()`, so JSON is the default
  // (ADR-0002) and the prose these arms assert lives on the `human` formatter.
  program.option('--human').option('--pretty').option('--verbose', 'Show stack traces');
  registerCustomFieldsCommands(program);
  return program;
}

async function runCli(args: string[]): Promise<void> {
  const program = buildProgram();
  program.exitOverride();
  await program.parseAsync(['node', 'favro', '--human', ...args]);
}

/**
 * The machine path — the DEFAULT since #119 (ADR-0002). `runCli` above prepends
 * `--human`; this one does not, which is the only difference.
 */
async function runJson(args: string[]): Promise<void> {
  const program = buildProgram();
  program.exitOverride();
  await program.parseAsync(['node', 'favro', ...args]);
}

beforeEach(() => {
  jest.clearAllMocks();
  (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
  // `run()` reads the config before it calls the handler and puts it on `ctx`,
  // so the auto-mock's `undefined` is not a stand-in for "no lock" any more —
  // it is a `TypeError` the runner's boundary swallows into an empty preview.
  (config.readConfig as jest.Mock).mockResolvedValue({});
  // The resolution half of a custom-field write, split out of `setFieldValue`
  // for #109 so the transactional facade can do it on the read side. A text
  // field spells its value under `value`.
  MockCustomFieldsAPI.prototype.fieldWrite = jest.fn(async (_fieldId: string, value: string) => ({
    key: 'value' as const,
    value,
  }));
});

// =============================================================================
// custom-fields list <board-id>
// =============================================================================

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
    await runJson(['custom-fields', 'list', 'board-1']);
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
    await runCli(['custom-fields', 'list', 'board-1']);
    expect(process.exitCode).toBe(1);
    mockExit.mockRestore();
  });

  it('exits with error when API call fails', async () => {
    MockCustomFieldsAPI.prototype.listFields = jest.fn().mockRejectedValue(
      new Error('Network error')
    );
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    await runCli(['custom-fields', 'list', 'board-1']);
    expect(process.exitCode).toBe(1);
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
    await runJson(['custom-fields', 'get', 'field-2']);
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
    await runCli(['custom-fields', 'get', 'nonexistent']);
    expect(process.exitCode).toBe(1);
    mockExit.mockRestore();
  });

  it('exits with error when API token is missing', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(null);
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    await runCli(['custom-fields', 'get', 'field-1']);
    expect(process.exitCode).toBe(1);
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

  it('resolves the value against the field, then writes it through the card PUT', async () => {
    await runCli(['custom-fields', 'set', 'card-1', 'field-1', 'Some text']);

    expect(MockCustomFieldsAPI.prototype.fieldWrite).toHaveBeenCalledWith('field-1', 'Some text');
    expect(mockUpdateCard).toHaveBeenCalledWith('card-1', {
      customFields: [{ customFieldId: 'field-1', value: 'Some text' }],
    });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('✓ Custom field updated'));
  });

  it('sends the value under the key the FIELD TYPE spells, not always `value`', async () => {
    // `custom-fields-api.ts` builds four different payload keys per type, and
    // routing must not quietly fold `Members` / `Link` / `Number` onto `value` —
    // three shapes nobody has probed on this path (#106).
    MockCustomFieldsAPI.prototype.fieldWrite = jest.fn(async (_fieldId: string, value: string) => ({
      key: 'members' as const,
      value: [value],
    }));

    await runCli(['custom-fields', 'set', 'card-1', 'field-9', 'user-9']);

    expect(mockUpdateCard).toHaveBeenCalledWith('card-1', {
      customFields: [{ customFieldId: 'field-9', members: ['user-9'] }],
    });
  });

  /**
   * There is no "accepted (200) but UNCONFIRMED" arm any more, and that is the
   * point of routing this command.
   *
   * It used to PUT and then report whatever came back: an echo carrying no value
   * for the field printed `UNCONFIRMED` at exit 1, and the write's fate was left
   * to the reader. `TxCards.setFieldValue` matches the echo on `customFieldId`
   * and THROWS when it does not carry what it sent, so the unobserved case is a
   * failure the table reports — with the retry advice attached — rather than a
   * success-shaped notice.
   */
  it('an echo that does not carry the value is a FAILURE, not a notice, and exits 1', async () => {
    mockUpdateCard.mockResolvedValueOnce({ cardId: 'card-1', customFields: [] } as never);
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit must not be called under run()');
    });

    await runCli(['custom-fields', 'set', 'card-1', 'field-1', 'Some text']);

    const printed = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).not.toContain('✓');
    const errored = consoleErrorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(errored).toContain('✗ update failed');
    expect(process.exitCode).toBe(1);
    expect(mockExit).not.toHaveBeenCalled();
    mockExit.mockRestore();
  });

  it('--json prints the intent result', async () => {
    await runJson(['custom-fields', 'set', 'card-1', 'field-1', 'text']);

    const printed = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(JSON.parse(printed)).toMatchObject({ cardId: 'card-1', wrote: ['customField:field-1'] });
  });

  it('--dry-run with no lock previews the intent and writes nothing', async () => {
    // Free: no credential, no request. The preview is the intent's own, so it
    // cannot word the write differently from the run that makes it.
    await runCli(['custom-fields', 'set', 'card-1', 'field-1', 'text', '--dry-run']);

    expect(mockUpdateCard).not.toHaveBeenCalled();
    const printed = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('[dry-run] update card card-1');
    expect(printed).toContain('custom field field-1: "text"');
  });

  it('exits with error when the value cannot be resolved for the field', async () => {
    MockCustomFieldsAPI.prototype.fieldWrite = jest.fn().mockRejectedValue(new Error('Invalid value'));
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    await runCli(['custom-fields', 'set', 'card-1', 'field-1', 'bad']);
    expect(process.exitCode).toBe(1);
    mockExit.mockRestore();
  });

  it('exits with error when API token is missing', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(null);
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    await runCli(['custom-fields', 'set', 'card-1', 'field-1', 'val']);
    expect(process.exitCode).toBe(1);
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
    await runJson(['custom-fields', 'values', 'field-2']);
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
    await runCli(['custom-fields', 'values', 'nonexistent']);
    expect(process.exitCode).toBe(1);
    mockExit.mockRestore();
  });

  it('exits with error when API token is missing', async () => {
    (config.resolveApiKey as jest.Mock).mockResolvedValue(null);
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    await runCli(['custom-fields', 'values', 'field-1']);
    expect(process.exitCode).toBe(1);
    mockExit.mockRestore();
  });
});
