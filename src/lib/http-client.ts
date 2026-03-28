import axios, { AxiosInstance, AxiosError } from 'axios';
import { rateLimitMessage } from './error-handler';

export interface AuthConfig {
  token?: string;
  organizationId?: string;
}

export class FavroHttpClient {
  private client: AxiosInstance;
  private auth?: AuthConfig;

  constructor(config: { baseURL?: string; auth?: AuthConfig } = {}) {
    this.auth = config.auth;
    this.client = axios.create({
      baseURL: config.baseURL || 'https://api.favro.com/v1',
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' }
    });

    this.client.interceptors.request.use((cfg) => {
      if (this.auth?.token) cfg.headers['Authorization'] = `Bearer ${this.auth.token}`;
      if (this.auth?.organizationId) cfg.headers['organizationId'] = this.auth.organizationId;
      return cfg;
    });

    this.client.interceptors.response.use(
      (response) => response,
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

  async delete<T = any>(url: string, config?: any): Promise<T> {
    return (await this.client.delete<T>(url, config)).data;
  }

  setAuth(auth: AuthConfig): void { this.auth = auth; }
  getClient(): AxiosInstance { return this.client; }
}

export default FavroHttpClient;
