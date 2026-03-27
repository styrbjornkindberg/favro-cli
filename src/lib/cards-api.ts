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
  updatedAt?: string;
}

export interface CreateCardRequest {
  name: string;
  description?: string;
  status?: string;
  boardId?: string;
  assignees?: string[];
}

export interface UpdateCardRequest {
  name?: string;
  description?: string;
  status?: string;
  assignees?: string[];
  tags?: string[];
}

/**
 * Paginated response from Favro API.
 * The API uses cursor-based pagination via requestId + page cursor.
 */
export interface PaginatedResponse<T> {
  entities: T[];
  requestId?: string;
  page?: number;
  pages?: number;
  limit?: number;
}

export class CardsAPI {
  constructor(private client: FavroHttpClient) {}

  /**
   * List cards with automatic cursor-based pagination.
   * Fetches all pages until the limit is reached or no more pages exist.
   *
   * @param boardId  Optional board ID to filter cards
   * @param limit    Maximum total cards to return (default 50)
   */
  async listCards(boardId?: string, limit: number = 50): Promise<Card[]> {
    const path = boardId ? `/boards/${boardId}/cards` : '/cards';
    const allCards: Card[] = [];
    let page = 0;
    let totalPages = 1;
    let requestId: string | undefined;

    while (allCards.length < limit && page < totalPages) {
      const params: Record<string, unknown> = {
        limit: Math.min(limit - allCards.length, 100), // request at most 100 per page
      };

      // On subsequent pages, use requestId to continue pagination
      if (requestId) {
        params.requestId = requestId;
        params.page = page;
      }

      const response = await this.client.get<PaginatedResponse<Card>>(path, { params });

      const entities = response.entities ?? [];
      allCards.push(...entities);

      // Update pagination state from response
      if (response.requestId) {
        requestId = response.requestId;
        totalPages = response.pages ?? 1;
        page = (response.page ?? 0) + 1;
      } else {
        // No pagination info — single-page response
        break;
      }

      // Stop if we got fewer entities than requested (last page)
      if (entities.length === 0) break;
    }

    return allCards.slice(0, limit);
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
    const response = await this.client.get<PaginatedResponse<Card>>('/cards/search', {
      params: { q: query, limit }
    });
    return response.entities ?? [];
  }
}

export default CardsAPI;
