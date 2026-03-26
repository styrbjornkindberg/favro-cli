import FavroHttpClient from './http-client';

export interface Card {
  cardId: string;
  name: string;
  description?: string;
  status?: string;
  assignees?: string[];
  tags?: string[];
  dueDate?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCardRequest {
  name: string;
  description?: string;
  status?: string;
  boardId?: string;
}

export interface UpdateCardRequest {
  name?: string;
  description?: string;
  status?: string;
  assignees?: string[];
  tags?: string[];
}

export class CardsAPI {
  constructor(private client: FavroHttpClient) {}

  async listCards(boardId?: string, limit: number = 50): Promise<Card[]> {
    const params = { limit };
    const path = boardId ? `/boards/${boardId}/cards` : '/cards';
    const response = await this.client.get<{ entities: Card[] }>(path, { params });
    return response.entities || [];
  }

  async getCard(cardId: string): Promise<Card> {
    return this.client.get<Card>(`/cards/${cardId}`);
  }

  async createCard(data: CreateCardRequest): Promise<Card> {
    return this.client.post<Card>('/cards', data);
  }

  async createCards(cards: CreateCardRequest[]): Promise<Card[]> {
    const response = await this.client.post<{ cards: Card[] }>('/cards/bulk', { cards });
    return response.cards || [];
  }

  async updateCard(cardId: string, data: UpdateCardRequest): Promise<Card> {
    return this.client.patch<Card>(`/cards/${cardId}`, data);
  }

  async deleteCard(cardId: string): Promise<void> {
    await this.client.delete(`/cards/${cardId}`);
  }

  async searchCards(query: string, limit: number = 50): Promise<Card[]> {
    const response = await this.client.get<{ entities: Card[] }>('/cards/search', {
      params: { q: query, limit }
    });
    return response.entities || [];
  }
}

export default CardsAPI;
