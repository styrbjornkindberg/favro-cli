"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BoardsAPI = void 0;
class BoardsAPI {
    constructor(client) {
        this.client = client;
    }
    async listBoards(pageSize = 50) {
        const allBoards = [];
        let requestId;
        let page = 1;
        while (true) {
            const params = { limit: pageSize };
            if (requestId) {
                params.requestId = requestId;
                params.page = page;
            }
            const response = await this.client.get('/boards', { params });
            const boards = response.entities || [];
            allBoards.push(...boards);
            requestId = response.requestId;
            if (!requestId || !response.pages || page >= response.pages || boards.length === 0)
                break;
            page++;
        }
        return allBoards;
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
    async listCollections(pageSize = 50) {
        const allCollections = [];
        let requestId;
        let page = 1;
        while (true) {
            const params = { limit: pageSize };
            if (requestId) {
                params.requestId = requestId;
                params.page = page;
            }
            const response = await this.client.get('/collections', { params });
            const collections = response.entities || [];
            allCollections.push(...collections);
            requestId = response.requestId;
            if (!requestId || !response.pages || page >= response.pages || collections.length === 0)
                break;
            page++;
        }
        return allCollections;
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