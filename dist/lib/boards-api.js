"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BoardsAPI = void 0;
exports.aggregateBoardStats = aggregateBoardStats;
exports.calculateVelocity = calculateVelocity;
/** Normalize a raw Favro widget object into the CLI Board interface */
function normalizeWidget(w) {
    return {
        boardId: w.widgetCommonId,
        name: w.name,
        type: w.type,
        collectionId: (w.collectionIds ?? [])[0],
        // columns is count of columns for display; raw response gives column objects
        columns: Array.isArray(w.columns) ? w.columns.length : undefined,
        createdAt: w.createdAt ?? '',
        updatedAt: w.updatedAt ?? '',
    };
}
/**
 * Aggregate board stats from board data.
 * If raw card data is provided, compute from cards; otherwise use board metadata.
 */
function aggregateBoardStats(board, cards) {
    if (cards && cards.length > 0) {
        const now = new Date();
        const doneCards = cards.filter(c => c.status?.toLowerCase() === 'done' || c.status?.toLowerCase() === 'completed').length;
        const overdueCards = cards.filter(c => {
            if (!c.dueDate)
                return false;
            return new Date(c.dueDate) < now && c.status?.toLowerCase() !== 'done';
        }).length;
        return {
            totalCards: cards.length,
            doneCards,
            openCards: cards.length - doneCards,
            overdueCards,
        };
    }
    const total = board.cardCount ?? 0;
    return {
        totalCards: total,
        doneCards: 0,
        openCards: total,
        overdueCards: 0,
    };
}
/**
 * Calculate velocity from card completion data.
 * Returns weekly velocity data for the last 4 weeks.
 */
function calculateVelocity(cards) {
    const velocity = [];
    const now = new Date();
    for (let week = 3; week >= 0; week--) {
        const weekEnd = new Date(now);
        weekEnd.setDate(weekEnd.getDate() - week * 7);
        const weekStart = new Date(weekEnd);
        weekStart.setDate(weekStart.getDate() - 7);
        const period = `${weekStart.toISOString().slice(0, 10)} to ${weekEnd.toISOString().slice(0, 10)}`;
        if (!cards || cards.length === 0) {
            velocity.push({ period, completed: 0, added: 0, netChange: 0 });
            continue;
        }
        const completed = cards.filter(c => {
            if (!c.updatedAt)
                return false;
            const updated = new Date(c.updatedAt);
            return (updated >= weekStart &&
                updated < weekEnd &&
                (c.status?.toLowerCase() === 'done' || c.status?.toLowerCase() === 'completed'));
        }).length;
        velocity.push({ period, completed, added: 0, netChange: completed });
    }
    return velocity;
}
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
            const response = await this.client.get('/widgets', { params });
            const boards = (response.entities || []).map(normalizeWidget);
            allBoards.push(...boards);
            requestId = response.requestId;
            if (!requestId || !response.pages || page >= response.pages || boards.length === 0)
                break;
            page++;
        }
        return allBoards;
    }
    async getBoard(boardId) {
        const raw = await this.client.get(`/widgets/${boardId}`);
        return normalizeWidget(raw);
    }
    /**
     * Get a board with optional extended data.
     * --include: custom-fields, cards, members, stats, velocity
     */
    async getBoardWithIncludes(boardId, include) {
        const params = {};
        if (include && include.length > 0) {
            params.include = include.join(',');
        }
        const raw = await this.client.get(`/widgets/${boardId}`, { params });
        const board = { ...normalizeWidget(raw) };
        // Stats and velocity are computed client-side if requested
        if (include?.includes('stats') || include?.includes('velocity')) {
            let cards;
            if (Array.isArray(board.cards)) {
                cards = board.cards;
            }
            if (include?.includes('stats')) {
                board.stats = aggregateBoardStats(board, cards);
            }
            if (include?.includes('velocity')) {
                board.velocity = calculateVelocity(cards);
            }
        }
        return board;
    }
    /**
     * List boards in a specific collection with optional includes.
     */
    async listBoardsByCollection(collectionId, include) {
        const params = { collectionId };
        if (include && include.length > 0) {
            params.include = include.join(',');
        }
        const allBoards = [];
        let requestId;
        let page = 1;
        while (true) {
            const p = { ...params, limit: 50 };
            if (requestId) {
                p.requestId = requestId;
                p.page = page;
            }
            const response = await this.client.get('/widgets', { params: p });
            const boards = (response.entities || []).map(normalizeWidget);
            // Augment each board with stats/velocity if requested
            for (const board of boards) {
                if (include?.includes('stats')) {
                    board.stats = aggregateBoardStats(board);
                }
                if (include?.includes('velocity')) {
                    board.velocity = calculateVelocity();
                }
                allBoards.push(board);
            }
            requestId = response.requestId;
            if (!requestId || !response.pages || page >= response.pages || boards.length === 0)
                break;
            page++;
        }
        return allBoards;
    }
    /**
     * Create a board in a collection with optional type.
     */
    async createBoardInCollection(collectionId, data) {
        const raw = await this.client.post('/widgets', { ...data, collectionId });
        return normalizeWidget(raw);
    }
    async createBoard(data) {
        const raw = await this.client.post('/widgets', data);
        return normalizeWidget(raw);
    }
    async updateBoard(boardId, data) {
        // Favro uses PUT for widget updates (not PATCH)
        const raw = await this.client.put(`/widgets/${boardId}`, data);
        return normalizeWidget(raw);
    }
    async deleteBoard(boardId) {
        await this.client.delete(`/widgets/${boardId}`);
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