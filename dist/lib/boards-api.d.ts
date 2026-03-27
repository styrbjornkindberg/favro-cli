import FavroHttpClient from './http-client';
export interface Board {
    boardId: string;
    name: string;
    description?: string;
    collectionId?: string;
    cardCount?: number;
    columns?: number;
    createdAt: string;
    updatedAt: string;
}
export interface Collection {
    collectionId: string;
    name: string;
    description?: string;
    boards?: Board[];
    createdAt: string;
    updatedAt: string;
}
export declare class BoardsAPI {
    private client;
    constructor(client: FavroHttpClient);
    listBoards(pageSize?: number): Promise<Board[]>;
    getBoard(boardId: string): Promise<Board>;
    createBoard(data: {
        name: string;
        description?: string;
        collectionId?: string;
    }): Promise<Board>;
    updateBoard(boardId: string, data: {
        name?: string;
        description?: string;
    }): Promise<Board>;
    deleteBoard(boardId: string): Promise<void>;
    listCollections(pageSize?: number): Promise<Collection[]>;
    getCollection(collectionId: string): Promise<Collection>;
    createCollection(data: {
        name: string;
        description?: string;
    }): Promise<Collection>;
    updateCollection(collectionId: string, data: {
        name?: string;
        description?: string;
    }): Promise<Collection>;
    deleteCollection(collectionId: string): Promise<void>;
    addBoardToCollection(collectionId: string, boardId: string): Promise<Collection>;
    removeBoardFromCollection(collectionId: string, boardId: string): Promise<void>;
}
export default BoardsAPI;
//# sourceMappingURL=boards-api.d.ts.map