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
export declare class CardsAPI {
    private client;
    constructor(client: FavroHttpClient);
    /**
     * List cards with automatic cursor-based pagination.
     * Fetches all pages until the limit is reached or no more pages exist.
     *
     * @param boardId  Optional board ID to filter cards
     * @param limit    Maximum total cards to return (default 50)
     */
    listCards(boardId?: string, limit?: number): Promise<Card[]>;
    getCard(cardId: string): Promise<Card>;
    createCard(data: CreateCardRequest): Promise<Card>;
    createCards(cards: CreateCardRequest[]): Promise<Card[]>;
    updateCard(cardId: string, data: UpdateCardRequest): Promise<Card>;
    deleteCard(cardId: string): Promise<void>;
    searchCards(query: string, limit?: number): Promise<Card[]>;
}
export default CardsAPI;
//# sourceMappingURL=cards-api.d.ts.map