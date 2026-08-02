/**
 * The one paginated-list loop (#91).
 *
 * Its own module rather than a member of `http-client`, for a reason that is
 * about tests, not layering: twenty-plus suites call
 * `jest.mock('../lib/http-client')`, and an automock replaces every named export
 * with a `jest.fn()` returning `undefined`. A pager exported from there is
 * silently disabled by any of them — the caller gets
 * `Cannot read properties of undefined (reading 'map')` from a line that never
 * mentions pagination. `PaginatedResponse` stays in `http-client` because it is
 * a type and erases at runtime; only the function had to move.
 */
import FavroHttpClient, { PaginatedResponse } from './http-client';

/** Favro clamps a page to 100 entities regardless of what `limit` asks for. */
const PAGE_MAX = 100;

/**
 * Anything that can issue the GET a pager needs: the client itself, a test
 * double, or a wrapper that adds behaviour — `cards-api` passes one that retries
 * without `descriptionFormat` when Favro's markdown converter 500s.
 */
export type Getter = Pick<FavroHttpClient, 'get'>;

export interface GetAllOptions {
  /** Stop once this many entities are collected. Omit to read to completion. */
  max?: number;
}

/**
 * Read a paginated Favro list to completion — every page, or it throws.
 *
 * The cursor rules, which the nineteen hand-rolled copies of this loop got two
 * different ways: the opening request carries **no** `page` and no `requestId`;
 * the response's `requestId` is what opens the cursor; and `page` is 0-based, so
 * the second request asks for page **1**. Nine of the copies asked for page 2,
 * silently skipping a whole page of entities into a client-side filter —
 * `favro members list` against a 150-user org returned users 1-50 and 101-150
 * and called it the whole org.
 *
 * The page number is counted locally rather than read back from the response:
 * the old `cards-api` loop trusted `response.page`, which a server echoing a
 * stale cursor could stall forever.
 *
 * A caller that asks for everything gets everything. `max` is the one exception,
 * and it is a fetch cap the caller named — never a silent trim of a whole read.
 * A caller wanting to *display* fewer rows than it read wants `capRows` in
 * `read-shape`, which marks the envelope `truncated`; `max` does not, because it
 * cuts the fetch and a cut fetch cannot know what it did not see (#136).
 *
 * A free function taking any `{ get }` rather than a client method: that is what
 * keeps the resource modules' own tests asserting on real wire parameters
 * instead of on a stubbed-out pager.
 */
export async function getAllPages<T>(
  client: Getter,
  url: string,
  params: Record<string, unknown> = {},
  { max }: GetAllOptions = {},
): Promise<T[]> {
  const all: T[] = [];
  let requestId: string | undefined;
  let page = 0;
  let pages = 1;

  while (page < pages && (max === undefined || all.length < max)) {
    // Rebuilt per page: the old loops mutated the caller's params object and
    // carried a stale cursor into the next call.
    const query: Record<string, unknown> = { ...params };
    if (max !== undefined) query.limit = Math.min(max - all.length, PAGE_MAX);
    if (requestId) {
      query.requestId = requestId;
      query.page = page;
    }

    const response = await client.get<PaginatedResponse<T>>(url, { params: query });
    const entities = response?.entities ?? [];
    all.push(...entities);

    // No cursor, or a page that came back empty: there is nothing after this.
    // The empty-page half is load-bearing, not belt-and-braces — a Favro page
    // can come back empty while `pages` still claims more.
    if (!response?.requestId || entities.length === 0) break;
    requestId = response.requestId;
    pages = response.pages ?? 1;
    page += 1;
  }

  return max === undefined ? all : all.slice(0, max);
}
