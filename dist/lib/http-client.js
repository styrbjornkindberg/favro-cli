"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FavroHttpClient = void 0;
const axios_1 = __importDefault(require("axios"));
const error_handler_1 = require("./error-handler");
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
                // For 429, read Retry-After header and show user-visible message
                let delay;
                if (error.response?.status === 429) {
                    const retryAfterHeader = error.response.headers?.['retry-after'];
                    const retryAfterSecs = retryAfterHeader ? parseInt(String(retryAfterHeader), 10) : undefined;
                    const delaySecs = (!isNaN(retryAfterSecs) && retryAfterSecs > 0) ? retryAfterSecs : Math.pow(2, retryCount);
                    delay = delaySecs * 1000;
                    // User-visible message: "Rate limited. Retrying in 30 seconds..."
                    process.stderr.write((0, error_handler_1.rateLimitMessage)(delaySecs) + '\n');
                }
                else {
                    delay = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
                }
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