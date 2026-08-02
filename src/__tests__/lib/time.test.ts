/**
 * Unit tests — time helpers (parseSince, formatTimestamp, formatRelative, daysSince)
 */
import { parseSince, formatTimestamp, formatRelative, daysSince } from '../../lib/time';


// ─── daysSince ───────────────────────────────────────────────────────────────
// Pins the one surviving copy (#89). `health` and `stale` each held these five
// lines verbatim; the contract both relied on is "unmeasurable reads as
// infinitely stale", never 0.
describe('daysSince', () => {
  it('returns whole days elapsed, floored', () => {
    const threeAndAHalfDays = new Date(Date.now() - 3.5 * 86_400_000).toISOString();
    expect(daysSince(threeAndAHalfDays)).toBe(3);
  });

  it('returns 0 for a timestamp from moments ago', () => {
    expect(daysSince(new Date().toISOString())).toBe(0);
  });

  it('returns Infinity when there is no date at all', () => {
    expect(daysSince(undefined)).toBe(Infinity);
    expect(daysSince('')).toBe(Infinity);
  });

  it('returns Infinity for an unparseable date rather than NaN', () => {
    expect(daysSince('not-a-date')).toBe(Infinity);
  });
});


// ─── parseSince ──────────────────────────────────────────────────────────────
describe('parseSince', () => {
  it('returns undefined for undefined input', () => {
    expect(parseSince(undefined)).toBeUndefined();
  });

  it('parses "1h" as 1 hour ago', () => {
    const before = Date.now();
    const result = parseSince('1h');
    const after = Date.now();
    const expected = 60 * 60 * 1000;
    expect(result).toBeInstanceOf(Date);
    expect(before - result!.getTime()).toBeGreaterThanOrEqual(expected - 50);
    expect(after - result!.getTime()).toBeLessThanOrEqual(expected + 50);
  });

  it('parses "1d" as 1 day ago', () => {
    const before = Date.now();
    const result = parseSince('1d');
    const after = Date.now();
    const expected = 24 * 60 * 60 * 1000;
    expect(result).toBeInstanceOf(Date);
    expect(before - result!.getTime()).toBeGreaterThanOrEqual(expected - 50);
    expect(after - result!.getTime()).toBeLessThanOrEqual(expected + 50);
  });

  it('parses "1w" as 7 days ago', () => {
    const before = Date.now();
    const result = parseSince('1w');
    const after = Date.now();
    const expected = 7 * 24 * 60 * 60 * 1000;
    expect(result).toBeInstanceOf(Date);
    expect(before - result!.getTime()).toBeGreaterThanOrEqual(expected - 50);
    expect(after - result!.getTime()).toBeLessThanOrEqual(expected + 50);
  });

  it('parses "2h" as 2 hours ago', () => {
    const before = Date.now();
    const result = parseSince('2h');
    const after = Date.now();
    const expected = 2 * 60 * 60 * 1000;
    expect(before - result!.getTime()).toBeGreaterThanOrEqual(expected - 50);
    expect(after - result!.getTime()).toBeLessThanOrEqual(expected + 50);
  });

  it('parses "3d" as 3 days ago', () => {
    const before = Date.now();
    const result = parseSince('3d');
    const after = Date.now();
    const expected = 3 * 24 * 60 * 60 * 1000;
    expect(before - result!.getTime()).toBeGreaterThanOrEqual(expected - 50);
    expect(after - result!.getTime()).toBeLessThanOrEqual(expected + 50);
  });

  it('throws for invalid format "bad"', () => {
    expect(() => parseSince('bad')).toThrow('Invalid --since value');
  });

  it('throws for "1x" (unknown unit)', () => {
    expect(() => parseSince('1x')).toThrow('Invalid --since value');
  });

  it('throws for empty string', () => {
    expect(() => parseSince('')).toThrow('Invalid --since value');
  });

  it('throws for "0d" (zero amount)', () => {
    expect(() => parseSince('0d')).toThrow('Amount must be greater than 0');
  });

  it('throws for "0h" (zero hours)', () => {
    expect(() => parseSince('0h')).toThrow('Amount must be greater than 0');
  });
});

// ─── formatRelative ──────────────────────────────────────────────────────────
describe('formatRelative', () => {
  it('returns "just now" for < 1 minute', () => {
    expect(formatRelative(30_000)).toBe('just now');
    expect(formatRelative(0)).toBe('just now');
  });

  it('returns "1 minute ago" for 1 minute', () => {
    expect(formatRelative(60_000)).toBe('1 minute ago');
  });

  it('returns "5 minutes ago" for 5 minutes', () => {
    expect(formatRelative(5 * 60_000)).toBe('5 minutes ago');
  });

  it('returns "1 hour ago" for 1 hour', () => {
    expect(formatRelative(60 * 60_000)).toBe('1 hour ago');
  });

  it('returns "2 hours ago" for 2 hours', () => {
    expect(formatRelative(2 * 60 * 60_000)).toBe('2 hours ago');
  });

  it('returns "1 day ago" for 24 hours', () => {
    expect(formatRelative(24 * 60 * 60_000)).toBe('1 day ago');
  });

  it('returns "3 days ago" for 3 days', () => {
    expect(formatRelative(3 * 24 * 60 * 60_000)).toBe('3 days ago');
  });

  it('returns "1 week ago" for 7 days', () => {
    expect(formatRelative(7 * 24 * 60 * 60_000)).toBe('1 week ago');
  });

  it('returns "2 weeks ago" for 14 days', () => {
    expect(formatRelative(14 * 24 * 60 * 60_000)).toBe('2 weeks ago');
  });

  it('returns "1 year ago" for 365 days', () => {
    expect(formatRelative(365 * 24 * 60 * 60_000)).toBe('1 year ago');
  });

  it('returns "in 2 hours" for negative diff (future)', () => {
    expect(formatRelative(-2 * 60 * 60_000)).toBe('in 2 hours');
  });
});

// ─── formatTimestamp ──────────────────────────────────────────────────────────
describe('formatTimestamp', () => {
  it('returns relative + absolute ISO format', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const result = formatTimestamp(twoHoursAgo);
    expect(result).toContain('2 hours ago');
    expect(result).toContain(twoHoursAgo);
    expect(result).toMatch(/^.+ \(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('handles "just now" for very recent timestamps', () => {
    const now = new Date().toISOString();
    const result = formatTimestamp(now);
    expect(result).toContain('just now');
  });

  it('returns original string for invalid date', () => {
    expect(formatTimestamp('not-a-date')).toBe('not-a-date');
  });

  it('returns "(unknown time)" for null input', () => {
    expect(formatTimestamp(null as any)).toBe('(unknown time)');
  });

  it('returns "(unknown time)" for undefined input', () => {
    expect(formatTimestamp(undefined as any)).toBe('(unknown time)');
  });

  it('returns "(unknown time)" for empty string', () => {
    expect(formatTimestamp('')).toBe('(unknown time)');
  });
});
