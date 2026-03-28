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
                }
                else {
                    // Fallback for legacy/testing — Basic auth without email won't work against live API
                    cfg.headers['Authorization'] = `Bearer ${this.auth.token}`;
                }
            }
            if (this.auth?.organizationId)
                cfg.headers['organizationId'] = this.auth.organizationId;
            // Forward backend routing header for paginated requests
            if (this.backendId)
                cfg.headers['X-Favro-Backend-Identifier'] = this.backendId;
            return cfg;
        });
        this.client.interceptors.response.use((response) => {
            // Capture backend routing identifier for pagination
            const bid = response.headers?.['x-favro-backend-identifier'];
            if (bid)
                this.backendId = bid;
            return response;
        }, async (error) => {
            const retryCount = error.config?._retryCount ?? 0;
            if (this.shouldRetry(error) && retryCount < 4) {
                error.config._retryCount = retryCount + 1;
                // For 429, read Retry-After header and show user-visible message
                let delay;
                if (error.response?.status === 429) {
                    const retryAfterHeader = error.response.headers?.['retry-after'];
                    const retryAfterSecs = retryAfterHeader ? parseInt(String(retryAfterHeader), 10) : undefined;
                    // Exponential backoff: 1s, 2s, 4s, 8s — capped at 30s
                    const expBackoffSecs = Math.min(Math.pow(2, retryCount), 30);
                    const delaySecs = Math.min((!isNaN(retryAfterSecs) && retryAfterSecs > 0) ? retryAfterSecs : expBackoffSecs, 30 // Global cap: Retry-After cannot exceed 30s either
                    );
                    delay = delaySecs * 1000;
                    // User-visible log: "⚠️ Rate limit detected, retrying after Ns..."
                    process.stderr.write((0, error_handler_1.rateLimitMessage)(delaySecs) + '\n');
                }
                else {
                    // Exponential backoff for 5xx/408: 1s, 2s, 4s, 8s — capped at 30s
                    delay = Math.min(Math.pow(2, retryCount) * 1000, 30000); // cap 30s
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
    async put(url, data, config) {
        return (await this.client.put(url, data, config)).data;
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