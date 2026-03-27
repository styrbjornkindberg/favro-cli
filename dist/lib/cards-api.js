"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
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
     * @param limit    Maximum total cards to return (default 25)
     * @param filter   Optional filter expression passed to API
     */
    async listCards(boardId, limit = 25, filter) {
        // Default 25; use explicit NaN/range check (not ||) to avoid limit=0 falsy bug
        const effectiveLimit = (isNaN(limit) || limit < 1) ? 25 : limit;
        const path = boardId ? `/boards/${boardId}/cards` : '/cards';
        const allCards = [];
        let page = 0;
        let totalPages = 1;
        let requestId;
        while (allCards.length < effectiveLimit && page < totalPages) {
            const params = {
                limit: Math.min(effectiveLimit - allCards.length, 100), // request at most 100 per page
            };
            if (filter) {
                params.filter = filter;
            }
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
        return allCards.slice(0, effectiveLimit);
    }
    /**
     * Get a single card with optional includes (board, collection, custom-fields, links, comments).
     */
    async getCard(cardId, options) {
        const params = {};
        const includes = options?.include ?? [];
        if (includes.length > 0) {
            params.include = includes.join(',');
        }
        const getConfig = Object.keys(params).length > 0 ? { params } : undefined;
        const card = await this.client.get(`/cards/${cardId}`, getConfig);
        // Hydrate board/collection if requested and not already present
        if (includes.includes('board') && card.boardId && !card.board) {
            try {
                const { BoardsAPI } = await Promise.resolve().then(() => __importStar(require('./boards-api')));
                const boardsApi = new BoardsAPI(this.client);
                card.board = await boardsApi.getBoard(card.boardId);
            }
            catch { /* best effort */ }
        }
        if (includes.includes('collection') && card.collectionId && !card.collection) {
            try {
                const { BoardsAPI } = await Promise.resolve().then(() => __importStar(require('./boards-api')));
                const boardsApi = new BoardsAPI(this.client);
                card.collection = await boardsApi.getCollection(card.collectionId);
            }
            catch { /* best effort */ }
        }
        if (includes.includes('custom-fields') && !card.customFields) {
            try {
                const cf = await this.client.get(`/cards/${cardId}/custom-fields`);
                card.customFields = cf.entities ?? [];
            }
            catch { /* best effort */ }
        }
        if (includes.includes('links') && !card.links) {
            try {
                const lnk = await this.client.get(`/cards/${cardId}/links`);
                card.links = lnk.entities ?? [];
            }
            catch { /* best effort */ }
        }
        if ((includes.includes('comments') || includes.includes('relations')) && !card.comments) {
            try {
                const cmt = await this.client.get(`/cards/${cardId}/comments`);
                card.comments = cmt.entities ?? [];
            }
            catch { /* best effort */ }
        }
        return card;
    }
    /**
     * Link two cards together.
     */
    async linkCard(cardId, req) {
        return this.client.post(`/cards/${cardId}/links`, {
            toCardId: req.toCardId,
            type: req.type,
        });
    }
    /**
     * Remove a link between two cards.
     */
    async unlinkCard(cardId, fromCardId) {
        await this.client.delete(`/cards/${cardId}/links/${fromCardId}`);
    }
    /**
     * Move a card to a different board.
     */
    async moveCard(cardId, req) {
        return this.client.patch(`/cards/${cardId}/move`, {
            boardId: req.toBoardId,
            position: req.position,
        });
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