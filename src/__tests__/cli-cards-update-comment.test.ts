/**
 * `favro cards update <card> --comment` — who resolves the `cardCommonId` (#89).
 *
 * There were two comments modules. This path used the one that did NOT resolve
 * identifiers, and then open-coded `card.cardCommonId ?? cardId` at the call
 * site — importing the module that was supposed to own that translation and
 * doing it by hand anyway.
 *
 * What these pin is only that: the CLI hands the client the reference the user
 * typed and resolves nothing itself. They mock `../api/comments` wholesale, so
 * they say nothing about what the resolver then does — the `?? reference`
 * fallback lived on inside `toCardCommonId` until it was made to throw in the
 * same change (`card-reference.ts:commonIdOf`, pinned in
 * `cards-api-reference-wire.test.ts` against a real socket).
 *
 * UNMEASURED: what Favro does with a `cardId` in the `cardCommonId` slot of
 * `POST /comments` has never been observed from this repo. `docs/research/
 * card-identifier-semantics.md` §3.2 reasons it is a 404 at best and an orphaned
 * comment at worst, and §3.1 records the *read* side answering an empty list
 * rather than an error — but neither is a measurement, and the write side is not
 * the read side. The refusal above is justified by the keyspaces being disjoint,
 * which is documented; it does not need the failure mode to be known.
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
