import axios, { AxiosInstance, AxiosError } from 'axios';
import { rateLimitMessage } from './error-handler';

/**
 * The shape every Favro list endpoint answers with. One declaration, here,
 * because pagination is the HTTP layer's job and not each resource module's
 * (#91). The loop that consumes it lives in `paginate.ts` — a type survives an
 * automock of this module, a function does not.
 *
 * `requestId` is the cursor: absent means there is no page after this one.
 * `page` is the 0-based index the server believes it just served.
 */
export interface PaginatedResponse<T> {
  entities: T[];
  requestId?: string;
  page?: number;
  pages?: number;
  limit?: number;
}

export interface AuthConfig {
  token?: string;
  /** User email — required for HTTP Basic Auth */
  email?: string;
  organizationId?: string;
}

export class FavroHttpClient {
  private client: AxiosInstance;
  private auth?: AuthConfig;
  /** Backend routing identifier — must be forwarded on paginated requests */
  private backendId?: string;

  /** The organization this client is authenticated against, if configured. */
  get organizationId(): string | undefined {
    return this.auth?.organizationId;
  }

  constructor(config: { baseURL?: string; auth?: AuthConfig } = {}) {
    this.auth = config.auth;
    this.client = axios.create({
      baseURL: config.baseURL || 'https://favro.com/api/v1',
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' }
    });

    this.client.interceptors.request.use((cfg) => {
      if (this.auth?.token) {
        if (this.auth.email) {
          // Favro API requires HTTP Basic Auth: email:apiToken
          const credentials = Buffer.from(`${this.auth.email}:${this.auth.token}`).toString('base64');
          cfg.headers['Authorization'] = `Basic ${credentials}`;
        } else {
          // Fallback for legacy/testing — Basic auth without email won't work against live API
          cfg.headers['Authorization'] = `Bearer ${this.auth.token}`;
        }
      }
      if (this.auth?.organizationId) cfg.headers['organizationId'] = this.auth.organizationId;
      // Forward backend routing header for paginated requests
      if (this.backendId) cfg.headers['X-Favro-Backend-Identifier'] = this.backendId;
      return cfg;
    });

    this.client.interceptors.response.use(
      (response) => {
        // Capture backend routing identifier for pagination
        const bid = response.headers?.['x-favro-backend-identifier'];
        if (bid) this.backendId = bid;
        return response;
      },
      async (error: AxiosError) => {
        const retryCount = (error.config as any)?._retryCount ?? 0;
        if (this.shouldRetry(error) && retryCount < 4) {
          (error.config as any)._retryCount = retryCount + 1;

          // For 429, read Retry-After header and show user-visible message
          let delay: number;
          if (error.response?.status === 429) {
            const retryAfterHeader = error.response.headers?.['retry-after'];
            const retryAfterSecs = retryAfterHeader ? parseInt(String(retryAfterHeader), 10) : undefined;
            // Exponential backoff: 1s, 2s, 4s, 8s — capped at 30s
            const expBackoffSecs = Math.min(Math.pow(2, retryCount), 30);
            const delaySecs = Math.min(
              (!isNaN(retryAfterSecs!) && retryAfterSecs! > 0) ? retryAfterSecs! : expBackoffSecs,
              30  // Global cap: Retry-After cannot exceed 30s either
            );
            delay = delaySecs * 1000;
            // User-visible log: "⚠️ Rate limit detected, retrying after Ns..."
            process.stderr.write(rateLimitMessage(delaySecs) + '\n');
          } else {
            // Exponential backoff for 5xx/408: 1s, 2s, 4s, 8s — capped at 30s
            delay = Math.min(Math.pow(2, retryCount) * 1000, 30000); // cap 30s
          }

          await new Promise(resolve => setTimeout(resolve, delay));
          return this.client.request(error.config!);
        }
        return Promise.reject(error);
      }
    );
  }

  private shouldRetry(error: AxiosError): boolean {
    const status = error.response?.status;
    return !status || status === 408 || status === 429 || (status >= 500);
  }

  async get<T = any>(url: string, config?: any): Promise<T> {
    return (await this.client.get<T>(url, config)).data;
  }

  async post<T = any>(url: string, data?: any, config?: any): Promise<T> {
    return (await this.client.post<T>(url, data, config)).data;
  }

  async patch<T = any>(url: string, data?: any, config?: any): Promise<T> {
    return (await this.client.patch<T>(url, data, config)).data;
  }

  async put<T = any>(url: string, data?: any, config?: any): Promise<T> {
    return (await this.client.put<T>(url, data, config)).data;
  }

  async delete<T = any>(url: string, config?: any): Promise<T> {
    return (await this.client.delete<T>(url, config)).data;
  }

  setAuth(auth: AuthConfig): void { this.auth = auth; }
  getClient(): AxiosInstance { return this.client; }
}

export default FavroHttpClient;
