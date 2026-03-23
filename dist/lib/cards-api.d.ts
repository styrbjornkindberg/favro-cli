import FavroHttpClient from './http-client';
export interface Card {
    cardId: string;
    name: string;
    description?: string;
    status?: string;
    assignees?: string[];
    tags?: string[];
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
export declare class CardsAPI {
    private client;
    constructor(client: FavroHttpClient);
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