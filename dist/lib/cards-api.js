"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CardsAPI = void 0;
class CardsAPI {
    constructor(client) {
        this.client = client;
    }
    async listCards(boardId, limit = 50) {
        const params = { limit };
        const path = boardId ? `/boards/${boardId}/cards` : '/cards';
        const response = await this.client.get(path, { params });
        return response.entities || [];
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
        return response.entities || [];
    }
}
exports.CardsAPI = CardsAPI;
exports.default = CardsAPI;
//# sourceMappingURL=cards-api.js.map