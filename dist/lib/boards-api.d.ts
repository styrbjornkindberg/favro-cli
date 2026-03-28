import FavroHttpClient from './http-client';
export type BoardType = 'board' | 'list' | 'kanban' | 'backlog';
export interface Board {
    boardId: string;
    name: string;
    description?: string;
    type?: BoardType;
    collectionId?: string;
    cardCount?: number;
    columns?: number;
    createdAt: string;
    updatedAt: string;
}
export interface BoardMember {
    userId: string;
    name: string;
    email?: string;
    role?: string;
}
export interface CustomField {
    fieldId: string;
    name: string;
    type: string;
    options?: string[];
}
export interface BoardColumn {
    columnId: string;
    name: string;
    cardCount?: number;
}
export interface BoardStats {
    totalCards: number;
    doneCards: number;
    openCards: number;
    overdueCards: number;
}
export interface VelocityData {
    period: string;
    completed: number;
    added: number;
    netChange: number;
}
export interface ExtendedBoard extends Board {
    members?: BoardMember[];
    customFields?: CustomField[];
    boardColumns?: BoardColumn[];
    cards?: Array<{
        status?: string;
        dueDate?: string;
        updatedAt?: string;
    }>;
    stats?: BoardStats;
    velocity?: VelocityData[];
}
export interface Collection {
    collectionId: string;
    name: string;
    description?: string;
    boards?: Board[];
    createdAt: string;
    updatedAt: string;
}
/**
 * Aggregate board stats from board data.
 * If raw card data is provided, compute from cards; otherwise use board metadata.
 */
export declare function aggregateBoardStats(board: ExtendedBoard, cards?: Array<{
    status?: string;
    dueDate?: string;
}>): BoardStats;
/**
 * Calculate velocity from card completion data.
 * Returns weekly velocity data for the last 4 weeks.
 */
export declare function calculateVelocity(cards?: Array<{
    status?: string;
    updatedAt?: string;
}>): VelocityData[];
export declare class BoardsAPI {
    private client;
    constructor(client: FavroHttpClient);
    listBoards(pageSize?: number): Promise<Board[]>;
    getBoard(boardId: string): Promise<Board>;
    /**
     * Get a board with optional extended data.
     * --include: custom-fields, cards, members, stats, velocity
     */
    getBoardWithIncludes(boardId: string, include?: string[]): Promise<ExtendedBoard>;
    /**
     * List boards in a specific collection with optional includes.
     */
    listBoardsByCollection(collectionId: string, include?: string[]): Promise<ExtendedBoard[]>;
    /**
     * Create a board in a collection with optional type.
     */
    createBoardInCollection(collectionId: string, data: {
        name: string;
        type?: BoardType;
        description?: string;
    }): Promise<Board>;
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