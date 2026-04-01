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
/**
 * Normalize a raw Favro API card response to our internal Card interface.
 * Maps Favro's field names (widgetCommonId, assignments, detailedDescription)
 * to the CLI's expected format (boardId, assignees, description).
 */
function normalizeCard(raw) {
    return {
        cardId: raw.cardId,
        cardCommonId: raw.cardCommonId,
        name: raw.name,
        description: raw.detailedDescription ?? raw.description,
        status: raw.status,
        // Map assignments[].userId → assignees[]
        assignees: (raw.assignments ?? []).map((a) => a.userId),
        tags: raw.tags ?? [],
        dueDate: raw.dueDate,
        createdAt: raw.createdAt ?? '',
        updatedAt: raw.updatedAt,
        // Map widgetCommonId → boardId for internal consistency
        boardId: raw.widgetCommonId ?? raw.boardId,
        columnId: raw.columnId,
        archived: raw.archived,
        sequentialId: raw.sequentialId,
        customFields: raw.customFields,
    };
}
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
        // Favro API: GET /cards with widgetCommonId query param (not /boards/:id/cards)
        const path = '/cards';
        const allCards = [];
        let page = 0;
        let totalPages = 1;
        let requestId;
        while (allCards.length < effectiveLimit && page < totalPages) {
            const params = {
                limit: Math.min(effectiveLimit - allCards.length, 100), // request at most 100 per page
            };
            // Favro uses widgetCommonId to scope cards to a board
            if (boardId) {
                params.widgetCommonId = boardId;
            }
            if (filter) {
                params.filter = filter;
            }
            // On subsequent pages, use requestId to continue pagination
            if (requestId) {
                params.requestId = requestId;
                params.page = page;
            }
            const response = await this.client.get(path, { params });
            const entities = (response.entities ?? []).map(normalizeCard);
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
        const rawCard = await this.client.get(`/cards/${cardId}`, getConfig);
        const card = normalizeCard(rawCard);
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
        // Custom fields are returned inline on card responses from Favro API,
        // not via a separate endpoint.
        if (includes.includes('links') && !card.links) {
            try {
                // Favro: GET /cards/:cardId/dependencies
                const lnk = await this.client.get(`/cards/${cardId}/dependencies`);
                card.links = lnk.entities ?? [];
            }
            catch { /* best effort */ }
        }
        if ((includes.includes('comments') || includes.includes('relations')) && !card.comments) {
            try {
                // Favro: GET /comments?cardCommonId=<cardId>
                const cmt = await this.client.get('/comments', {
                    params: { cardCommonId: cardId }
                });
                card.comments = cmt.entities ?? [];
            }
            catch { /* best effort */ }
        }
        return card;
    }
    /**
     * Get all links for a card.
     */
    async getCardLinks(cardId) {
        // Favro: GET /cards/:cardId/dependencies
        const res = await this.client.get(`/cards/${cardId}/dependencies`);
        return res.entities ?? [];
    }
    /**
     * Link two cards together.
     */
    async linkCard(cardId, req) {
        // Favro: POST /cards/:cardId/dependencies
        return this.client.post(`/cards/${cardId}/dependencies`, {
            toCardId: req.toCardId,
            type: req.type,
        });
    }
    /**
     * Remove a link between two cards.
     */
    async unlinkCard(cardId, fromCardId) {
        await this.client.delete(`/cards/${cardId}/dependencies/${fromCardId}`);
    }
    /**
     * Move a card to a different board.
     */
    async moveCard(cardId, req) {
        // Favro uses PUT /cards/:cardId with widgetCommonId to move cards
        return this.client.put(`/cards/${cardId}`, {
            widgetCommonId: req.toBoardId,
            position: req.position,
        });
    }
    async createCard(data) {
        // Map boardId → widgetCommonId for callers using the old field name
        const payload = { ...data };
        if (payload.boardId && !payload.widgetCommonId) {
            payload.widgetCommonId = payload.boardId;
            delete payload.boardId;
        }
        if (payload.description !== undefined) {
            payload.detailedDescription = payload.description;
            delete payload.description;
        }
        return this.client.post('/cards', payload);
    }
    async createCards(cards) {
        const response = await this.client.post('/cards/bulk', { cards });
        return response.cards || [];
    }
    async updateCard(cardId, data) {
        const payload = { ...data };
        if (payload.description !== undefined) {
            payload.detailedDescription = payload.description;
            delete payload.description;
        }
        if (payload.boardId !== undefined) {
            payload.widgetCommonId = payload.boardId;
            delete payload.boardId;
        }
        // Favro API uses addAssignmentIds/removeAssignmentIds, not assignees
        if (payload.assignees !== undefined) {
            payload.addAssignmentIds = payload.assignees;
            delete payload.assignees;
        }
        // Favro uses PUT for card updates, not PATCH
        return this.client.put(`/cards/${cardId}`, payload);
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