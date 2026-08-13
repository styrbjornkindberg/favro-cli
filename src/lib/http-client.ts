import axios, { AxiosInstance, AxiosError } from 'axios';
import { rateLimitMessage } from './error-handler';
import { isTransientStatus } from './favro-error';
import { RefusalError } from './refusal';

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
    // `isTransientStatus` is shared with the `retryable` we REPORT (#162), so
    // the set this client retries and the set an agent is told to retry cannot
    // drift apart again.
    return isTransientStatus(error.response?.status);
  }

  /**
   * Refuse a mutating request whose target has an empty path segment (#125).
   *
   * Every single-resource write in this codebase is `/<resource>/${id}` —
   * `/tags/${tagId}`, `/usergroups/${groupId}`, `/cards/${cardId}`,
   * `/collections/${id}/boards/${id}` and eleven more. An empty id does not
   * produce a malformed request that fails safely; it produces a well-formed one
   * addressed at the COLLECTION. `deleteTag('')` sends `DELETE /tags/` — the
   * organization's whole tag set instead of one tag — and `favro tags delete
   * "$TAG" --yes` with `TAG` unset is the way in. #138 is the same shape: an
   * empty filter read as "every card" rather than "no cards", and moved a board.
   *
   * Fail closed: an unbounded target refuses, it never widens. This is the
   * chokepoint every resource module routes through, so it is one guard rather
   * than fourteen for the fifteenth module to forget.
   *
   * READS are deliberately not guarded — `GET /tags/` is the list endpoint, and
   * a widened read costs nothing.
   *
   * Measured, not assumed: no mutating URL in `src/` carries an empty segment
   * when its ids are present. Every collection write is `'/tags'`, `'/cards'`,
   * `'/widgets'`… with no trailing slash, and the single collection-level delete
   * (`DELETE /cards/:id/dependencies`) has none either.
   *
   * It checks the path the WIRE WILL CARRY, not the template string, because the
   * two are not the same string. axios resolves the path against `baseURL`, and
   * resolution REWRITES the target before the request leaves. Measured against a
   * local stand, with the first version of this guard in place:
   *
   *   deleteTag('.')            → DELETE /tags/          (still the collection)
   *   deleteTag(' ')            → DELETE /tags/          (still the collection)
   *   deleteTag('../boards/b1') → DELETE /boards/b1      (a DIFFERENT resource)
   *
   * None of those three has an empty segment as written, so a check on the raw
   * template passed all three and validated a URL that was never sent. The last
   * is the worst of the set: a tag delete arriving as a board delete escapes the
   * scope lock as well, since no board was ever resolved to check.
   *
   * So: resolve first, then apply BOTH tests to the resolved path — no empty
   * segment, and resolution changed nothing. Neither alone is enough. Resolution
   * PRESERVES an empty segment (`/tags/` resolves to `/tags/`, `/cards//deps` to
   * `/cards//deps`), so the equality test alone misses the original `''` hole;
   * and `/tags/.` has no empty segment as written, so the segment test alone
   * misses normalization. An id that survives resolution intact and leaves no
   * empty segment names exactly one resource. No real Favro id contains `/`, `.`
   * or a space, so nothing legitimate is caught — the fifteen mutating URLs in
   * `src/` are all `/resource` or `/resource/${id}` with opaque alphanumeric ids.
   */
  private assertBoundedTarget(method: string, url: string): void {
    const [pathOnly] = String(url ?? '').split(/[?#]/);
    const wire = this.wirePath(pathOnly);
    // An empty url needs no arm of its own: it resolves to `/`, which the
    // equality test already rejects. Measured, and pinned in the wire test.
    const unbounded =
      wire !== pathOnly || wire.split('/').some((segment, i) => i > 0 && segment === '');
    if (!unbounded) return;
    throw new RefusalError(
      `Refusing to ${method} "${url}": the target does not name one bounded resource — as sent it would ` +
        `address a COLLECTION, or a different resource than the one named.\n` +
        `  An unset, empty or non-id value is the usual cause, e.g. 'favro tags delete "$TAG"' with TAG ` +
        `unset, which would send DELETE /tags/ and name every tag in the organization.\n` +
        `  Pass the id explicitly. Run 'favro tags list' (or the matching list command) to find it.`
    );
  }

  /**
   * The path after URL resolution — what the request actually carries — or `''`
   * when it cannot be resolved at all, which `assertBoundedTarget` reads as
   * unbounded. Fail closed: an unparseable target refuses rather than escaping
   * the comparison as a thrown `TypeError`.
   */
  private wirePath(pathOnly: string): string {
    try {
      // ponytail: any absolute base works — only the resolved pathname is read.
      return new URL(pathOnly, 'http://favro.invalid').pathname;
    } catch {
      return '';
    }
  }

  async get<T = any>(url: string, config?: any): Promise<T> {
    return (await this.client.get<T>(url, config)).data;
  }

  async post<T = any>(url: string, data?: any, config?: any): Promise<T> {
    this.assertBoundedTarget('POST', url);
    return (await this.client.post<T>(url, data, config)).data;
  }

  async patch<T = any>(url: string, data?: any, config?: any): Promise<T> {
    this.assertBoundedTarget('PATCH', url);
    return (await this.client.patch<T>(url, data, config)).data;
  }

  async put<T = any>(url: string, data?: any, config?: any): Promise<T> {
    this.assertBoundedTarget('PUT', url);
    return (await this.client.put<T>(url, data, config)).data;
  }

  async delete<T = any>(url: string, config?: any): Promise<T> {
    this.assertBoundedTarget('DELETE', url);
    return (await this.client.delete<T>(url, config)).data;
  }

  setAuth(auth: AuthConfig): void { this.auth = auth; }
  getClient(): AxiosInstance { return this.client; }
}

export default FavroHttpClient;
