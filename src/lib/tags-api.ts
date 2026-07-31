import FavroHttpClient from './http-client';
import { cachedTags } from './name-cache';
import { MISSING_WORDING } from './favro-error';

export interface Tag {
  tagId: string;
  name: string;
  color?: string;
  organizationId?: string;
}

export interface PaginatedResponse<T> {
  entities: T[];
  requestId?: string;
  pages?: number;
}

/**
 * `tagId` has TWO measured shapes inside one organization — 27 hex-24 and 222
 * base62-17. A hex-24-only classifier misses 11% of the tags, so both count.
 */
const HEX_24 = /^[0-9a-f]{24}$/i;
const BASE62_17 = /^[0-9A-Za-z]{17}$/;

/** True when the string has the shape of a `tagId` rather than a tag name. */
export function isTagId(value: string): boolean {
  const v = value.trim();
  return HEX_24.test(v) || BASE62_17.test(v);
}

export type TagLookupFailure = 'unknown' | 'ambiguous';

/** Structured refusal from `getTag`. `candidates` is populated on 'ambiguous'. */
export class TagLookupError extends Error {
  constructor(
    message: string,
    readonly kind: TagLookupFailure,
    readonly value: string,
    readonly candidates: Tag[] = []
  ) {
    super(message);
    this.name = 'TagLookupError';
  }
}

export class TagsAPI {
  constructor(private client: FavroHttpClient) {}

  /**
   * Resolve one tag by `tagId` or by name — the read `favro tags get` needs, and
   * ~200 bytes of output instead of the 27 KB tag list.
   *
   * Detection is by SHAPE, not escalate-on-404: the longest pure-alnum
   * single-token tag name measured is 14 chars, so nothing that looks like an id
   * can be a name.
   *
   * A name matching more than one tag REFUSES with every colliding `tagId`.
   * That is fidelity, not convention: Favro's own resolution of three casings
   * returns an id that is not the byte-exact match, so any tie-break here would
   * write an id Favro never selects. This lookup must never become the tag
   * write-path resolver — writes pass names and let Favro resolve them.
   *
   * ponytail: one cached org-wide list answers all three questions (id lookup,
   * name lookup, ambiguity). GET /tags/:tagId would shave a cold-cache fetch and
   * buy a second not-found path; add it if the cold fetch ever shows up.
   */
  async getTag(key: string): Promise<Tag> {
    const value = key.trim();
    const tags = await cachedTags(this.client, this.client.organizationId);

    if (isTagId(value)) {
      const byId = tags.find((t) => t.tagId === value);
      if (!byId) {
        throw new TagLookupError(
          `No tag with tagId "${value}" — it is ${MISSING_WORDING}. Run 'favro tags list' to see the workspace tags.`,
          'unknown',
          value
        );
      }
      return byId;
    }

    const matches = tags.filter(
      (t) => (t.name ?? '').trim().toLowerCase() === value.toLowerCase()
    );

    if (matches.length === 0) {
      throw new TagLookupError(
        `No tag named "${value}" — it is ${MISSING_WORDING}. Run 'favro tags list' to see the workspace tags.`,
        'unknown',
        value
      );
    }

    if (matches.length > 1) {
      const listed = matches.map((t) => `  ${t.tagId}  ${t.name}`).join('\n');
      throw new TagLookupError(
        `Tag name "${value}" matches ${matches.length} tags — refusing to pick one:\n${listed}\n` +
          `Favro resolves a tag name itself on a write and its choice is not always the byte-exact match, ` +
          `so write tags by name (favro cards update <card> --tags "${value}"), never by tagId.`,
        'ambiguous',
        value,
        matches
      );
    }

    return matches[0];
  }

  /**
   * List all global workspace tags.
   */
  async listTags(): Promise<Tag[]> {
    const allTags: Tag[] = [];
    let requestId: string | undefined;
    let page = 0;

    while (true) {
      const params: Record<string, any> = {};
      if (requestId) {
        params.requestId = requestId;
        params.page = page;
      }

      const response = await this.client.get<PaginatedResponse<Tag>>('/tags', { params });
      
      if (response && response.entities) {
        allTags.push(...response.entities);
      }

      requestId = response.requestId;
      if (!requestId || !response.pages || page >= response.pages - 1 || !response.entities || response.entities.length === 0) {
        break;
      }
      page++;
    }

    return allTags;
  }

  /**
   * Create a new workspace tag.
   */
  async createTag(name: string, color?: string): Promise<Tag> {
    const payload: any = { name };
    if (color) {
      payload.color = color;
    }
    return this.client.post<Tag>('/tags', payload);
  }

  async updateTag(tagId: string, data: { name?: string; color?: string }): Promise<Tag> {
    return this.client.put<Tag>(`/tags/${tagId}`, data);
  }

  async deleteTag(tagId: string): Promise<void> {
    await this.client.delete(`/tags/${tagId}`);
  }
}

export default TagsAPI;
