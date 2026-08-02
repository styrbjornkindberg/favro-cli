/**
 * Time helpers — relative window parsing and timestamp formatting.
 *
 * Extracted from the deleted `audit-api.ts` (#19): `favro audit` and
 * `favro who-changed` were built on a 404 endpoint and a synthetic fallback,
 * but these helpers were always generic and are used by `activity`,
 * `comments` and the skill engine.
 */

/**
 * Parse a --since string like "1h", "1d", "1w" into a Date cutoff.
 * Returns undefined if input is null/undefined.
 * Throws if format is unrecognised.
 */
export function parseSince(since: string | undefined): Date | undefined {
  if (since === undefined || since === null) return undefined;
  const trimmed = since.trim();
  if (trimmed === '') {
    throw new Error(
      `Invalid --since value "${since}". Use format: 1h, 1d, 1w (hours, days, weeks).`
    );
  }
  const match = trimmed.match(/^(\d+)(h|d|w)$/i);
  if (!match) {
    throw new Error(
      `Invalid --since value "${trimmed}". Use format: 1h, 1d, 1w (hours, days, weeks).`
    );
  }
  const amount = parseInt(match[1], 10);
  if (amount === 0) {
    throw new Error(
      `Invalid --since value "${trimmed}". Amount must be greater than 0.`
    );
  }
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = {
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  };
  return new Date(Date.now() - amount * multipliers[unit]);
}

/**
 * Whole days between `dateStr` and now, floored — or `undefined` when there is
 * no date, or it will not parse.
 *
 * One home for what `health` and `stale` each held verbatim (#89). It used to
 * answer `Infinity` here, on the reading that a card nobody can date is
 * infinitely stale. That reading was wrong, and #130 is what it cost:
 * `Infinity` is a *number*, so it satisfies every `>= threshold` a caller can
 * write, and `favro stale` reported every undated card as over the limit
 * whatever `--days` said. 0 would have been the mirror-image lie ("touched
 * today").
 *
 * `undefined` is neither. An unknown age is not an age, so it does not compare,
 * and TypeScript makes each caller state what it does with one instead of
 * inheriting a default that happens to read as a plausible answer.
 */
export function daysSince(dateStr?: string): number | undefined {
  if (!dateStr) return undefined;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return undefined;
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * The one staleness threshold (#145).
 *
 * `favro stale --days` defaults to it and `favro health` scores against it, and
 * they mean the SAME thing on purpose — one card, one answer to "is this
 * stale". They used to be two literals written separately, which is how they
 * drifted to two different boundaries around the same number.
 */
export const DEFAULT_STALE_DAYS = 14;

/**
 * The one staleness boundary, INCLUSIVE (#145).
 *
 * `stale` filtered `days >= staleDays` and `health` filtered `d > 14`, so a
 * card inactive for exactly 14 days was stale to one command and healthy to the
 * other. Inclusive is the side that was chosen:
 *
 * - "inactive for n days or more" is how the threshold is read aloud, and how
 *   `--days 14` is meant when someone types it.
 * - It keeps `--days 0` meaning "everything" (#130 made 0 a real threshold);
 *   exclusive would make it "everything except cards created today", which is
 *   a degenerate reading of a flag whose whole point is to widen the net.
 *
 * `days` is a measured age. An unmeasurable one is `undefined` from
 * `daysSince` and never reaches here — see the callers, which name those cards
 * separately rather than guessing at a number for them.
 */
export const isStale = (days: number, staleDays: number): boolean => days >= staleDays;

/**
 * How `isStale` reads in a human report. Lives next to the predicate so the
 * header cannot promise a boundary the filter does not apply — `stale`'s used
 * to say `inactive >14 days` over a set built with `>=`.
 */
export const staleWording = (staleDays: number): string =>
  `inactive ${staleDays} ${staleDays === 1 ? 'day' : 'days'} or more`;

/**
 * Format a timestamp in both relative and absolute (ISO 8601) form.
 * E.g.: "2 hours ago (2026-03-25T14:30:00.000Z)"
 */
export function formatTimestamp(isoString: string | null | undefined): string {
  // Explicit guard: null/undefined/empty must not be passed to new Date()
  // (new Date(null) returns epoch 1970-01-01, not an invalid date)
  if (!isoString) return '(unknown time)';
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return isoString;

  const diffMs = Date.now() - date.getTime();
  const relative = formatRelative(diffMs);
  return `${relative} (${date.toISOString()})`;
}

/**
 * Format a millisecond difference as a human-readable relative string.
 */
export function formatRelative(diffMs: number): string {
  const abs = Math.abs(diffMs);
  const future = diffMs < 0;

  if (abs < 60_000) {
    return future ? 'in a few seconds' : 'just now';
  }
  const minutes = Math.floor(abs / 60_000);
  if (minutes < 60) {
    const label = minutes === 1 ? '1 minute' : `${minutes} minutes`;
    return future ? `in ${label}` : `${label} ago`;
  }
  const hours = Math.floor(abs / 3_600_000);
  if (hours < 24) {
    const label = hours === 1 ? '1 hour' : `${hours} hours`;
    return future ? `in ${label}` : `${label} ago`;
  }
  const days = Math.floor(abs / 86_400_000);
  if (days < 7) {
    const label = days === 1 ? '1 day' : `${days} days`;
    return future ? `in ${label}` : `${label} ago`;
  }
  const weeks = Math.floor(days / 7);
  if (weeks < 52) {
    const label = weeks === 1 ? '1 week' : `${weeks} weeks`;
    return future ? `in ${label}` : `${label} ago`;
  }
  const years = Math.floor(weeks / 52);
  const label = years === 1 ? '1 year' : `${years} years`;
  return future ? `in ${label}` : `${label} ago`;
}
