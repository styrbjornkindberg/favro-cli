/**
 * `favro cards update <card> --comment` — who resolves the `cardCommonId` (#89).
 *
 * There were two comments modules. This path used the one that did NOT resolve
 * identifiers, and then open-coded `card.cardCommonId ?? cardId` at the call
 * site — importing the module that was supposed to own that translation and
 * doing it by hand anyway. The fallback was the bug: on a card whose read came
 * back without `cardCommonId`, it posted a `cardId` to an endpoint that only
 * takes a `cardCommonId`, and Favro answers that with a 200 and no comment.
 *
 * The surviving client resolves the reference itself, so what these pin is that
 * the CLI hands it the reference the user typed and nothing else.
 */
import { buildProgram } from '../cli';
import { Command } from 'commander';
import CardsAPI, { Card } from '../lib/cards-api';
import FavroHttpClient from '../lib/http-client';
import * as config from '../lib/config';
import * as safety from '../lib/safety';
import { CommentsApiClient } from '../api/comments';

jest.mock('../lib/cards-api');
jest.mock('../lib/http-client');
jest.mock('../lib/config');
jest.mock('../api/comments');
jest.mock('../lib/safety', () => ({
  checkScope: jest.fn().mockResolvedValue(undefined),
  confirmAction: jest.fn().mockResolvedValue(true),
}));

const mockResolveApiKey = config.resolveApiKey as jest.MockedFunction<typeof config.resolveApiKey>;
const mockReadConfig = config.readConfig as jest.MockedFunction<typeof config.readConfig>;
const MockComments = CommentsApiClient as jest.MockedClass<typeof CommentsApiClient>;

const CARD_ID = '713db3018af39956227d4279';
const COMMON_ID = '9f1c2d3e4a5b6c7d8e9f0a1b';

describe('favro cards update --comment', () => {
  let program: Command;
  let mockApi: jest.Mocked<CardsAPI>;
  let addComment: jest.Mock;

  function arrange(card: Partial<Card>): void {
    mockApi.getCard.mockResolvedValue({
      cardId: CARD_ID,
      name: 'A card',
      boardId: 'board-1',
      ...card,
    } as Card);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveApiKey.mockResolvedValue('test-token');
    mockReadConfig.mockResolvedValue({} as never);

    const client = new FavroHttpClient() as jest.Mocked<FavroHttpClient>;
    mockApi = new CardsAPI(client) as jest.Mocked<CardsAPI>;
    (CardsAPI as jest.MockedClass<typeof CardsAPI>).mockImplementation(() => mockApi);

    addComment = jest.fn().mockResolvedValue({ commentId: 'cm-1' });
    MockComments.mockImplementation(() => ({ addComment }) as unknown as CommentsApiClient);

    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    program = buildProgram();
    program.exitOverride();
  });

  afterEach(() => jest.restoreAllMocks());

  it('hands the comments client the reference the user typed, and resolves nothing itself', async () => {
    arrange({ cardCommonId: COMMON_ID });

    await program.parseAsync(['node', 'favro', 'cards', 'update', CARD_ID, '--comment', 'ship it', '--yes']);

    expect(addComment).toHaveBeenCalledWith(CARD_ID, 'ship it');
  });

  it('still passes the reference when the card read carried no cardCommonId', async () => {
    arrange({ cardCommonId: undefined });

    await program.parseAsync(['node', 'favro', 'cards', 'update', CARD_ID, '--comment', 'ship it', '--yes']);

    expect(addComment).toHaveBeenCalledWith(CARD_ID, 'ship it');
  });

  it('takes the scope lock before commenting', async () => {
    arrange({ cardCommonId: COMMON_ID });

    await program.parseAsync(['node', 'favro', 'cards', 'update', CARD_ID, '--comment', 'ship it', '--yes']);

    expect(safety.checkScope).toHaveBeenCalled();
  });

  it('unescapes \\n in the comment body', async () => {
    arrange({ cardCommonId: COMMON_ID });

    await program.parseAsync(['node', 'favro', 'cards', 'update', CARD_ID, '--comment', 'one\\ntwo', '--yes']);

    expect(addComment).toHaveBeenCalledWith(CARD_ID, 'one\ntwo');
  });
});
