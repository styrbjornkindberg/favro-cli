import { CardsAPI, parseCardUrl } from '../lib/cards-api';
import FavroHttpClient from '../lib/http-client';

describe('parseCardUrl', () => {
  it('parses org, board and sequential id from a Favro card URL', () => {
    const url =
      'https://favro.com/organization/b0b311ac98a0250191573541/f37003d6b64b8f229de2fed8?card=Squ-8850';
    const parsed = parseCardUrl(url);
    expect(parsed.organizationId).toBe('b0b311ac98a0250191573541');
    expect(parsed.widgetCommonId).toBe('f37003d6b64b8f229de2fed8');
    expect(parsed.cardSequentialIdLabel).toBe('Squ-8850');
    expect(parsed.sequentialId).toBe(8850);
  });

  it('parses a URL without a board segment', () => {
    const parsed = parseCardUrl('https://favro.com/organization/org123?card=ABC-12');
    expect(parsed.organizationId).toBe('org123');
    expect(parsed.widgetCommonId).toBeUndefined();
    expect(parsed.sequentialId).toBe(12);
  });

  it('throws on a URL missing the card query param', () => {
    expect(() => parseCardUrl('https://favro.com/organization/org123/board')).toThrow(/card/);
  });

  it('throws when the card label has no numeric id', () => {
    expect(() =>
      parseCardUrl('https://favro.com/organization/org123/board?card=NoNumber'),
    ).toThrow(/sequential/i);
  });

  it('throws on a malformed URL', () => {
    expect(() => parseCardUrl('not a url')).toThrow(/Invalid card URL/);
  });
});

describe('CardsAPI.findCardByUrl', () => {
  let api: CardsAPI;
  let mockClient: jest.Mocked<Pick<FavroHttpClient, 'get' | 'post' | 'patch' | 'put' | 'delete'>>;

  beforeEach(() => {
    mockClient = {
      get: jest.fn(),
      post: jest.fn(),
      patch: jest.fn(),
      put: jest.fn(),
      delete: jest.fn(),
    } as any;
    api = new CardsAPI(mockClient as any);
  });

  it('queries by cardSequentialId parsed from the URL and returns the first match', async () => {
    mockClient.get.mockResolvedValue({
      entities: [{ cardId: 'card-1', name: 'Found card', sequentialId: 8850 }],
    });

    const card = await api.findCardByUrl(
      'https://favro.com/organization/org123/board456?card=Squ-8850',
    );

    expect(mockClient.get).toHaveBeenCalledWith('/cards', {
      params: { cardSequentialId: 8850, unique: true, descriptionFormat: 'markdown' },
    });
    expect(card?.cardId).toBe('card-1');
    expect(card?.name).toBe('Found card');
  });

  it('returns null when no card matches', async () => {
    mockClient.get.mockResolvedValue({ entities: [] });
    const card = await api.findCardByUrl(
      'https://favro.com/organization/org123/board456?card=Squ-9999',
    );
    expect(card).toBeNull();
  });

  it('falls back to default description format on a 500', async () => {
    mockClient.get
      .mockRejectedValueOnce({ response: { status: 500 } })
      .mockResolvedValueOnce({
        entities: [{ cardId: 'card-2', name: 'Recovered', sequentialId: 42 }],
      });

    const card = await api.findCardBySequentialId(42);

    expect(mockClient.get).toHaveBeenCalledTimes(2);
    expect(mockClient.get).toHaveBeenLastCalledWith('/cards', {
      params: { cardSequentialId: 42, unique: true },
    });
    expect(card?.cardId).toBe('card-2');
  });
});
