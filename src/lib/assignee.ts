/**
 * `assignee` as a closed vocabulary — CLA #42.
 *
 * ONE resolution home for every call site, reads and writes. Any flag or filter
 * value spelled `assignee` comes through here and leaves as a `userId`, so the
 * same spelling can never mean different things by verb.
 *
 * Three keys, detected by shape (see `detectUserKey`): `@` → email, base62-17 →
 * `userId`, else name. An unknown id is shape-valid and makes no call of its
 * own, so without this it would answer `0 rows` in silence — the safest-looking
 * key is the silent one. Validation is free: the name path already holds the
 * list.
 */
import FavroHttpClient from './http-client';
import UsersAPI, { User, UserLookupError } from './users-api';
import { resolveUserId } from './config';

export type AssigneeFailure = 'unknown' | 'ambiguous';

/** Structured refusal. `candidates` holds ONLY the collided entries. */
export class AssigneeError extends Error {
  constructor(
    message: string,
    readonly kind: AssigneeFailure,
    readonly value: string,
    readonly candidates: User[] = []
  ) {
    super(message);
    this.name = 'AssigneeError';
  }
}

/**
 * Resolve one `--assignee` / `assignee:` value to a `userId`.
 *
 * `@me` resolves through the cached config userId. Everything else goes to
 * `UsersAPI.getUser`.
 */
export async function resolveAssignee(
  client: FavroHttpClient,
  value: string
): Promise<string> {
  const raw = value.trim();

  if (raw === '@me') {
    const me = await resolveUserId();
    if (!me) {
      throw new AssigneeError(
        `Cannot resolve "@me" — no userId is cached for your credentials. Run 'favro auth login' first.`,
        'unknown',
        raw
      );
    }
    return me;
  }

  try {
    return (await new UsersAPI(client).getUser(raw)).userId;
  } catch (error) {
    if (!(error instanceof UserLookupError)) throw error;

    // Unknown: the value and a reachable next step, and NO candidate list —
    // the org holds 135 users and every name has a space in it, so listing them
    // would make an error message out of the 16 KB read this command deletes.
    if (error.kind === 'unknown') {
      throw new AssigneeError(
        `Unknown assignee "${raw}" — no user matches that name, email or userId. ` +
          `Run 'favro users get "<name|email|userId>"' to confirm one, or 'favro users list' to see them all.`,
        'unknown',
        raw
      );
    }

    // Ambiguous: only the collided entries, with userId AND email.
    throw new AssigneeError(
      `Ambiguous assignee "${raw}" — ${error.candidates.length} users share it:\n` +
        error.candidates.map((u) => `  ${u.userId}  ${u.name}  <${u.email}>`).join('\n') +
        `\nPass the userId (or the email) instead.`,
      'ambiguous',
      raw,
      error.candidates
    );
  }
}

/** Resolve several values, in order, refusing on the first bad one. */
export async function resolveAssignees(
  client: FavroHttpClient,
  values: string[]
): Promise<string[]> {
  const resolved: string[] = [];
  for (const value of values) {
    resolved.push(await resolveAssignee(client, value));
  }
  return resolved;
}
