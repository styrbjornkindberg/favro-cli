import axios, { AxiosInstance, AxiosError } from 'axios';

export interface AuthConfig {
  token?: string;
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
      return cfg;
    });

    this.client.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        const retryCount = (error.config as any)?._retryCount ?? 0;
        if (this.shouldRetry(error) && retryCount < 3) {
          (error.config as any)._retryCount = retryCount + 1;
          const delay = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
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
