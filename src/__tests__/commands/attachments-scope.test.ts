/**
 * Unit tests — scope lock on the `attachments` write paths (issue #102)
 *
 * `attachments upload-to-comment` writes an attachment; a commentId carries no
 * board, so the board is resolved comment → card before the lock is taken.
 */
import { Command } from 'commander';
import { registerAttachmentsCommands } from '../../commands/attachments';
import * as config from '../../lib/config';
import * as safety from '../../lib/safety';
import CardsAPI from '../../lib/cards-api';
import { passThroughScopeResolution } from '../../test-support/scope-passthrough';
import AttachmentsAPI from '../../lib/attachments-api';
import { CommentsApiClient } from '../../api/comments';

jest.mock('../../lib/http-client');
jest.mock('../../lib/config');
jest.mock('../../lib/safety');
jest.mock('../../lib/cards-api');
jest.mock('../../lib/attachments-api');
jest.mock('../../api/comments');

const MockCardsAPI = CardsAPI as jest.MockedClass<typeof CardsAPI>;
const MockAttachmentsAPI = AttachmentsAPI as jest.MockedClass<typeof AttachmentsAPI>;
const MockComments = CommentsApiClient as jest.MockedClass<typeof CommentsApiClient>;

async function runCli(args: string[]): Promise<void> {
  const program = new Command();
  program.option('--verbose', 'Show stack traces');
  registerAttachmentsCommands(program);
  program.exitOverride();
  await program.parseAsync(['node', 'favro', ...args]);
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

  (config.resolveApiKey as jest.Mock).mockResolvedValue('test-token');
  (config.readConfig as jest.Mock).mockResolvedValue({ scopeCollectionId: 'coll-a' });
  passThroughScopeResolution(safety, config, MockCardsAPI, MockComments);
  (safety.checkScope as jest.Mock).mockResolvedValue(undefined);
  (safety.confirmAction as jest.Mock).mockResolvedValue(true);

  MockComments.prototype.getComment = jest
    .fn()
    .mockResolvedValue({ commentId: 'comment-1', cardId: 'card-1', text: 'hi', createdAt: '' });
  MockCardsAPI.prototype.getCard = jest.fn().mockResolvedValue({ cardId: 'card-1', boardId: 'board-a' });
  MockAttachmentsAPI.prototype.uploadAttachment = jest
    .fn()
    .mockResolvedValue({ attachmentId: 'att-1', name: 'f.log' });
  MockAttachmentsAPI.prototype.uploadAttachmentToComment = jest
    .fn()
    .mockResolvedValue({ attachmentId: 'att-1', name: 'f.log' });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('favro attachments upload-to-comment — scope lock', () => {
  it('resolves the board through comment → card and checks scope before writing', async () => {
    await runCli(['attachments', 'upload-to-comment', 'comment-1', '--file', './f.log', '--yes']);

    expect(MockComments.prototype.getComment).toHaveBeenCalledWith('comment-1');
    expect(MockCardsAPI.prototype.getCard).toHaveBeenCalledWith('card-1');
    expect(safety.checkScope).toHaveBeenCalledWith('board-a', expect.anything(), expect.anything(), undefined);

    const check = (safety.checkScope as jest.Mock).mock.invocationCallOrder[0];
    const write = (MockAttachmentsAPI.prototype.uploadAttachmentToComment as jest.Mock).mock
      .invocationCallOrder[0];
    expect(check).toBeLessThan(write);
  });

  it('writes nothing when the comment’s board is out of scope', async () => {
    (safety.checkScope as jest.Mock).mockRejectedValue(new Error('out of scope'));

    await runCli(['attachments', 'upload-to-comment', 'comment-1', '--file', './f.log', '--yes']);

    expect(MockAttachmentsAPI.prototype.uploadAttachmentToComment).not.toHaveBeenCalled();
  });

  it('checks scope BEFORE asking the user to confirm', async () => {
    await runCli(['attachments', 'upload-to-comment', 'comment-1', '--file', './f.log']);

    const check = (safety.checkScope as jest.Mock).mock.invocationCallOrder[0];
    const confirm = (safety.confirmAction as jest.Mock).mock.invocationCallOrder[0];
    expect(check).toBeLessThan(confirm);
  });

  it('forwards --force to checkScope', async () => {
    await runCli([
      'attachments', 'upload-to-comment', 'comment-1', '--file', './f.log', '--yes', '--force',
    ]);

    expect(safety.checkScope).toHaveBeenCalledWith('board-a', expect.anything(), expect.anything(), true);
  });

  it('still checks scope with an empty board when the comment cannot be read', async () => {
    MockComments.prototype.getComment = jest.fn().mockRejectedValue(new Error('404 Not Found'));

    await runCli(['attachments', 'upload-to-comment', 'stale-comment', '--file', './f.log', '--yes']);

    expect(safety.checkScope).toHaveBeenCalledWith('', expect.anything(), expect.anything(), undefined);
  });

  it('checks scope with an empty board when the card has no board instance', async () => {
    MockCardsAPI.prototype.getCard = jest.fn().mockResolvedValue({ cardId: 'card-1' });

    await runCli(['attachments', 'upload-to-comment', 'comment-1', '--file', './f.log', '--yes']);

    expect(safety.checkScope).toHaveBeenCalledWith('', expect.anything(), expect.anything(), undefined);
  });
});

describe('favro attachments upload — scope lock (regression guard)', () => {
  it('still checks scope for the target card before uploading', async () => {
    await runCli(['attachments', 'upload', 'card-1', '--file', './f.log', '--yes']);

    expect(safety.checkScope).toHaveBeenCalledWith('board-a', expect.anything(), expect.anything(), undefined);

    const check = (safety.checkScope as jest.Mock).mock.invocationCallOrder[0];
    const write = (MockAttachmentsAPI.prototype.uploadAttachment as jest.Mock).mock.invocationCallOrder[0];
    expect(check).toBeLessThan(write);
  });
});
