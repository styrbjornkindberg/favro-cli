"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FavroHttpClient = void 0;
const axios_1 = __importDefault(require("axios"));
class FavroHttpClient {
    constructor(config = {}) {
        this.auth = config.auth;
        this.client = axios_1.default.create({
            baseURL: config.baseURL || 'https://api.favro.com/v1',
            timeout: 30000,
            headers: { 'Content-Type': 'application/json' }
        });
        this.client.interceptors.request.use((cfg) => {
            if (this.auth?.token)
                cfg.headers['Authorization'] = `Bearer ${this.auth.token}`;
            return cfg;
        });
        this.client.interceptors.response.use((response) => response, async (error) => {
            const retryCount = error.config?._retryCount ?? 0;
            if (this.shouldRetry(error) && retryCount < 3) {
                error.config._retryCount = retryCount + 1;
                const delay = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.client.request(error.config);
            }
            return Promise.reject(error);
        });
    }
    shouldRetry(error) {
        const status = error.response?.status;
        return !status || status === 408 || status === 429 || (status >= 500);
    }
    async get(url, config) {
        return (await this.client.get(url, config)).data;
    }
    async post(url, data, config) {
        return (await this.client.post(url, data, config)).data;
    }
    async patch(url, data, config) {
        return (await this.client.patch(url, data, config)).data;
    }
    async delete(url, config) {
        return (await this.client.delete(url, config)).data;
    }
    setAuth(auth) { this.auth = auth; }
    getClient() { return this.client; }
}
exports.FavroHttpClient = FavroHttpClient;
exports.default = FavroHttpClient;
//# sourceMappingURL=http-client.js.map