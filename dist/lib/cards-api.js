"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CardsAPI = void 0;
class CardsAPI {
    constructor(client) {
        this.client = client;
    }
    /**
     * List cards with automatic cursor-based pagination.
     * Fetches all pages until the limit is reached or no more pages exist.
     *
     * @param boardId  Optional board ID to filter cards
     * @param limit    Maximum total cards to return (default 50)
     */
    async listCards(boardId, limit = 50) {
        const path = boardId ? `/boards/${boardId}/cards` : '/cards';
        const allCards = [];
        let page = 0;
        let totalPages = 1;
        let requestId;
        while (allCards.length < limit && page < totalPages) {
            const params = {
                limit: Math.min(limit - allCards.length, 100), // request at most 100 per page
            };
            // On subsequent pages, use requestId to continue pagination
            if (requestId) {
                params.requestId = requestId;
                params.page = page;
            }
            const response = await this.client.get(path, { params });
            const entities = response.entities ?? [];
            allCards.push(...entities);
            // Update pagination state from response
            if (response.requestId) {
                requestId = response.requestId;
                totalPages = response.pages ?? 1;
                page = (response.page ?? 0) + 1;
            }
            else {
                // No pagination info — single-page response
                break;
            }
            // Stop if we got fewer entities than requested (last page)
            if (entities.length === 0)
                break;
        }
        return allCards.slice(0, limit);
    }
    async getCard(cardId) {
        return this.client.get(`/cards/${cardId}`);
    }
    async createCard(data) {
        return this.client.post('/cards', data);
    }
    async createCards(cards) {
        const response = await this.client.post('/cards/bulk', { cards });
        return response.cards || [];
    }
    async updateCard(cardId, data) {
        return this.client.patch(`/cards/${cardId}`, data);
    }
    async deleteCard(cardId) {
        await this.client.delete(`/cards/${cardId}`);
    }
    async searchCards(query, limit = 50) {
        const response = await this.client.get('/cards/search', {
            params: { q: query, limit }
        });
        return response.entities ?? [];
    }
}
exports.CardsAPI = CardsAPI;
exports.default = CardsAPI;
//# sourceMappingURL=cards-api.js.map