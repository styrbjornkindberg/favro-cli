"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BoardsAPI = void 0;
class BoardsAPI {
    constructor(client) {
        this.client = client;
    }
    async listBoards(limit = 50) {
        const response = await this.client.get('/boards', { params: { limit } });
        return response.entities || [];
    }
    async getBoard(boardId) {
        return this.client.get(`/boards/${boardId}`);
    }
    async createBoard(data) {
        return this.client.post('/boards', data);
    }
    async updateBoard(boardId, data) {
        return this.client.patch(`/boards/${boardId}`, data);
    }
    async deleteBoard(boardId) {
        await this.client.delete(`/boards/${boardId}`);
    }
    async listCollections(limit = 50) {
        const response = await this.client.get('/collections', { params: { limit } });
        return response.entities || [];
    }
    async getCollection(collectionId) {
        return this.client.get(`/collections/${collectionId}`);
    }
    async createCollection(data) {
        return this.client.post('/collections', data);
    }
    async updateCollection(collectionId, data) {
        return this.client.patch(`/collections/${collectionId}`, data);
    }
    async deleteCollection(collectionId) {
        await this.client.delete(`/collections/${collectionId}`);
    }
    async addBoardToCollection(collectionId, boardId) {
        return this.client.post(`/collections/${collectionId}/boards/${boardId}`, {});
    }
    async removeBoardFromCollection(collectionId, boardId) {
        await this.client.delete(`/collections/${collectionId}/boards/${boardId}`);
    }
}
exports.BoardsAPI = BoardsAPI;
exports.default = BoardsAPI;
//# sourceMappingURL=boards-api.js.map