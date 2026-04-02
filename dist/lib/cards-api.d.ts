import FavroHttpClient from './http-client';
export interface CustomField {
    fieldId: string;
    name: string;
    value: unknown;
    type?: string;
}
export interface CardLink {
    linkId: string;
    type: 'depends-on' | 'blocks' | 'related' | 'duplicates';
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
    type: 'depends-on' | 'blocks' | 'related' | 'duplicates';
    cardId: string;
}
export interface Card {
    cardId: string;
    /** cardCommonId — stable ID across widgets; used for comments API */
    cardCommonId?: string;
    name: string;
    description?: string;
    status?: string;
    assignees?: string[];
    tags?: string[];
    dueDate?: string;
    createdAt: string;
    updatedAt?: string;
    /** boardId — our alias for widgetCommonId */
    boardId?: string;
    columnId?: string;
    collectionId?: string;
    archived?: boolean;
    sequentialId?: number;
    /** Parent card ID for hierarchical card relationships */
    parentCardId?: string;
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
    /** widgetCommonId — the board (widget) to create the card on */
    widgetCommonId?: string;
    /** @deprecated Use widgetCommonId instead */
    boardId?: string;
    columnId?: string;
    assignees?: string[];
    /** Parent card ID — makes this card a child of the specified card */
    parentCardId?: string;
}
export interface UpdateCardRequest {
    name?: string;
    description?: string;
    status?: string;
    assignees?: string[];
    tags?: string[];
    /** Due date in YYYY-MM-DD format. Supported by Favro API updateCard endpoint. */
    dueDate?: string;
    /** Target board ID when moving a card between boards. Supported by Favro API updateCard endpoint. */
    boardId?: string;
    /** Target column ID when moving a card between columns on a board. */
    columnId?: string;
    /** Parent card ID — sets or changes the parent card */
    parentCardId?: string;
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
    type: 'depends-on' | 'blocks' | 'related' | 'duplicates';
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
     * Get all links for a card.
     */
    getCardLinks(cardId: string): Promise<CardLink[]>;
    /**
     * Link two cards together.
     */
    linkCard(cardId: string, req: LinkCardRequest): Promise<CardLink>;
    /**
     * Remove a link between two cards.
     */
    unlinkCard(cardId: string, fromCardId: string): Promise<void>;
    /**
     * Remove all dependencies from a card.
     */
    deleteAllDependencies(cardId: string): Promise<void>;
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