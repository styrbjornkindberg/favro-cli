import FavroHttpClient from './http-client';
export interface CustomField {
    fieldId: string;
    name: string;
    value: unknown;
    type?: string;
}
export interface CardLink {
    linkId: string;
    type: 'depends' | 'blocks' | 'duplicates' | 'relates';
    cardId: string;
    cardName?: string;
}
export interface CardComment {
    commentId: string;
    text: string;
    createdAt: string;
    author?: string;
}
export interface CardRelation {
    type: 'depends' | 'blocks' | 'duplicates' | 'relates';
    cardId: string;
}
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
    boardId?: string;
    collectionId?: string;
    board?: {
        boardId: string;
        name: string;
        [key: string]: unknown;
    };
    collection?: {
        collectionId: string;
        name: string;
        [key: string]: unknown;
    };
    customFields?: CustomField[];
    links?: CardLink[];
    comments?: CardComment[];
    relations?: CardRelation[];
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
export interface GetCardOptions {
    /** List of include keys: board, collection, custom-fields, links, comments, relations */
    include?: string[];
}
export interface LinkCardRequest {
    toCardId: string;
    type: 'depends' | 'blocks' | 'duplicates' | 'relates';
}
export interface MoveCardRequest {
    toBoardId: string;
    position?: 'top' | 'bottom';
}
export declare class CardsAPI {
    private client;
    constructor(client: FavroHttpClient);
    /**
     * List cards with automatic cursor-based pagination.
     * Fetches all pages until the limit is reached or no more pages exist.
     *
     * @param boardId  Optional board ID to filter cards
     * @param limit    Maximum total cards to return (default 25)
     * @param filter   Optional filter expression passed to API
     */
    listCards(boardId?: string, limit?: number, filter?: string): Promise<Card[]>;
    /**
     * Get a single card with optional includes (board, collection, custom-fields, links, comments).
     */
    getCard(cardId: string, options?: GetCardOptions): Promise<Card>;
    /**
     * Link two cards together.
     */
    linkCard(cardId: string, req: LinkCardRequest): Promise<CardLink>;
    /**
     * Remove a link between two cards.
     */
    unlinkCard(cardId: string, fromCardId: string): Promise<void>;
    /**
     * Move a card to a different board.
     */
    moveCard(cardId: string, req: MoveCardRequest): Promise<Card>;
    createCard(data: CreateCardRequest): Promise<Card>;
    createCards(cards: CreateCardRequest[]): Promise<Card[]>;
    updateCard(cardId: string, data: UpdateCardRequest): Promise<Card>;
    deleteCard(cardId: string): Promise<void>;
    searchCards(query: string, limit?: number): Promise<Card[]>;
}
export default CardsAPI;
//# sourceMappingURL=cards-api.d.ts.map