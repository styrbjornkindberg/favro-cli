/**
 * `favro attachments upload|upload-to-comment` — behaviour (#100).
 *
 * The board resolution behind the scope lock is covered by
 * `attachments-scope.test.ts` (#102). This file covers the rest of the command
 * contract: the confirm, the `--dry-run` preview, the rendered result, and the
 * ordering that makes the preview safe — the lock runs BEFORE the preview, so
 * `--dry-run` is not a way around it.
 */
import { Command } from 'commander';
import { registerAttachmentsCommands } from '../../commands/attachments';
import * as config from '../../lib/config';
import * as safety from '../../lib/safety';
import AttachmentsAPI from '../../lib/attachments-api';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../lib/safety');
jest.mock('../../lib/attachments-api');

const MockAttachments = AttachmentsAPI as jest.MockedClass<typeof AttachmentsAPI>;

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

let logSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
let exitSpy: jest.SpyInstance;

function buildProgram(): Command {
  const program = new Command();
  // `--human` and `--pretty` declared at the root: #119 moved this command onto
  // `run()`, so JSON is the default (ADR-0002) and the prose most arms assert
  // lives on the `human` formatter.
  program.option('--human').option('--pretty').option('--verbose', 'Show stack traces');
  registerAttachmentsCommands(program);
  program.exitOverride();
  return program;
}

/** The human path — `--human` prepended. */
async function runCli(args: string[]): Promise<void> {
  await buildProgram().parseAsync(['node', 'favro', '--human', ...args]);
}

/** The machine path — the DEFAULT since #119 (ADR-0002). */
async function runJson(args: string[]): Promise<void> {
  await buildProgram().parseAsync(['node', 'favro', ...args]);
}

const output = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
const errors = () => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');

beforeEach(() => {
  jest.clearAllMocks();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit must not be called under run()');
  }) as never);

  (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
  (config.readConfig as jest.Mock).mockResolvedValue({});
  (safety.checkResolvedScope as jest.Mock).mockResolvedValue(undefined);
  (safety.confirmAction as jest.Mock).mockResolvedValue(true);
  (safety.dryRunLog as jest.Mock).mockImplementation((verb: string, noun: string, detail: string) =>
    console.log(`[dry-run] ${verb} ${noun}: ${detail}`),
  );

  MockAttachments.prototype.uploadAttachment = jest
    .fn()
    .mockResolvedValue({ attachmentId: 'att-1', name: 'error.log' });
  MockAttachments.prototype.uploadAttachmentToComment = jest
    .fn()
    .mockResolvedValue({ attachmentId: 'att-2', name: 'trace.txt' });
});

afterEach(() => {
  jest.restoreAllMocks();
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

describe('attachments upload', () => {
  test('uploads the named file to the named card and reports the new attachment', async () => {
    await runCli(['attachments', 'upload', 'card-1', '--file', './error.log', '-y']);

    expect(MockAttachments.prototype.uploadAttachment).toHaveBeenCalledWith('card-1', './error.log');
    expect(output()).toContain('✓ Attachment uploaded: att-1 (error.log)');
  });

  test('--dry-run previews and uploads nothing', async () => {
    await runCli(['attachments', 'upload', 'card-1', '--file', './error.log', '--dry-run']);

    expect(MockAttachments.prototype.uploadAttachment).not.toHaveBeenCalled();
    // The TARGET, not just the marker: this arm read `toContain('[dry-run]')` while
    // the target went from `./error.log to card card-1` to the bare name (#162 item
    // 10), so the string it exists to cover was free to drift either way.
    // Anchored at end of line, not `toContain`: a composite target still CONTAINS
    // the bare file name, so a substring match passes on the string being banned.
    expect(output()).toMatch(/^\[dry-run\] upload attachment: \.\/error\.log$/m);
    expect(process.exitCode).toBeUndefined();
  });

  test('the lock runs BEFORE the preview — a preview is not a way around it', async () => {
    await runCli(['attachments', 'upload', 'card-1', '--file', './error.log', '--dry-run']);

    const check = (safety.checkResolvedScope as jest.Mock).mock.invocationCallOrder[0];
    const preview = (safety.dryRunLog as jest.Mock).mock.invocationCallOrder[0];
    expect(check).toBeLessThan(preview);
  });

  test('--dry-run does not ask — previewing is not writing', async () => {
    await runCli(['attachments', 'upload', 'card-1', '--file', './error.log', '--dry-run']);

    expect(safety.confirmAction).not.toHaveBeenCalled();
  });

  test('declining the confirm uploads nothing and exits 0', async () => {
    (safety.confirmAction as jest.Mock).mockResolvedValue(false);

    await runCli(['attachments', 'upload', 'card-1', '--file', './error.log']);

    expect(MockAttachments.prototype.uploadAttachment).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  test('--json emits the attachment record instead of the human line', async () => {
    await runJson(['attachments', 'upload', 'card-1', '--file', './error.log', '-y']);

    expect(JSON.parse(output())).toEqual({ attachmentId: 'att-1', name: 'error.log' });
  });

  test('a refused scope stops the upload and exits 1', async () => {
    (safety.checkResolvedScope as jest.Mock).mockRejectedValue(new Error('Scope violation: board-x'));

    await runCli(['attachments', 'upload', 'card-1', '--file', './error.log', '-y']);

    expect(MockAttachments.prototype.uploadAttachment).not.toHaveBeenCalled();
    expect(errors()).toContain('Scope violation');
    expect(process.exitCode).toBe(1);
  });

  test('a failed upload exits 1 rather than reporting success', async () => {
    MockAttachments.prototype.uploadAttachment = jest.fn().mockRejectedValue(new Error('413 payload too large'));

    await runCli(['attachments', 'upload', 'card-1', '--file', './big.bin', '-y']);

    expect(output()).not.toContain('✓ Attachment uploaded');
    expect(errors()).toContain('413 payload too large');
    expect(process.exitCode).toBe(1);
  });
});

describe('attachments upload-to-comment', () => {
  test('uploads to the comment and reports the new attachment', async () => {
    await runCli(['attachments', 'upload-to-comment', 'cm-1', '--file', './trace.txt', '-y']);

    expect(MockAttachments.prototype.uploadAttachmentToComment).toHaveBeenCalledWith('cm-1', './trace.txt');
    expect(output()).toContain('✓ Attachment uploaded to comment: att-2 (trace.txt)');
  });

  test('--dry-run previews and uploads nothing', async () => {
    await runCli(['attachments', 'upload-to-comment', 'cm-1', '--file', './trace.txt', '--dry-run']);

    expect(MockAttachments.prototype.uploadAttachmentToComment).not.toHaveBeenCalled();
    // The target, as on the card arm above.
    expect(output()).toMatch(/^\[dry-run\] upload attachment: \.\/trace\.txt$/m);
  });

  test('--force reaches the lazy scope resolver', async () => {
    await runCli(['attachments', 'upload-to-comment', 'cm-1', '--file', './trace.txt', '-y', '--force']);

    expect(safety.checkResolvedScope).toHaveBeenCalledWith(expect.anything(), expect.any(Function), true);
  });
});
