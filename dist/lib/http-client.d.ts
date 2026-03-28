import { AxiosInstance } from 'axios';
export interface AuthConfig {
    token?: string;
    organizationId?: string;
}
export declare class FavroHttpClient {
    private client;
    private auth?;
    constructor(config?: {
        baseURL?: string;
        auth?: AuthConfig;
    });
    private shouldRetry;
    get<T = any>(url: string, config?: any): Promise<T>;
    post<T = any>(url: string, data?: any, config?: any): Promise<T>;
    patch<T = any>(url: string, data?: any, config?: any): Promise<T>;
    delete<T = any>(url: string, config?: any): Promise<T>;
    setAuth(auth: AuthConfig): void;
    getClient(): AxiosInstance;
}
export default FavroHttpClient;
//# sourceMappingURL=http-client.d.ts.map